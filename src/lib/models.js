/*
 * 模型系列 / 模型解析（渲染进程侧）
 * ================================
 * 数据结构（见 electron/src/store.js 与 electron/assets/model-series.json）：
 *   settings.modelGroups   [{ seriesId, models:[{id,name,sourceId}] }]  已添加的模型系列
 *   settings.sourceConfig  { '<seriesId>.<sourceId>': {apiKey, baseUrl} }
 *   state.modelSeries      { series:[{id,label,sources:[{id,label,protocol,baseUrl,sizeOptions,…}],…}] }
 *
 * 注意：主进程 electron/src/modelSeries.js 里的 resolveModel 是发请求时的权威口径，
 *       本文件只服务于界面（下拉框、尺寸列表、参数面板、提示文案），两者需保持同一套规则。
 *       请求模式只有「同步」一种（见 AIDEV.md §4.12），界面不再解析 mode / 异步开关。
 */

export function seriesById(modelSeries, id) {
  const list = (modelSeries && modelSeries.series) || [];
  return list.find((s) => s.id === id) || null;
}

export function sourceOf(series, sourceId) {
  const list = (series && series.sources) || [];
  return list.find((s) => s.id === sourceId) || list[0] || null;
}

export function sourceKey(seriesId, sourceId) {
  return `${seriesId}.${sourceId}`;
}

export function sourceConfigOf(settings, seriesId, sourceId) {
  const all = (settings && settings.sourceConfig) || {};
  const cfg = all[sourceKey(seriesId, sourceId)] || {};
  return { apiKey: cfg.apiKey || '', baseUrl: cfg.baseUrl || '' };
}

/** 可见（未被用户移除）的系列，按内置顺序 */
export function visibleSeries(modelSeries) {
  const list = (modelSeries && modelSeries.series) || [];
  return list.filter((s) => !s.hidden);
}

/** 扁平模型列表：输入区下拉框用（跨系列按系列顺序） */
export function allModels(settings, modelSeries) {
  const groups = (settings && settings.modelGroups) || [];
  const out = [];
  for (const series of visibleSeries(modelSeries)) {
    const g = groups.find((x) => x.seriesId === series.id);
    if (!g) continue;
    for (const m of (g.models || [])) {
      const source = sourceOf(series, m.sourceId);
      out.push({
        id: m.id,
        name: m.name,
        seriesId: series.id,
        seriesLabel: series.label,
        sourceId: source ? source.id : null,
        sourceLabel: source ? source.label : '',
        protocol: (source && source.protocol) || series.protocol || null
      });
    }
  }
  return out;
}

/**
 * 解析一个模型 id → 界面需要的全部信息。
 * 只有同步一种请求模式，因此没有 mode / canAsync（见 AIDEV.md §4.12）。
 * @param protocols state.protocols（主进程下发的适配器元信息：sizeOptions/paramSchema…）
 */
export function resolveModel(settings, modelSeries, protocols, modelId) {
  const groups = (settings && settings.modelGroups) || [];
  let group = groups.find((g) => (g.models || []).some((m) => m.id === modelId)) || null;
  let model = group ? (group.models || []).find((m) => m.id === modelId) : null;
  if (!model && settings && settings.defaultModelId) {
    group = groups.find((g) => (g.models || []).some((m) => m.id === settings.defaultModelId)) || null;
    model = group ? (group.models || []).find((m) => m.id === settings.defaultModelId) : null;
  }
  if (!model) return null;

  const series = seriesById(modelSeries, group.seriesId);
  const source = sourceOf(series, model.sourceId);
  const protocol = (source && source.protocol) || (series && series.protocol) || null;
  const protocolInfo = (protocols || []).find((p) => p.id === protocol) || null;
  const sc = sourceConfigOf(settings, group.seriesId, source ? source.id : '');
  const apiKey = sc.apiKey || '';
  return {
    id: model.id,
    name: model.name,
    seriesId: group.seriesId,
    series,
    seriesLabel: series ? series.label : group.seriesId,
    sourceId: source ? source.id : null,
    source,
    sourceLabel: source ? source.label : '',
    protocol,
    protocolInfo,
    apiKey,
    hasKey: !!apiKey.trim(),
    baseUrl: (sc.baseUrl && sc.baseUrl.trim()) || (source && source.baseUrl) || (protocolInfo && protocolInfo.defaultBaseUrl) || '',
    sizeOptions: (source && source.sizeOptions) || (protocolInfo && protocolInfo.sizeOptions) || ['auto'],
    paramSchema: (protocolInfo && protocolInfo.paramSchema) || {},
    supportsImageInput: !protocolInfo || protocolInfo.supportsImageInput !== false,
    hidden: !!(series && series.hidden)
  };
}

/** 该系列在当前设置里已添加的模型 */
export function modelsOfSeries(settings, seriesId) {
  const g = ((settings && settings.modelGroups) || []).find((x) => x.seriesId === seriesId);
  return (g && g.models) || [];
}

/** 尺寸下拉的展示文案：auto / 2688×1536 · 7:4 / 16:9 / 2K（像素尺寸后面带上比例，见 §4.10） */
export function sizeLabel(s) {
  if (s === 'auto') return '尺寸：自动（模型推荐）';
  const m = /^(\d+)\s*[*x×]\s*(\d+)$/i.exec(String(s));
  if (m) return `尺寸：${m[1]}×${m[2]} · ${ratioText(parseInt(m[1], 10), parseInt(m[2], 10))}`;
  // 比例串（16:9）本身就是比例；1K / 2K / 4K 这类档位的比例由模型决定，都不再追加
  return `尺寸：${s}`;
}

/* ---------------- 比例（尺寸选择器右侧的「比例 + 方框示例」） ----------------
 * 比例 = 宽 / 高：像素尺寸能算出确切比例，比例串本身就是比例，
 * auto / 1K / 2K / 4K 这类档位没有确定比例 → 一律显示 '-'（方框位置也显示 '-'）。
 */

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) { const t = x % y; x = y; y = t; }
  return x || 1;
}

/**
 * 两个正数 → 比例文案。
 * 先按最大公约数约分成最简整数比（2048×1152 → 16:9）；任一边超过两位数时改显示小数比（1000×333 → 3.00:1）。
 * 任一边 ≤ 0 / 非数字（除 0 问题）→ '-'。
 */
export function ratioText(w, h) {
  const W = Number(w);
  const H = Number(h);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return '-';
  const g = gcd(W, H);
  const a = Math.round(W) / g;
  const b = Math.round(H) / g;
  if (a <= 99 && b <= 99) return `${a}:${b}`;
  return `${(W / H).toFixed(2)}:1`;
}

/**
 * 从一个尺寸值里取出「已知的比例」（供方框示例按比例真实绘制）。
 *   像素尺寸（2688*1536 / 1024x768）→ {w,h}
 *   比例串（16:9 / 4:3）            → {w,h}
 *   auto / 1K / 2K / 4K            → null（比例由模型决定）
 * @returns {{w:number,h:number}|null}
 */
export function sizeRatioOf(value) {
  const d = parseSizeDims(value);
  if (d) return { w: d.w, h: d.h };
  const m = /^(\d{1,3})\s*[:：]\s*(\d{1,3})$/.exec(String(value === undefined || value === null ? '' : value).trim());
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!w || !h) return null;
  return { w, h };
}

/** 尺寸值的比例文案（取不到比例时为 '-'） */
export function ratioLabel(value) {
  const r = sizeRatioOf(value);
  return r ? ratioText(r.w, r.h) : '-';
}

/* ---------------- 自定义尺寸（尺寸选择器末尾的「自定义」） ----------------
 * 用户只填**两个数字**，中间的乘号是固定的：界面上一律显示 `×`，
 * 真正发给 API 的值按协议拼回去（见 sizeSeparator）。
 */

/** 尺寸下拉里「自定义」这一项的哨兵值（不是真正发给 API 的尺寸） */
export const CUSTOM_SIZE = '__custom__';

/**
 * 解析像素尺寸：`2688*1536` / `2048x2048` / `1024×1024` 都认。
 * @returns {{w:number,h:number}|null} 不是像素尺寸（auto / 1K / 16:9 …）时返回 null
 */
export function parseSizeDims(s) {
  const m = /^(\d{1,5})\s*[*x×X]\s*(\d{1,5})$/.exec(String(s === undefined || s === null ? '' : s).trim());
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!w || !h) return null;
  return { w, h };
}

/**
 * 自定义尺寸里两个数字之间**用什么符号拼**（用户不用管，由协议决定）：
 * DashScope（Qwen 系列）要 `宽*高`；Seedream / New API / Grsai 用 `宽x高`。
 */
export function sizeSeparator(model) {
  const protocol = model && (model.protocol || (model.protocolInfo && model.protocolInfo.id));
  return protocol === 'dashscope-multimodal' ? '*' : 'x';
}

/** 按当前协议规范化尺寸值（不是像素尺寸则原样返回）：自定义尺寸换模型后符号自动跟着变 */
export function normalizeSize(model, value) {
  const d = parseSizeDims(value);
  if (!d) return value;
  return `${d.w}${sizeSeparator(model)}${d.h}`;
}

/** 尺寸是否可用：候选列表里的值，或用户自己填的像素尺寸 */
export function isValidSize(model, value, options) {
  const opts = (options && options.length) ? options : ((model && model.sizeOptions) || []);
  return opts.includes(value) || !!parseSizeDims(value);
}
