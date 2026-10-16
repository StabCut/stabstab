'use strict';
/*
 * API 请求执行器。
 * 每个生成请求独立运行、独立中止（等效于一个独立“线程”），互不阻塞：
 * 同一个对话里可以同时有多个「同步等待」中的请求，各自独立返回结果（见 AIDEV.md §4.12）。
 *
 * 只有「同步」一种请求模式：提交请求 → 阻塞等待响应 → 下载图片 → 结束。
 * 唯一的例外是**协议内部**的任务兜底（例如 Grsai 某些节点只回一个任务 id）：
 * 这时按适配器给出的查询端点轮询到结果为止 —— 它不是用户可切换的「异步模式」，
 * 没有开关、没有状态徽标，也不参与重启恢复。
 *
 * 通过 sendEvent(payload) 向渲染进程推送事件：
 *   {type:'status'|'delta'|'result'|'error'|'cancelled', conversationId, messageId, ...}
 *   · 'delta' 只有**流式协议**会发（文本对话，见 grsai-chat.js）：一段新增正文，界面把它追加到气泡上；
 *     收尾仍然是 'result'（带着完整正文），所以渲染进程不需要为文本模式再搭一套事件管道。
 */
const log = require('../logger');
const { getAdapter } = require('./registry');
const { downloadImage } = require('../imageutil');
const { isHttpError, errorMessage, errorCode } = require('./util');

/** 流式增量的节流间隔：模型一块一块地吐字，每块都发事件会把渲染进程刷爆（这里约 16 次/秒） */
const STREAM_FLUSH_MS = 60;

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
 *        timeoutSec, prompt, images:[dataUrl], imageNames:[string], params, cacheDir}
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
    // 文本对话的 Key 在「文本模型」页、图像的在「图像模型」页：这条兜底提示要指对地方
    // （正常不会走到这里：两个入口都各自先校验过一次）
    const where = opts.text ? '文本模型' : '图像模型';
    sendEvent({ ...base, type: 'error', ok: false, error: { code: 'NO_API_KEY', message: `尚未配置 API Key，请先在「设置 → ${where}」中填写。` } });
    return { jobId };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(5, opts.timeoutSec || 300) * 1000;
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const job = {
    controller, deadline,
    taskId: null,
    cancelled: false,
    conversationId, messageId,
    protocol: opts.protocol,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl
  };
  activeJobs.set(jobId, job);

  const startedAt = Date.now();
  log.info(opts.text ? '开始对话生成请求' : '开始生成请求', {
    jobId, model: opts.model, protocol: opts.protocol,
    series: opts.seriesId, source: opts.sourceId,
    // 文本请求没有 prompt / images，改报「上下文条数 + 总字数」（无最大上下文限制，全量发送）
    messages: opts.text ? (opts.messages || []).length : undefined,
    chars: opts.text
      ? (opts.messages || []).reduce((n, m) => n + String((m && m.text) || '').length, 0)
      : undefined,
    images: opts.text ? undefined : (opts.images || []).length,
    hasPrompt: opts.text ? undefined : !!(opts.prompt && opts.prompt.trim()),
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
        messages: opts.messages            // 文本对话的上下文（只有文本协议用得到）
      };

      // 1) 提交
      const sub = adapter.buildSubmitRequest(ctx);
      log.info('提交请求', { jobId, url: sub.url });

      // 流式协议（文本对话）：一次请求要边收边发，读 body 的方式与一次性请求不同
      if (adapter.stream && opts.stream) {
        return await runStream(adapter, sub, job, opts, finish, sendEvent);
      }

      const res = await fetchWithTimeout(sub.url, { method: sub.method, headers: sub.headers, body: sub.body }, timeoutMs, controller.signal);
      const json = await readJsonSafe(res);
      const parsed = adapter.parseSubmit(json, res.status);

      if (parsed.kind === 'error') {
        log.warn('提交返回错误', { jobId, error: parsed.error });
        return finish({ type: 'error', ok: false, error: parsed.error });
      }
      if (parsed.kind === 'result') {
        return await deliverResult(parsed, opts, job, finish, sendEvent);
      }
      if (parsed.kind === 'task') {
        // 协议内部的兜底：服务端只给了任务 id（当前只有 Grsai 可能走到这里）
        job.taskId = parsed.taskId;
        log.info('服务端只返回任务 id，按协议内部查询结果', { jobId, taskId: job.taskId, status: parsed.taskStatus });
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
 * 流式请求：边收边把增量文本推给界面（当前只有文本对话的 grsai-chat 走这里）。
 *
 * 与一次性请求的区别只有「怎么读 body」—— 提交、超时（job.deadline）、取消（job.controller.abort）、
 * 错误文案的口径全部一致，所以渲染进程不需要为文本模式再搭一套事件管道：
 * 增量走 type:'delta'，收尾仍是 type:'result'（带着完整正文）。
 *
 * 两个容易踩的点：
 *   1) **不能**用 fetchWithTimeout：它的计时器在响应头到手时就清掉了，管不到后面的流。
 *      这里直接把 job 的 controller 交给 fetch，超时与「停止」才能真正中断一个**已经开始的**流。
 *   2) 收尾时总把完整正文放进 result.texts[0]：万一某个增量事件被节流掉 / 丢了，
 *      界面以 result 为准覆盖一次，显示出来的一定是全文。
 */
async function runStream(adapter, sub, job, opts, finish, sendEvent) {
  const base = { conversationId: job.conversationId, messageId: job.messageId };
  const res = await fetch(sub.url, {
    method: sub.method, headers: sub.headers, body: sub.body,
    signal: job.controller.signal, redirect: 'follow'
  });

  if (isHttpError(res.status)) {
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { json = { __raw: raw }; }
    const error = { code: errorCode(json, res.status), message: `HTTP ${res.status}：${errorMessage(json, res.status)}` };
    log.warn('流式请求返回错误', { jobId: job.messageId, status: res.status, code: error.code });
    return finish({ type: 'error', ok: false, error });
  }
  if (!res.body) {
    return finish({ type: 'error', ok: false, error: { code: 'BAD_RESPONSE', message: '响应没有正文，无法流式读取。' } });
  }

  const parser = adapter.createStreamParser();
  const decoder = new TextDecoder('utf-8');
  const reader = res.body.getReader();
  let full = '';              // 已积累的正文
  let pending = '';           // 还没下发的增量（节流用）
  let raw = '';               // 响应原文：服务端忽略 stream:true 时的整包兜底
  let usage = null;
  let requestId = null;
  let lastFlush = Date.now();
  let readError = null;

  // streaming:true = 告诉界面「这是一次流式生成」：把气泡切成“生成中”，但不要显示任务状态徽标
  // （任务徽标是图像那边「服务端只回任务 id」才有的东西）
  sendEvent({ ...base, type: 'status', streaming: true, status: 'RUNNING' });

  const flush = () => {
    if (!pending) return;
    const text = pending;
    pending = '';
    lastFlush = Date.now();
    sendEvent({ ...base, type: 'delta', ok: true, text });
  };

  // 定时把攒下的增量发出去：只靠「下一块到达时再判断」是不够的 —— 服务端一旦停顿（模型在思考），
  // 已经收到的正文就会一直压在手里不显示。60ms 一次既够顺滑，也不会把渲染进程刷爆。
  const flushTimer = setInterval(flush, STREAM_FLUSH_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      const r = parser.push(chunk);
      if (r.error) {
        log.warn('流式响应中途报错', { jobId: job.messageId, error: r.error });
        return finish({ type: 'error', ok: false, error: r.error });
      }
      if (r.usage) usage = r.usage;
      if (r.requestId) requestId = r.requestId;
      if (r.deltas.length) {
        const t = r.deltas.join('');
        full += t;
        pending += t;
      }
      if (pending && Date.now() - lastFlush >= STREAM_FLUSH_MS) flush();
    }
    const tail = parser.end(raw);
    if (tail.deltas.length) {
      const t = tail.deltas.join('');
      full += t;
      pending += t;
    }
    if (tail.usage) usage = tail.usage;
    if (tail.requestId) requestId = requestId || tail.requestId;
    if (tail.error && !full) {
      return finish({ type: 'error', ok: false, error: tail.error });
    }
  } catch (e) {
    readError = e;      // 取消 / 超时 / 断网：下面按「收到了多少」决定怎么收场
  } finally {
    clearInterval(flushTimer);      // 计时器随本次请求一起收掉（否则它会一直往一个已经结束的流上 flush）
  }

  // 服务端可能压根没走 SSE（忽略了 stream:true，直接回一整包 JSON，甚至带缩进换行）。
  // 这种情况下 SSE 分帧一行都认不出来，但正文其实就在 body 里 —— 再按一次性响应解析一次。
  if (!readError && !full && raw && raw.trim()) {
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { json = null; }
    if (json) {
      const parsed = adapter.parseSubmit(json, res.status);
      if (parsed.kind === 'error') {
        log.warn('流式请求按整包 JSON 兜底解析：失败', { jobId: job.messageId, error: parsed.error });
        return finish({ type: 'error', ok: false, error: parsed.error });
      }
      if (parsed.kind === 'result') {
        const t = (parsed.texts || []).join('').trim();
        if (t) {
          full = t;
          usage = usage || parsed.usage || null;
          requestId = requestId || parsed.requestId || null;
        }
      }
    }
  }

  if (job.cancelled) {
    // 用户按了「停止」：cancel() 已经发过 cancelled 事件，这里不再发任何事件。
    // 已经推给界面的增量照旧留在气泡里（停止 = 保留已生成的部分，而不是把它变成错误）
    log.info('对话生成已停止', { jobId: job.messageId, chars: full.length });
    return;
  }

  const text = full.trim();
  if (!text) {
    if (readError) throw readError;        // 一个字都没收到 → 交给上层按请求失败 / 超时处理
    return finish({ type: 'error', ok: false, error: { code: 'EMPTY_REPLY', message: '模型没有返回任何内容。' } });
  }
  if (readError) {
    log.warn('流式读取中断，保留已收到的正文', {
      jobId: job.messageId, chars: text.length, error: readError && readError.message
    });
  }
  flush();
  log.info('对话生成完成', { jobId: job.messageId, model: opts.model, chars: text.length, requestId });
  return finish({ type: 'result', ok: true, images: [], texts: [full.trimEnd()], usage, requestId });
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

/**
 * 协议内部的任务查询（初始 3s，×1.5，上限 15s），受总超时约束。
 * 只在适配器返回 kind:'task' 时使用（Grsai 某些节点只回任务 id），不是可切换的请求模式。
 */
async function pollTask(adapter, ctx, job, opts, finish, sendEvent) {
  const base = { conversationId: job.conversationId, messageId: job.messageId };
  let interval = 3000;
  const maxInterval = 15000;
  while (!job.controller.signal.aborted && !job.cancelled) {
    await sleep(interval, job.controller.signal);
    if (job.controller.signal.aborted || job.cancelled) {
      if (!job.cancelled) {
        return finish({ type: 'error', ok: false, error: { code: 'TIMEOUT_OR_ABORT', message: `等待结果超时（${opts.timeoutSec}s）。` }, taskId: job.taskId });
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
 * 取消 / 停止等待一个请求（每个请求独立中止，互不影响）。
 * - 有 taskId（协议内部任务兜底，如 Grsai）：先调服务端取消接口（若适配器提供）+ 停止本地查询。
 * - 无 taskId（常规同步请求）：中止本地等待 —— 远端请求撤回不了，但结果不再显示、也不再占用界面。
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
        log.info('该协议无服务端取消接口，仅停止本地查询', { taskId: job.taskId, protocol: job.protocol });
      }
    } catch (e) {
      log.warn('取消任务请求失败（仍停止本地等待）', { taskId: job.taskId, error: e && e.message });
    }
  }
  job.controller.abort();
  activeJobs.delete(jobId);
  log.info('请求已停止等待', { jobId, taskId: job.taskId });
  if (sendEvent) {
    sendEvent({ ...base, type: 'cancelled', ok: false, taskId: job.taskId, error: { code: 'CANCELED', message: '已停止等待（这一次请求的结果不再显示）。' } });
  }
  return { ok: true };
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
    jobId, taskId: j.taskId, conversationId: j.conversationId, messageId: j.messageId
  }));
}

module.exports = { start, cancel, cancelAll, listActive };
