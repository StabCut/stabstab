'use strict';
/*
 * 后端逻辑端到端测试（无需 GUI）：
 * 启动一个 mock 服务，驱动真实的 runner 走完 同步/异步/错误/取消 全链路，
 * 并额外覆盖新增协议（Seedream 官方 / New API / Grsai）与「模型系列」配置读写。
 * 运行：npm run test:api   （或 node scripts/test-api.js）
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

// 一张 16x16 的 PNG（用于校验尺寸嗅探 / b64 结果落盘）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGP80hLPQApgIkn1qIZRDUNKAwDTsgH3dLIX4AAAAABJRU5ErkJggg==',
  'base64'
);
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'stabstab-cache-'));
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stabstab-log-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stabstab-cfg-'));
log.init(LOGDIR);

let PORT = 0;
let taskPollCount = 0;
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
      const asyncMode = req.headers['x-dashscope-async'] === 'enable';
      const model = parsed.model;
      if (model === 'err-model') return send(400, { code: 'InvalidParameter', message: '模拟错误：参数不正确', request_id: 'req-err-1' });
      if (asyncMode) {
        const taskId = model === 'err-async' ? 'task_fail' : (model === 'hang-model' ? 'task_hang' : 'task_ok');
        return send(200, { request_id: 'req-a1', output: { task_id: taskId, task_status: 'PENDING' } });
      }
      return send(200, {
        request_id: 'req-s1',
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: IMG_URL() }, { image: IMG_URL() }] } }] },
        usage: { output_width: 16, output_height: 16, output_image_count: 2 }
      });
    }
    if (req.method === 'GET' && url.includes('/tasks/')) {
      const id = decodeURIComponent(url.split('/tasks/')[1]);
      if (id === 'task_hang') return send(200, { request_id: 'r', output: { task_id: id, task_status: 'PENDING' } });
      if (id === 'task_fail') return send(200, { request_id: 'r', output: { task_id: id, task_status: 'FAILED', code: 'DataInspectionFailed', message: '内容可能不合规' } });
      taskPollCount++;
      return send(200, {
        request_id: 'r',
        output: { task_id: id, task_status: 'SUCCEEDED', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: IMG_URL() }] } }] },
        usage: { output_width: 16, output_height: 16, image_count: 1 }
      });
    }
    if (req.method === 'POST' && url.includes('/cancel')) return send(200, { request_id: 'r', message: 'ok' });

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

async function runScenario(name, optsPatch) {
  const events = [];
  const opts = {
    jobId: 'job_' + name, conversationId: 'conv1', messageId: 'msg_' + name,
    protocol: 'dashscope-multimodal', model: 'qwen-image-3.0-pro',
    apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${PORT}/api/v1`,
    mode: 'sync', timeoutSec: 30, prompt: '测试', images: [], params: { size: '2048*2048', n: 1 },
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

  console.log('\n[3] 异步成功（submit→poll→SUCCEEDED）');
  {
    const { events, term } = await runScenario('async_ok', { mode: 'async' });
    check(events.some((e) => e.type === 'status' && e.status === 'PENDING'), '出现 PENDING 状态事件');
    check(term && term.type === 'result' && term.ok === true, '最终 result 成功');
    check(term && term.images.length === 1, '一张结果图');
  }

  console.log('\n[4] 异步失败（FAILED DataInspectionFailed）');
  {
    const { term } = await runScenario('async_fail', { mode: 'async', model: 'err-async' });
    check(term && term.type === 'error', '返回 error');
    check(term && term.error.code === 'DataInspectionFailed', '任务失败码透传');
  }

  console.log('\n[5] 异步取消（hang 任务）');
  {
    const events = [];
    const opts = {
      jobId: 'job_cancel', conversationId: 'conv1', messageId: 'msg_cancel',
      protocol: 'dashscope-multimodal', model: 'hang-model',
      apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${PORT}/api/v1`,
      mode: 'async', timeoutSec: 30, prompt: '', images: [], params: {}, cacheDir: CACHE
    };
    runner.start(opts, (ev) => events.push(ev));
    await new Promise((r) => setTimeout(r, 300));
    await runner.cancel('job_cancel', (ev) => events.push(ev));
    check(events.some((e) => e.type === 'cancelled'), '收到 cancelled 事件');
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

  console.log('\n[14] 模型系列配置（内置 json / 合并 / 隐藏 / 同步异步开关）');
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
    check(qwen.requestMode.supported === true && qwen.requestMode.value === 'sync', 'qwen 支持同步/异步，默认同步');
    check(!seed.requestMode.supported && !gpt.requestMode.supported, '其它系列不支持异步');

    // 用户操作：隐藏 gpt 系列 + 把 qwen 切到异步
    const saved = modelSeriesLib.save(cfgFile, {
      series: cfg.series.map((s) => (s.id === 'qwen'
        ? { ...s, requestMode: { ...s.requestMode, value: 'async' } }
        : (s.id === 'gpt-image' ? { ...s, hidden: true, protocol: 'hacked-protocol' } : s)))
    });
    const reloaded = modelSeriesLib.load(cfgFile);
    const q2 = reloaded.series.find((s) => s.id === 'qwen');
    const g2 = reloaded.series.find((s) => s.id === 'gpt-image');
    check(q2.requestMode.value === 'async', '同步/异步开关已持久化（存在 json 里）');
    check(g2.hidden === true, '隐藏状态已持久化');
    check(g2.protocol === 'newapi-images', '内置协议不可被本地 json 篡改');
    check(saved.series.length === 3, '保存不会丢内置系列');
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

  console.log('\n[16] 模型解析（resolveModel：协议 / 密钥 / 同步异步 / 隐藏系列）');
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
    check(q.mode === 'async' && q.supportsAsync === true, 'qwen 切到异步后按异步执行');

    const g = modelSeriesLib.resolveModel(settings, cfg, 'm_g');
    check(g.protocol === 'grsai-image', 'gpt-image 模型：绑定到 Grsai 协议');
    check(g.baseUrl === 'http://127.0.0.1:9/custom', '自定义地址覆盖内置默认');
    check(g.mode === 'sync' && g.supportsAsync === false, '不支持异步的系列强制同步');

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

  console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========`);
  server.close();
  runner.cancelAll();
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.rmSync(LOGDIR, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常', e); process.exit(2); });
