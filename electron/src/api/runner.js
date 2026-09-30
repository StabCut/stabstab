'use strict';
/*
 * API 请求执行器。
 * 每个生成请求独立运行、独立中止（等效于一个独立“线程”），互不阻塞：
 * 多个对话标签可以同时处于“同步等待”状态，各自独立返回结果。
 *
 * 通过 sendEvent(payload) 向渲染进程推送事件：
 *   {type:'status'|'result'|'error'|'cancelled', conversationId, messageId, ...}
 */
const log = require('../logger');
const { getAdapter } = require('./registry');
const { downloadImage } = require('../imageutil');

// 活动任务表：jobId -> job
const activeJobs = new Map();

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** fetch，同时受外部 signal 与超时约束 */
async function fetchWithTimeout(url, opts, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function readJsonSafe(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { __raw: text }; }
}

/**
 * 启动一次生成。立即返回 {jobId}，结果经 sendEvent 推送。
 * opts: {jobId, conversationId, messageId, protocol, model, apiKey, baseUrl,
 *        mode:'sync'|'async', timeoutSec, prompt, images:[dataUrl], imageNames:[string], params, cacheDir}
 *   imageNames：用户这次一起发送的输入图文件名（与 images 顺序一一对应，读不到就是空串），
 *               会被写进结果图的 pic1…picN（见 requestMeta）。
 */
function start(opts, sendEvent) {
  const { jobId, conversationId, messageId } = opts;
  const base = { conversationId, messageId };
  const adapter = getAdapter(opts.protocol);

  if (!adapter) {
    sendEvent({ ...base, type: 'error', ok: false, error: { code: 'NO_ADAPTER', message: `未找到协议适配器: ${opts.protocol}` } });
    return { jobId };
  }
  if (!opts.apiKey || !String(opts.apiKey).trim()) {
    sendEvent({ ...base, type: 'error', ok: false, error: { code: 'NO_API_KEY', message: '尚未配置 API Key，请先在「设置 → 模型设置」中填写。' } });
    return { jobId };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(5, opts.timeoutSec || 300) * 1000;
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const job = {
    controller, deadline,
    taskId: null,
    mode: opts.mode,
    cancelled: false,
    conversationId, messageId,
    protocol: opts.protocol,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl
  };
  activeJobs.set(jobId, job);

  const startedAt = Date.now();
  log.info('开始生成请求', {
    jobId, model: opts.model, protocol: opts.protocol, mode: opts.mode,
    series: opts.seriesId, source: opts.sourceId,
    images: (opts.images || []).length, hasPrompt: !!(opts.prompt && opts.prompt.trim()),
    timeoutSec: opts.timeoutSec, size: opts.params && opts.params.size,
    n: opts.params && opts.params.n
  });

  const finish = (evt) => {
    clearTimeout(job.deadline);
    activeJobs.delete(jobId);
    const durationMs = Date.now() - startedAt;
    log.info('请求结束', { jobId, type: evt.type, ok: evt.ok, durationMs: `${durationMs}ms` });
    sendEvent({ ...base, ...evt, durationMs });
  };

  const onFatal = (e) => {
    if (job.cancelled) return; // cancel() 已发过事件
    const aborted = controller.signal.aborted;
    log.error('请求失败', { jobId, error: e && e.message, aborted });
    finish({
      type: 'error', ok: false,
      error: {
        code: aborted ? 'TIMEOUT_OR_ABORT' : 'REQUEST_ERROR',
        message: aborted
          ? `请求超时或已中止（超时设置 ${opts.timeoutSec}s）。`
          : `请求失败：${e && e.message ? e.message : String(e)}`
      }
    });
  };

  (async () => {
    try {
      const ctx = {
        apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model,
        prompt: opts.prompt, images: opts.images, params: opts.params,
        mode: opts.mode
      };

      // 1) 提交
      const sub = adapter.buildSubmitRequest(ctx);
      log.info('提交请求', { jobId, url: sub.url, mode: opts.mode });
      const res = await fetchWithTimeout(sub.url, { method: sub.method, headers: sub.headers, body: sub.body }, timeoutMs, controller.signal);
      const json = await readJsonSafe(res);
      const parsed = adapter.parseSubmit(json, res.status, opts.mode);

      if (parsed.kind === 'error') {
        log.warn('提交返回错误', { jobId, error: parsed.error });
        return finish({ type: 'error', ok: false, error: parsed.error });
      }
      if (parsed.kind === 'result') {
        return await deliverResult(parsed, opts, job, finish, sendEvent);
      }
      if (parsed.kind === 'task') {
        job.taskId = parsed.taskId;
        log.info('异步任务已提交', { jobId, taskId: job.taskId, status: parsed.taskStatus });
        sendEvent({ ...base, type: 'status', status: parsed.taskStatus || 'PENDING', taskId: job.taskId });
        return await pollTask(adapter, ctx, job, opts, finish, sendEvent);
      }
      return finish({ type: 'error', ok: false, error: { code: 'BAD_RESPONSE', message: '无法解析 API 响应。' } });
    } catch (e) {
      onFatal(e);
    }
  })();

  return { jobId };
}

/**
 * 本次请求要写进结果图的元数据：提示词 + 用户随这次请求一起发送的输入图文件名。
 *
 * 规则（与 promptmeta 的存储约定一致）：
 *   - 纯文生图（没带输入图）→ 只有 prompt，记录仍是 {"prompt":"…","v":1}
 *   - 带了输入图 → 追加 pic1…picN（与图片发送顺序一一对应）；某个名字读不到
 *     （系统剪贴板直接粘贴等）时该位置留空串，但 pic 项必须存在，于是「发送了几张输入图」
 *     这件事本身也被记下来了。
 *   - 名字来源两个：opts.imageNames（渲染进程按图片顺序传来的真实文件名）或
 *     opts.pics（重启后恢复的异步任务，由主进程从会话记录里取回）。
 *   - opts 是每个 job 独立的对象，并发生成不会串到其它 job。
 */
function requestMeta(opts) {
  const names = Array.isArray(opts.pics) ? opts.pics
    : (Array.isArray(opts.imageNames) ? opts.imageNames : []);
  const imageCount = Array.isArray(opts.images) && opts.images.length ? opts.images.length : names.length;
  const pics = [];
  for (let i = 0; i < imageCount; i++) pics.push(names[i] == null ? '' : String(names[i]));
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  if (!prompt.trim() && !pics.length) return null;
  return { prompt, pics };
}

/** 下载结果图片并下发 result 事件 */
async function deliverResult(parsed, opts, job, finish, sendEvent) {
  const urls = parsed.images || [];
  const usage = parsed.usage || null;
  if (!urls.length) {
    const text = (parsed.texts || []).join('\n').trim();
    log.warn('响应中没有图片', { jobId: job.messageId, text: text.slice(0, 200) });
    if (text) {
      return finish({ type: 'result', ok: true, images: [], texts: parsed.texts || [], usage, requestId: parsed.requestId, taskId: job.taskId });
    }
    return finish({ type: 'error', ok: false, error: { code: 'NO_IMAGE', message: 'API 未返回任何图片。' } });
  }

  const images = [];
  // 本次请求的实际提示词 + 输入图文件名：与这一批结果图一一对应地写进图片元数据
  const promptMeta = requestMeta(opts);
  for (const url of urls) {
    if (job.cancelled) return;
    try {
      const item = await downloadImage(url, opts.cacheDir, 'result', 120000, promptMeta);
      if (!item.width && usage && usage.output_width) item.width = usage.output_width;
      if (!item.height && usage && usage.output_height) item.height = usage.output_height;
      images.push({ file: item.file, width: item.width, height: item.height, url, bytes: item.bytes });
    } catch (e) {
      log.error('结果图片下载失败', { url: String(url).slice(0, 120), error: e && e.message });
      images.push({ file: null, width: usage && usage.output_width, height: usage && usage.output_height, url, bytes: 0, downloadError: e.message });
    }
  }
  const okCount = images.filter(i => i.file).length;
  log.info('生成成功', { messageId: job.messageId, count: okCount, taskId: job.taskId });
  return finish({ type: 'result', ok: true, images, texts: parsed.texts || [], usage, requestId: parsed.requestId, taskId: job.taskId });
}

/** 指数退避轮询异步任务（初始 3s，×1.5，上限 15s），受总超时约束 */
async function pollTask(adapter, ctx, job, opts, finish, sendEvent) {
  const base = { conversationId: job.conversationId, messageId: job.messageId };
  let interval = 3000;
  const maxInterval = 15000;
  while (!job.controller.signal.aborted && !job.cancelled) {
    await sleep(interval, job.controller.signal);
    if (job.controller.signal.aborted || job.cancelled) {
      if (!job.cancelled) {
        return finish({ type: 'error', ok: false, error: { code: 'TIMEOUT_OR_ABORT', message: `异步任务等待超时（${opts.timeoutSec}s）。` }, taskId: job.taskId });
      }
      return;
    }

    let res, json;
    try {
      const q = adapter.buildTaskQuery({ ...ctx, taskId: job.taskId });
      res = await fetchWithTimeout(q.url, { method: q.method, headers: q.headers }, 30000, job.controller.signal);
      json = await readJsonSafe(res);
    } catch (e) {
      log.warn('轮询出错，将重试', { taskId: job.taskId, error: e && e.message });
      interval = Math.min(interval * 1.5, maxInterval);
      continue;
    }

    const parsed = adapter.parseTask(json, res.status);
    if (parsed.status === 'SUCCEEDED') {
      return await deliverResult(parsed, opts, job, finish, sendEvent);
    }
    if (parsed.status === 'FAILED' || parsed.status === 'UNKNOWN') {
      log.warn('任务失败', { taskId: job.taskId, error: parsed.error });
      return finish({ type: 'error', ok: false, error: parsed.error, taskId: job.taskId });
    }
    if (parsed.status === 'CANCELED') {
      return finish({ type: 'cancelled', ok: false, taskId: job.taskId, error: { code: 'CANCELED', message: '任务已被取消。' } });
    }
    // PENDING / RUNNING
    sendEvent({ ...base, type: 'status', status: parsed.status, taskId: job.taskId });
    interval = Math.min(interval * 1.5, maxInterval);
  }
}

/**
 * 取消/停止一个任务。
 * - 有 taskId（异步）：调用服务端取消接口（仅 PENDING 生效）+ 停止本地轮询。
 * - 无 taskId（同步）：中止本地等待（远端请求无法撤回，但不再占用界面）。
 */
async function cancel(jobId, sendEvent) {
  const job = activeJobs.get(jobId);
  if (!job) return { ok: false, message: '任务不存在或已结束。' };
  if (job.cancelled) return { ok: true };
  job.cancelled = true;
  clearTimeout(job.deadline);
  const base = { conversationId: job.conversationId, messageId: job.messageId };

  if (job.taskId) {
    try {
      const adapter = getAdapter(job.protocol);
      const c = adapter && adapter.buildTaskCancel
        ? adapter.buildTaskCancel({ apiKey: job.apiKey, baseUrl: job.baseUrl, taskId: job.taskId })
        : null;
      if (c) {
        const res = await fetchWithTimeout(c.url, { method: c.method, headers: c.headers, body: c.body }, 15000);
        const json = await readJsonSafe(res);
        log.info('已请求取消任务', { taskId: job.taskId, http: res.status, resp: json && (json.message || json.code || '') });
      } else {
        log.info('该协议无服务端取消接口，仅停止本地轮询', { taskId: job.taskId, protocol: job.protocol });
      }
    } catch (e) {
      log.warn('取消任务请求失败（仍停止本地等待）', { taskId: job.taskId, error: e && e.message });
    }
  }
  job.controller.abort();
  activeJobs.delete(jobId);
  log.info('任务已取消/停止等待', { jobId, taskId: job.taskId, mode: job.mode });
  if (sendEvent) {
    sendEvent({ ...base, type: 'cancelled', ok: false, taskId: job.taskId, error: { code: 'CANCELED', message: job.taskId ? '任务已取消。' : '已停止等待（结果若返回仍会显示）。' } });
  }
  return { ok: true };
}

/**
 * 恢复一个异步任务的轮询（应用重启后，凭已保存的 taskId 继续）。
 * opts: {jobId, conversationId, messageId, protocol, apiKey, baseUrl, taskId, timeoutSec, cacheDir,
 *        prompt?, pics?}   ← prompt / pics 由主进程从会话记录里取回，落盘时要写进结果图元数据
 */
function resume(opts, sendEvent) {
  const adapter = getAdapter(opts.protocol);
  const base = { conversationId: opts.conversationId, messageId: opts.messageId };
  if (!adapter || !opts.taskId) {
    sendEvent({ ...base, type: 'error', ok: false, error: { code: 'RESUME_FAILED', message: '无法恢复任务（缺少协议或 taskId）。' } });
    return { jobId: opts.jobId };
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(5, opts.timeoutSec || 300) * 1000;
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const job = {
    controller, deadline,
    taskId: opts.taskId,
    mode: 'async',
    cancelled: false,
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    protocol: opts.protocol,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl
  };
  activeJobs.set(opts.jobId, job);
  const startedAt = Date.now();
  const finish = (evt) => {
    clearTimeout(job.deadline);
    activeJobs.delete(opts.jobId);
    sendEvent({ ...base, ...evt, durationMs: Date.now() - startedAt });
  };
  log.info('恢复异步任务轮询', { jobId: opts.jobId, taskId: opts.taskId });
  (async () => {
    try {
      const ctx = { apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model };
      await pollTask(adapter, ctx, job, opts, finish, sendEvent);
    } catch (e) {
      if (!job.cancelled) {
        finish({ type: 'error', ok: false, error: { code: 'RESUME_ERROR', message: e && e.message || String(e) }, taskId: opts.taskId });
      }
    }
  })();
  return { jobId: opts.jobId };
}

/** 应用退出时中止所有任务 */
function cancelAll() {
  for (const [jobId, job] of Array.from(activeJobs.entries())) {
    clearTimeout(job.deadline);
    job.controller.abort();
    activeJobs.delete(jobId);
  }
}

function listActive() {
  return Array.from(activeJobs.entries()).map(([jobId, j]) => ({
    jobId, taskId: j.taskId, mode: j.mode, conversationId: j.conversationId, messageId: j.messageId
  }));
}

module.exports = { start, resume, cancel, cancelAll, listActive };
