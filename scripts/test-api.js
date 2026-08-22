'use strict';
/*
 * 后端逻辑端到端测试（无需 GUI）：
 * 启动一个 mock DashScope 服务，驱动真实的 runner 走完 同步/异步/错误/取消 全链路。
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

// 一张 16x16 的 PNG（用于校验尺寸嗅探）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGP80hLPQApgIkn1qIZRDUNKAwDTsgH3dLIX4AAAAABJRU5ErkJggg==',
  'base64'
);
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'stabstab-cache-'));
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stabstab-log-'));
log.init(LOGDIR);

let PORT = 0;
let taskPollCount = 0;
const IMG_URL = () => `http://127.0.0.1:${PORT}/img.png`;

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url;
    if (req.method === 'POST' && url.endsWith('/multimodal-generation/generation')) {
      const asyncMode = req.headers['x-dashscope-async'] === 'enable';
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
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
    check(list.some((p) => !p.available), '存在预留协议');
    const sizes = registry.getAdapter('dashscope-multimodal').sizeOptions;
    check(sizes.includes('2688*1536') && sizes.includes('2048*2048') && sizes.includes('auto'), 'size 列表正确');
  }

  console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========`);
  server.close();
  runner.cancelAll();
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.rmSync(LOGDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常', e); process.exit(2); });
