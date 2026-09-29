'use strict';
/*
 * 协议适配器注册表。
 *
 * 「模型系列 → API 来源 → 协议适配器」是三层关系：
 *   - 系列与来源定义在 electron/assets/model-series.json（内置，可被数据目录副本覆盖）；
 *   - 每个来源通过 sources[].protocol 绑定到下面 adapters 里的一个适配器；
 *   - 新增一套 API 规则时：写一个适配器文件 → 在 adapters 注册 → 在 model-series.json 里挂到某个系列的 sources。
 *
 * reserved 列表用于在 UI 中展示「预留但未实现」的协议（占位、禁用）。
 */
const dashscope = require('./dashscope');
const seedream = require('./seedream');
const newapiImages = require('./newapi-images');
const grsai = require('./grsai');

const adapters = {
  [dashscope.id]: dashscope,        // qwen 系列·官方（DashScope 多模态，同步 + 异步）
  [seedream.id]: seedream,          // Doubao Seedream 系列·官方（火山方舟 Ark）
  [newapiImages.id]: newapiImages,  // Doubao Seedream / GPT Image 系列·New API（OpenAI 兼容）
  [grsai.id]: grsai                 // GPT Image 系列·Grsai
};

const reserved = [
  { id: 'sd-webui', label: 'Stable Diffusion WebUI（预留，暂未实现）' }
];

function getAdapter(id) {
  return adapters[id] || null;
}

function listProtocols() {
  const active = Object.values(adapters).map((a) => ({
    id: a.id,
    label: a.label,
    available: true,
    supportsAsync: !!a.supportsAsync,
    supportsImageInput: a.supportsImageInput !== false,
    defaultBaseUrl: a.defaultBaseUrl,
    defaultModel: a.defaultModel,
    modelPlaceholder: a.modelPlaceholder || '',
    sizeOptions: a.sizeOptions || ['auto'],
    paramSchema: a.paramSchema || {}
  }));
  const pending = reserved
    .filter((r) => !adapters[r.id])
    .map((r) => ({ id: r.id, label: r.label, available: false }));
  return [...active, ...pending];
}

module.exports = { getAdapter, listProtocols, adapters };
