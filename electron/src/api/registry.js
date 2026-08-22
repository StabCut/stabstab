'use strict';
/*
 * 协议适配器注册表。
 * 新增「另一套 API 请求与解析规则」的模型时：
 *   1. 在 electron/src/api/ 下新建适配器文件（参照 dashscope.js 的接口）；
 *   2. 在下方 adapters 中注册；
 *   3. 前端设置页协议下拉会自动出现该选项。
 * reserved 列表用于在 UI 中展示「预留但未实现」的协议（占位、禁用）。
 */
const dashscope = require('./dashscope');

const adapters = {
  [dashscope.id]: dashscope
  // 未来示例：
  // 'openai-images': require('./openai-images'),
  // 'sd-webui': require('./sd-webui'),
};

const reserved = [
  { id: 'openai-images', label: 'OpenAI Images API（预留，暂未实现）' },
  { id: 'openai-compatible', label: 'OpenAI 兼容协议（预留，暂未实现）' },
  { id: 'sd-webui', label: 'Stable Diffusion WebUI（预留，暂未实现）' }
];

function getAdapter(id) {
  return adapters[id] || null;
}

function listProtocols() {
  const active = Object.values(adapters).map(a => ({
    id: a.id,
    label: a.label,
    available: true,
    supportsAsync: !!a.supportsAsync,
    defaultBaseUrl: a.defaultBaseUrl,
    defaultModel: a.defaultModel,
    sizeOptions: a.sizeOptions || ['auto']
  }));
  const pending = reserved
    .filter(r => !adapters[r.id])
    .map(r => ({ id: r.id, label: r.label, available: false }));
  return [...active, ...pending];
}

module.exports = { getAdapter, listProtocols, adapters };
