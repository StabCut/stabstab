'use strict';
/*
 * 协议适配器：Grsai 生图（GPT Image 系列的 Grsai 来源）
 *
 * 规则来源（工作区文档 gpt-image系列.md 的 Grsai API 部分）：
 *  - 同步：POST {baseUrl}   例如 https://grsaiapi.com/v1/api/generate
 *      headers: Authorization: Bearer sk-xxx（可选，但配额必须）
 *      body: { model, prompt, images?[], aspectRatio? }
 *        images: 参考图数组，支持 base64（data:image/png;base64,…）与 URL 链接
 *        aspectRatio: 比例（如 "16:9"）或 1K 像素值（如 "1024x1024"）
 *  - 无异步模式：单次请求阻塞等待返回。
 *
 * 响应兼容两种形态（不同节点/模型不一致，这里都吃掉）：
 *  A) SSE 流（text/event-stream）：逐行 `data: {json}`，进度事件里 status=running，
 *     结束时 status=succeeded 且 results[].url 有值；最终一次性解析出图片地址。
 *  B) 普通 JSON：{ code:0, data:{ id, status, progress, results:[{url}] } }
 *     若只返回任务 id（例如服务端要求走 webHook/轮询），则退化为轮询 POST {host}/v1/draw/result {id}。
 */
const { normBase, collectImages, errorMessage, errorCode, isHttpError, normalizeUsage } = require('./util');

const DEFAULT_BASE_URL = 'https://grsaiapi.com/v1/api/generate';
const GEN_PATH = '/v1/api/generate';
const RESULT_PATH = '/v1/draw/result';

/** 生成端点：base 已是完整地址时原样使用 */
function genUrl(baseUrl) {
  const b = normBase(baseUrl, DEFAULT_BASE_URL);
  if (b.endsWith(GEN_PATH)) return b;
  if (/\/v1\/api\/generate$/i.test(b)) return b;
  return b.replace(/\/v1\/api\/?$/i, '') + GEN_PATH;
}

/** 结果查询端点：由生成端点推导同节点的 /v1/draw/result */
function resultUrl(baseUrl) {
  const b = normBase(baseUrl, DEFAULT_BASE_URL);
  const cut = b.replace(/\/v1\/api\/generate$/i, '');
  return (cut || b) + RESULT_PATH;
}

function buildBody(ctx) {
  const p = ctx.params || {};
  const images = Array.isArray(ctx.images) ? ctx.images.filter(Boolean) : [];
  const body = {
    model: ctx.model,
    prompt: String(ctx.prompt || '')
  };
  if (p.size && p.size !== 'auto') body.aspectRatio = p.size;
  if (images.length === 1) body.images = [images[0]];
  else if (images.length > 1) body.images = images;
  return body;
}

function buildRequest(url, ctx) {
  const headers = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
  return { url, method: 'POST', headers, body: JSON.stringify(buildBody(ctx)) };
}

function buildSubmitRequest(ctx) {
  return buildRequest(genUrl(ctx.baseUrl), ctx);
}

// ---------- 响应解析 ----------

/** 逐行拆 SSE，返回其中的 JSON 负载列表 */
function parseSsePayloads(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith(':') || t.startsWith('event:')) continue;
    let payload = null;
    if (t.startsWith('data:')) payload = t.slice(5).trim();
    else if (t.startsWith('{')) payload = t;
    if (!payload || payload === '[DONE]') continue;
    try {
      const o = JSON.parse(payload);
      if (o && typeof o === 'object') out.push(o);
    } catch (e) { /* 心跳或非 JSON 行：忽略 */ }
  }
  return out;
}

/** 取出负载里的业务对象（Grsai 形如 {code,msg,data:{...}}） */
function bodyOf(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return (payload.data && typeof payload.data === 'object') ? payload.data : payload;
}

const STATUS_OF = {
  succeeded: 'SUCCEEDED', success: 'SUCCEEDED', completed: 'SUCCEEDED', done: 'SUCCEEDED',
  failed: 'FAILED', error: 'FAILED', canceled: 'CANCELED', cancelled: 'CANCELED',
  running: 'RUNNING', processing: 'RUNNING', queued: 'PENDING', pending: 'PENDING', created: 'PENDING'
};

function taskStatusOf(body) {
  const raw = String((body && (body.status || body.state)) || '').toLowerCase();
  return STATUS_OF[raw] || 'RUNNING';
}

/** 任务失败时的错误对象 */
function failureOf(payload, body) {
  const msg = (body && (body.failure_reason || body.failureReason || body.error || body.message))
    || (payload && payload.msg)
    || '生成失败';
  return {
    code: (body && (body.error_code || body.code)) || errorCode(payload, 200) || 'GRSAI_FAILED',
    message: String(msg),
    requestId: (body && body.id) || null
  };
}

function parseSubmit(json, httpStatus) {
  const raw = (json && typeof json.__raw === 'string') ? json.__raw : null;
  const payloads = raw ? parseSsePayloads(raw) : (json ? [json] : []);
  const httpFail = isHttpError(httpStatus);

  if (!payloads.length) {
    if (httpFail) {
      return { kind: 'error', error: { code: `HTTP_${httpStatus}`, message: errorMessage(json, httpStatus) } };
    }
    return {
      kind: 'error',
      error: { code: 'BAD_RESPONSE', message: '无法解析 Grsai 响应（既不是 JSON，也没有 SSE data 行）。' }
    };
  }

  const last = payloads[payloads.length - 1];
  const lastBody = bodyOf(last);

  if (httpFail) {
    return { kind: 'error', error: { code: errorCode(last, httpStatus), message: errorMessage(last, httpStatus) } };
  }
  // 业务错误码：Grsai 用 code === 0 表示成功
  const badCode = payloads.find((p) => p && p.code !== undefined && p.code !== 0 && !collectImages(bodyOf(p)).length);
  const failedEvent = payloads.find((p) => taskStatusOf(bodyOf(p)) === 'FAILED' || taskStatusOf(bodyOf(p)) === 'CANCELED');

  // 收集所有负载中的图片（含 data 包裹层）
  const images = [];
  for (const p of payloads) {
    for (const src of [p, bodyOf(p)]) {
      for (const u of collectImages(src)) if (!images.includes(u)) images.push(u);
    }
  }
  const requestId = (lastBody && lastBody.id) || (last && last.id) || null;

  if (images.length) {
    return {
      kind: 'result',
      images,
      texts: [],
      usage: normalizeUsage((lastBody && lastBody.usage) || (last && last.usage), images.length),
      requestId
    };
  }
  if (badCode || failedEvent) {
    const src = failedEvent || badCode;
    return { kind: 'error', error: failureOf(src, bodyOf(src)) };
  }
  // 只拿到任务 id：退化为轮询 /v1/draw/result
  const taskId = (lastBody && (lastBody.id || lastBody.task_id)) || (last && (last.id || last.task_id));
  if (taskId) {
    return { kind: 'task', taskId, taskStatus: taskStatusOf(lastBody), requestId };
  }
  return { kind: 'error', error: { code: 'NO_IMAGE', message: errorMessage(last, httpStatus) } };
}

/** 轮询查询（仅当服务端只返回任务 id 时才会用到） */
function buildTaskQuery(ctx) {
  const headers = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
  return {
    url: resultUrl(ctx.baseUrl),
    method: 'POST',
    headers,
    body: JSON.stringify({ id: ctx.taskId })
  };
}

function parseTask(json, httpStatus) {
  if (isHttpError(httpStatus)) {
    return { status: 'FAILED', error: { code: errorCode(json, httpStatus), message: errorMessage(json, httpStatus) } };
  }
  if (json && json.code !== undefined && json.code !== 0) {
    return { status: 'FAILED', error: { code: String(json.code), message: json.msg || '任务查询失败' } };
  }
  const body = bodyOf(json);
  const status = taskStatusOf(body);
  const images = collectImages(body);
  if (status === 'SUCCEEDED' || (images.length && status !== 'FAILED')) {
    return {
      status: 'SUCCEEDED',
      images,
      texts: [],
      usage: normalizeUsage(body && body.usage, images.length),
      requestId: (body && body.id) || null
    };
  }
  if (status === 'FAILED' || status === 'CANCELED') {
    return { status, error: failureOf(json, body) };
  }
  return { status };
}

function buildTaskCancel() {
  // Grsai 未提供取消接口：本地停止轮询即可
  return null;
}

module.exports = {
  id: 'grsai-image',
  label: 'Grsai 生图',
  defaultBaseUrl: DEFAULT_BASE_URL,
  defaultModel: 'gpt-image-2',
  supportsAsync: false,
  supportsImageInput: true,
  modelPlaceholder: '例如：gpt-image-2 / gpt-image-2.5',
  sizeOptions: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9', '1024x1024', '2048x2048'],
  paramSchema: {},
  buildSubmitRequest,
  parseSubmit,
  buildTaskQuery,
  parseTask,
  buildTaskCancel
};
