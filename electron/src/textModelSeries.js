'use strict';
/*
 * 文本模型系列（Text Model Series）配置 —— 「对话生成」模式的模型定义。
 *
 * 两处同口径（**改规则时两处都要改**）：
 *   · 主进程（权威口径，发请求时用）：本文件 resolveTextModel；
 *   · 渲染进程（只服务于界面）：src/lib/textModels.js#resolveTextModel。
 *   两边的生效模型链、认领系列的判定、来源选择、地址优先级与「绝不把清单外的模型 id 交给 API」这条
 *   完全一致，仅返回形状不同（这里多一个 found 字段，渲染层回 null）。
 *
 * 与图像模型（model-series.js）**完全隔离**：两份 json、两份数据目录副本、settings 里两组字段
 * （图像是 modelGroups/sourceConfig/defaultModelId，文本是 textSourceConfig/textModelId），
 * 两条链互不读写、互不干扰 —— 改图像那条不会影响文本模型，反之亦然。
 *
 * 两个来源（与 model-series.json 同一套做法）：
 *   1) 程序内置（只读）：electron/assets/text-model-series.json —— 随包发布，定义「有哪些文本系列、
 *      每个系列支持哪些来源、各来源默认地址、内置模型清单（下拉顺序）」。
 *   2) 数据目录副本（唯一可写）：<dataRoot>/text-model-series.json —— 首次启动自动落地；
 *      保存用户的 series[].hidden 开关，以及用户自己追加的模型 id / 自定义系列。
 *
 * 合并策略（升级安全，与 modelSeries.js 同口径）：
 *   - 系列的「成员」与「协议」永远以程序内置为准（内置协议才能被适配器执行）；
 *   - 文案与默认值（label/description/defaultModelId/hidden、来源 label/baseUrl/hint/apiKeyUrl）副本可覆盖；
 *   - **models 取并集**：内置清单在前、副本追加的 id 按原顺序跟在后面（只能增不能删）——
 *     否则首次启动落地的那份副本会把内置新增的模型永久压住，「升级后新模型看不见」；
 *   - 本地副本里非内置 id 的系列原样保留（custom:true），但它必须自带 protocol 与 sources，
 *     否则无法发请求，直接丢弃。
 *
 * 约定：本文件不打印任何 Key；解析失败一律回 { found:false }，绝不抛异常。
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');

/** 内置配置（随包发布，只读） */
const SEED_FILE = path.join(__dirname, '..', 'assets', 'text-model-series.json');

/** 副本可覆盖的系列级字段（成员与协议永远取内置） */
const SERIES_OVERRIDABLE = ['label', 'description', 'defaultModelId', 'hidden'];
/** 副本可覆盖的来源级字段 */
const SOURCE_OVERRIDABLE = ['label', 'baseUrl', 'hint', 'apiKeyUrl'];

// ---------- 配置文件读写（与 model-series.json / rename-model.json 同一套做法） ----------

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log.error(`读取 JSON 失败: ${file}`, { error: e.message });
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/** 模型条目统一成 {id} 形状（多余的字段一并保留，方便以后加 label 之类） */
function modelIdOf(m) {
  if (typeof m === 'string') return m.trim();
  if (m && typeof m === 'object' && m.id !== undefined && m.id !== null) return String(m.id).trim();
  return '';
}

/**
 * 内置模型清单的合并：内置顺序在前，副本里多出来的 id 按原顺序追加。
 * 并集（而不是「副本覆盖内置」）是为了让升级新增的模型对老用户立刻可见 ——
 * 数据目录副本是首次启动时落地的一整份配置，它若把 models 原样带回来就会压住内置新增项。
 * 代价：在副本里手工**删掉**某个内置模型不会生效（只能增不能删，见 json 的 _readme）。
 */
function mergeModels(seedModels, curModels) {
  const seed = Array.isArray(seedModels) ? seedModels : null;
  const cur = Array.isArray(curModels) ? curModels : null;
  if (!seed && !cur) return undefined;
  if (!seed) return clone(cur);
  if (!cur) return clone(seed);
  const out = clone(seed);
  const seen = new Set(out.map(modelIdOf).filter(Boolean));
  for (const m of cur) {
    const id = modelIdOf(m);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(clone(m));
  }
  return out;
}

/** 系列级字段合并（内置成员为准，副本可覆盖文案 / 默认模型 / 开关） */
function mergeSeries(seed, cur) {
  const out = clone(seed);
  if (cur && typeof cur === 'object') {
    for (const k of SERIES_OVERRIDABLE) {
      if (cur[k] !== undefined) out[k] = clone(cur[k]);
    }
    // 模型清单：内置在前，副本追加的跟在后面（只能增不能删）
    const models = mergeModels(seed.models, cur.models);
    if (models) out.models = models; else delete out.models;
    // 来源：内置来源为主，副本来源覆盖文案 / 地址；副本额外新增的来源保留
    const curSources = Array.isArray(cur.sources) ? cur.sources.filter((s) => s && s.id && s.protocol) : [];
    const byId = new Map(curSources.map((s) => [s.id, s]));
    const merged = (out.sources || []).map((s) => {
      const c = byId.get(s.id);
      if (!c) return clone(s);
      const m = clone(s);
      for (const k of SOURCE_OVERRIDABLE) {
        if (c[k] !== undefined) m[k] = clone(c[k]);
      }
      return m;
    });
    const seen = new Set(merged.map((s) => s.id));
    for (const s of curSources) {
      if (!seen.has(s.id)) merged.push({ ...clone(s), custom: true });
    }
    out.sources = merged;
  }
  out.builtin = true;
  // 协议永远以内置为准：副本改不动它（否则副本里写个接口不存在的协议就整条链不可用）
  if (seed.protocol !== undefined) out.protocol = seed.protocol;
  else delete out.protocol;
  if (!Array.isArray(out.sources) || !out.sources.length) {
    out.sources = [{ id: 'default', label: '默认来源', protocol: out.protocol, baseUrl: '' }];
  }
  if (out.hidden === undefined) out.hidden = false;
  return out;
}

function mergeConfig(seed, cur) {
  const seedSeries = Array.isArray(seed && seed.series)
    ? seed.series.filter((s) => s && s.id && (s.protocol || (Array.isArray(s.sources) && s.sources.length)))
    : [];
  const curSeries = Array.isArray(cur && cur.series) ? cur.series.filter((s) => s && s.id) : [];
  const curById = new Map(curSeries.map((s) => [s.id, s]));
  const out = {
    version: (seed && seed.version) || 1,
    _readme: (seed && seed._readme) || [],
    series: []
  };
  for (const s of seedSeries) {
    out.series.push(mergeSeries(s, curById.get(s.id)));
    curById.delete(s.id);
  }
  // 用户自行追加的系列（非内置 id）：必须自带协议与来源，否则没法发请求
  for (const s of curById.values()) {
    if (!s.protocol || !Array.isArray(s.sources) || !s.sources.length) continue;
    out.series.push({ ...clone(s), builtin: false, custom: true });
  }
  return out;
}

/** 读取并合并配置；数据目录副本不存在时自动落地一份 */
function load(file) {
  const seed = readJson(SEED_FILE) || { version: 1, series: [] };
  const cur = readJson(file);
  const merged = mergeConfig(seed, cur);
  if (!cur) {
    try {
      writeJsonAtomic(file, merged);
      log.info('文本模型系列配置已初始化到数据目录', { file, series: merged.series.length });
    } catch (e) {
      log.warn('文本模型系列配置落地失败（将只在内存中使用）', { file, error: e.message });
    }
  }
  return merged;
}

/** 保存（渲染进程提交的是整份配置；这里再合并一次，保证内置结构与协议不被破坏） */
function save(file, data) {
  const seed = readJson(SEED_FILE) || { version: 1, series: [] };
  const merged = mergeConfig(seed, data);
  writeJsonAtomic(file, merged);
  return merged;
}

// ---------- 查询 / 解析（主进程在执行请求时的权威口径） ----------

/** 全部系列（内置在前，自定义在后） */
function listSeries(cfg) {
  return (cfg && Array.isArray(cfg.series)) ? cfg.series.filter((s) => s && s.id) : [];
}

function findSeries(cfg, seriesId) {
  return listSeries(cfg).find((s) => s.id === seriesId) || null;
}

function findSource(series, sourceId) {
  if (!series || !Array.isArray(series.sources)) return null;
  return series.sources.find((s) => s.id === sourceId) || series.sources[0] || null;
}

/** 设置里「来源级配置」的键：`<seriesId>.<sourceId>`（文本侧用 settings.textSourceConfig） */
function sourceKey(seriesId, sourceId) {
  return `${seriesId}.${sourceId}`;
}

function sourceConfigOf(settings, seriesId, sourceId) {
  const all = (settings && settings.textSourceConfig) || {};
  const cfg = all[sourceKey(seriesId, sourceId)] || {};
  return { apiKey: cfg.apiKey || '', baseUrl: cfg.baseUrl || '' };
}

/** 系列的模型 id 清单（下拉顺序即内置顺序 + 副本追加项），用于返回给调用方 */
function modelIdsOf(series) {
  const out = [];
  for (const m of (series && Array.isArray(series.models) ? series.models : [])) {
    const id = modelIdOf(m);
    if (id) out.push(id);
  }
  return out;
}

/**
 * 该系列这次实际用哪个来源。
 * 文本侧没有「选中来源」这个设置项（图片侧有 model.sourceId），所以口径是：
 * 优先取「在 settings.textSourceConfig 里配了 Key 或地址」的那个来源，都没配就取第一个。
 */
function sourceOf(settings, series) {
  const sources = (series && Array.isArray(series.sources)) ? series.sources.filter((s) => s && s.id) : [];
  if (!sources.length) return null;
  const all = (settings && settings.textSourceConfig) || {};
  const configured = sources.find((s) => {
    const c = all[sourceKey(series.id, s.id)];
    return !!(c && (String(c.apiKey || '').trim() || String(c.baseUrl || '').trim()));
  });
  return configured || sources[0];
}

/**
 * 调用方给的模型选择值可能是三种东西，统一取「真正的模型 id」（与渲染层 src/lib/textModels.js 同口径）：
 *   · 复合选择值 `<seriesId>.<sourceId>::<modelId>`（输入区下拉框的 value）→ 取 `::` 之后那一段
 *   · 图像模型 id / 清单里没有的脏值 → 原样返回，由 resolveTextModel 判定「不认识」并回落
 *   · ''（调用方只想拿「当前默认」）→ ''
 */
function rawModelIdOf(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  const i = s.indexOf('::');
  return i >= 0 ? s.slice(i + 2).trim() : s;
}

/**
 * 由模型 id 解析出「真正用于发请求」的全部信息（当前只有一个内置系列，但按多系列写好）。
 *
 * 口径与渲染层 `src/lib/textModels.js#resolveTextModel` **完全一致**（两处必须同时改，见文件头注释）：
 *   · 生效模型：参数 → settings.textModelId → 系列的 defaultModelId（且要在清单里）→ 清单第一个；
 *     **返回的 modelId 永远是 series.models[] 里真实存在的 id** —— 脏值 / 图像模型 id / 已删掉的 id
 *     一律当作「没指定」回落，绝不把未知 id 原样交给 API；
 *   · 认领这个 id 的系列优先（清单里命中）；都不命中就用第一个可见系列，再退第一个系列；
 *   · 用哪个来源：优先「真的配过 Key 或地址」的那个来源（键 = <seriesId>.<sourceId>），都没配就用第一个；
 *   · 地址优先级：textSourceConfig 里的覆盖地址 → 来源的默认地址（实际请求 POST {baseUrl}/chat/completions）。
 *
 * 与渲染层的差别只有返回形状：这里多一个 found 字段（渲染层回 null），调用方（main.js）据此报中文错误。
 * 永不抛异常：系列 / 来源缺失或参数脏了都回 { found:false }。
 * @returns {{found:boolean, id?, name?, seriesId?, seriesLabel?, sourceId?, sourceLabel?, modelId?, protocol?,
 *            baseUrl?, apiKey?, hasKey?, models?:string[], defaultModelId?}}
 */
function resolveTextModel(settings, cfg, modelId) {
  try {
    const seriesList = listSeries(cfg);
    if (!seriesList.length) return { found: false };

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
    if (!series) series = seriesList.find((s) => !s.hidden) || seriesList[0];
    if (!series) return { found: false };

    // 用哪个来源：优先「用户真的配过 Key / 地址」的那个来源（键 = <seriesId>.<sourceId>），
    // 都没配就用第一个（内置系列只有一个来源，两种口径结果一致）。没有可用来源 → 不可用。
    const source = sourceOf(settings, series);
    if (!source) return { found: false };

    const models = modelIdsOf(series);
    const def = String(series.defaultModelId || '').trim();
    const defaultModelId = def || (models[0] || '');
    if (!effective) effective = (def && models.includes(def)) ? def : (models[0] || def || '');
    // 一个可用模型 id 都拿不到（清单为空且没定义默认）→ 视为「没有可用文本模型」
    if (!effective) return { found: false };

    const sc = sourceConfigOf(settings, series.id, source.id);
    const apiKey = String(sc.apiKey || '');
    return {
      found: true,
      id: effective,
      name: effective,                                    // 与渲染层同形（下拉框用 id/name；主进程只需要 modelId）
      seriesId: series.id,
      seriesLabel: String(series.label || series.id),
      sourceId: source.id,
      sourceLabel: String(source.label || source.id),
      modelId: effective,
      protocol: source.protocol || series.protocol || null,
      baseUrl: String(sc.baseUrl || '').trim() || String(source.baseUrl || '').trim(),
      apiKey,
      hasKey: !!apiKey.trim(),
      models,
      defaultModelId
    };
  } catch (e) {
    log.warn('解析文本模型失败（按「找不到模型」处理）', { error: e && e.message });
    return { found: false };
  }
}

module.exports = {
  SEED_FILE,
  readJson,
  writeJsonAtomic,
  load,
  save,
  mergeConfig,
  sourceKey,
  listSeries,
  findSeries,
  findSource,
  resolveTextModel
};
