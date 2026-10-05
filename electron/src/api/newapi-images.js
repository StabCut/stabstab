'use strict';
/*
 * 协议适配器：New API（OpenAI 兼容的图像生成端点）
 *  —— Doubao Seedream 的「New API」来源与 GPT Image 系列的「NewApi」来源共用本适配器。
 *
 * 规则来源（工作区文档 seedream系列api.md / gpt-image系列.md 的 New Api 部分）：
 *  - 同步：POST {baseUrl}/images/generations
 *      headers: Authorization: Bearer <TOKEN>
 *      body: { model, prompt, size?, n?, quality?, style?, response_format?, image? }
 *      size 枚举默认 1024x1024；quality 默认 standard；style 默认 vivid；n 默认 1（1~10）；response_format 默认 url
 *      响应: { data:[{ url | b64_json }] }
 *  - 无异步模式：单次请求阻塞等待图片返回。
 *
 * 说明：模型 id 由用户填写（如 gpt-image-2 / doubao-seedream-5.0-pro）。
 *       带输入图时按图生图发送 image 字段（单图 → 字符串，多图 → 数组），
 *       部分 New API 部署不支持该字段，此时会由服务端返回错误，便于用户改用别的方式。
 */
const { endpoint, collectImages, errorMessage, errorCode, isHttpError, normalizeUsage } = require('./util');

const DEFAULT_BASE_URL = 'https://toprouter.sealoshzh.site/v1';
const GEN_PATH = '/images/generations';

function buildBody(ctx) {
  const p = ctx.params || {};
  const images = Array.isArray(ctx.images) ? ctx.images.filter(Boolean) : [];
  const body = {
    model: ctx.model,
    prompt: String(ctx.prompt || '')
  };
  if (p.size && p.size !== 'auto') body.size = p.size;
  const n = Number(p.n);
  if (Number.isFinite(n) && n >= 1) body.n = Math.min(10, Math.round(n));
  if (p.quality) body.quality = p.quality;
  if (p.style) body.style = p.style;
  body.response_format = 'url';
  if (images.length === 1) body.image = images[0];
  else if (images.length > 1) body.image = images;
  return body;
}

function buildSubmitRequest(ctx) {
  return {
    url: endpoint(ctx.baseUrl, GEN_PATH, DEFAULT_BASE_URL),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.apiKey || ''}`,
      Accept: 'application/json'
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
    return {
      kind: 'error',
      error: {
        code: 'NO_IMAGE',
        message: msg === `HTTP ${httpStatus}` ? '接口未返回图片（请检查模型 id 与令牌权限）。' : msg,
        requestId
      }
    };
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
  id: 'newapi-images',
  label: 'New API（OpenAI 兼容图像生成）',
  defaultBaseUrl: DEFAULT_BASE_URL,
  defaultModel: 'gpt-image-2',
  supportsImageInput: true,
  modelPlaceholder: '例如：gpt-image-2',
  sizeOptions: ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '1792x1024', '1024x1792'],
  paramSchema: {
    n: { type: 'int', min: 1, max: 10, default: 1, label: '生成张数 n' },
    quality: { type: 'enum', default: '', options: ['', 'standard', 'hd', 'high', 'medium', 'low'], label: '质量 quality' },
    style: { type: 'enum', default: '', options: ['', 'vivid', 'natural'], label: '画风 style' }
  },
  buildSubmitRequest,
  parseSubmit
};
