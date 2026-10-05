'use strict';
/*
 * DashScope 多模态生成协议适配器（千问图像系列：qwen-image-3.0-pro 等）。
 *
 * 规则来源（工作区文档）：
 *  - 同步：POST {baseUrl}/services/aigc/multimodal-generation/generation
 *      body: { model, input:{messages:[{role:'user',content:[{image:...},{text:...}]}]}, parameters:{...} }
 *      响应: output.choices[0].message.content[] -> [{image: url}]（旧版 output.results[].url）
 *  - 图片输入：公开 URL 或 data:<mime>;base64,<data>，最多 3 张。
 *  - **没有异步模式**：不发送 X-DashScope-Async 请求头、不轮询 /tasks/{id}、没有取消接口。
 *    一次请求阻塞等待图片返回（见 AIDEV.md §4.12）。
 *
 * 适配器接口（新增其它协议时照此实现并在 registry 注册）：
 *   id / label / defaultBaseUrl / defaultModel / sizeOptions
 *   buildSubmitRequest(ctx) -> {url, method, headers, body}
 *   parseSubmit(json, httpStatus) -> {kind:'result',...} | {kind:'error',...}
 *   （可选，仅当服务端只能给任务 id 时）buildTaskQuery / parseTask / buildTaskCancel
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
  return {
    url: `${normBase(ctx.baseUrl)}${GEN_PATH}`,
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(ctx))
  };
}

/** 从成功响应中提取图片 URL 列表 */
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

function parseSubmit(json, httpStatus) {
  // 服务端错误：非 2xx 或带 code
  if (httpStatus < 200 || httpStatus >= 300 || (json && json.code)) {
    return {
      kind: 'error',
      error: {
        code: (json && json.code) || `HTTP_${httpStatus}`,
        message: (json && json.message) || `HTTP ${httpStatus}`,
        requestId: (json && json.request_id) || null
      }
    };
  }
  const { images, texts, usage } = extractResult(json.output || {}, json.usage);
  return {
    kind: 'result',
    images,
    texts,
    usage,
    requestId: json.request_id || null
  };
}

module.exports = {
  id: 'dashscope-multimodal',
  label: 'DashScope 多模态生成（千问图像）',
  defaultBaseUrl: DEFAULT_BASE_URL,
  defaultModel: 'qwen-image-3.0-pro',
  // 候选尺寸（仅当来源没有自己的 sizeOptions 时才作为兜底）：
  // 官方「常见比例推荐分辨率」（1:1 / 3:2 / 2:3 / 4:3 / 3:4 / 16:9 / 9:16 / 21:9）+ 旧候选，见 model-series.json
  sizeOptions: [
    'auto',
    '1024*1024', '1536*1536', '2048*2048',
    '1280*960', '960*1280',
    '1152*768', '1536*1024', '768*1152', '1024*1536',
    '1280*720', '1920*1080', '720*1280', '1080*1920',
    '1344*576',
    '2688*1536', '2368*1728', '1728*2368', '1536*2688'
  ],
  paramSchema: {
    n: { type: 'int', min: 1, max: 6, default: 1, label: '生成张数 n' },
    negative_prompt: { type: 'string', default: '', label: '反向提示词' },
    watermark: { type: 'bool', default: false, label: '水印' },
    prompt_extend: { type: 'bool', default: true, label: '提示词改写' },
    seed: { type: 'int', min: 0, max: 2147483647, default: null, label: '随机种子' }
  },
  buildSubmitRequest,
  parseSubmit
};
