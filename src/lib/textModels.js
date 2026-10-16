/*
 * 文本模型系列 / 文本模型解析（渲染进程侧，「对话生成」模式）
 * =========================================================
 * 数据结构（见 electron/src/textModelSeries.js 与 electron/assets/text-model-series.json）：
 *   settings.textModelId       ''                                      当前选中的文本模型 id（空 = 用系列的 defaultModelId）
 *   settings.textSourceConfig  { '<seriesId>.<sourceId>': {apiKey, baseUrl} }
 *   state.textModelSeries      { series:[{id,label,description,builtin,protocol,defaultModelId,
 *                                        models:[{id},…], sources:[{id,label,protocol,baseUrl,apiKeyUrl,hint}]}] }
 *
 * 注意：主进程 electron/src/textModelSeries.js 里的 resolveTextModel 是发请求时的权威口径，
 *       本文件只服务于界面（输入区的文本模型下拉框、设置页「文本模型」页）—— 两处同口径，
 *       改规则时两处都要改。文本侧没有「同步 / 异步」开关：一律流式 SSE（见 AIDEV.md §4.20）。
 *
 * 与图像模型（model-series.json / settings.modelGroups / settings.sourceConfig / resolveModel）**完全隔离**：
 * 两条链各自一份 json、各自一组 settings 字段，互不读写、互不干扰 —— 改图像那条不会影响文本模型，反之亦然。
 */

/** 可见（未被用户移除）的文本系列，按内置顺序；includeHidden = true 时连 removed 的一起给（设置页仍要能重新见到） */
export function textSeriesOf(textModelSeries, { includeHidden = false } = {}) {
  const list = (textModelSeries && textModelSeries.series) || [];
  return includeHidden ? list.slice() : list.filter((s) => !s.hidden);
}

/** 系列里的某个来源（找不到时退回第一个来源 —— 文本侧只有一个内置来源，两种口径结果一致） */
export function textSourceOf(series, sourceId) {
  const list = (series && series.sources) || [];
  return list.find((s) => s.id === sourceId) || list[0] || null;
}

/** 设置里「来源级配置」的键：`<seriesId>.<sourceId>`（文本侧存 settings.textSourceConfig） */
export function textSourceKey(seriesId, sourceId) {
  return `${seriesId}.${sourceId}`;
}

/** 取某个「系列·来源」的密钥与地址覆盖；baseUrl 为空 = 用 json 里的默认地址 */
export function textSourceConfigOf(settings, seriesId, sourceId) {
  const all = (settings && settings.textSourceConfig) || {};
  const cfg = all[textSourceKey(seriesId, sourceId)] || {};
  return { apiKey: cfg.apiKey || '', baseUrl: cfg.baseUrl || '' };
}

/** 该系列的默认模型 id（用户没选过任何模型时用它） */
export function textDefaultModelId(textModelSeries, seriesId) {
  const series = ((textModelSeries && textModelSeries.series) || []).find((s) => s.id === seriesId);
  return String((series && series.defaultModelId) || '').trim();
}

/** 系列的模型 id 清单（内置顺序即 json 里的顺序，只能增不能删，见 text-model-series.json 的 _readme） */
function modelIdsOf(series) {
  const out = [];
  for (const m of (series && series.models) || []) {
    const id = typeof m === 'string' ? m.trim() : String((m && m.id) || '').trim();
    if (id) out.push(id);
  }
  return out;
}

/**
 * 调用方给的模型选择值可能是三种东西，统一取「真正的模型 id」：
 *   · 复合选择值 `<seriesId>.<sourceId>::<modelId>`（下拉框的 value，见 allTextModels）→ 取 `::` 之后那一段
 *   · 图像模型 id / 清单里没有的脏值 → 原样返回，由 resolveTextModel 判定「不认识」并回落
 *   · ''（调用方只想拿「当前默认」）→ ''
 */
function rawModelIdOf(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  const i = s.indexOf('::');
  return i >= 0 ? s.slice(i + 2).trim() : s;
}

/**
 * 扁平模型列表：输入区下拉框用（可见系列的 系列 × 来源 × 内置模型 展开，保持 json 里的顺序）。
 * id 形如 `<seriesId>.<sourceId>::<modelId>` —— 同一个模型 id 以后可能挂在两个来源下，
 * 用它当唯一键才能区分；真正发给主进程（window.stab.chat / lib/send.js）的是 **modelId** 这个字段。
 * seriesDefaultModelId = 该系列的 defaultModelId，供输入区在「用户没选过」时落到内置默认。
 */
export function allTextModels(settings, textModelSeries) {
  const out = [];
  for (const series of textSeriesOf(textModelSeries)) {
    for (const source of (series.sources || [])) {
      if (!source || !source.id) continue;
      const cfg = textSourceConfigOf(settings, series.id, source.id);
      const baseUrl = String(cfg.baseUrl || '').trim() || String(source.baseUrl || '').trim();
      for (const modelId of modelIdsOf(series)) {
        out.push({
          id: `${series.id}.${source.id}::${modelId}`,
          name: modelId,
          modelId,
          seriesId: series.id,
          seriesLabel: series.label,
          seriesDefaultModelId: String(series.defaultModelId || '').trim(),
          sourceId: source.id,
          sourceLabel: source.label,
          protocol: source.protocol || series.protocol || null,
          hasKey: !!String(cfg.apiKey || '').trim(),
          baseUrl
        });
      }
    }
  }
  return out;
}

/**
 * 解析一个文本模型选择值 → 界面需要的全部信息（与主进程 textModelSeries.js#resolveTextModel 同口径）。
 *
 * 口径（两处必须一致）：
 *   · 生效模型：参数 → settings.textModelId → 系列的 defaultModelId → 清单第一个
 *   · 认领这个 id 的系列优先（清单里命中）；都不命中就用第一个可见系列，再退第一个系列
 *   · 用哪个来源：优先「真的配过 Key 或地址」的那个来源（键 = <seriesId>.<sourceId>），都没配就用第一个
 *   · 地址优先级：textSourceConfig 里的覆盖地址 → 来源的默认地址（实际请求 POST {baseUrl}/chat/completions）
 *
 * 比主进程**更保守**的一点（正常输入下两者结果完全一致，仅「脏值 / 未知 id」时不同）：
 * 参数可能是下拉框的复合选择值（`<series>.<来源>::<模型>`）、图像模型 id、或已被删掉的 id ——
 * 这些一律当作「没指定」，回落到 settings.textModelId → 系列 defaultModelId → 清单第一个；
 * 也就是**返回的 modelId 永远是清单里真实存在的那个**，绝不把未知 id 原样交给 API。
 *
 * 永不抛异常：系列 / 来源缺失或参数脏了都回 null，由调用方（界面）显示「没有可用文本模型」。
 * @returns {{id,name,modelId,seriesId,seriesLabel,sourceId,sourceLabel,protocol,baseUrl,apiKey,hasKey,models,defaultModelId}|null}
 */
export function resolveTextModel(settings, textModelSeries, modelId) {
  const seriesList = (textModelSeries && textModelSeries.series) || [];
  if (!seriesList.length) return null;

  const argId = rawModelIdOf(modelId);
  const settingsId = rawModelIdOf(settings && settings.textModelId);
  const seriesFor = (id) => (id ? seriesList.find((s) => modelIdsOf(s).includes(id)) || null : null);

  // 1) 参数里的模型真的存在 → 用它；2) 否则看用户选过的 settings.textModelId
  let series = seriesFor(argId);
  let effective = series ? argId : '';
  if (!series) {
    series = seriesFor(settingsId);
    if (series) effective = settingsId;
  }
  // 3) 都没命中：落到第一个可见系列（再退第一个系列），模型用它的 defaultModelId，最后退清单第一个
  if (!series) {
    series = seriesList.find((s) => !s.hidden) || seriesList[0];
    if (!series) return null;
  }

  const sources = (series.sources || []).filter((s) => s && s.id);
  if (!sources.length) return null;

  const models = modelIdsOf(series);
  const def = String(series.defaultModelId || '').trim();
  const defaultModelId = def || (models[0] || '');
  if (!effective) effective = (def && models.includes(def)) ? def : (models[0] || def || '');
  // 一个可用模型 id 都拿不到（清单为空且没定义默认）→ 视为「没有可用文本模型」
  if (!effective) return null;

  const all = (settings && settings.textSourceConfig) || {};
  const source = sources.find((s) => {
    const c = all[textSourceKey(series.id, s.id)];
    return !!(c && (String(c.apiKey || '').trim() || String(c.baseUrl || '').trim()));
  }) || sources[0];

  const cfg = textSourceConfigOf(settings, series.id, source.id);
  const apiKey = String(cfg.apiKey || '');
  return {
    id: effective,
    name: effective,
    modelId: effective,
    seriesId: series.id,
    seriesLabel: String(series.label || series.id),
    sourceId: source.id,
    sourceLabel: String(source.label || source.id),
    protocol: source.protocol || series.protocol || null,
    baseUrl: String(cfg.baseUrl || '').trim() || String(source.baseUrl || '').trim(),
    apiKey,
    hasKey: !!apiKey.trim(),
    models,
    defaultModelId
  };
}
