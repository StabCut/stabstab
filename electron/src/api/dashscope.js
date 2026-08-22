'use strict';
/*
 * DashScope 多模态生成协议适配器（千问图像系列：qwen-image-3.0-pro 等）。
 *
 * 规则来源（工作区文档）：
 *  - 同步：POST {baseUrl}/services/aigc/multimodal-generation/generation
 *      body: { model, input:{messages:[{role:'user',content:[{image:...},{text:...}]}]}, parameters:{...} }
 *      响应: output.choices[0].message.content[] -> [{image: url}]
 *  - 异步：同一端点 + 请求头 X-DashScope-Async: enable -> 返回 output.task_id
 *      轮询: GET {baseUrl}/tasks/{task_id}
 *      取消: POST {baseUrl}/tasks/{task_id}/cancel （仅 PENDING 可取消）
 *  - 图片输入：公开 URL 或 data:<mime>;base64,<data>，最多 3 张。
 *
 * 适配器接口（新增其它协议时照此实现并在 registry 注册）：
 *   id / label / defaultBaseUrl / defaultModel / sizeOptions / supportsAsync
 *   buildSubmitRequest(ctx) -> {url, method, headers, body}
 *   parseSubmit(json, httpStatus, mode) -> {kind:'result',...} | {kind:'task',...}
 *   buildTaskQuery(ctx) -> {url, method, headers}
 *   parseTask(json, httpStatus) -> {status:'SUCCEEDED'|'FAILED'|'RUNNING', ...}
 *   buildTaskCancel(ctx) -> {url, method, headers}
 */

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const GEN_PATH = '/services/aigc/multimodal-generation/generation';

function normBase(baseUrl) {
  let b = (baseUrl || DEFAULT_BASE_URL).trim();
  if (!b) b = DEFAULT_BASE_URL;
  return b.replace(/\/+$/, '');
}

/**
 * 组装请求体。
 * @param {object} ctx {model, prompt, images:[dataUrl], params:{size,n,negative_prompt,watermark,prompt_extend,seed}}
 */
function buildBody(ctx) {
  const content = [];
  for (const img of (ctx.images || [])) {
    content.push({ image: img });
  }
  if (ctx.prompt && String(ctx.prompt).trim()) {
    content.push({ text: String(ctx.prompt) });
  }
  const p = ctx.params || {};
  const parameters = {};
  if (typeof p.n === 'number' && p.n >= 1) parameters.n = Math.min(6, Math.round(p.n));
  if (p.size && p.size !== 'auto') parameters.size = p.size;
  if (typeof p.negative_prompt === 'string' && p.negative_prompt.trim()) {
    parameters.negative_prompt = p.negative_prompt;
  }
  if (typeof p.watermark === 'boolean') parameters.watermark = p.watermark;
  if (typeof p.prompt_extend === 'boolean') parameters.prompt_extend = p.prompt_extend;
  if (Number.isFinite(p.seed)) parameters.seed = Math.round(p.seed);

  return {
    model: ctx.model,
    input: { messages: [{ role: 'user', content }] },
    parameters
  };
}

function buildSubmitRequest(ctx) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ctx.apiKey || ''}`
  };
  if (ctx.mode === 'async') headers['X-DashScope-Async'] = 'enable';
  return {
    url: `${normBase(ctx.baseUrl)}${GEN_PATH}`,
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(ctx))
  };
}

/** 从同步成功响应或任务成功结果中提取图片 URL 列表 */
function extractResult(output, usage) {
  const images = [];
  // 新版结构：output.choices[].message.content[].image
  const choices = output && output.choices;
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      const content = ch && ch.message && ch.message.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && item.image) images.push(item.image);
        }
      }
    }
  }
  // 旧版结构（万相 2.5 及更早）：output.results[].url
  if (!images.length && Array.isArray(output && output.results)) {
    for (const r of output.results) {
      if (r && (r.url || r.image)) images.push(r.url || r.image);
    }
  }
  const texts = [];
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      const content = ch && ch.message && ch.message.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && item.text) texts.push(item.text);
        }
      }
    }
  } else if (output && typeof output.text === 'string' && output.text) {
    texts.push(output.text);
  }
  return { images, texts, usage: usage || null };
}

function parseSubmit(json, httpStatus, mode, requestId) {
  // 服务端错误：非 2xx 或带 code
  if (httpStatus < 200 || httpStatus >= 300 || (json && json.code)) {
    return {
      kind: 'error',
      error: {
        code: (json && json.code) || `HTTP_${httpStatus}`,
        message: (json && json.message) || `HTTP ${httpStatus}`,
        requestId: (json && json.request_id) || requestId || null
      }
    };
  }
  const output = json.output || {};
  if (mode === 'async' || output.task_id) {
    return {
      kind: 'task',
      taskId: output.task_id,
      taskStatus: output.task_status || 'PENDING',
      requestId: json.request_id || requestId || null
    };
  }
  const { images, texts, usage } = extractResult(output, json.usage);
  return {
    kind: 'result',
    images,
    texts,
    usage,
    requestId: json.request_id || requestId || null
  };
}

function buildTaskQuery(ctx) {
  return {
    url: `${normBase(ctx.baseUrl)}/tasks/${encodeURIComponent(ctx.taskId)}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${ctx.apiKey || ''}` }
  };
}

function parseTask(json, httpStatus) {
  const output = (json && json.output) || {};
  const status = output.task_status || 'UNKNOWN';
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      status: 'FAILED',
      error: {
        code: (json && json.code) || `HTTP_${httpStatus}`,
        message: (json && json.message) || `任务查询失败 (HTTP ${httpStatus})`,
        requestId: json && json.request_id
      }
    };
  }
  if (status === 'SUCCEEDED') {
    const { images, texts, usage } = extractResult(output, json.usage);
    return { status, images, texts, usage, requestId: json.request_id };
  }
  if (status === 'FAILED' || status === 'UNKNOWN' || status === 'CANCELED') {
    return {
      status,
      error: {
        code: output.code || status,
        message: output.message || `任务${status === 'CANCELED' ? '已取消' : '失败'}`,
        requestId: json.request_id
      }
    };
  }
  // PENDING / RUNNING
  return { status };
}

function buildTaskCancel(ctx) {
  return {
    url: `${normBase(ctx.baseUrl)}/tasks/${encodeURIComponent(ctx.taskId)}/cancel`,
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.apiKey || ''}` }
  };
}

module.exports = {
  id: 'dashscope-multimodal',
  label: 'DashScope 多模态生成（千问图像）',
  defaultBaseUrl: DEFAULT_BASE_URL,
  defaultModel: 'qwen-image-3.0-pro',
  supportsAsync: true,
  // 需求给定的 size 列表（+ 自动）
  sizeOptions: ['auto', '2688*1536', '2368*1728', '2048*2048', '1728*2368', '1536*2688'],
  paramSchema: {
    n: { type: 'int', min: 1, max: 6, default: 1, label: '生成张数 n' },
    negative_prompt: { type: 'string', default: '', label: '反向提示词' },
    watermark: { type: 'bool', default: false, label: '水印' },
    prompt_extend: { type: 'bool', default: true, label: '提示词改写' },
    seed: { type: 'int', min: 0, max: 2147483647, default: null, label: '随机种子' }
  },
  buildSubmitRequest,
  parseSubmit,
  buildTaskQuery,
  parseTask,
  buildTaskCancel
};
