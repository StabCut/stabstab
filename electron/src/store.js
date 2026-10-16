'use strict';
/*
 * JSON 持久化：设置与会话数据。
 * 采用「写临时文件 + rename」的原子写入，避免中断导致数据损坏。
 *
 * 模型相关字段（v2 结构，模型系列化改造后）：
 *   modelGroups    [{ seriesId, models:[{id,name,sourceId}] }]   已添加的模型系列（隐藏的系列不在此列表）
 *   sourceConfig   { '<seriesId>.<sourceId>': {apiKey, baseUrl} } 按「系列·来源」保存密钥与地址覆盖（baseUrl 为空 = 用内置默认）
 *   defaultModelId 全局默认模型（模型行左侧单选框选中项）
 *   renameModel    { apiKey, baseUrl, modelId } 「重命名模型」：用 DeepSeek Responses API
 *                  把首条用户文字压成会话标签名；baseUrl/modelId 留空 = 用代码里的默认值
 *                  （默认地址 https://api.deepseek.com 写死在 electron/src/renameModel.js）
 *   generationMode 'image' | 'text'  对话生成模式：图像生图 / 文本对话（顶部开关）
 *   textModelId    ''                文本模型（「对话生成」模式）当前选中的模型 id；
 *                                    不属于任何内置/自定义文本系列时会被清空（回落到系列默认模型）
 *   textSourceConfig { '<seriesId>.<sourceId>': {apiKey, baseUrl} } 文本模型的密钥与地址覆盖
 *                  （与图像侧的 sourceConfig **完全隔离**：键只在 text-model-series.json 的
 *                   系列·来源里存在时保留，apiKey 与 baseUrl 都为空则丢掉）
 *   closeAction    '' | 'tray' | 'quit'  点窗口 × 时的行为（设置 → 基础设置 →「关闭窗口时」）。
 *                  '' = 从未设置 → 按运行形态给默认值：开发模式直接退出、打包后最小化到托盘
 *                  （判定口径见 electron/src/closeBehavior.js，主进程与界面共用同一套规则）。
 *   shortcuts      { toggleWindow, toggleTheme, newConversation } 全局快捷键（设置 → 基础设置 →
 *                  「全局快捷键」）。值是 Electron accelerator（如 CommandOrControl+Shift+S），
 *                  '' = 未设置。规整 / 冲突检测见 electron/src/shortcuts.js（全程序唯一注册处）。
 * 旧版（v1）的 api.apiKey/api.baseUrl/models/requestMode 会在启动时自动迁移，见 migrateLegacySettings。
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const closeBehavior = require('./closeBehavior');
const shortcutsLib = require('./shortcuts');

const APP_VERSION = 1;

const DEFAULT_SETTINGS = {
  theme: 'system',                     // system | light | dark
  defaultSavePath: '',                 // 为空则使用 <dataRoot>/downloads
  requestTimeoutSec: 300,              // 单次 API 请求超时（秒），默认 5 分钟
  compressEnabled: true,               // 图片自动压缩开关
  compressMaxMB: 10,                   // 超过该大小的图片自动压缩
  saveNamePromptChars: 5,              // 保存文件名取自提示词前 N 个字（0 = 不用提示词命名，见「高级设置」）
  closeAction: '',                     // '' = 从未设置（跟随默认）| 'tray' 最小化到托盘 | 'quit' 直接退出
  shortcuts: {                         // 全局快捷键（设置 → 基础设置 →「全局快捷键」），空串 = 未设置
    ...shortcutsLib.DEFAULT_SHORTCUTS
  },
  modelGroups: [],                     // 见文件头注释
  sourceConfig: {},
  defaultModelId: '',
  generationMode: 'image',             // 'image' 生图（默认）| 'text' 文本对话；「对话生成」模式开关
  textModelId: '',                     // 文本模型选中项（见文件头注释）
  textSourceConfig: {},                // 文本模型的「系列·来源」密钥 / 地址覆盖（与 sourceConfig 隔离）
  renameModel: {                       // 「重命名模型」（会话标签自动命名）
    apiKey: '',
    baseUrl: '',                       // 空 = 用写死的默认地址 https://api.deepseek.com
    modelId: ''                        // 空 = 用写死的默认模型 deepseek-flash
  }
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
 *  迁移策略（按需求）：**不自动带出任何模型系列**——图像模型列表初始为空，
 *  系列与模型全部由用户在「设置 → 图像模型」里手动添加；
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

/**
 * 结构规整：丢弃未知系列 / 未知来源 / 重复 id 的模型；文本模型相关字段见 normalizeTextSettings。
 * @param {object} settings settings.json 内容
 * @param {object} seriesConfig 图像模型系列配置（model-series.json）
 * @param {object} [textSeriesConfig] 文本模型系列配置（text-model-series.json）；
 *        省略时不做文本侧的「未知系列 / 未知模型」清理（见 normalizeTextSettings 注释）
 */
function normalizeModelGroups(settings, seriesConfig, textSeriesConfig) {
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
  // 关闭窗口行为：只认 'tray' / 'quit'，其余（含从未设置的空值、手工改坏的值）一律回 '' = 跟随默认
  out.closeAction = closeBehavior.normalizeCloseAction(out.closeAction);
  // 全局快捷键：只认三个动作 id + 合法 accelerator，非法 / 脏值一律清成 ''（主进程注册前再规整一次）
  out.shortcuts = shortcutsLib.normalizeShortcuts(out.shortcuts);
  // 重命名模型：只保留三个字符串字段（缺省 = 用代码里的默认地址 / 默认模型）
  const rm = (out.renameModel && typeof out.renameModel === 'object') ? out.renameModel : {};
  out.renameModel = {
    apiKey: String(rm.apiKey || ''),
    baseUrl: String(rm.baseUrl || '').trim(),
    modelId: String(rm.modelId || '').trim()
  };
  // 文本模型（「对话生成」）：模式开关 / 密钥 / 选中模型（见 normalizeTextSettings）
  normalizeTextSettings(out, textSeriesConfig);
  return out;
}

/**
 * 文本模型（「对话生成」模式）字段的规整 —— 与图像侧的 sourceConfig / modelGroups 完全隔离。
 *   1) generationMode：只认 'image' / 'text'，其余（含脏值、缺省）一律回 'image'；
 *   2) textSourceConfig：键必须是 text-model-series.json 里真实存在的 `<seriesId>.<sourceId>`，
 *      其余键（系列被删掉、手工写错、误把图像侧的键塞进来）直接丢弃；
 *      apiKey 与 baseUrl 都为空的条目也丢掉（空配置没意义，还会让「已配置来源」的判断出错）；
 *   3) textModelId：去空白；不属于任何已知文本模型 id 时清空（回落到系列的 defaultModelId）。
 * 拿不到文本系列配置（调用方没传，例如纯图片场景的老调用）时只做 1) 与字段整形，
 * 不做「未知系列 / 未知模型」清理 —— 免得把用户已经配好的数据误清掉。
 */
function normalizeTextSettings(out, textSeriesConfig) {
  const seriesList = (textSeriesConfig && Array.isArray(textSeriesConfig.series)) ? textSeriesConfig.series : [];
  const known = !!textSeriesConfig;

  out.generationMode = out.generationMode === 'text' ? 'text' : 'image';

  const pairs = new Set();
  const modelIds = new Set();
  for (const s of seriesList) {
    if (!s || !s.id) continue;
    for (const src of (Array.isArray(s.sources) ? s.sources : [])) {
      if (src && src.id) pairs.add(`${s.id}.${src.id}`);
    }
    for (const m of (Array.isArray(s.models) ? s.models : [])) {
      const id = (m && typeof m === 'object') ? m.id : m;
      if (id !== undefined && id !== null && String(id).trim()) modelIds.add(String(id).trim());
    }
  }

  const cfg = {};
  for (const [k, v] of Object.entries(out.textSourceConfig || {})) {
    if (!v || typeof v !== 'object') continue;
    if (known && !pairs.has(k)) continue;                 // 不是真实存在的「系列·来源」→ 丢掉
    const entry = { apiKey: String(v.apiKey || ''), baseUrl: String(v.baseUrl || '').trim() };
    if (!entry.apiKey.trim() && !entry.baseUrl) continue; // 两者都空 → 丢掉
    cfg[k] = entry;
  }
  out.textSourceConfig = cfg;

  const tid = String(out.textModelId || '').trim();
  out.textModelId = (known && tid && !modelIds.has(tid)) ? '' : tid;
  return out;
}

/** 读取并规整设置。textSeriesConfig 见 normalizeModelGroups 的说明 */
function loadSettings(file, seriesConfig, textSeriesConfig) {
  const s = readJson(file, null);
  if (!s || typeof s !== 'object') {
    return { settings: normalizeModelGroups({ ...DEFAULT_SETTINGS }, seriesConfig, textSeriesConfig), migrated: false };
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
  return { settings: normalizeModelGroups(merged, seriesConfig, textSeriesConfig), migrated };
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
