'use strict';
/*
 * 模型系列（Model Series）配置 —— 本需求的核心数据结构。
 *
 * 两个来源：
 *   1) 程序内置（只读）：electron/assets/model-series.json —— 随包发布，定义「有哪些系列、每个系列支持哪些 API 来源、各来源默认地址/尺寸」。
 *   2) 数据目录副本（唯一可写）：<dataRoot>/model-series.json —— 首次启动自动落地；保存用户的开关
 *      （series[].hidden 隐藏系列）以及用户自己在 json 里追加的自定义系列。
 *
 * 合并策略（升级安全）：
 *   - 系列/来源的「成员」与「协议」永远以程序内置为准（内置协议才能被适配器执行）；
 *   - 文案与默认值（label/description/modelPlaceholder/hint/baseUrl/sizeOptions/apiKeyUrl）本地副本可覆盖；
 *   - 本地副本里非内置 id 的系列原样保留（builtin:false）；
 *   - 只有「同步」一种请求模式：老版本数据里的 requestMode / supportsAsync 一律丢弃（见 AIDEV.md §4.12）。
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const SEED_FILE = path.join(__dirname, '..', 'assets', 'model-series.json');

const SERIES_OVERRIDABLE = ['label', 'description', 'modelPlaceholder', 'hidden'];
const SOURCE_OVERRIDABLE = ['label', 'baseUrl', 'hint', 'apiKeyUrl', 'sizeOptions'];

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

/** 系列级字段合并（内置成员为准，本地可覆盖文案与开关） */
function mergeSeries(seed, cur) {
  const out = clone(seed);
  if (cur && typeof cur === 'object') {
    for (const k of SERIES_OVERRIDABLE) {
      if (cur[k] !== undefined) out[k] = clone(cur[k]);
    }
    // 来源：内置来源为主，本地来源补充覆盖；本地额外新增的来源保留
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
  // 老版本数据可能带 requestMode / supportsAsync：一律丢弃，只有同步一种请求模式
  delete out.requestMode;
  if (Array.isArray(out.sources)) {
    for (const s of out.sources) delete s.supportsAsync;
  }
  if (!Array.isArray(out.sources) || !out.sources.length) {
    out.sources = [{ id: 'default', label: '默认来源', protocol: out.protocol, baseUrl: out.defaultBaseUrl || '' }];
  }
  if (out.hidden === undefined) out.hidden = false;
  return out;
}

function mergeConfig(seed, cur) {
  const seedSeries = Array.isArray(seed && seed.series) ? seed.series.filter((s) => s && s.id && s.protocol) : [];
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
  // 用户自行追加的系列（非内置 id）
  for (const s of curById.values()) {
    if (!s.protocol || !Array.isArray(s.sources) || !s.sources.length) continue;
    out.series.push({ ...clone(s), builtin: false, custom: true });
  }
  return out;
}

/** 读取并合并配置；本地副本不存在时自动落地一份 */
function load(file) {
  const seed = readJson(SEED_FILE) || { version: 1, series: [] };
  const cur = readJson(file);
  const merged = mergeConfig(seed, cur);
  if (!cur) {
    try {
      writeJsonAtomic(file, merged);
      log.info('模型系列配置已初始化到数据目录', { file, series: merged.series.length });
    } catch (e) {
      log.warn('模型系列配置落地失败（将只在内存中使用）', { file, error: e.message });
    }
  }
  return merged;
}

/** 保存（渲染进程提交的是整份配置；这里再合并一次，保证内置结构不被破坏） */
function save(file, data) {
  const seed = readJson(SEED_FILE) || { version: 1, series: [] };
  const merged = mergeConfig(seed, data);
  writeJsonAtomic(file, merged);
  return merged;
}

/** 兼容渲染进程提交的简写：只带 hidden 的补丁 */
function applyPatch(file, patch) {
  const cur = readJson(file) || { series: [] };
  const series = Array.isArray(cur.series) ? cur.series : [];
  for (const p of (patch && patch.series) || []) {
    const item = series.find((s) => s && s.id === p.id);
    if (item) {
      if (p.hidden !== undefined) item.hidden = !!p.hidden;
      delete item.requestMode;
    }
  }
  return save(file, { ...cur, series });
}

// ---------- 查询 / 解析（主进程在执行请求时的权威口径） ----------

function findSeries(config, seriesId) {
  if (!config || !Array.isArray(config.series)) return null;
  return config.series.find((s) => s.id === seriesId) || null;
}

function findSource(series, sourceId) {
  if (!series || !Array.isArray(series.sources)) return null;
  return series.sources.find((s) => s.id === sourceId) || series.sources[0] || null;
}

/** 设置里「来源级配置」的键：`<seriesId>.<sourceId>` */
function sourceKey(seriesId, sourceId) {
  return `${seriesId}.${sourceId}`;
}

function sourceConfigOf(settings, seriesId, sourceId) {
  const all = (settings && settings.sourceConfig) || {};
  const cfg = all[sourceKey(seriesId, sourceId)] || {};
  return { apiKey: cfg.apiKey || '', baseUrl: cfg.baseUrl || '' };
}

/**
 * 由模型 id 解析出「真正用于发请求」的全部信息。
 * 只有同步一种请求模式，因此没有 mode 字段（见 AIDEV.md §4.12）。
 * @returns {{group,model,series,seriesId,sourceId,source,protocol,apiKey,baseUrl,hidden,modelName}|null}
 */
function resolveModel(settings, config, modelId) {
  const groups = (settings && Array.isArray(settings.modelGroups)) ? settings.modelGroups : [];
  let group = groups.find((g) => (g.models || []).some((m) => m.id === modelId)) || null;
  let model = group ? (group.models || []).find((m) => m.id === modelId) : null;
  if (!model && settings && settings.defaultModelId) {
    group = groups.find((g) => (g.models || []).some((m) => m.id === settings.defaultModelId)) || null;
    model = group ? (group.models || []).find((m) => m.id === settings.defaultModelId) : null;
  }
  if (!model) return null;

  const series = findSeries(config, group.seriesId);
  const source = findSource(series, model.sourceId);
  const sc = sourceConfigOf(settings, group.seriesId, source ? source.id : '');
  const protocol = (source && source.protocol) || (series && series.protocol) || null;
  return {
    group, model, series,
    seriesId: group.seriesId,
    sourceId: source ? source.id : null,
    source,
    protocol,
    baseUrl: (sc.baseUrl && sc.baseUrl.trim()) || (source && source.baseUrl) || '',
    apiKey: sc.apiKey || '',
    hidden: !!(series && series.hidden),
    modelName: model.name
  };
}

module.exports = {
  SEED_FILE,
  load,
  save,
  applyPatch,
  mergeConfig,
  findSeries,
  findSource,
  sourceKey,
  sourceConfigOf,
  resolveModel
};
