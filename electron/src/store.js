'use strict';
/*
 * JSON 持久化：设置与会话数据。
 * 采用「写临时文件 + rename」的原子写入，避免中断导致数据损坏。
 *
 * 模型相关字段（v2 结构，模型系列化改造后）：
 *   modelGroups    [{ seriesId, models:[{id,name,sourceId}] }]   已添加的模型系列（隐藏的系列不在此列表）
 *   sourceConfig   { '<seriesId>.<sourceId>': {apiKey, baseUrl} } 按「系列·来源」保存密钥与地址覆盖（baseUrl 为空 = 用内置默认）
 *   defaultModelId 全局默认模型（模型行左侧单选框选中项）
 * 旧版（v1）的 api.apiKey/api.baseUrl/models/requestMode 会在启动时自动迁移，见 migrateLegacySettings。
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const APP_VERSION = 1;

const DEFAULT_SETTINGS = {
  theme: 'system',                     // system | light | dark
  defaultSavePath: '',                 // 为空则使用 <dataRoot>/downloads
  requestTimeoutSec: 300,              // 单次 API 请求超时（秒），默认 5 分钟
  compressEnabled: true,               // 图片自动压缩开关
  compressMaxMB: 10,                   // 超过该大小的图片自动压缩
  modelGroups: [],                     // 见文件头注释
  sourceConfig: {},
  defaultModelId: ''
};

const DEFAULT_CONVERSATIONS = {
  version: APP_VERSION,
  tabCounter: 0,      // 数字标签命名计数器（只增不减）
  activeId: null,
  conversations: []
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    log.error(`读取 JSON 失败: ${file}`, { error: e.message });
    return fallback;
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

/** 旧结构（单一 api + 扁平 models）→ 新结构（模型系列 + 来源）
 *
 *  迁移策略（按需求）：**不自动带出任何模型系列**——模型设置列表初始为空，
 *  系列与模型全部由用户在「设置 → 模型设置」里手动添加；
 *  但旧配置里的 API Key / 自定义 API 地址要保住：按旧模型协议（或旧 baseUrl）
 *  定位到对应的「系列·来源」后写进 sourceConfig，用户添加该系列后即可直接使用。
 */
function migrateLegacySettings(s, seriesConfig) {
  const out = clone(s);
  const series = (seriesConfig && Array.isArray(seriesConfig.series)) ? seriesConfig.series : [];
  const legacyModels = Array.isArray(out.models) ? out.models : [];
  const legacyApi = out.api || {};
  const sourceConfig = {};

  const hint = legacyModels.find((m) => m && m.protocol) || null;
  const serie = (hint && series.find((x) => (x.sources || []).some((src) => src.protocol === hint.protocol)))
    || series.find((x) => (x.sources || []).some((src) => src.baseUrl && src.baseUrl === legacyApi.baseUrl))
    || series[0];
  if (serie && (legacyApi.apiKey || legacyApi.baseUrl)) {
    const src = (hint && (serie.sources || []).find((x) => x.protocol === hint.protocol)) || (serie.sources || [])[0];
    if (src) {
      sourceConfig[`${serie.id}.${src.id}`] = {
        apiKey: legacyApi.apiKey || '',
        // 与内置默认一致就不落盘（留空 = 使用内置默认地址）
        baseUrl: (legacyApi.baseUrl && legacyApi.baseUrl !== src.baseUrl) ? legacyApi.baseUrl : ''
      };
    }
  }

  out.modelGroups = [];
  out.sourceConfig = sourceConfig;
  out.defaultModelId = '';
  delete out.models;
  delete out.api;
  delete out.requestMode;
  log.info('设置已从旧结构迁移到「模型系列」结构（不自动带出模型系列）', {
    keptSecrets: Object.keys(sourceConfig)
  });
  return { settings: out, migrated: true };
}

/** 结构规整：丢弃未知系列 / 未知来源 / 重复 id 的模型 */
function normalizeModelGroups(settings, seriesConfig) {
  const series = (seriesConfig && Array.isArray(seriesConfig.series)) ? seriesConfig.series : [];
  const out = clone(settings);
  const seen = new Set();
  const groups = [];
  for (const g of (Array.isArray(out.modelGroups) ? out.modelGroups : [])) {
    const serie = series.find((x) => x.id === g.seriesId);
    if (!serie) continue;                       // 未知系列（例如 json 被改坏）直接忽略
    const models = [];
    for (const m of (Array.isArray(g.models) ? g.models : [])) {
      if (!m || !m.id || !m.name || seen.has(m.id)) continue;
      const src = (serie.sources || []).find((x) => x.id === m.sourceId) || (serie.sources || [])[0];
      if (!src) continue;
      seen.add(m.id);
      models.push({ id: String(m.id), name: String(m.name), sourceId: src.id });
    }
    // 空系列也保留：用户可能先添加系列 / 配好密钥，稍后再加模型
    groups.push({ seriesId: serie.id, models });
  }
  out.modelGroups = groups;
  if (!groups.some((g) => g.models.some((m) => m.id === out.defaultModelId))) {
    out.defaultModelId = (groups[0] && groups[0].models[0] && groups[0].models[0].id) || '';
  }
  const cfg = {};
  for (const [k, v] of Object.entries(out.sourceConfig || {})) {
    if (!v || typeof v !== 'object') continue;
    cfg[k] = { apiKey: String(v.apiKey || ''), baseUrl: String(v.baseUrl || '').trim() };
  }
  out.sourceConfig = cfg;
  return out;
}

function loadSettings(file, seriesConfig) {
  const s = readJson(file, null);
  if (!s || typeof s !== 'object') {
    return { settings: normalizeModelGroups({ ...DEFAULT_SETTINGS }, seriesConfig), migrated: false };
  }
  let merged = {
    ...DEFAULT_SETTINGS,
    ...s,
    sourceConfig: { ...DEFAULT_SETTINGS.sourceConfig, ...(s.sourceConfig || {}) }
  };
  let migrated = false;
  if (!Array.isArray(merged.modelGroups) || Array.isArray(merged.models)) {
    const r = migrateLegacySettings(merged, seriesConfig);
    merged = r.settings;
    migrated = true;
  }
  return { settings: normalizeModelGroups(merged, seriesConfig), migrated };
}

function saveSettings(file, settings) {
  writeJsonAtomic(file, settings);
}

function loadConversations(file) {
  const c = readJson(file, null);
  if (!c || typeof c !== 'object' || !Array.isArray(c.conversations)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONVERSATIONS));
  }
  return c;
}

function saveConversations(file, data) {
  writeJsonAtomic(file, data);
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_CONVERSATIONS,
  loadSettings,
  saveSettings,
  loadConversations,
  saveConversations,
  normalizeModelGroups,
  migrateLegacySettings
};
