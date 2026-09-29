'use strict';
/*
 * 协议适配器：Doubao Seedream —— 官方来源（火山方舟 Ark）
 *
 * 规则来源（工作区文档 seedream系列api.md + 火山方舟图像生成 API）：
 *  - 同步：POST {baseUrl}/images/generations
 *      headers: Authorization: Bearer <ARK_API_KEY>
 *      body: { model, prompt, size?, image?, response_format:'url', watermark?, output_format? }
 *      size 支持 1K/2K/4K 这类预设，或 2048x2048 这类像素值（两者不可混用）
 *      image 可为单个 URL / data:base64，或它们的数组（图生图 / 多参考图）
 *      响应: { data:[{ url }] }（response_format=url），usage 里带 generated_images
 *  - 无异步模式：单次请求阻塞等待图片返回（不发送 task 轮询）。
 *
 * 注意：Ark 文档明确「不要传不支持的参数」（例如 Pro 模型拒绝 sequential_image_generation / stream / tools），
 *       所以这里只发送上面列出的字段，且可选字段一律由用户在参数面板显式勾选后才发送。
 */
const { endpoint, collectImages, errorMessage, errorCode, isHttpError, normalizeUsage } = require('./util');

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const GEN_PATH = '/images/generations';

function buildBody(ctx) {
  const p = ctx.params || {};
  const body = {
    model: ctx.model,
    prompt: String(ctx.prompt || '')
  };
  const images = Array.isArray(ctx.images) ? ctx.images.filter(Boolean) : [];
  if (images.length === 1) body.image = images[0];
  else if (images.length > 1) body.image = images;

  if (p.size && p.size !== 'auto') body.size = p.size;
  body.response_format = 'url';
  if (typeof p.watermark === 'boolean') body.watermark = p.watermark;
  if (p.output_format === 'png' || p.output_format === 'jpeg') body.output_format = p.output_format;
  return body;
}

function buildSubmitRequest(ctx) {
  return {
    url: endpoint(ctx.baseUrl, GEN_PATH, DEFAULT_BASE_URL),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.apiKey || ''}`
    },
    body: JSON.stringify(buildBody(ctx))
  };
}

function parseSubmit(json, httpStatus) {
  if (isHttpError(httpStatus)) {
    return { kind: 'error', error: { code: errorCode(json, httpStatus), message: errorMessage(json, httpStatus), requestId: (json && (json.request_id || json.id)) || null } };
  }
  if (json && json.error) {
    return { kind: 'error', error: { code: errorCode(json, httpStatus), message: errorMessage(json, httpStatus), requestId: (json && json.id) || null } };
  }
  const images = collectImages(json);
  const requestId = (json && (json.id || json.request_id)) || null;
  if (!images.length) {
    const msg = errorMessage(json, httpStatus);
    return { kind: 'error', error: { code: 'NO_IMAGE', message: msg === `HTTP ${httpStatus}` ? '接口未返回图片（请检查模型 id 是否为 Seedream 图像模型）。' : msg, requestId } };
  }
  return {
    kind: 'result',
    images,
    texts: [],
    usage: normalizeUsage(json && json.usage, images.length),
    requestId
  };
}

module.exports = {
  id: 'seedream-official',
  label: 'Doubao Seedream 官方（火山方舟 Ark）',
  defaultBaseUrl: DEFAULT_BASE_URL,
  defaultModel: 'doubao-seedream-4-0-250828',
  supportsAsync: false,
  supportsImageInput: true,
  modelPlaceholder: '例如：doubao-seedream-4-0-250828',
  sizeOptions: ['auto', '1K', '2K', '4K', '1024x1024', '2048x2048', '1536x1024', '1024x1536', '1280x720', '720x1280'],
  paramSchema: {
    watermark: { type: 'bool', default: false, label: '水印' },
    output_format: { type: 'enum', default: '', options: ['', 'png', 'jpeg'], label: '输出格式（部分模型支持）' }
  },
  buildSubmitRequest,
  parseSubmit
};
