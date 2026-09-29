'use strict';
/*
 * 协议适配器公共小工具（各适配器共用，避免重复实现）。
 */

/** 去掉首尾空白与结尾斜杠；空则回退默认地址 */
function normBase(baseUrl, fallback) {
  let b = String(baseUrl || '').trim();
  if (!b) b = String(fallback || '').trim();
  return b.replace(/\/+$/, '');
}

/**
 * 拼端点：base 已经是完整端点（用户直接粘贴了完整地址）时原样返回，否则追加 path。
 * @example endpoint('https://ark.cn-beijing.volces.com/api/v3', '/images/generations')
 *          endpoint('https://ark.cn-beijing.volces.com/api/v3/images/generations', '/images/generations') // 原样
 */
function endpoint(baseUrl, path, fallback) {
  const b = normBase(baseUrl, fallback);
  if (!b) return path;
  if (b.endsWith(path)) return b;
  return b + path;
}

const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

/** b64 → data URL（结果图可能是 b64_json） */
function b64ToDataUrl(b64, format) {
  const mime = /jpe?g/i.test(String(format || '')) ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${String(b64).replace(/\s+/g, '')}`;
}

/**
 * 从各种「OpenAI 兼容 / 图生图」响应结构里收集结果图片地址。
 * 返回元素可能是 http(s) URL 或 data:base64 URL。
 */
function collectImages(json) {
  const out = [];
  const push = (v, format) => {
    if (typeof v !== 'string' || !v) return;
    if (/^https?:\/\//i.test(v) || DATA_URL_RE.test(v)) out.push(v);
    else if (v.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 200))) out.push(b64ToDataUrl(v, format));
  };
  const pushItem = (item) => {
    if (typeof item === 'string') return push(item);
    if (!item || typeof item !== 'object') return;
    const fmt = item.output_format || item.format;
    push(item.url || item.image_url || item.image, fmt);
    if (item.b64_json || item.b64 || item.base64) push(b64ToDataUrl(item.b64_json || item.b64 || item.base64, fmt), fmt);
  };

  const lists = [
    json && json.data,
    json && json.output && json.output.data,
    json && json.output && json.output.results,
    json && json.results,
    json && json.output && json.output.images,
    json && json.images,
    json && json.urls
  ];
  for (const list of lists) {
    if (Array.isArray(list)) list.forEach(pushItem);
    else if (typeof list === 'string') push(list);
  }
  if (!out.length) {
    push(json && json.url);
    push(json && json.image_url);
    push(json && json.output && json.output.url);
    push(json && json.output && json.output.image);
    if (json && (json.b64_json || json.b64)) push(b64ToDataUrl(json.b64_json || json.b64, json.output_format));
  }
  // 去重（保留顺序）
  return Array.from(new Set(out));
}

/** 尽量从错误响应里挖出一句人话 */
function errorMessage(json, httpStatus) {
  if (!json) return `HTTP ${httpStatus}`;
  return (json.error && (json.error.message || json.error.code))
    || json.message || json.msg || json.error_msg || json.detail
    || `HTTP ${httpStatus}`;
}

function errorCode(json, httpStatus) {
  if (!json) return `HTTP_${httpStatus}`;
  const c = (json.error && (json.error.code || json.error.type)) || json.code || json.error_code;
  return c ? String(c) : `HTTP_${httpStatus}`;
}

/** 统一判定「这个响应是不是错误」 */
function isHttpError(httpStatus) {
  return httpStatus < 200 || httpStatus >= 300;
}

/** usage 归一化：界面只认 output_image_count / output_width / output_height */
function normalizeUsage(usage, imageCount) {
  const u = (usage && typeof usage === 'object') ? { ...usage } : {};
  if (u.output_image_count == null) {
    if (u.generated_images != null) u.output_image_count = Number(u.generated_images);
    else if (imageCount != null) u.output_image_count = imageCount;
  }
  return u;
}

module.exports = {
  normBase,
  endpoint,
  b64ToDataUrl,
  collectImages,
  errorMessage,
  errorCode,
  isHttpError,
  normalizeUsage,
  DATA_URL_RE
};
