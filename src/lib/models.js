/*
 * 模型系列 / 模型解析（渲染进程侧）
 * ================================
 * 数据结构（见 electron/src/store.js 与 electron/assets/model-series.json）：
 *   settings.modelGroups   [{ seriesId, models:[{id,name,sourceId}] }]  已添加的模型系列
 *   settings.sourceConfig  { '<seriesId>.<sourceId>': {apiKey, baseUrl} }
 *   state.modelSeries      { series:[{id,label,sources:[{id,label,protocol,baseUrl,sizeOptions,…}],requestMode,…}] }
 *
 * 注意：主进程 electron/src/modelSeries.js 里的 resolveModel 是发请求时的权威口径，
 *       本文件只服务于界面（下拉框、尺寸列表、参数面板、提示文案），两者需保持同一套规则。
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
 * @param protocols state.protocols（主进程下发的适配器元信息：sizeOptions/paramSchema/supportsAsync…）
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
  const rm = (series && series.requestMode) || {};
  const canAsync = !!(rm.supported && protocolInfo && protocolInfo.supportsAsync);
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
    canAsync,
    mode: (canAsync && rm.value === 'async') ? 'async' : 'sync',
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

/** 尺寸下拉的展示文案：auto / 2688×1536 / 16:9 / 2K */
export function sizeLabel(s) {
  if (s === 'auto') return '尺寸：自动（模型推荐）';
  const m = /^(\d+)\s*[*x×]\s*(\d+)$/i.exec(String(s));
  if (m) return `尺寸：${m[1]}×${m[2]}`;
  return `尺寸：${s}`;
}
