'use strict';
/*
 * 后端逻辑端到端测试（无需 GUI）：
 * 启动一个 mock 服务，驱动真实的 runner 走完 同步 / 错误 / 取消（含同一对话里的并发请求）全链路，
 * 并额外覆盖新增协议（Seedream 官方 / New API / Grsai）与「模型系列」配置读写。
 * 运行：npm run test:api   （或 node scripts/test-api.js）
 *
 * 注意：**没有异步模式**（同步/异步开关已删除，见 AIDEV.md §4.12）。
 * 唯一保留的 kind:'task' 兜底是 Grsai 协议内部的（某些节点只回任务 id），本文件仍覆盖它。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const log = require(path.join(ROOT, 'electron/src/logger'));
const runner = require(path.join(ROOT, 'electron/src/api/runner'));
const registry = require(path.join(ROOT, 'electron/src/api/registry'));
const modelSeriesLib = require(path.join(ROOT, 'electron/src/modelSeries'));
const renameModel = require(path.join(ROOT, 'electron/src/renameModel'));
const store = require(path.join(ROOT, 'electron/src/store'));
const promptMeta = require(path.join(ROOT, 'electron/src/promptmeta'));
const exportLib = require(path.join(ROOT, 'electron/src/exportImage'));
const imageutil = require(path.join(ROOT, 'electron/src/imageutil'));

// 一张 16x16 的 PNG（用于校验尺寸嗅探 / b64 结果落盘）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGP80hLPQApgIkn1qIZRDUNKAwDTsgH3dLIX4AAAAABJRU5ErkJggg==',
  'base64'
);
// 一张 2x2 的 JPEG / WebP（提示词元数据的格式覆盖）
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEB' +
  'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
  'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
  'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z',
  'base64'
);
const WEBP = Buffer.from(
  'UklGRisAAABXRUJQVlA4IBYAAAAwAQCdASoCAQIAAUAmJQBOgCHwAP7+4AAAAAAAAAAA',
  'base64'
);
// 一张 1x1 的 GIF：容器可识别，但不支持提示词元数据
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** 含中文 / 换行 / 引号 / 反斜杠 / emoji 的提示词（往返完整性用） */
const PROMPT_SPECIAL = '赛博朋克「城市夜景」\n霓虹灯 24mm f/1.4\t"引号" \\反斜杠\\ 与 $符号; 长度 ' + '的'.repeat(200) + ' 🎨✨';
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'stabstab-cache-'));
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stabstab-log-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stabstab-cfg-'));
log.init(LOGDIR);

let PORT = 0;
let grsaiPollCount = 0;
const seen = [];                       // 记录收到的请求体，供协议断言
const IMG_URL = () => `http://127.0.0.1:${PORT}/img.png`;

const sse = (res, payloads) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const p of payloads) res.write(`data: ${JSON.stringify(p)}\n\n`);
  res.end('data: [DONE]\n\n');
};

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url;
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (e) { /* 允许空 body */ }
    seen.push({ url, method: req.method, headers: req.headers, body: parsed });

    // ---------- DashScope（qwen 系列） ----------
    if (req.method === 'POST' && url.endsWith('/multimodal-generation/generation')) {
      const model = parsed.model;
      if (model === 'err-model') return send(400, { code: 'InvalidParameter', message: '模拟错误：参数不正确', request_id: 'req-err-1' });
      if (model === 'hang-model') return;   // 永不响应：取消测试用
      // 结果图格式覆盖：提示词元数据要按真实格式写入
      const resultUrl = model === 'jpg-model' ? `${IMG_URL().replace(/\/img\.png$/, '/img.jpg')}`
        : (model === 'webp-model' ? `${IMG_URL().replace(/\/img\.png$/, '/img.webp')}` : IMG_URL());
      return send(200, {
        request_id: 'req-s1',
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: resultUrl }, { image: resultUrl }] } }] },
        usage: { output_width: 16, output_height: 16, output_image_count: 2 }
      });
    }

    // ---------- Doubao Seedream 官方（火山方舟） ----------
    if (req.method === 'POST' && url.endsWith('/api/v3/images/generations')) {
      if (parsed.model === 'err-seedream') {
        return send(400, { error: { code: 'InvalidParameter', message: '模型 id 不存在' }, request_id: 'req-seed-err' });
      }
      return send(200, { model: parsed.model, created: 1, data: [{ url: IMG_URL() }], usage: { generated_images: 1 } });
    }

    // ---------- New API（OpenAI 兼容图像生成） ----------
    if (req.method === 'POST' && url === '/v1/images/generations') {
      if (parsed.model === 'err-newapi') {
        return send(401, { error: { message: '令牌无效', type: 'invalid_request_error', code: 'invalid_api_key' } });
      }
      // b64_json 结果：验证「不下载 URL 也能落盘」
      return send(200, { created: 1, data: [{ b64_json: PNG.toString('base64') }] });
    }

    // ---------- Grsai ----------
    if (req.method === 'POST' && url === '/v1/api/generate') {
      if (parsed.model === 'grsai-task') return send(200, { code: 0, msg: 'ok', data: { id: 'grsai_task_1' } });
      if (parsed.model === 'grsai-fail') {
        return sse(res, [
          { id: 'g1', status: 'running', progress: 10 },
          { id: 'g1', status: 'failed', failure_reason: '内容不合规' }
        ]);
      }
      return sse(res, [
        { id: 'g1', status: 'running', progress: 10 },
        { id: 'g1', status: 'succeeded', progress: 100, results: [{ url: IMG_URL() }] }
      ]);
    }
    if (req.method === 'POST' && url === '/v1/draw/result') {
      grsaiPollCount++;
      return send(200, { code: 0, data: { id: parsed.id, status: 'succeeded', progress: 100, results: [{ url: IMG_URL() }] } });
    }

    // ---------- 重命名模型（DeepSeek Responses API：/responses，不是 chat/completions） ----------
    if (req.method === 'POST' && url === '/responses') {
      if (parsed.model === 'err-rename') return send(401, { error: { message: 'Authentication Fails', type: 'authentication_error' } });
      if (parsed.model === 'empty-rename') {
        // 只有思维链 item、没有 message：标题取不到 → 调用方回退到首条文字
        return send(200, { id: 'resp_0', object: 'response', output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: '……' }] }] });
      }
      // 正常返回 {"title":"…"}；raw-rename 返回「“标题”。」这种非 JSON，验证按纯文本兜底 + 清洗
      const text = parsed.model === 'raw-rename' ? '“赛博朋克城市夜景”。' : '{"title":"智能客服提效"}';
      return send(200, {
        id: 'resp_1', object: 'response', status: 'completed',
        output: [
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先读 text 字段再概括' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
        ],
        usage: { input_tokens: 20, output_tokens: 8 }
      });
    }

    if (req.method === 'GET' && url === '/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG);
    }

    if (req.method === 'GET' && url === '/img.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(JPEG);
    }

    if (req.method === 'GET' && url === '/img.webp') {
      res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(WEBP);
    }

    send(404, { message: 'not found' });
  });
});

function waitForTerminal(events) {
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const term = events.find((e) => ['result', 'error', 'cancelled'].includes(e.type));
      if (term) { clearInterval(iv); resolve(term); }
    }, 20);
    setTimeout(() => { clearInterval(iv); resolve(null); }, 40000);
  });
}

/** 等某个特定请求（按 messageId 等条件筛选）的终态事件 —— 并发场景下不能只看「第一个终态」 */
function waitForEvent(events, pred, timeoutMs = 40000) {
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const hit = events.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); }
    }, 20);
    setTimeout(() => { clearInterval(iv); resolve(null); }, timeoutMs);
  });
}

async function runScenario(name, optsPatch) {
  const events = [];
  const opts = {
    jobId: 'job_' + name, conversationId: 'conv1', messageId: 'msg_' + name,
    protocol: 'dashscope-multimodal', model: 'qwen-image-3.0-pro',
    apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${PORT}/api/v1`,
    timeoutSec: 30, prompt: '测试', images: [], params: { size: '2048*2048', n: 1 },
    cacheDir: CACHE, ...optsPatch
  };
  runner.start(opts, (ev) => events.push(ev));
  return { events, term: await waitForTerminal(events) };
}

const lastTo = (suffix) => [...seen].reverse().find((s) => s.url.endsWith(suffix));

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  console.log('mock server on', PORT);
  let pass = 0, fail = 0;
  const check = (cond, label) => { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗ FAIL:', label); } };

  console.log('\n[1] 同步成功（2 张图 + 下载缓存）');
  {
    const { term } = await runScenario('sync_ok');
    check(term && term.type === 'result' && term.ok === true, '返回 result 且 ok');
    check(term && Array.isArray(term.images) && term.images.length === 2, '两张结果图');
    check(term && term.images.every((i) => i.file && i.width === 16 && i.height === 16), '尺寸嗅探 16x16');
    check(fs.readdirSync(CACHE).length >= 2, '缓存目录已落盘');
  }

  console.log('\n[2] 同步错误（400 InvalidParameter）');
  {
    const { term } = await runScenario('sync_err', { model: 'err-model' });
    check(term && term.type === 'error' && term.ok === false, '返回 error');
    check(term && term.error.code === 'InvalidParameter', '错误码透传');
  }

  console.log('\n[3] 同步请求不带异步请求头（异步模式已删除）');
  {
    await runScenario('no_async_header');
    const req = lastTo('/multimodal-generation/generation');
    check(!!req && req.headers['x-dashscope-async'] === undefined, '不发 X-DashScope-Async 请求头');
    check(registry.getAdapter('dashscope-multimodal').supportsAsync === undefined, '适配器不再声明 supportsAsync');
    check(registry.getAdapter('dashscope-multimodal').buildTaskQuery === undefined, '适配器不再提供任务查询 / 取消端点');
    check(registry.listProtocols().every((p) => p.supportsAsync === undefined), '协议元信息里没有 supportsAsync（界面无从显示同步/异步）');
  }

  console.log('\n[4] 同一对话里的并发请求互不干扰（伪异步，见 AIDEV.md §4.12）');
  {
    // 三个请求用同一个 conversationId，但各自有自己的 messageId：
    // 一个成功、一个业务错误、一个永不返回 —— 前两个必须各走各的，互不串事件。
    const events = [];
    const convId = 'conv_parallel';
    const mk = (name, patch) => ({
      jobId: 'job_' + name, conversationId: convId, messageId: 'msg_' + name,
      protocol: 'dashscope-multimodal', model: 'qwen-image-3.0-pro',
      apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${PORT}/api/v1`,
      timeoutSec: 30, prompt: name, images: [], params: { size: '2048*2048' },
      cacheDir: CACHE, ...patch
    });
    runner.start(mk('p_ok'), (ev) => events.push(ev));
    runner.start(mk('p_err', { model: 'err-model' }), (ev) => events.push(ev));
    runner.start(mk('p_hang', { model: 'hang-model' }), (ev) => events.push(ev));

    const okEvt = await waitForEvent(events, (e) => e.messageId === 'msg_p_ok' && e.type === 'result');
    const errEvt = await waitForEvent(events, (e) => e.messageId === 'msg_p_err' && e.type === 'error');
    check(!!okEvt && okEvt.ok === true && okEvt.images.length === 2, '并发中的成功请求照常拿到结果');
    check(!!errEvt && errEvt.error.code === 'InvalidParameter', '并发中的失败请求只影响自己');
    check(events.every((e) => e.conversationId === convId), '事件都带着自己的 conversationId');
    check(events.filter((e) => e.messageId === 'msg_p_ok').every((e) => e.type !== 'error'), '成功请求没有收到别人的错误事件');
    check(runner.listActive().filter((j) => j.conversationId === convId).length === 1, '仍在等待的只有那个永不返回的请求');

    // 单独中止它：其它请求（已经结束的）不受影响
    await runner.cancel('job_p_hang', (ev) => events.push(ev));
    check(events.some((e) => e.messageId === 'msg_p_hang' && e.type === 'cancelled'), '可以只中止其中一个请求');
    check(runner.listActive().filter((j) => j.conversationId === convId).length === 0, '中止后没有残留活动任务');
  }

  console.log('\n[5] 同步请求取消 / 停止等待（永不返回的请求）');
  {
    const events = [];
    const opts = {
      jobId: 'job_cancel', conversationId: 'conv1', messageId: 'msg_cancel',
      protocol: 'dashscope-multimodal', model: 'hang-model',
      apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${PORT}/api/v1`,
      timeoutSec: 30, prompt: '', images: [], params: {}, cacheDir: CACHE
    };
    runner.start(opts, (ev) => events.push(ev));
    await new Promise((r) => setTimeout(r, 300));
    await runner.cancel('job_cancel', (ev) => events.push(ev));
    check(events.some((e) => e.type === 'cancelled'), '收到 cancelled 事件');
    check(events.find((e) => e.type === 'cancelled').messageId === 'msg_cancel', '取消事件带着自己的 messageId');
  }

  console.log('\n[6] 协议注册表');
  {
    const list = registry.listProtocols();
    check(list.some((p) => p.id === 'dashscope-multimodal' && p.available), 'DashScope 协议可用');
    check(list.some((p) => p.id === 'seedream-official' && p.available), 'Seedream 官方协议可用');
    check(list.some((p) => p.id === 'newapi-images' && p.available), 'New API 协议可用');
    check(list.some((p) => p.id === 'grsai-image' && p.available), 'Grsai 协议可用');
    check(list.some((p) => !p.available), '存在预留协议');
    const sizes = registry.getAdapter('dashscope-multimodal').sizeOptions;
    check(sizes.includes('2688*1536') && sizes.includes('2048*2048') && sizes.includes('auto'), 'size 列表正确');
  }

  console.log('\n[7] Doubao Seedream 官方（同步 + 图生图参数）');
  {
    const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
    const { term } = await runScenario('seedream', {
      protocol: 'seedream-official', model: 'doubao-seedream-5-0-pro-260628',
      baseUrl: `http://127.0.0.1:${PORT}/api/v3`,
      prompt: '一只猫', images: [dataUrl], params: { size: '2K', watermark: false, output_format: 'png' }
    });
    check(term && term.type === 'result' && term.images.length === 1, 'Seedream 同步返回 1 张图');
    check(term && term.usage && term.usage.output_image_count === 1, 'usage.generated_images 归一化');
    const req = lastTo('/api/v3/images/generations');
    check(!!req && req.body.image === dataUrl, '输入图按 image 字段发送（单图 → 字符串）');
    check(!!req && req.body.size === '2K' && req.body.response_format === 'url', 'size / response_format 正确');
    check(!!req && req.headers.authorization === 'Bearer sk-test', 'Authorization 头正确');
  }

  console.log('\n[8] Doubao Seedream 官方（错误透传）');
  {
    const { term } = await runScenario('seedream_err', {
      protocol: 'seedream-official', model: 'err-seedream',
      baseUrl: `http://127.0.0.1:${PORT}/api/v3`, params: { size: 'auto' }
    });
    check(term && term.type === 'error', '返回 error');
    check(term && term.error.code === 'InvalidParameter' && /模型 id/.test(term.error.message), '错误码与信息透传');
  }

  console.log('\n[9] New API（OpenAI 兼容，b64_json 结果落盘）');
  {
    const { term } = await runScenario('newapi', {
      protocol: 'newapi-images', model: 'gpt-image-2',
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      params: { size: '1024x1024', n: 2, quality: 'high' }
    });
    check(term && term.type === 'result' && term.images.length === 1, '返回 1 张 b64 图片');
    check(term && term.images[0].file && term.images[0].width === 16 && term.images[0].height === 16, 'b64 图片已落盘且尺寸正确');
    const req = lastTo('/v1/images/generations');
    check(!!req && req.body.model === 'gpt-image-2' && req.body.n === 2 && req.body.quality === 'high', 'model / n / quality 正确');
    check(!!req && req.body.size === '1024x1024', 'size 正确');
  }

  console.log('\n[10] New API（令牌错误透传）');
  {
    const { term } = await runScenario('newapi_err', {
      protocol: 'newapi-images', model: 'err-newapi', baseUrl: `http://127.0.0.1:${PORT}/v1`, params: {}
    });
    check(term && term.type === 'error' && term.error.code === 'invalid_api_key', 'OpenAI 风格错误码透传');
  }

  console.log('\n[11] Grsai（SSE 同步流）');
  {
    const { term } = await runScenario('grsai_sse', {
      protocol: 'grsai-image', model: 'gpt-image-2',
      baseUrl: `http://127.0.0.1:${PORT}/v1/api/generate`,
      params: { size: '16:9' }
    });
    check(term && term.type === 'result' && term.images.length === 1, 'SSE 流中解析出结果图');
    const req = lastTo('/v1/api/generate');
    check(!!req && req.body.aspectRatio === '16:9', 'aspectRatio 来自尺寸下拉');
  }

  console.log('\n[12] Grsai（SSE 失败事件）');
  {
    const { term } = await runScenario('grsai_fail', {
      protocol: 'grsai-image', model: 'grsai-fail', baseUrl: `http://127.0.0.1:${PORT}/v1/api/generate`, params: {}
    });
    check(term && term.type === 'error' && /不合规/.test(term.error.message), '失败原因透传');
  }

  console.log('\n[13] Grsai（只返回任务 id → 自动退化为轮询）');
  {
    const before = grsaiPollCount;
    const { events, term } = await runScenario('grsai_task', {
      protocol: 'grsai-image', model: 'grsai-task', baseUrl: `http://127.0.0.1:${PORT}/v1/api/generate`, params: {}
    });
    check(term && term.type === 'result' && term.images.length === 1, '轮询后拿到结果');
    check(events.some((e) => e.type === 'status'), '出现过任务状态事件');
    check(grsaiPollCount > before, '确实调用了 /v1/draw/result');
  }

  console.log('\n[14] 模型系列配置（内置 json / 合并 / 隐藏；没有同步异步开关）');
  {
    const cfgFile = path.join(TMP, 'model-series.json');
    const cfg = modelSeriesLib.load(cfgFile);
    check(fs.existsSync(cfgFile), '首次加载会把配置落地到数据目录');
    check(cfg.series.length === 3, '内置 3 个模型系列');
    const qwen = cfg.series.find((s) => s.id === 'qwen');
    const seed = cfg.series.find((s) => s.id === 'doubao-seedream');
    const gpt = cfg.series.find((s) => s.id === 'gpt-image');
    check(!!qwen && qwen.sources.length === 1 && qwen.sources[0].protocol === 'dashscope-multimodal', 'qwen 系列只有官方来源');
    check(!!seed && seed.sources.map((s) => s.id).join(',') === 'official,newapi', 'seedream 系列：官方 + New Api');
    check(!!gpt && gpt.sources.map((s) => s.id).join(',') === 'grsai,newapi', 'gpt-image 系列：Grsai + NewApi');
    check(cfg.series.every((s) => s.requestMode === undefined), '内置配置里没有 requestMode（异步模式已删除）');
    check(cfg.series.every((s) => (s.sources || []).every((src) => src.supportsAsync === undefined)), '来源不再声明 supportsAsync');

    // 用户操作：隐藏 gpt 系列（并把偷改的协议与老版本的 requestMode 一起提交上来）
    const saved = modelSeriesLib.save(cfgFile, {
      series: cfg.series.map((s) => (s.id === 'qwen'
        ? { ...s, requestMode: { supported: true, value: 'async' } }
        : (s.id === 'gpt-image' ? { ...s, hidden: true, protocol: 'hacked-protocol' } : s)))
    });
    const reloaded = modelSeriesLib.load(cfgFile);
    const q2 = reloaded.series.find((s) => s.id === 'qwen');
    const g2 = reloaded.series.find((s) => s.id === 'gpt-image');
    check(q2.requestMode === undefined, '本地 json 里残留的 requestMode 被丢弃（不可能再切到异步）');
    check(g2.hidden === true, '隐藏状态已持久化');
    check(g2.protocol === 'newapi-images', '内置协议不可被本地 json 篡改');
    check(saved.series.length === 3, '保存不会丢内置系列');

    // applyPatch 只认 hidden，不再接受 requestMode
    modelSeriesLib.applyPatch(cfgFile, { series: [{ id: 'qwen', requestMode: { value: 'async' }, hidden: false }] });
    const patched = modelSeriesLib.load(cfgFile).series.find((s) => s.id === 'qwen');
    check(patched.requestMode === undefined && patched.hidden === false, 'applyPatch 不接受 requestMode，只改 hidden');
  }

  console.log('\n[15] 设置迁移（旧结构 → 模型系列结构，且不自动带出任何系列）');
  {
    const settingsFile = path.join(TMP, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
      theme: 'dark',
      requestTimeoutSec: 120,
      requestMode: 'async',
      api: { apiKey: 'sk-legacy', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
      models: [
        { id: 'm_builtin_qwen', name: 'qwen-image-3.0-pro', protocol: 'dashscope-multimodal', builtin: true },
        { id: 'm_custom', name: 'qwen-image-2.5', protocol: 'dashscope-multimodal' }
      ],
      defaultModelId: 'm_custom'
    }), 'utf8');

    const cfg = modelSeriesLib.load(path.join(TMP, 'model-series.json'));
    const r = store.loadSettings(settingsFile, cfg);
    check(r.migrated === true, '检测到旧结构并迁移');
    const s = r.settings;
    check(Array.isArray(s.modelGroups) && s.modelGroups.length === 0, '迁移后不自动添加任何模型系列（列表为空）');
    check(s.defaultModelId === '', '不自动设置默认模型');
    check(s.sourceConfig['qwen.official'] && s.sourceConfig['qwen.official'].apiKey === 'sk-legacy', '旧 API Key 保留在「系列·来源」配置里');
    check(s.sourceConfig['qwen.official'].baseUrl === '', '与内置默认一致的地址不重复落盘');
    check(s.api === undefined && s.models === undefined && s.requestMode === undefined, '旧字段已清理');
    check(s.theme === 'dark' && s.requestTimeoutSec === 120, '其它设置不受影响');

    // 用户之后自己添加该系列 + 模型时，旧密钥应能直接生效
    const afterAdd = {
      ...s,
      modelGroups: [{ seriesId: 'qwen', models: [{ id: 'm_new', name: 'qwen-image-3.0-pro', sourceId: 'official' }] }],
      defaultModelId: 'm_new'
    };
    const resolved = modelSeriesLib.resolveModel(afterAdd, cfg, 'm_new');
    check(resolved && resolved.apiKey === 'sk-legacy', '用户添加系列后，旧密钥自动可用');

    // 自定义 baseUrl 也要迁移
    const customFile = path.join(TMP, 'settings-custom.json');
    fs.writeFileSync(customFile, JSON.stringify({
      api: { apiKey: 'sk-2', baseUrl: 'https://my-relay.example.com/api/v1' },
      models: [{ id: 'm1', name: 'qwen-image-3.0-pro', protocol: 'dashscope-multimodal' }]
    }), 'utf8');
    const r2 = store.loadSettings(customFile, cfg);
    check(r2.settings.sourceConfig['qwen.official'].baseUrl === 'https://my-relay.example.com/api/v1', '自定义 API 地址也迁移（不会被默认地址覆盖）');

    // 落盘（主进程迁移后就是这么做的），再读一次：已是新结构，不应重复迁移
    store.saveSettings(settingsFile, s);
    const again = store.loadSettings(settingsFile, cfg);
    check(again.migrated === false, '已是新结构时不再迁移');
    check(again.settings.modelGroups.length === 0, '重启后依然没有自动带出的系列');
    check(again.settings.sourceConfig['qwen.official'].apiKey === 'sk-legacy', '密钥仍然在');
  }

  console.log('\n[16] 模型解析（resolveModel：协议 / 密钥 / 地址 / 隐藏系列；无 mode）');
  {
    const cfg = modelSeriesLib.load(path.join(TMP, 'model-series.json'));
    const settings = {
      defaultModelId: 'm_q',
      sourceConfig: {
        'qwen.official': { apiKey: 'sk-qwen', baseUrl: '' },
        'gpt-image.grsai': { apiKey: 'sk-grsai', baseUrl: 'http://127.0.0.1:9/custom' }
      },
      modelGroups: [
        { seriesId: 'qwen', models: [{ id: 'm_q', name: 'qwen-image-3.0-pro', sourceId: 'official' }] },
        { seriesId: 'gpt-image', models: [{ id: 'm_g', name: 'gpt-image-2', sourceId: 'grsai' }] },
        { seriesId: 'doubao-seedream', models: [{ id: 'm_s', name: 'doubao-seedream-5-0-pro-260628', sourceId: 'newapi' }] }
      ]
    };
    const q = modelSeriesLib.resolveModel(settings, cfg, 'm_q');
    check(q.protocol === 'dashscope-multimodal' && q.apiKey === 'sk-qwen', 'qwen 模型：协议 + 密钥正确');
    check(q.baseUrl === 'https://dashscope.aliyuncs.com/api/v1', '未覆盖时使用 json 里的默认地址');
    check(q.mode === undefined && q.supportsAsync === undefined, 'resolveModel 不再返回 mode / supportsAsync（只有同步）');

    const g = modelSeriesLib.resolveModel(settings, cfg, 'm_g');
    check(g.protocol === 'grsai-image', 'gpt-image 模型：绑定到 Grsai 协议');
    check(g.baseUrl === 'http://127.0.0.1:9/custom', '自定义地址覆盖内置默认');

    const s = modelSeriesLib.resolveModel(settings, cfg, 'm_s');
    check(s.protocol === 'newapi-images' && s.baseUrl === 'https://toprouter.sealoshzh.site/v1', 'seedream·New Api 来源解析正确');

    check(modelSeriesLib.resolveModel(settings, cfg, 'nope') !== null, '未知 id 回退到默认模型');
    check(modelSeriesLib.resolveModel({ modelGroups: [] }, cfg, 'x') === null, '没有任何模型时返回 null');
  }

  console.log('\n[17] 重命名模型（DeepSeek Responses API：首条文字 → 会话标签）');
  {
    const base = `http://127.0.0.1:${PORT}`;
    const cfgFile = path.join(TMP, 'rename-model.json');
    const cfg = renameModel.load(cfgFile);
    check(fs.existsSync(cfgFile), '配置会落地到数据目录（rename-model.json）');
    check(cfg.temperature === 0.5 && cfg.topP === 0.5, '默认温度 0.5 / Top-P 0.5（存在配置 json 里）');
    check(/5 或 6 个汉字/.test(cfg.promptTemplate) && /\{\$\$\}/.test(cfg.promptTemplate), '内置提示模板含「5 或 6 个汉字」规则与 $$ 占位符');
    check(cfg.baseUrl === 'https://api.deepseek.com' && cfg.modelId === 'deepseek-flash', '默认 API 地址 / 默认模型同样来自配置 json');

    // 未配置 Key：不发起请求，直接回 NO_API_KEY（渲染进程会用首条文字）
    const noKey = await renameModel.generateTitle({ renameModel: { apiKey: '' } }, '一张猫的图', cfg);
    check(noKey.ok === false && noKey.code === 'NO_API_KEY', '未配置 API Key 时返回 NO_API_KEY');

    const empty = await renameModel.generateTitle({ renameModel: { apiKey: 'sk-ds' } }, '   ', cfg);
    check(empty.ok === false && empty.code === 'EMPTY_INPUT', '空文字不发起请求');

    const local = { ...cfg, baseUrl: base };
    const r = await renameModel.generateTitle({ renameModel: { apiKey: 'sk-ds' } }, '帮我把这张照片改成赛博朋克城市夜景', local);
    check(r.ok === true && r.name === '智能客服提效', '从 output[].content[].output_text 里解析 {"title":…}（跳过 reasoning item）');

    const req = lastTo('/responses');
    check(!!req && req.body.model === 'deepseek-flash', '模型 id 留空 → 用配置里的默认 deepseek-flash');
    check(!!req && req.body.stream === false, 'stream=false（一次性返回）');
    check(!!req && req.body.reasoning && req.body.reasoning.effort === 'none', 'reasoning.effort = none（非思考模式）');
    check(!!req && req.body.temperature === 0.5 && req.body.top_p === 0.5, 'temperature / top_p 来自配置 json（0.5 / 0.5）');
    check(!!req && req.body.text && req.body.text.format && req.body.text.format.type === 'json_object', '要求 json_object 输出');
    check(!!req && req.body.input === '{"text":"帮我把这张照片改成赛博朋克城市夜景"}', 'input 为 {"text":"…"} 形式');
    check(!!req && req.body.instructions.includes('"text":"帮我把这张照片改成赛博朋克城市夜景"'), '模板里的 $$ 被替换为实际 text 片段');
    check(!!req && /你是一个标题生成助手/.test(req.body.instructions), '模型收到的是内置提示模板');
    check(!!req && req.body.messages === undefined, '不是 chat/completions 格式（没有 messages 字段）');
    check(!!req && req.headers.authorization === 'Bearer sk-ds', 'Authorization: Bearer 头正确');

    // 设置里的地址 / 模型 id 覆盖配置里的默认值；地址已含 /responses 时不重复拼接
    const r2 = await renameModel.generateTitle(
      { renameModel: { apiKey: 'sk-ds', baseUrl: `${base}/responses`, modelId: 'raw-rename' } },
      '给猫换宇航服', cfg
    );
    check(r2.ok === true && r2.name === '赛博朋克城市夜景', '非 JSON 输出按纯文本兜底并清洗引号 / 句号');
    const req2 = lastTo('/responses');
    check(!!req2 && req2.body.model === 'raw-rename', '设置里的模型 id 覆盖配置默认值');

    const err = await renameModel.generateTitle({ renameModel: { apiKey: 'sk-bad', modelId: 'err-rename' } }, '任意文字', local);
    check(err.ok === false && err.code === 'authentication_error', 'HTTP 错误码透传（401）');
    check(/Authentication Fails/.test(err.message), 'HTTP 错误信息透传');

    const emptyTitle = await renameModel.generateTitle({ renameModel: { apiKey: 'sk-ds', modelId: 'empty-rename' } }, '任意文字', local);
    check(emptyTitle.ok === false && emptyTitle.code === 'EMPTY_TITLE', '没有 message item 时返回 EMPTY_TITLE');

    // 模板渲染 / 标题清洗 / JSON 解析
    check(renameModel.renderTemplate('A\n{$$}', '你好') === 'A\n{"text":"你好"}', '$$ 渲染成 JSON 片段（模板写作 {$$}）');
    check(renameModel.renderTemplate('没有占位符', '你好').includes('{"text":"你好"}'), '模板缺占位符时自动补上输入 JSON');
    check(renameModel.pickTitle('{"title":"智能客服提效"}') === '智能客服提效', '解析 {"title":…}');
    check(renameModel.pickTitle('{"title":"甲","extra":1}') === '甲', '忽略多余字段');
    check(renameModel.pickTitle('就是一句普通的话') === '就是一句普通的话', '非 JSON 时按纯文本用');
    check(renameModel.sanitizeTitle('“赛博朋克城市夜景”。') === '赛博朋克城市夜景', '去掉引号与结尾句号');
    check(renameModel.sanitizeTitle('标题：给猫换宇航服') === '给猫换宇航服', '去掉「标题：」前缀');
    check(Array.from(renameModel.sanitizeTitle('一'.repeat(40))).length === renameModel.MAX_TITLE_CHARS, '超长标题截到上限');
    check(renameModel.sanitizeTitle('有\n换行\t的标题') === '有 换行 的标题', '换行/制表符压缩为空格');

    // 配置文件：可手工编辑，非法值回退内置默认
    renameModel.save(cfgFile, { ...cfg, temperature: 9, topP: 2, promptTemplate: '   ' });
    const saved = renameModel.load(cfgFile);
    check(saved.temperature === 2 && saved.topP === 1, '超范围数值被夹到区间内（温度 0~2 / Top-P 0~1）');
    check(saved.promptTemplate === cfg.promptTemplate, '模板被改空时回退内置默认模板');
    const manual = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    check(manual.promptTemplate.length > 100 && manual.temperature === 2, '手工编辑后的整份配置写回 json');
    const back = renameModel.save(cfgFile, { ...manual, temperature: 0.5, topP: 0.5 });
    check(back.temperature === 0.5 && back.topP === 0.5 && back.promptTemplate === manual.promptTemplate, '滑动条只改数值时不动模板');
  }

  console.log('\n[18] 设置里的重命名模型字段（settings.json 规整）');
  {
    const cfg = modelSeriesLib.load(path.join(TMP, 'model-series.json'));
    const f = path.join(TMP, 'settings-rename.json');
    fs.writeFileSync(f, JSON.stringify({ theme: 'dark' }), 'utf8');   // 老数据：没有 renameModel
    const r = store.loadSettings(f, cfg);
    check(r.settings.renameModel && r.settings.renameModel.apiKey === '' && r.settings.renameModel.baseUrl === '', '缺失时补空字段（= 使用配置 json 里的默认值）');

    fs.writeFileSync(f, JSON.stringify({ renameModel: { apiKey: 'sk-x', baseUrl: ' https://my-relay.example.com ', modelId: 123 } }), 'utf8');
    const r2 = store.loadSettings(f, cfg);
    check(r2.settings.renameModel.baseUrl === 'https://my-relay.example.com', 'API 地址去首尾空白');
    check(r2.settings.renameModel.modelId === '123', '模型 id 统一成字符串');
  }

  console.log('\n[19] 图片提示词元数据（PNG / JPEG / WebP 写入 ↔ 读取，含输入图文件名 picN）');
  {
    // 格式识别
    check(promptMeta.detectFormat(PNG) === 'png', '识别 PNG');
    check(promptMeta.detectFormat(JPEG) === 'jpeg', '识别 JPEG');
    check(promptMeta.detectFormat(WEBP) === 'webp', '识别 WebP');
    check(promptMeta.detectFormat(GIF) === 'gif' && promptMeta.formatSupport('gif') === false, 'GIF 可识别但不支持元数据（不静默转换）');
    check(promptMeta.buildRecord('猫') === '{"prompt":"猫","v":1}', '结构化记录形如 {"prompt":"…"}');
    check(promptMeta.buildRecord('猫', ['a.png', 'b.jpg']) === '{"pic1":"a.png","pic2":"b.jpg","prompt":"猫","v":1}',
      '带输入图时记录形如 {"pic1":"…","pic2":"…","prompt":"…"}（pic 在 prompt 之前）');
    check(promptMeta.buildRecord('', ['']) === '{"pic1":"","prompt":"","v":1}', '读不到输入图文件名时 pic 项仍在（值为空串）');
    check(promptMeta.crc32(Buffer.from('123456789')) === 0xcbf43926, 'CRC32 正确（PNG 分块校验）');

    // 三格式：中文 / 多行 / 引号 / 反斜杠 / emoji 完整往返（并带上输入图文件名 pic1/pic2）
    const PICS = ['参考 图1.png', ''];
    for (const [name, buf] of [['PNG', PNG], ['JPEG', JPEG], ['WebP', WEBP]]) {
      const w = promptMeta.writePromptToBuffer(buf, PROMPT_SPECIAL, PICS);
      check(w.ok === true, `${name}：写入元数据成功`);
      check(w.ok && w.buffer.length > buf.length, `${name}：以插入分块的方式追加（原图字节未被重编码）`);
      const r = promptMeta.extractPromptFromBuffer(w.buffer);
      check(r.ok === true && r.prompt === PROMPT_SPECIAL, `${name}：中文 / 换行 / 引号 / 反斜杠 / emoji 完整往返`);
      check(r.ok === true && r.pics.join('|') === '参考 图1.png|', `${name}：输入图文件名按位置往返（读不到的位置是空串，不缺项）`);
      // 重写：替换自己写过的记录，不重复堆积分块
      const w2 = promptMeta.writePromptToBuffer(w.buffer, '改写后的提示词', ['only.png']);
      const r2 = promptMeta.extractPromptFromBuffer(w2.buffer);
      check(w2.ok === true && r2.prompt === '改写后的提示词' && r2.pics.join('|') === 'only.png', `${name}：重写记录后被读回的是新值（替换而非叠加）`);
      if (name === 'PNG') {
        const dim = require(path.join(ROOT, 'electron/src/imageutil')).sniffDimensions(w.buffer);
        check(dim.width === 16 && dim.height === 16, 'PNG：分辨率不变（像素未重编码）');
        const chunks = [];
        let off = 8;
        while (off + 8 <= w.buffer.length) {
          const len = w.buffer.readUInt32BE(off);
          chunks.push(w.buffer.toString('ascii', off + 4, off + 8));
          off += 12 + len;
        }
        check(chunks.join(',') === 'IHDR,iTXt,iTXt,IDAT,IEND', 'PNG：iTXt 紧随 IHDR，IDAT/IEND 原样保留');
        check(w.buffer.toString('ascii', 0, 8) === PNG.toString('ascii', 0, 8), 'PNG：文件头保持');
        check(w.buffer.toString('utf8').includes('{"pic1":'), 'PNG：结构化 JSON 记录里带 pic1 键');
        check(w2.buffer.toString('utf8').split('iTXt').length - 1 === 2, 'PNG：重写后仍是 2 个记录分块（不叠加）');
      }
      if (name === 'JPEG') {
        check(w.buffer[0] === 0xff && w.buffer[1] === 0xd8, 'JPEG：仍以 SOI 开头');
        check(w.buffer.toString('latin1').includes('adobe:ns:meta'), 'JPEG：写入标准 XMP（APP1）元数据包');
        check(w.buffer.toString('latin1').includes('APP1') === false, 'JPEG：未追加非标准文本到文件末尾');
        check(w2.buffer.toString('utf8').split('adobe:ns:meta').length - 1 === 1, 'JPEG：重写后只有一段自有 XMP（不叠加）');
      }
      if (name === 'WebP') {
        check(w.buffer.toString('ascii', 0, 4) === 'RIFF' && w.buffer.toString('ascii', 8, 12) === 'WEBP', 'WebP：仍是 RIFF/WEBP 容器');
        check(w.buffer.toString('latin1').includes('XMP '), 'WebP：写入 XMP 分块');
        check(w.buffer.readUInt32LE(4) === w.buffer.length - 8, 'WebP：RIFF 总长度已修正');
        check(w2.buffer.toString('latin1').split('XMP ').length - 1 === 1, 'WebP：重写后只有一个 XMP 分块（不叠加）');
      }
    }

    // 边界与异常
    const noMeta = promptMeta.extractPromptFromBuffer(PNG);
    check(noMeta.ok === true && noMeta.prompt === null, '普通图片：可解析但无提示词（安静返回 null）');
    check(noMeta.ok === true && Array.isArray(noMeta.pics) && noMeta.pics.length === 0, '普通图片：也没有 pic 项（空数组）');
    const empty = promptMeta.writePromptToBuffer(PNG, '   ');
    check(empty.ok === false && empty.code === 'EMPTY_PROMPT', '空提示词（且无输入图）不写入');
    const picOnly = promptMeta.writePromptToBuffer(PNG, '', ['仅图.png']);
    check(picOnly.ok === true, '只带输入图、没有文字时仍写入');
    const picOnlyRead = promptMeta.extractPromptFromBuffer(picOnly.buffer);
    check(picOnlyRead.prompt === null && picOnlyRead.pics.join('|') === '仅图.png', '…记录为 {"pic1":"仅图.png","prompt":""}（有 pic 项、提示词为空）');
    check(promptMeta.sanitizePics(['C:\\Users\\me\\桌 面.png', 123, null]).join('|') === '桌 面.png||',
      '文件名只留文件名本身（去掉路径），非字符串 / 空值位置保留空串');
    check(promptMeta.mergeMeta({ ok: true, prompt: '图片自带', pics: ['图片自带.png'] }, { prompt: '兜底', pics: ['兜底.png'] }).prompt === '图片自带' &&
      promptMeta.mergeMeta({ ok: true, prompt: '图片自带', pics: [] }, { prompt: '兜底', pics: ['兜底.png'] }).pics.join('|') === '兜底.png',
      '合并规则：图片自带值优先，只补缺失的那一项');

    // 重写只动「自己写过的分块」，别家工具的元数据（如 ComfyUI 的 tEXt keyword=prompt）必须原样保留
    {
      const pngChunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const t = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(promptMeta.crc32(Buffer.concat([t, data])), 0);
        return Buffer.concat([len, t, data, crc]);
      };
      const foreign = Buffer.concat([
        PNG.slice(0, 8), PNG.slice(8, 33),                       // 签名 + IHDR
        pngChunk('tEXt', Buffer.concat([Buffer.from('prompt', 'latin1'), Buffer.from([0]), Buffer.from('{"3":{"class_type":"KSampler"}}', 'latin1')])),
        pngChunk('iTXt', Buffer.concat([
          Buffer.from('Comment', 'latin1'), Buffer.from([0]), Buffer.from([0]), Buffer.from([0]),
          Buffer.from([0]), Buffer.from([0]), Buffer.from('made by another tool', 'utf8')
        ])),
        PNG.slice(33)                                            // IDAT + IEND
      ]);
      const fw = promptMeta.writePromptToBuffer(foreign, '我们的提示词', ['输入图.png']);
      const ft = fw.buffer.toString('utf8');
      check(fw.ok && ft.includes('KSampler') && ft.includes('made by another tool'),
        '写入时不误删别家元数据（ComfyUI 的 tEXt keyword=prompt / 其它 iTXt 原样保留）');
      const fw2 = promptMeta.writePromptToBuffer(fw.buffer, '第二版', ['b.png']);
      const ft2 = fw2.buffer.toString('utf8');
      check(ft2.includes('KSampler') && ft2.split('{"pic1"').length - 1 === 1,
        '二次写入：别家元数据仍在，自己的结构化记录仍只有一份');
      const onlyForeign = Buffer.concat([
        PNG.slice(0, 8), PNG.slice(8, 33),
        pngChunk('iTXt', Buffer.concat([
          Buffer.from('prompt', 'latin1'), Buffer.from([0]), Buffer.from([0]), Buffer.from([0]),
          Buffer.from([0]), Buffer.from([0]), Buffer.from('别家写的纯文本提示词', 'utf8')
        ])),
        PNG.slice(33)
      ]);
      const ofr = promptMeta.extractPromptFromBuffer(onlyForeign);
      check(ofr.ok && ofr.prompt === '别家写的纯文本提示词' && ofr.pics.length === 0, '没有结构化记录时退回原文分块（别的工具写的提示词仍能读）');
    }
    const gifW = promptMeta.writePromptToBuffer(GIF, 'x');
    check(gifW.ok === false && gifW.code === 'FORMAT_UNSUPPORTED', 'GIF 写入返回 FORMAT_UNSUPPORTED（界面据此提示）');
    const gifR = promptMeta.extractPromptFromBuffer(GIF);
    check(gifR.ok === false && gifR.code === 'FORMAT_UNSUPPORTED', 'GIF 读取同样区分「不支持」而非「未找到」');
    const junk = promptMeta.extractPromptFromBuffer(Buffer.from('not an image at all'));
    check(junk.ok === false && junk.code === 'FORMAT_UNKNOWN', '非图片字节返回 FORMAT_UNKNOWN');
    const truncated = promptMeta.extractPromptFromBuffer(PNG.slice(0, 30));
    check(truncated.ok === false && truncated.code === 'CORRUPT', '截断的 PNG 返回 CORRUPT（不抛异常）');
    const quote = '引号"与\'单引号\' 换行\n制表\t & <tag> \\ 结束';
    const qr = promptMeta.extractPromptFromBuffer(promptMeta.writePromptToBuffer(PNG, quote).buffer);
    check(qr.ok && qr.prompt === quote, 'XML 特殊字符（& < > " \\）转义后完整还原');
    const html = '<img src=x onerror=alert(1)> 提示词';
    check(promptMeta.extractPromptFromBuffer(promptMeta.writePromptToBuffer(PNG, html).buffer).prompt === html, 'HTML 片段按纯文本往返（不会被当代码执行）');
    const long = '长'.repeat(40000);
    check(promptMeta.extractPromptFromBuffer(promptMeta.writePromptToBuffer(PNG, long).buffer).prompt === long, '超长提示词（4 万字）不被截断');
  }

  console.log('\n[20] 生成结果落盘即带提示词 + 输入图文件名 + 导出携带 + 并发不串词');
  {
    const PROMPT_A = 'A 的提示词：猫 ' + '喵'.repeat(20) + ' 🎨';
    const PROMPT_B = 'B 的提示词：狗\n第二行 "带引号" \\反斜杠\\';
    const INPUT_URL = `data:image/png;base64,${PNG.toString('base64')}`;
    // 并发生成（两个 job 同时跑）：提示词必须各归各的图片
    const [a, b] = await Promise.all([
      runScenario('meta_a', { prompt: PROMPT_A, model: 'meta-model-a' }),
      runScenario('meta_b', { prompt: PROMPT_B, model: 'meta-model-b' })
    ]);
    check(a.term && a.term.type === 'result' && a.term.images.length === 2, 'A：并发生成成功（两张图）');
    check(b.term && b.term.type === 'result' && b.term.images.length === 2, 'B：并发生成成功（两张图）');

    // 每个 job 的提示词只写进自己那批图片
    const aImg = promptMeta.extractPromptFromFile(path.join(CACHE, a.term.images[0].file));
    const aImg2 = promptMeta.extractPromptFromFile(path.join(CACHE, a.term.images[1].file));
    const bImg = promptMeta.extractPromptFromFile(path.join(CACHE, b.term.images[0].file));
    check(aImg.ok && aImg.prompt === PROMPT_A, 'A 的图片读回 A 的提示词（中文 + emoji 完整）');
    check(aImg2.ok && aImg2.prompt === PROMPT_A, 'A 的第二张图同样带提示词');
    check(bImg.ok && bImg.prompt === PROMPT_B, '并发生成时 B 的图片仍是 B 的提示词（不串词）');
    check(aImg.bytes === fs.statSync(path.join(CACHE, a.term.images[0].file)).size, '生成结果以正常图片尺寸落盘');
    check(aImg.pics.length === 0 && !fs.readFileSync(path.join(CACHE, a.term.images[0].file), 'utf8').includes('"pic1"'),
      '纯文生图：记录里不出现任何 pic 项（仍是 {"prompt":"…","v":1}）');

    // 图生图：结果图要带上「用户一起发送的输入图文件名」，顺序与图片一致
    const { term: it2 } = await runScenario('meta_input', {
      prompt: '以这张图为参考', model: 'meta-model-a',
      images: [INPUT_URL, INPUT_URL], imageNames: ['用户桌面图.png', '']
    });
    check(it2 && it2.type === 'result' && it2.images.length === 2, '图生图：正常出图（两张图）');
    const i1 = promptMeta.extractPromptFromFile(path.join(CACHE, it2.images[0].file));
    const i2 = promptMeta.extractPromptFromFile(path.join(CACHE, it2.images[1].file));
    check(i1.ok && i1.prompt === '以这张图为参考' && i1.pics.join('|') === '用户桌面图.png|',
      '图生图：pic1 = 用户文件名，读不到名字的位置是空串（pic 项仍在）');
    check(i2.ok && i2.pics.join('|') === '用户桌面图.png|', '同一批的每张结果图都带同一组 pic 项');
    check(fs.readFileSync(path.join(CACHE, it2.images[0].file), 'utf8').includes('{"pic1":"用户桌面图.png","pic2":"","prompt":"以这张图为参考","v":1}'),
      '记录 JSON 形如 {"pic1":"…","pic2":"","prompt":"…","v":1}');
    // 渲染进程没传名字（老版本 / 直接粘贴）：pic 项要在，值为空
    const { term: it4 } = await runScenario('meta_input_noname', {
      prompt: '没有名字的输入图', model: 'meta-model-a', images: [INPUT_URL, INPUT_URL]
    });
    const i4 = promptMeta.extractPromptFromFile(path.join(CACHE, it4.images[0].file));
    check(i4.ok && i4.pics.join('|') === '|', '读不到任何输入图名字时：pic 项齐全但值为空串');

    // 原型场景（用户口径）：拖入一张「图片.png」+ 提示词「改为黑白」
    const { term: demo } = await runScenario('meta_demo', {
      prompt: '改为黑白', model: 'meta-model-a', images: [INPUT_URL], imageNames: ['图片.png']
    });
    const demoMeta = promptMeta.extractPromptFromFile(path.join(CACHE, demo.images[0].file));
    check(demoMeta.prompt === '改为黑白' && demoMeta.pics.join('|') === '图片.png',
      '原型场景：输入图 + 「改为黑白」→ 结果图记录 {"pic1":"图片.png","prompt":"改为黑白"}');
    // 多张输入图：pic1 / pic2 / pic3 按发送顺序一一对应（输入框上限 3 张）
    const { term: three } = await runScenario('meta_three', {
      prompt: '三图合成', model: 'meta-model-a',
      images: [INPUT_URL, INPUT_URL, INPUT_URL], imageNames: ['a.png', '', 'c.png']
    });
    const threeMeta = promptMeta.extractPromptFromFile(path.join(CACHE, three.images[0].file));
    check(threeMeta.pics.join('|') === 'a.png||c.png',
      '多张输入图：pic1/pic2/pic3 与发送顺序一致（读不到名字的那张留空串）');
    // 只传图不打字：仍要记下「带过输入图」
    const { term: it3 } = await runScenario('meta_no_text_input', { prompt: '', model: 'meta-model-a', images: [INPUT_URL], imageNames: ['只有图.png'] });
    const i3 = promptMeta.extractPromptFromFile(path.join(CACHE, it3.images[0].file));
    check(i3.ok && i3.prompt === null && i3.pics.join('|') === '只有图.png',
      '只发图不打字：记录 {"pic1":"只有图.png","prompt":""}（提示词为空但 pic 项照写）');

    // 导出：与 result:download 同一条代码路径（lib/exportResultImage）
    const expDir = path.join(TMP, 'downloads');
    const exp = exportLib.exportResultImage({
      srcPath: path.join(CACHE, a.term.images[0].file),
      destDir: expDir,
      fallbackPrompt: '会话里记录的提示词'
    });
    check(exp.ok === true && fs.existsSync(exp.path), '导出结果图成功');
    const exported = promptMeta.extractPromptFromFile(exp.path);
    check(exported.ok && exported.prompt === PROMPT_A, '导出文件带着提示词元数据（用户保存的图片可被再次拖入解析）');
    check(path.basename(exp.path) === path.basename(a.term.images[0].file), '导出沿用原文件名（元数据可直接透传）');

    // 保存：源图自带 pic 项 → 原样带走；兜底值不得覆盖已有值
    const expInput = exportLib.exportResultImage({
      srcPath: path.join(CACHE, it2.images[0].file),
      destDir: expDir,
      fallbackPrompt: '不该生效的提示词',
      fallbackPics: ['不该生效.png']
    });
    const expInputMeta = promptMeta.extractPromptFromFile(expInput.path);
    check(expInputMeta.prompt === '以这张图为参考' && expInputMeta.pics.join('|') === '用户桌面图.png|',
      '保存图生图结果：图片自带的提示词与 pic 项优先（不被兜底值覆盖）');

    // 旧版本生成的图（只有提示词、没有 picN）：保存 / 另存为时用会话记录里的输入图名补齐
    const legacyPic = path.join(TMP, 'legacy-pics.png');
    fs.writeFileSync(legacyPic, promptMeta.writePromptToBuffer(PNG, '旧版本写的提示词').buffer);
    const expPic = exportLib.exportResultImage({
      srcPath: legacyPic, destDir: expDir,
      fallbackPrompt: '旧版本写的提示词', fallbackPics: ['来自会话.png', '']
    });
    const expPicMeta = promptMeta.extractPromptFromFile(expPic.path);
    check(expPic.ok === true && expPic.promptApplied === true, '旧图缺 pic 项：导出时补写（重写元数据）');
    check(expPicMeta.prompt === '旧版本写的提示词' && expPicMeta.pics.join('|') === '来自会话.png|',
      '补写后：提示词仍是图片自带的那个，pic 项来自会话记录');
    check(fs.readFileSync(legacyPic).length === promptMeta.writePromptToBuffer(PNG, '旧版本写的提示词').buffer.length, '补写只在导出文件上生效，源文件不被修改');

    const asPic = path.join(TMP, 'as-pics.png');
    const asRes = exportLib.exportResultImageAs({
      srcPath: legacyPic, destPath: asPic,
      fallbackPrompt: '旧版本写的提示词', fallbackPics: ['来自会话.png', '']
    });
    check(asRes.ok === true && asRes.promptApplied === true, '另存为同样补写 pic 项');
    check(promptMeta.extractPromptFromFile(asPic).pics.join('|') === '来自会话.png|', '另存为的文件读回 pic1 = 来自会话.png');
    const reSave = exportLib.exportResultImageAs({ srcPath: asPic, destPath: path.join(TMP, 'as-pics-2.png'), fallbackPics: ['来自会话.png', ''] });
    check(reSave.ok === true && reSave.promptApplied === false, '已带齐元数据的图再另存：原字节透传，不重复写');

    // 旧缓存图（元数据丢失）：用会话里记录的提示词补写
    const legacy = path.join(TMP, 'legacy.png');
    fs.writeFileSync(legacy, PNG);
    const exp2 = exportLib.exportResultImage({ srcPath: legacy, destDir: expDir, fallbackPrompt: '来自会话的旧提示词' });
    check(promptMeta.extractPromptFromFile(exp2.path).prompt === '来自会话的旧提示词', '旧图缺元数据时用会话记录补写');
    check(fs.readFileSync(legacy).length === PNG.length, '源文件不被修改');

    // 不支持的格式：保留原图，不静默转换
    const legacyGif = path.join(TMP, 'legacy.gif');
    fs.writeFileSync(legacyGif, GIF);
    const exp3 = exportLib.exportResultImage({ srcPath: legacyGif, destDir: expDir, fallbackPrompt: 'GIF 提示词' });
    check(exp3.ok === true && exp3.promptApplied === false, 'GIF 导出：带不过去元数据但保留图片');
    check(promptMeta.extractPromptFromBuffer(fs.readFileSync(exp3.path)).code === 'FORMAT_UNSUPPORTED', 'GIF 仍可被识别为「不支持读写元数据」');

    // 元数据来源：JPEG / WebP 结果同样闭环
    const { term: jt } = await runScenario('meta_jpg', { prompt: 'JPEG 结果提示词\n第二行', model: 'jpg-model', images: [INPUT_URL], imageNames: ['参考图.jpg'] });
    check(jt && jt.images.length === 2, 'JPEG 结果图生成成功');
    const jr = promptMeta.extractPromptFromFile(path.join(CACHE, jt.images[0].file));
    check(jr.ok && jr.prompt === 'JPEG 结果提示词\n第二行' && jr.format === 'jpeg', 'JPEG 结果图带提示词元数据');
    check(jr.pics.join('|') === '参考图.jpg', 'JPEG 结果图同时带 pic1（输入图文件名）');
    const { term: wt } = await runScenario('meta_webp', { prompt: 'WebP 结果提示词 🎨', model: 'webp-model' });
    const wr = promptMeta.extractPromptFromFile(path.join(CACHE, wt.images[0].file));
    check(wr.ok && wr.prompt === 'WebP 结果提示词 🎨' && wr.format === 'webp', 'WebP 结果图带提示词元数据');

    // 无文字的图生图：不写空提示词
    const { term: it } = await runScenario('meta_no_text', { prompt: '', model: 'meta-model-a' });
    check(it && it.images.length === 2, '无文字请求仍正常出图');
    const ir = promptMeta.extractPromptFromFile(path.join(CACHE, it.images[0].file));
    check(ir.ok && ir.prompt === null, '没有提示词时不写空元数据');

    // 已有提示词的图片不被覆盖
    const keep = promptMeta.applyPromptToFile(path.join(CACHE, b.term.images[0].file), '试图覆盖');
    check(keep.ok === true && keep.skipped === true, '已有提示词的图片不被二次覆盖');
    check(promptMeta.extractPromptFromFile(path.join(CACHE, b.term.images[0].file)).prompt === PROMPT_B, '原提示词保持不变');
  }

  console.log('\n[21] 保存 / 另存为的兜底来源：从会话记录取「提示词 + 输入图文件名」');
  {
    const convMeta = require(path.join(ROOT, 'electron/src/conversationMeta'));
    const convs = {
      conversations: [
        {
          id: 'c1',
          messages: [
            // 图生图：两张输入图，第二张读不到名字（剪贴板粘贴）
            {
              id: 'u1', role: 'user', text: '把它变成赛博朋克风格',
              images: [
                { file: 'up_a.png', name: 'a.png', srcName: '街景.png' },
                { file: 'up_b.png', name: 'image.png', srcName: '' }
              ]
            },
            { id: 'a1', role: 'assistant', parentId: 'u1', images: [{ file: 'result_1.png' }] },
            // 纯文生图：没有输入图 → 不应产生 pic 项
            { id: 'u2', role: 'user', text: '一只坐在窗台上的猫', images: [] },
            { id: 'a2', role: 'assistant', parentId: 'u2', images: [{ file: 'result_2.png' }] },
            // 老数据：用户消息里有图但没记 srcName → 位置保留、值为空串
            { id: 'u3', role: 'user', text: '老会话里的图生图', images: [{ file: 'up_old.png', name: 'old.png' }] },
            { id: 'a3', role: 'assistant', parentId: 'u3', images: [{ file: 'result_3.png' }] }
          ]
        }
      ]
    };
    const m1 = convMeta.metaFromConversations(convs, 'result_1.png');
    check(m1.prompt === '把它变成赛博朋克风格' && m1.pics.join('|') === '街景.png|',
      '结果图 → 父用户消息的提示词 + 输入图真实文件名（读不到名字的位置是空串）');
    check(m1.pics.length === 2, 'pic 项数量 = 用户发送的图片数量（不做压缩）');
    const m2 = convMeta.metaFromConversations(convs, 'result_2.png');
    check(m2.prompt === '一只坐在窗台上的猫' && m2.pics.length === 0, '纯文生图：兜底值里没有任何 pic 项');
    const m3 = convMeta.metaFromConversations(convs, 'result_3.png');
    check(m3.prompt === '老会话里的图生图' && m3.pics.join('|') === '', '老会话缺 srcName：pic 项仍在，值为空串');
    check(convMeta.metaFromConversations(convs, 'result_missing.png').pics.length === 0, '会话里找不到该图：返回空值（不抛异常）');
    check(convMeta.metaFromConversations(null, 'result_1.png').pics.length === 0, '会话数据缺失：返回空值（不抛异常）');

    // 真实的保存链路：老图 + 会话兜底 → 文件里出现 picN
    const tmpImg = path.join(TMP, 'conv-fallback.png');
    fs.writeFileSync(tmpImg, promptMeta.writePromptToBuffer(PNG, '把它变成赛博朋克风格').buffer);
    const exp = exportLib.exportResultImage({
      srcPath: tmpImg, destDir: path.join(TMP, 'downloads'),
      fallbackPrompt: m1.prompt, fallbackPics: m1.pics
    });
    const back = promptMeta.extractPromptFromBuffer(fs.readFileSync(exp.path));
    check(back.prompt === '把它变成赛博朋克风格' && back.pics.join('|') === '街景.png|',
      '导出后：文件里的记录 = {"pic1":"街景.png","pic2":"","prompt":"…"}');
  }

  console.log('\n[22] 复制到剪贴板的载荷（位图不携带，HTML 里的原图字节携带）');
  {
    const clip = require(path.join(ROOT, 'electron/src/clipboardPayload'));
    const PROMPT_C = '复制用提示词 "带引号" & 符号\n第二行';

    // 纯文本格式：文件名 + 提示词（行为不变）
    check(clip.buildText({ name: 'result.png', prompt: '一只猫' }) === 'result.png\n一只猫', '文本格式 = 文件名 + 提示词');
    check(clip.buildText({ name: 'result.png', prompt: '' }) === 'result.png', '没有提示词时文本格式只留文件名');

    // HTML 格式：内嵌原图字节，并把可读信息放进属性
    const imgBuf = promptMeta.writePromptToBuffer(PNG, PROMPT_C, ['参考图.png', '']).buffer;
    const h1 = clip.buildHtml({ mime: 'image/png', buf: PNG, name: 'result.png', prompt: PROMPT_C, pics: [] });
    check(h1.html.includes('src="data:image/png;base64,'), 'HTML 内嵌原图字节（不是重新编码的位图）');
    check(h1.html.includes('data-filename="result.png"') && h1.html.includes('data-prompt="'), 'HTML 带 data-filename / data-prompt');
    check(h1.html.includes('data-pics=') === false, '纯文生图：HTML 里不出现 data-pics（与 pic 项规则一致）');
    check(h1.html.includes('data-prompt="复制用提示词 &quot;带引号&quot; &amp; 符号&#10;第二行"'),
      '提示词里的引号 / & / 换行被转义（不会破坏 HTML）');

    const h2 = clip.buildHtml({ mime: 'image/jpeg', buf: JPEG, name: 'a"b.jpg', prompt: PROMPT_C, pics: ['参考图.png', ''] });
    check(h2.html.includes('data-pics="[&quot;参考图.png&quot;,&quot;&quot;]"'),
      '图生图：HTML 带 data-pics（JSON 数组，读不到名字的位置是空串）');
    check(h2.html.includes('alt="a&quot;b.jpg"') && h2.html.includes('src="data:image/jpeg;base64,'), '文件名里的引号被转义，MIME 用真实格式');
    const big = clip.buildHtml({ mime: 'image/png', buf: Buffer.alloc(clip.COPY_HTML_MAX_BYTES + 1), name: 'big.png', prompt: '', pics: [] });
    check(big.html === '', '超过大小上限时不带 HTML（位图照常复制）');

    // 复制老图：在内存里补写 pic 项（缓存文件不改），剪贴板里的字节与属性都完整
    const legacyCopy = path.join(TMP, 'copy-legacy.png');
    fs.writeFileSync(legacyCopy, promptMeta.writePromptToBuffer(PNG, '老图提示词').buffer);
    const srcBuf = fs.readFileSync(legacyCopy);
    const patched = exportLib.applyPromptToBuffer(srcBuf, '老图提示词', ['会话里的输入图.png', '']);
    const backCopy = promptMeta.extractPromptFromBuffer(patched);
    check(backCopy.prompt === '老图提示词' && backCopy.pics.join('|') === '会话里的输入图.png|',
      '复制时补写 pic 项：剪贴板里的字节读回 = {"pic1":"会话里的输入图.png","pic2":"","prompt":"老图提示词"}');
    check(fs.readFileSync(legacyCopy).equals(srcBuf), '补写只作用在剪贴板那一份，缓存 / 源文件保持原样');
    const h3 = clip.buildHtml({ mime: 'image/png', buf: patched, name: 'copy-legacy.png', prompt: backCopy.prompt, pics: backCopy.pics });
    check(h3.html.includes('data-pics="[&quot;会话里的输入图.png&quot;,&quot;&quot;]"'),
      '复制老图得到的 HTML：data-pics 与图片字节里的 pic 项一致');
    const inner = /src="data:image\/png;base64,([^"]+)"/.exec(h3.html);
    const innerMeta = inner ? promptMeta.extractPromptFromBuffer(Buffer.from(inner[1], 'base64')) : { ok: false };
    check(innerMeta.ok === true && innerMeta.prompt === '老图提示词' && innerMeta.pics.join('|') === '会话里的输入图.png|',
      'HTML 内嵌的字节本身就带着「提示词 + pic 项」（宿主把图存回文件就能读回）');
    check(patched.length > srcBuf.length && promptMeta.extractPromptFromBuffer(srcBuf).pics.length === 0,
      '补写前后的差异确实来自新增的 pic 项');
  }

  console.log('\n[23] zip 读写（无依赖打包 / 解包，含 ZIP64 与损坏检测）');
  {
    const zipLib = require(path.join(ROOT, 'electron/src/zip'));
    const srcDir = path.join(TMP, 'zip-src');
    fs.mkdirSync(srcDir, { recursive: true });
    const big = Buffer.alloc(300000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) % 251;
    fs.writeFileSync(path.join(srcDir, '大图 结果.bin'), big);
    const text = JSON.stringify({ 中文: '内容 🎨', 说明: '这段文本要足够长，deflate 才会比原样更小'.repeat(20), 行: '第二行' });
    const zipPath = path.join(TMP, 'zip-basic.zip');

    const w = await zipLib.writeZip(zipPath, [
      { name: 'ss-export/manifest.json', data: text },
      { name: 'ss-export/cache/大图 结果.bin', file: path.join(srcDir, '大图 结果.bin') },
      { name: 'ss-export/empty.txt', data: '' }
    ], { now: new Date(2026, 1, 13, 15, 30, 0) });
    check(w.entries === 3 && w.bytes > 0, 'writeZip 写入 3 个条目');
    const list = await zipLib.listZip(zipPath);
    check(list.length === 3 && list.map((e) => e.rel).join('|') === 'ss-export/manifest.json|ss-export/cache/大图 结果.bin|ss-export/empty.txt',
      'listZip 按中央目录列出条目（UTF-8 中文名 + 空格正确）');
    check(list[0].method === zipLib.METHOD_DEFLATE && list[1].method === zipLib.METHOD_STORE,
      '文本走 DEFLATE、已压缩的大文件走 STORE');
    check((await zipLib.readEntryText(zipPath, 'ss-export/manifest.json')) === text, '文本条目往返一致');
    const outDir = path.join(TMP, 'zip-out');
    const ex = await zipLib.extractAll(zipPath, outDir);
    check(ex.files.length === 3, 'extractAll 解出全部条目');
    check(fs.readFileSync(path.join(outDir, 'ss-export/cache/大图 结果.bin')).equals(big), '大文件字节完全一致（STORE + CRC 校验）');
    check(fs.readFileSync(path.join(outDir, 'ss-export/empty.txt')).length === 0, '空条目解出空文件');

    // ZIP64（强制分支：本地头 / 中央目录 / 结尾记录都走 64 位字段）
    const z64 = path.join(TMP, 'zip-64.zip');
    await zipLib.writeZip(z64, [{ name: 'a.txt', data: 'zip64 内容' }, { name: 'b.bin', file: path.join(srcDir, '大图 结果.bin') }], { forceZip64: true });
    const l64 = await zipLib.listZip(z64);
    check(l64.length === 2 && l64[1].size === big.length, 'ZIP64 包能被自己读回（条目大小走 64 位扩展字段）');
    const out64 = path.join(TMP, 'zip-out64');
    await zipLib.extractAll(z64, out64);
    check(fs.readFileSync(path.join(out64, 'b.bin')).equals(big) && fs.readFileSync(path.join(out64, 'a.txt'), 'utf8') === 'zip64 内容',
      'ZIP64 包解压内容正确');

    // 条目名安全（目录穿越 / 盘符 / 反斜杠归一）
    check(zipLib.normalizeEntryName('cache\\a.png') === 'cache/a.png', '反斜杠条目名（Windows 工具产生）归一为 /');
    let badName = false;
    try { zipLib.normalizeEntryName('../evil.txt'); } catch (e) { badName = e.code === 'BAD_NAME'; }
    check(badName, '拒绝向上跳目录的条目名');
    let badDrive = false;
    try { zipLib.normalizeEntryName('C:\\Windows\\x.txt'); } catch (e) { badDrive = e.code === 'BAD_NAME'; }
    check(badDrive, '拒绝绝对路径 / 盘符条目名');

    // 损坏检测：改掉一个数据字节 → CRC 校验必须失败
    const broken = path.join(TMP, 'zip-broken.zip');
    const buf = fs.readFileSync(zipPath);
    const first = await zipLib.listZip(zipPath);
    const target = first[1];
    const dataStart = target.localOffset + 30 + Buffer.from(target.name, 'utf8').length;
    buf[dataStart + 10] ^= 0xff;
    fs.writeFileSync(broken, buf);
    let crcCode = '';
    try { await zipLib.extractAll(broken, path.join(TMP, 'zip-broken-out')); } catch (e) { crcCode = e.code; }
    check(crcCode === 'CRC_MISMATCH', '包体被改坏时解压报 CRC_MISMATCH（不产生脏数据）');

    // 不是 zip 的文件
    const notZip = path.join(TMP, 'not-zip.zip');
    fs.writeFileSync(notZip, '这根本不是 zip');
    let nzCode = '';
    try { await zipLib.listZip(notZip); } catch (e) { nzCode = e.code; }
    check(nzCode === 'BAD_ZIP', '非 zip 文件报 BAD_ZIP');
  }

  console.log('\n[24] 配置 + 聊天记录：导出 / 导入（包名协议 + 目录协议 + 智能合并）');
  {
    const zipLib = require(path.join(ROOT, 'electron/src/zip'));
    const dt = require(path.join(ROOT, 'electron/src/dataTransfer'));
    const seed = JSON.parse(fs.readFileSync(modelSeriesLib.SEED_FILE, 'utf8'));

    // ---- 包名协议 ----
    const at = new Date(2026, 1, 13, 15, 30, 5);
    check(dt.zipNameFor(at) === 'ss-20260213-1530.zip', '导出包名 = ss-YYYYMMDD-HHmm.zip（精确到分钟）');
    check(dt.parseZipName('ss-20260213-1530.zip').ok === true, '合法包名通过校验');
    check(dt.parseZipName('SS-20260213-1530.ZIP').ok === true, '包名校验不区分大小写');
    for (const n of ['backup.zip', 'ss-20260213-1530-1.zip', 'ss-2026-02-13.zip', 'ss-20261399-1530.zip', 'ss-20260213-1530.tar.gz', 'ss-20260213-9999.zip']) {
      check(dt.parseZipName(n).ok === false, `非法包名被拒：${n}`);
    }

    // ---- 导出 ----
    const srcCache = path.join(TMP, 'dt-cache');
    const srcUploads = path.join(TMP, 'dt-uploads');
    fs.mkdirSync(srcCache, { recursive: true });
    fs.mkdirSync(srcUploads, { recursive: true });
    fs.writeFileSync(path.join(srcCache, 'result_1.png'), PNG);
    fs.writeFileSync(path.join(srcUploads, 'up_1.png'), PNG);
    fs.writeFileSync(path.join(srcCache, 'result_unused.png'), PNG);   // 没被任何会话引用 → 不打包

    const convs = {
      version: 1,
      tabCounter: 7,
      activeId: 'c1',
      conversations: [
        {
          id: 'c1', name: '一只猫', nameAuto: false, createdAt: 1000, updatedAt: 2000, dot: 'success',
          messages: [
            {
              id: 'u1', role: 'user', text: '一只猫', createdAt: 1000,
              images: [{ file: 'up_1.png', name: 'up_1.png', srcName: '猫.png', mime: 'image/png' }],
              params: { size: 'auto' },
              model: { id: 'm_import_1', name: 'qwen-image-3.0-pro', seriesId: 'qwen', sourceId: 'official', protocol: 'dashscope-multimodal' }
            },
            { id: 'a1', role: 'assistant', parentId: 'u1', status: 'success', images: [{ file: 'result_1.png', width: 16, height: 16 }], meta: { modelId: 'm_import_1', seriesId: 'qwen' } },
            { id: 'a2', role: 'assistant', parentId: 'u1', status: 'running', images: [], meta: { modelId: 'm_import_1' } }
          ]
        }
      ]
    };
    const settingsA = {
      theme: 'dark',
      defaultSavePath: path.join(TMP, '不存在的保存目录'),
      requestTimeoutSec: 120,
      compressEnabled: false,
      compressMaxMB: 4,
      saveNamePromptChars: 9,
      modelGroups: [
        { seriesId: 'qwen', models: [{ id: 'm_import_1', name: 'qwen-image-3.0-pro', sourceId: 'official' }, { id: 'm_new_1', name: 'qwen-image-max', sourceId: 'official' }] },
        { seriesId: 'my-series', models: [{ id: 'm_custom_1', name: 'my-model-v1', sourceId: 'only' }] }
      ],
      sourceConfig: {
        'qwen.official': { apiKey: 'sk-import', baseUrl: 'https://import.example.com' },
        'gpt-image.grsai': { apiKey: 'sk-grsai', baseUrl: '' }
      },
      defaultModelId: 'm_new_1',
      renameModel: { apiKey: 'sk-rename', baseUrl: '', modelId: 'deepseek-chat' }
    };
    const seriesA = {
      version: 1,
      series: [
        ...seed.series.map((s) => ({ ...s, hidden: s.id === 'qwen' })),
        {
          id: 'my-series', label: '我的自定义系列', protocol: 'newapi-images', builtin: false, hidden: false,
          sources: [{ id: 'only', label: '唯一来源', protocol: 'newapi-images', baseUrl: 'https://my.example.com/v1' }]
        }
      ]
    };
    const renameA = { version: 1, baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-flash', temperature: 0.9, topP: 0.3, promptTemplate: '导入的模板：{$$}' };

    const zipPath = path.join(TMP, dt.zipNameFor(at));
    const exp = await dt.exportData({
      destPath: zipPath, settings: settingsA, conversations: convs, modelSeries: seriesA, renameConfig: renameA,
      paths: { cache: srcCache, uploads: srcUploads }, appVersion: '1.0.0', now: at
    });
    check(exp.ok === true, '导出成功');
    check(exp.images === 2 && exp.missing === 0, '只打包会话引用到的图片（未引用的 result_unused.png 不打包）');
    check(exp.conversations === 1 && exp.messages === 3, '导出计数：会话数 / 消息数');
    const names = (await zipLib.listZip(zipPath)).map((e) => e.rel);
    check(['ss-export/manifest.json', 'ss-export/settings.json', 'ss-export/conversations.json', 'ss-export/model-series.json', 'ss-export/rename-model.json']
      .every((n) => names.includes(n)), '包内四份 json + manifest 齐全');
    check(names.includes('ss-export/cache/result_1.png') && names.includes('ss-export/uploads/up_1.png'), '图片落在 cache/ 与 uploads/ 下');
    check(names.includes('ss-export/cache/result_unused.png') === false, '未被引用的缓存图不进包');
    const manifest = JSON.parse(await zipLib.readEntryText(zipPath, 'ss-export/manifest.json'));
    check(manifest.format === dt.FORMAT && manifest.version === dt.FORMAT_VERSION, 'manifest 记录格式与版本');
    check(manifest.counts.conversations === 1 && manifest.counts.images === 2, 'manifest 记录计数');

    // ---- 包名校验先于解压 ----
    const badNamePath = path.join(TMP, 'backup.zip');
    fs.copyFileSync(zipPath, badNamePath);
    const badName = await dt.importData({ zipPath: badNamePath, paths: { cache: path.join(TMP, 'dt-w1') }, current: {} });
    check(badName.ok === false && badName.code === 'BAD_NAME', '包名不符合格式 → BAD_NAME（在解压之前）');

    // ---- 目录协议校验 ----
    const structZip = path.join(TMP, dt.zipNameFor(new Date(2026, 1, 14, 10, 0)));
    await zipLib.writeZip(structZip, [
      { name: 'ss-export/manifest.json', data: JSON.stringify({ format: dt.FORMAT, version: 1 }) },
      { name: 'ss-export/settings.json', data: '{}' },
      { name: 'ss-export/evil.txt', data: '协议外条目' }
    ]);
    const badStruct = await dt.importData({ zipPath: structZip, paths: { cache: path.join(TMP, 'dt-w2') }, current: {} });
    check(badStruct.ok === false && badStruct.code === 'BAD_STRUCTURE', '包内出现协议外条目 → BAD_STRUCTURE');

    const noManifest = path.join(TMP, dt.zipNameFor(new Date(2026, 1, 14, 10, 1)));
    await zipLib.writeZip(noManifest, [{ name: 'ss-export/settings.json', data: '{}' }]);
    const nm = await dt.importData({ zipPath: noManifest, paths: { cache: path.join(TMP, 'dt-w3') }, current: {} });
    check(nm.ok === false && nm.code === 'BAD_STRUCTURE', '缺少 manifest.json → BAD_STRUCTURE');

    const subDir = path.join(TMP, dt.zipNameFor(new Date(2026, 1, 14, 10, 2)));
    await zipLib.writeZip(subDir, [
      { name: 'ss-export/manifest.json', data: JSON.stringify({ format: dt.FORMAT, version: 1 }) },
      { name: 'ss-export/conversations.json', data: '{"conversations":[]}' },
      { name: 'ss-export/cache/sub/x.png', data: PNG }
    ]);
    const sd = await dt.importData({ zipPath: subDir, paths: { cache: path.join(TMP, 'dt-w4') }, current: {} });
    check(sd.ok === false && sd.code === 'BAD_STRUCTURE', '媒体目录里出现子目录 → BAD_STRUCTURE');

    const newer = path.join(TMP, dt.zipNameFor(new Date(2026, 1, 14, 10, 3)));
    await zipLib.writeZip(newer, [
      { name: 'ss-export/manifest.json', data: JSON.stringify({ format: dt.FORMAT, version: dt.FORMAT_VERSION + 1 }) },
      { name: 'ss-export/settings.json', data: '{}' }
    ]);
    const nv = await dt.importData({ zipPath: newer, paths: { cache: path.join(TMP, 'dt-w5') }, current: {} });
    check(nv.ok === false && nv.code === 'BAD_VERSION', '包格式版本比程序新 → BAD_VERSION');

    const garbage = path.join(TMP, dt.zipNameFor(new Date(2026, 1, 14, 10, 4)));
    fs.writeFileSync(garbage, '这不是 zip');
    const gz = await dt.importData({ zipPath: garbage, paths: { cache: path.join(TMP, 'dt-w6') }, current: {} });
    check(gz.ok === false && gz.code === 'BAD_ZIP', '不是 zip 的包 → BAD_ZIP');

    // ---- 智能合并 ----
    const current = {
      settings: {
        theme: 'light',
        defaultSavePath: path.join(TMP, 'local-downloads'),
        requestTimeoutSec: 300,
        compressEnabled: true,
        compressMaxMB: 10,
        saveNamePromptChars: 5,
        modelGroups: [
          { seriesId: 'qwen', models: [{ id: 'm_q1', name: 'qwen-image-3.0-pro', sourceId: 'official' }, { id: 'm_local', name: 'local-model', sourceId: 'official' }] }
        ],
        sourceConfig: { 'qwen.official': { apiKey: 'sk-local', baseUrl: 'https://local.example.com' } },
        defaultModelId: 'm_q1',
        renameModel: { apiKey: '', baseUrl: '', modelId: '' }
      },
      modelSeries: { version: 1, series: seed.series.map((s) => ({ ...s, hidden: s.id === 'doubao-seedream' })) },
      renameConfig: { version: 1, temperature: 0.5, topP: 0.5, promptTemplate: '本机模板' },
      conversations: {
        version: 1, tabCounter: 2, activeId: 'c_local',
        conversations: [{ id: 'c_local', name: '本机对话', messages: [{ id: 'u_local', role: 'user', text: '本机', createdAt: 10 }] }]
      }
    };
    const target = { cache: path.join(TMP, 'dt-target-cache'), uploads: path.join(TMP, 'dt-target-uploads') };
    const imp = await dt.importData({ zipPath, paths: target, current, dirExists: () => false });
    check(imp.ok === true, '导入成功（包名 + 目录协议都通过）');
    if (imp.ok) {
      const m = imp.merged;
      // 设置：选项类按导入改动
      check(m.settings.theme === 'dark' && m.settings.compressEnabled === false && m.settings.compressMaxMB === 4
        && m.settings.saveNamePromptChars === 9 && m.settings.requestTimeoutSec === 120, '选项类设置按导入的值改动（主题 / 压缩 / 命名 / 超时）');
      check(m.settings.defaultSavePath === current.settings.defaultSavePath, '默认保存路径在本机不存在 → 保留当前值');
      check(m.settings.defaultModelId === 'm_new_1', '导入的默认模型在合并后存在 → 采用它');
      // 模型：查重 + 追加 + 自动新增系列
      const qwen = m.settings.modelGroups.find((g) => g.seriesId === 'qwen');
      check(qwen.models.map((x) => x.id).join('|') === 'm_q1|m_local|m_new_1', '同系列新模型追加在末尾（已有模型保持原样）');
      check(qwen.models.some((x) => x.id === 'm_new_1' && x.name === 'qwen-image-max'), '新模型带着名字被追加');
      check(m.summary.ignoredModels === 1, '同系列同来源同名（不同 id）的模型被查重忽略');
      check(!!m.settings.modelGroups.find((g) => g.seriesId === 'my-series'), '当前没有的模型系列自动新增分组');
      check(m.modelSeries.series.some((s) => s.id === 'my-series' && s.custom === true), '自定义系列定义一起带过来');
      check(m.modelSeries.series.find((s) => s.id === 'doubao-seedream').hidden === true, '合并后依旧没有模型的系列保持隐藏（hidden 不被导入改掉）');
      check(m.modelSeries.series.find((s) => s.id === 'my-series').hidden === false, '自动新增的系列是可见的（hidden=false）');
      // 密钥：只补空缺
      check(m.settings.sourceConfig['qwen.official'].apiKey === 'sk-local', '本机已有的 API Key 不被导入覆盖');
      check(m.settings.sourceConfig['qwen.official'].baseUrl === 'https://local.example.com', '本机已有的 API 地址不被导入覆盖');
      check(m.settings.sourceConfig['gpt-image.grsai'].apiKey === 'sk-grsai', '本机空缺的「系列·来源」密钥由导入补上');
      // renameModel
      check(m.settings.renameModel.apiKey === 'sk-rename' && m.settings.renameModel.modelId === 'deepseek-chat', '重命名模型的非空字段按导入覆盖');
      check(m.renameConfig.temperature === 0.9 && m.renameConfig.topP === 0.3 && m.renameConfig.promptTemplate === '导入的模板：{$$}', 'rename-model.json 按导入的值改动');
      // 会话：追加在最上面 + id 映射 + 中断标记
      const list = m.conversations.conversations;
      check(list[0].id === 'c1' && list[1].id === 'c_local', '导入的聊天记录追加在当前列表最新位置（最上面）');
      check(list[0].name === '一只猫' && list[0].dot === null, '标签名一起带过来，圆点终态清空');
      check(m.summary.remappedModels === 3, '导入会话里的模型引用按 id 映射改指本机同款模型');
      check(list[0].messages[0].model.id === 'm_q1', '用户消息的模型 id 被改写为本机模型 id');
      check(list[0].messages[1].meta.modelId === 'm_q1', '助手消息的 meta.modelId 被改写为本机模型 id');
      check(list[0].messages[2].status === 'error' && list[0].messages[2].error.code === 'INTERRUPTED', '导入时仍 pending/running 的请求标记为被中断');
      check(m.conversations.activeId === 'c_local' && m.conversations.tabCounter === 7, 'activeId 不变，tabCounter 取两者最大值');
      // 图片叠加
      check(imp.media.copied === 2 && fs.readFileSync(path.join(target.cache, 'result_1.png')).equals(PNG), '图片叠加到目标数据目录（不存在则创建）');
      check(fs.existsSync(path.join(target.uploads, 'up_1.png')), '输入图叠加到 uploads/');

      // 再导入同一个包：会话按 id 查重、图片按文件名查重
      const imp2 = await dt.importData({ zipPath, paths: target, current: { ...current, ...m }, dirExists: () => false });
      check(imp2.ok === true && imp2.merged.summary.conversations === 0 && imp2.merged.summary.skippedConversations === 1, '重复导入：会话按 id 查重后不再追加');
      check(imp2.merged.summary.ignoredModels === 3 && imp2.merged.summary.addedModels === 0, '重复导入：模型不再重复追加（全部按 id / 同名查重忽略）');
      check(imp2.media.copied === 0 && imp2.media.skipped === 2, '重复导入：同名图片文件直接忽略（查重）');
    }

    // ---- 纯函数：合并规则可直接断言 ----
    const g = dt.mergeModelGroups(
      [{ seriesId: 'qwen', models: [{ id: 'a', name: 'M1', sourceId: 'official' }] }],
      [
        { seriesId: 'qwen', models: [{ id: 'a', name: 'M1', sourceId: 'official' }, { id: 'b', name: 'm1', sourceId: 'official' }, { id: 'c', name: 'M2', sourceId: 'official' }] },
        { seriesId: '没这个系列', models: [{ id: 'd', name: 'M3', sourceId: 'official' }] }
      ],
      { series: [{ id: 'qwen', protocol: 'dashscope-multimodal', sources: [{ id: 'official', protocol: 'dashscope-multimodal' }] }] }
    );
    check(g.groups[0].models.length === 2 && g.addedModels === 1 && g.ignoredModels === 2, 'mergeModelGroups：同 id 忽略、同系列同来源同名忽略、其余追加');
    check(g.idRemap.get('b') === 'a', 'mergeModelGroups：同名模型的 id 映射到本机 id');
    check(g.skippedSeries.join() === '没这个系列' && g.groups.length === 1, 'mergeModelGroups：无法识别的系列被跳过（不新建分组）');

    const sc = dt.mergeSourceConfig({ 'a.b': { apiKey: 'k1', baseUrl: '' } }, { 'a.b': { apiKey: 'k2', baseUrl: 'u2' }, 'c.d': { apiKey: 'k3', baseUrl: '' } });
    check(sc.config['a.b'].apiKey === 'k1' && sc.config['a.b'].baseUrl === 'u2', 'mergeSourceConfig：已有 Key 保留、空缺的地址补上');
    check(sc.filled === 2 && sc.kept === 0, 'mergeSourceConfig：统计补空缺 / 保留的组数');

    const mc = dt.mergeConversations(
      { tabCounter: 1, activeId: 'x', conversations: [{ id: 'x', messages: [] }] },
      { tabCounter: 5, conversations: [{ id: 'y', messages: [{ id: 'm', role: 'assistant', status: 'running' }] }, { id: 'x', messages: [] }] },
      new Map()
    );
    check(mc.added === 1 && mc.skipped === 1 && mc.conversations.conversations[0].id === 'y', 'mergeConversations：新会话插到最上面、同 id 跳过');
    check(mc.conversations.tabCounter === 5 && mc.conversations.activeId === 'x', 'mergeConversations：tabCounter 取最大、activeId 保持有效值');

    const hiddenMerge = dt.mergeImport({
      current: {
        settings: { ...store.DEFAULT_SETTINGS, modelGroups: [] },
        modelSeries: {
          version: 1,
          series: [{ id: 'hidden-series', label: '隐藏系列', protocol: 'newapi-images', hidden: true, sources: [{ id: 'only', protocol: 'newapi-images' }] }]
        },
        renameConfig: {},
        conversations: { conversations: [] }
      },
      imported: {
        settings: { modelGroups: [{ seriesId: 'hidden-series', models: [{ id: 'mm1', name: 'x-model', sourceId: 'only' }] }] },
        modelSeries: { series: [] },
        conversations: { conversations: [] }
      }
    });
    check(hiddenMerge.modelSeries.series[0].hidden === false && hiddenMerge.settings.modelGroups[0].models.length === 1,
      '导入的模型属于本机已隐藏的系列时：自动新增分组并把该系列从隐藏里放出来');
  }

  console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========`);
  server.close();
  runner.cancelAll();
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.rmSync(LOGDIR, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常', e); process.exit(2); });
