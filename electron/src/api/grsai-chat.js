'use strict';
/*
 * 协议适配器：Grsai 文本模型（对话生成模式）—— OpenAI 兼容 chat/completions，**流式**。
 *
 * 规则来源（工作区文档里用户给的接口示例）：
 *   POST {baseUrl}/chat/completions                 默认 https://grsai.dakka.com.cn/v1/chat/completions
 *     headers: Authorization: Bearer sk-xxx + Content-Type: application/json
 *     body: { model, stream: true, messages: [...] }
 *       messages[] 与 OpenAI 一致：
 *         · 纯文字：content 直接是字符串
 *         · 带图  ：content 是数组 [{type:'text',text}, {type:'image_url',image_url:{url}}]
 *                   url 用 **base64 data URL**（渲染进程已经把附件转好了），支持多图
 *   响应两种形态都要吃下：
 *     A) 流式（本适配器的主路径）：`data: {json}` 逐块，形如
 *        { id, object:'chat.completion.chunk', model, choices:[{index,delta:{role,content},finish_reason}],
 *          system_fingerprint }
 *        末尾一块带 finish_reason:'stop' 与 usage（prompt_tokens/completion_tokens/total_tokens），
 *        之后是 `data: [DONE]`。
 *     B) 非流式（服务端忽略 stream:true 或走非流式端点）：{ choices:[{message:{role,content}}], usage }
 *
 * 与图像适配器的两点不同：
 *   1) 声明 stream:true —— 执行器（runner.js）看到它就走「边收边发」的分支，增量文本以
 *      type:'delta' 事件推给渲染进程，气泡逐字显示；收尾仍是 type:'result'（texts:[全文]）。
 *   2) 不产出图片：parseSubmit / 流的收尾都返回 images: []，只有 texts。
 *
 * 无最大上下文限制：messages 由渲染进程按「当前对话里对话生成模式的消息」整体组装后传进来，
 * 适配器不截断、不裁剪（见 AIDEV.md 的对话生成模式一节）。
 */
const { normBase, endpoint, errorMessage, errorCode, isHttpError, createSseDecoder } = require('./util');

const DEFAULT_BASE_URL = 'https://grsai.dakka.com.cn/v1';
const CHAT_PATH = '/chat/completions';

/** 对话端点：base 已经是完整地址（用户直接粘了 .../chat/completions）时原样使用 */
function chatUrl(baseUrl) {
  return endpoint(baseUrl, CHAT_PATH, DEFAULT_BASE_URL);
}

// ---------- 消息与请求体 ----------

/**
 * 一条内部消息 → OpenAI 的 content。
 * 纯文字一律用字符串形式（兼容性最好，部分中转站不接受只含文本的数组）；
 * 带图才升级成数组，且**文字在前、图片在后**（与用户给的示例一致）。
 * @param msg {role, text, images?: string[]}  images = data URL / http(s) URL 列表
 */
function wireContent(msg) {
  const text = String((msg && msg.text) || '');
  const images = Array.isArray(msg && msg.images) ? msg.images.filter((u) => typeof u === 'string' && u) : [];
  if (!images.length) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/** 组装 wire 消息数组：只认 user / assistant（system 以后要用再说） */
function buildMessages(ctx) {
  const list = Array.isArray(ctx && ctx.messages) ? ctx.messages : [];
  return list
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: wireContent(m) }));
}

function buildSubmitRequest(ctx) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
  const body = {
    model: ctx.model,
    stream: true,                      // 对话生成一律流式：气泡要逐字显示
    messages: buildMessages(ctx)
  };
  return { url: chatUrl(ctx.baseUrl), method: 'POST', headers, body: JSON.stringify(body) };
}

// ---------- 响应解析 ----------

/** 增量文本：delta.content 可能是字符串，也可能是 [{type:'text',text}] 数组 */
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let out = '';
    for (const part of c) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part.text === 'string') out += part.text;
    }
    return out;
  }
  return '';
}

const deltaTextOf = (delta) => contentText(delta && delta.content);
const messageTextOf = (message) => contentText(message && message.content);

/** 取 usage（流式的最后一块才有；没有就不带） */
const usageOf = (json) => ((json && json.usage && typeof json.usage === 'object') ? json.usage : null);

function errorOf(json, httpStatus) {
  return { code: errorCode(json, httpStatus), message: errorMessage(json, httpStatus) };
}

/** 非流式响应（服务端忽略了 stream:true 时会走到这里） */
function parseSubmit(json, httpStatus) {
  if (isHttpError(httpStatus)) {
    return { kind: 'error', error: errorOf(json, httpStatus) };
  }
  if (json && json.error) {
    return { kind: 'error', error: errorOf(json, httpStatus) };
  }
  const ch = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const text = ch ? messageTextOf(ch.message) : '';
  if (!text) {
    return { kind: 'error', error: { code: 'EMPTY_REPLY', message: '模型没有返回任何内容。' } };
  }
  return {
    kind: 'result',
    images: [],                                  // 文本协议不产出图片
    texts: [text],
    usage: usageOf(json),
    requestId: (json && json.id) || null
  };
}

/**
 * 流式解析器：执行器每收到一个网络分块就 push()，拿回本次新增的文本。
 *
 * 状态都封在闭包里（一次请求一个解析器），所以同一个对话里多个请求不会互相串。
 * 解析器不管节流 —— 那是执行器的事（见 runner.js#STREAM_FLUSH_MS）。
 */
function createStreamParser() {
  const sse = createSseDecoder();
  let sawChunk = false;
  let usage = null;
  let requestId = null;
  let finishReason = null;
  let error = null;
  let model = null;

  /** 负载 → 本次新增文本（顺带收 usage / finish_reason / 业务错误） */
  const handle = (obj) => {
    if (!obj) return '';
    sawChunk = true;
    if (obj.error) {
      // 流中途报错：OpenAI 兼容接口用 {"error":{...}} 表示失败
      error = { code: errorCode(obj, 200) || 'UPSTREAM_ERROR', message: errorMessage(obj, 200) };
      return '';
    }
    if (obj.id) requestId = obj.id;
    if (obj.model) model = obj.model;
    if (obj.usage) usage = obj.usage;
    const ch = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (!ch) return '';
    if (ch.finish_reason) finishReason = ch.finish_reason;
    // 正常流式是 delta；但有些中转站会把**完整** message 塞进一块里（甚至整包 JSON 返回），
    // 所以两种都认：delta 优先，取不到再退回 message。
    return deltaTextOf(ch.delta) || messageTextOf(ch.message);
  };

  return {
    /** @returns {{deltas:string[], error:object|null, usage:object|null, requestId:string|null}} */
    push(chunk) {
      const payloads = sse.push(chunk);
      let text = '';
      for (const o of payloads) text += handle(o);
      return { deltas: text ? [text] : [], error, usage, requestId };
    },
    /**
     * 流结束：处理残留的半行。
     * @param raw 整个响应原文（兜底用：服务端没走 SSE、直接回了一整包 JSON）
     */
    end(raw) {
      let text = '';
      for (const o of sse.flush()) text += handle(o);
      // 一个负载都没解析出来，但 body 本身是完整 JSON → 当成非流式响应兜底
      if (!sawChunk && !text && raw) {
        let json = null;
        try { json = JSON.parse(String(raw)); } catch (e) { json = null; }
        if (json) {
          if (json.error) error = { code: errorCode(json, 200) || 'UPSTREAM_ERROR', message: errorMessage(json, 200) };
          else {
            const ch = Array.isArray(json.choices) ? json.choices[0] : null;
            text = ch ? messageTextOf(ch.message) : '';
            requestId = requestId || json.id || null;
            usage = usage || usageOf(json);
            finishReason = finishReason || (ch && ch.finish_reason) || null;
          }
        }
      }
      return {
        deltas: text ? [text] : [],
        error,
        usage,
        requestId,
        model,
        finishReason
      };
    }
  };
}

module.exports = {
  id: 'grsai-chat',
  label: 'Grsai 文本模型（OpenAI 兼容，流式）',
  // 流式标记：runner 看到它就走「边收边发」的分支
  stream: true,
  // 文本模型不是图像协议：不参与尺寸 / 图像参数面板
  supportsImageInput: false,
  isText: true,
  defaultBaseUrl: DEFAULT_BASE_URL,
  defaultModel: '',
  modelPlaceholder: '例如：gemini-3.5-flash',
  sizeOptions: [],
  paramSchema: {},
  DEFAULT_BASE_URL,
  CHAT_PATH,
  chatUrl,
  wireContent,
  buildMessages,
  buildSubmitRequest,
  parseSubmit,
  createStreamParser
};
