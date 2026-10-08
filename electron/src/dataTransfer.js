'use strict';
/*
 * 「配置 + 聊天记录」导出 / 导入（zip 打包 + 智能合并）
 * ==================================================
 * 本模块是**纯 Node**（不 require electron），所以回归脚本可以直接驱动；
 * 弹对话框、写数据目录、更新内存状态由 electron/main.js 的 IPC 处理器负责。
 *
 * ---------- 包名协议 ----------
 *   ss-YYYYMMDD-HHmm.zip        例如 ss-20260213-1530.zip（精确到分钟，本地时间）
 *   不满足 → code:'BAD_NAME'（「包名不符合格式」），在解压之前就报错。
 *
 * ---------- 包内目录协议 ----------
 *   ss-export/
 *     manifest.json        {format:'stabstab-export', version:1, appVersion, exportedAt, counts}
 *     settings.json        settings.json 原样（含各「系列·来源」的 API Key）
 *     conversations.json   会话 + 消息（含标签名 / 模型引用 / 参数）
 *     model-series.json    模型系列定义（用户自定义系列会被带到新机器）
 *     rename-model.json    重命名模型（提示模板 / 温度 / Top-P / 默认地址）
 *     cache/<file>         仅导出「聊天记录里引用到的」结果图
 *     uploads/<file>       仅导出「聊天记录里引用到的」用户输入图
 *   顶层只允许上面这些条目（多了 / 少了 manifest / 媒体目录里出现子目录或非图片
 *   一律 code:'BAD_STRUCTURE'）。
 *
 * ---------- 合并规则（导入时叠加到当前数据）----------
 *   图片（独立的文件）：直接落到 <data>/cache、<data>/uploads，同名已存在则忽略（查重）。
 *   设置（单文件）：解析后逐项智能合并 ——
 *     · theme / requestTimeoutSec / compressEnabled / compressMaxMB / saveNamePromptChars 这类
 *       「选项」按导入的值改动（含 defaultModelId：导入值在合并后的模型列表里存在就用它）；
 *     · defaultSavePath 是机器相关的绝对路径：只有本机确实存在该目录才采用，否则保留当前值；
 *     · renameModel（凭据）：导入的非空字段覆盖，留空的保留当前；
 *     · modelGroups：同一模型 id = 忽略；同系列同来源同名（不同机器上 id 不同）= 认作同一个模型，
 *       忽略并记下 id 映射（导入会话里的模型引用会改指本机这个模型）；其余追加；
 *       当前配置里没有的系列自动新增（并把它从 hidden 里放出来）；
 *     · sourceConfig：只补空缺 —— 本机已有 Key/地址的不被导入覆盖（避免误换账号）；
 *     · 最后统一走 store.normalizeModelGroups 规整（未知系列 / 重复 id 丢掉）。
 *   聊天记录（单文件）：按 id 查重后**追加在当前列表最新位置（最上面）**，标签名一起带过来；
 *     导入时仍在 pending/running 的消息按「被中断」标记为失败（理由同启动规范化），
 *     tabCounter 取两者最大值（新对话的序号不撞车）。
 */
const fs = require('fs');
const path = require('path');
const zip = require('./zip');
const log = require('./logger');
const store = require('./store');
const modelSeriesLib = require('./modelSeries');

// ---------- 协议常量 ----------
const EXPORT_PREFIX = 'ss-';
const ROOT_DIR = 'ss-export';
const MANIFEST_FILE = 'manifest.json';
const FORMAT = 'stabstab-export';
const FORMAT_VERSION = 1;
const SETTINGS_FILE = 'settings.json';
const CONVERSATIONS_FILE = 'conversations.json';
const SERIES_FILE = 'model-series.json';
const RENAME_FILE = 'rename-model.json';
/** 媒体目录：包内 `ss-export/<目录>/<文件名>` ↔ 数据目录 `<dataRoot>/<目录>/<文件名>` */
const MEDIA_DIRS = ['cache', 'uploads'];
const ZIP_NAME_RE = /^ss-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.zip$/i;
const ROOT_ALLOWED = new Set([MANIFEST_FILE, SETTINGS_FILE, CONVERSATIONS_FILE, SERIES_FILE, RENAME_FILE, ...MEDIA_DIRS]);
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);
/** 「选项类」设置：按导入的值改动（见文件头合并规则） */
const OPTION_KEYS = ['theme', 'requestTimeoutSec', 'compressEnabled', 'compressMaxMB', 'saveNamePromptChars', 'closeAction'];

const clone = (v) => JSON.parse(JSON.stringify(v));
const pad2 = (n) => String(n).padStart(2, '0');

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/** 文件名只取 basename，顺带挡掉空名 / `.` / `..`（会话里可能被人手工改坏） */
function safeBaseName(name) {
  const base = path.basename(String(name === undefined || name === null ? '' : name).trim());
  if (!base || base === '.' || base === '..') return '';
  if (/[\u0000-\u001f]/.test(base)) return '';
  return base;
}

/** 读 JSON（容忍 UTF-8 BOM —— 手工编辑过的文件常常带） */
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

// =====================================================================
// 包名
// =====================================================================

/** 导出包名：`ss-YYYYMMDD-HHmm.zip`（精确到分钟，本地时间） */
function zipNameFor(date) {
  const d = date instanceof Date ? date : new Date();
  return `${EXPORT_PREFIX}${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.zip`;
}

/**
 * 校验导出包名是否符合协议（导入第一步，先于解压）。
 * @returns {{ok:true, at:Date, name:string} | {ok:false, message:string}}
 */
function parseZipName(fileName) {
  const name = path.basename(String(fileName || '').trim());
  const m = ZIP_NAME_RE.exec(name);
  if (!m) {
    return {
      ok: false,
      message: `压缩包名不符合格式：需要形如 ss-YYYYMMDD-HHmm.zip（例如 ${zipNameFor(new Date(2026, 1, 13, 15, 30))}），当前是「${name}」。`
    };
  }
  const [, y, mo, d, h, mi] = m;
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const valid = at.getFullYear() === Number(y) && at.getMonth() === Number(mo) - 1 && at.getDate() === Number(d)
    && at.getHours() === Number(h) && at.getMinutes() === Number(mi);
  if (!valid) {
    return { ok: false, message: `压缩包名里的日期时间不合法：「${name}」。` };
  }
  return { ok: true, at, name };
}

// =====================================================================
// 导出
// =====================================================================

/**
 * 聊天记录里引用到的图片文件名（去重）。
 * 用户消息 → uploads（用户输入图）；助手消息 → cache（结果图）。
 * @returns {{cache:string[], uploads:string[]}}
 */
function referencedImages(conversations) {
  const buckets = { cache: new Set(), uploads: new Set() };
  const list = (conversations && Array.isArray(conversations.conversations)) ? conversations.conversations : [];
  for (const conv of list) {
    for (const msg of (conv && Array.isArray(conv.messages) ? conv.messages : [])) {
      const area = msg && msg.role === 'user' ? 'uploads' : (msg && msg.role === 'assistant' ? 'cache' : null);
      if (!area) continue;
      for (const im of (Array.isArray(msg.images) ? msg.images : [])) {
        const file = safeBaseName(im && im.file);
        if (file) buckets[area].add(file);
      }
    }
  }
  return { cache: [...buckets.cache].sort(), uploads: [...buckets.uploads].sort() };
}

/**
 * 导出「配置 + 聊天记录（含被引用的图片）」为 zip。
 * @param {object} o
 * @param {string} o.destPath       目标 zip 路径
 * @param {object} o.settings       当前设置（含密钥）
 * @param {object} o.conversations  当前会话
 * @param {object} o.modelSeries    当前模型系列配置
 * @param {object} o.renameConfig   当前重命名模型配置
 * @param {object} o.paths          数据目录（{cache, uploads}）
 * @param {string} [o.appVersion]
 * @param {Date}   [o.now]
 * @returns {Promise<{ok:true, path:string, bytes:number, entries:number, conversations:number,
 *                    messages:number, images:number, missing:number} | {ok:false, code:string, message:string}>}
 */
async function exportData(o) {
  const opts = o || {};
  const destPath = String(opts.destPath || '');
  if (!destPath) return { ok: false, code: 'BAD_DEST', message: '没有指定导出文件路径。' };
  const now = opts.now instanceof Date ? opts.now : new Date();
  const conversations = opts.conversations || { conversations: [] };
  const convList = Array.isArray(conversations.conversations) ? conversations.conversations : [];
  const refs = referencedImages(conversations);

  const entries = [];
  const json = (name, data) => entries.push({ name: `${ROOT_DIR}/${name}`, data: JSON.stringify(data, null, 2) });

  let images = 0;
  let missing = 0;
  const mediaEntries = [];
  for (const area of MEDIA_DIRS) {
    const dir = (opts.paths && opts.paths[area]) || '';
    for (const file of refs[area]) {
      const src = dir ? path.join(dir, file) : '';
      if (!src || !isFile(src)) { missing++; continue; }      // 图片已被清理：跳过，导入端显示「图片缺失」
      mediaEntries.push({ name: `${ROOT_DIR}/${area}/${file}`, file: src });
      images++;
    }
  }

  const counts = {
    conversations: convList.length,
    messages: convList.reduce((n, c) => n + ((c && c.messages) || []).length, 0),
    images,
    missing
  };
  json(MANIFEST_FILE, {
    format: FORMAT,
    version: FORMAT_VERSION,
    appVersion: String(opts.appVersion || ''),
    exportedAt: now.toISOString(),
    counts
  });
  json(SETTINGS_FILE, opts.settings || {});
  json(CONVERSATIONS_FILE, conversations);
  json(SERIES_FILE, opts.modelSeries || { series: [] });
  json(RENAME_FILE, opts.renameConfig || {});

  try {
    const r = await zip.writeZip(destPath, [...entries, ...mediaEntries], { now });
    log.info('导出配置与聊天记录完成', {
      path: destPath, entries: r.entries, bytes: r.bytes,
      conversations: counts.conversations, messages: counts.messages, images, missing
    });
    return { ok: true, path: destPath, bytes: r.bytes, entries: r.entries, ...counts };
  } catch (e) {
    log.error('导出配置与聊天记录失败', { path: destPath, error: e.message });
    return { ok: false, code: e.code || 'EXPORT_FAILED', message: e.message };
  }
}

// =====================================================================
// 解压 + 目录协议校验
// =====================================================================

/**
 * 校验解压出来的目录是否符合包内协议。
 * @returns {{ok:true, root:string, manifest:object, media:{cache:string[],uploads:string[]}}
 *          | {ok:false, code:'BAD_STRUCTURE', message:string}}
 */
function inspectDir(workDir) {
  const fail = (message) => ({ ok: false, code: 'BAD_STRUCTURE', message });
  const root = path.join(workDir, ROOT_DIR);
  if (!isDir(root)) return fail(`压缩包里没有顶层目录「${ROOT_DIR}/」，不是 StabStab 导出包。`);

  const names = fs.readdirSync(root);
  for (const n of names) {
    if (!ROOT_ALLOWED.has(n)) return fail(`压缩包里出现协议外的条目「${ROOT_DIR}/${n}」，已停止导入。`);
    if (MEDIA_DIRS.includes(n)) {
      if (!isDir(path.join(root, n))) return fail(`「${ROOT_DIR}/${n}」应当是目录。`);
    } else if (!isFile(path.join(root, n))) {
      return fail(`「${ROOT_DIR}/${n}」应当是文件。`);
    }
  }

  const manifestPath = path.join(root, MANIFEST_FILE);
  if (!isFile(manifestPath)) return fail(`压缩包里缺少 ${MANIFEST_FILE}，无法确认这是 StabStab 导出包。`);
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (e) {
    return fail(`${MANIFEST_FILE} 不是合法 JSON：${e.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || manifest.format !== FORMAT) {
    return fail(`${MANIFEST_FILE} 里的 format 不是「${FORMAT}」，不是 StabStab 导出包。`);
  }
  const version = Number(manifest.version);
  if (!Number.isFinite(version) || version < 1) return fail(`${MANIFEST_FILE} 里的 version 不合法。`);
  if (version > FORMAT_VERSION) {
    return {
      ok: false,
      code: 'BAD_VERSION',
      message: `导出包版本（${version}）比当前程序支持的版本（${FORMAT_VERSION}）新，请升级 StabStab 后再导入。`
    };
  }
  if (!isFile(path.join(root, SETTINGS_FILE)) && !isFile(path.join(root, CONVERSATIONS_FILE))) {
    return fail(`压缩包里既没有 ${SETTINGS_FILE} 也没有 ${CONVERSATIONS_FILE}，没有可导入的数据。`);
  }

  const media = {};
  for (const area of MEDIA_DIRS) {
    const dir = path.join(root, area);
    const files = [];
    if (isDir(dir)) {
      for (const n of fs.readdirSync(dir)) {
        const full = path.join(dir, n);
        if (isDir(full)) return fail(`「${ROOT_DIR}/${area}/${n}」是子目录，包内协议只允许平铺的图片文件。`);
        if (!MEDIA_EXT.has(path.extname(n).toLowerCase())) return fail(`「${ROOT_DIR}/${area}/${n}」不是支持的图片格式。`);
        files.push(n);
      }
    }
    media[area] = files;
  }

  return { ok: true, root, manifest, media };
}

/** 读包里的四份数据（缺哪份算哪份没有，至少要有一份能合） */
function readBundle(root) {
  const wanted = [
    ['settings', SETTINGS_FILE],
    ['conversations', CONVERSATIONS_FILE],
    ['modelSeries', SERIES_FILE],
    ['renameConfig', RENAME_FILE]
  ];
  const data = {};
  for (const [key, file] of wanted) {
    const full = path.join(root, file);
    if (!isFile(full)) continue;
    try {
      data[key] = readJson(full);
    } catch (e) {
      return { ok: false, code: 'BAD_STRUCTURE', message: `压缩包里的 ${file} 不是合法 JSON：${e.message}` };
    }
  }
  return { ok: true, data };
}

// =====================================================================
// 智能合并
// =====================================================================

/** 导入包里「当前配置没有的系列」直接新增（内置系列结构以程序为准，不动） */
function mergeSeriesDefs(currentConfig, importedConfig) {
  const out = clone(currentConfig && typeof currentConfig === 'object' ? currentConfig : { series: [] });
  out.series = Array.isArray(out.series) ? out.series : [];
  const have = new Set(out.series.map((s) => s && s.id));
  const added = [];
  const list = (importedConfig && Array.isArray(importedConfig.series)) ? importedConfig.series : [];
  for (const s of list) {
    if (!s || !s.id || have.has(s.id)) continue;
    if (!s.protocol || !Array.isArray(s.sources) || !s.sources.length) continue;   // 结构不全：没法用，忽略
    out.series.push({ ...clone(s), builtin: false, custom: true, hidden: !!s.hidden });
    have.add(s.id);
    added.push(s.id);
  }
  return { config: out, added };
}

/** 让「合并后确实有模型的系列」从 hidden 里放出来（自动新增系列时要用） */
function unhideSeries(config, seriesIds) {
  const out = clone(config);
  out.series = (out.series || []).map((s) => (seriesIds.has(s.id) ? { ...s, hidden: false } : s));
  return out;
}

const modelKey = (seriesId, sourceId, name) => `${seriesId}\u0000${sourceId}\u0000${String(name).trim().toLowerCase()}`;

/**
 * 模型列表合并：追加 + 查重（同 id / 同系列同来源同名）。纯函数，回归脚本直接断言。
 * @returns {{groups:Array, idRemap:Map<string,string>, addedModels:number,
 *            ignoredModels:number, addedGroups:string[], skippedSeries:string[]}}
 *          idRemap = 导入包模型 id → 本机已有模型 id（导入会话里的引用据此改指）
 */
function mergeModelGroups(currentGroups, importedGroups, seriesConfig) {
  const groups = clone(Array.isArray(currentGroups) ? currentGroups : [])
    .filter((g) => g && g.seriesId)
    .map((g) => ({ seriesId: g.seriesId, models: Array.isArray(g.models) ? clone(g.models) : [] }));
  const byId = new Map();
  const byKey = new Map();
  for (const g of groups) {
    for (const m of g.models) {
      if (!m || !m.id) continue;
      byId.set(m.id, m);
      byKey.set(modelKey(g.seriesId, m.sourceId, m.name), m);
    }
  }

  const idRemap = new Map();
  const addedGroups = [];
  const skippedSeries = [];
  let addedModels = 0;
  let ignoredModels = 0;

  for (const ig of (Array.isArray(importedGroups) ? importedGroups : [])) {
    const seriesId = String((ig && ig.seriesId) || '');
    const series = seriesId ? modelSeriesLib.findSeries(seriesConfig, seriesId) : null;
    if (!series) {                       // 连系列定义都没有（包里也没带）：无法解析协议，忽略
      if (seriesId) skippedSeries.push(seriesId);
      continue;
    }
    let group = groups.find((g) => g.seriesId === seriesId) || null;
    for (const im of (Array.isArray(ig.models) ? ig.models : [])) {
      if (!im || !im.id || !String(im.name || '').trim()) continue;
      if (byId.has(im.id)) { ignoredModels++; continue; }                          // 同一模型（id 相同）
      const sources = Array.isArray(series.sources) ? series.sources : [];
      const sourceId = sources.some((s) => s && s.id === im.sourceId) ? im.sourceId : ((sources[0] && sources[0].id) || '');
      const name = String(im.name).trim();
      const twin = byKey.get(modelKey(seriesId, sourceId, name));
      if (twin) {                                                                  // 同系列同来源同名 = 同一个模型
        idRemap.set(String(im.id), twin.id);
        ignoredModels++;
        continue;
      }
      if (!group) {
        group = { seriesId, models: [] };
        groups.push(group);
        addedGroups.push(seriesId);
      }
      const model = { id: String(im.id), name, sourceId };
      group.models.push(model);
      byId.set(model.id, model);
      byKey.set(modelKey(seriesId, sourceId, name), model);
      addedModels++;
    }
  }
  return { groups, idRemap, addedModels, ignoredModels, addedGroups, skippedSeries };
}

/** 重命名模型配置：导入的非空 / 合法值覆盖，留空的保留当前（其余由 renameModel.save 再兜一次） */
function mergeRenameConfig(current, imported) {
  const out = { ...(current && typeof current === 'object' ? current : {}) };
  if (!imported || typeof imported !== 'object') return out;
  for (const k of ['baseUrl', 'modelId', 'promptTemplate']) {
    const v = imported[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  for (const k of ['temperature', 'topP']) {
    const n = Number(imported[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/** settings.renameModel（凭据）：导入的非空字段覆盖 */
function mergeRenameModel(current, imported) {
  const out = { apiKey: '', baseUrl: '', modelId: '', ...(current || {}) };
  if (!imported || typeof imported !== 'object') return out;
  for (const k of ['apiKey', 'baseUrl', 'modelId']) {
    const v = imported[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * 来源级密钥 / 地址：**只补空缺**。
 * 本机已经配好的不被导入覆盖（导入到新机器时空位自动填上；在老机器上导回来不会把本机 Key 换掉）。
 */
function mergeSourceConfig(current, imported) {
  const out = { ...(current || {}) };
  let filled = 0;
  let kept = 0;
  for (const [k, v] of Object.entries(imported && typeof imported === 'object' ? imported : {})) {
    if (!v || typeof v !== 'object') continue;
    const apiKey = String(v.apiKey || '');
    const baseUrl = String(v.baseUrl || '').trim();
    const cur = (out[k] && typeof out[k] === 'object') ? out[k] : { apiKey: '', baseUrl: '' };
    const merged = { apiKey: cur.apiKey || apiKey, baseUrl: cur.baseUrl || baseUrl };
    if (merged.apiKey !== String(cur.apiKey || '') || merged.baseUrl !== String(cur.baseUrl || '')) filled++;
    else if (apiKey || baseUrl) kept++;
    out[k] = merged;
  }
  return { config: out, filled, kept };
}

/** 导入的会话 / 消息（补字段、清圆点、把中断中的请求标记为失败、模型引用按 idRemap 改指） */
function sanitizeConversation(conv, idRemap) {
  const out = { ...clone(conv) };
  out.id = String(conv.id);
  const name = String(conv.name === undefined || conv.name === null ? '' : conv.name).trim();
  out.name = name || '导入的对话';
  out.nameAuto = conv.nameAuto !== false;
  out.createdAt = Number(conv.createdAt) || Date.now();
  out.updatedAt = Number(conv.updatedAt) || out.createdAt;
  out.dot = null;                                  // 圆点终态不跨机器搬（点开才消费，导入的旧点没有意义）
  delete out.unread;                               // 老版本字段
  out.messages = (Array.isArray(conv.messages) ? conv.messages : [])
    .map((m) => sanitizeMessage(m, idRemap))
    .filter(Boolean);
  return out;
}

function sanitizeMessage(msg, idRemap) {
  if (!msg || !msg.id) return null;
  const out = { ...clone(msg) };
  out.id = String(msg.id);
  out.text = typeof msg.text === 'string' ? msg.text : (msg.text === undefined || msg.text === null ? '' : String(msg.text));
  out.createdAt = Number(msg.createdAt) || Date.now();
  if (out.role === 'assistant') {
    if (['pending', 'running', 'polling'].includes(out.status)) {
      // 导出后另一端早就结束了：与「启动时规范化」同口径，标记为被中断
      out.status = 'error';
      out.error = { code: 'INTERRUPTED', message: '导入时会话里该请求已不在等待中，请重新发送。' };
      out.finishedAt = out.finishedAt || Date.now();
    }
    out.taskId = null;
    out.taskStatus = null;
    if (out.meta) {
      delete out.meta.mode;                        // 老数据字段（异步模式已删除）
      const mid = out.meta.modelId;
      if (mid && idRemap.has(mid)) out.meta = { ...out.meta, modelId: idRemap.get(mid) };
    }
  } else if (out.role === 'user' && out.model) {
    const mid = out.model.id;
    if (mid && idRemap.has(mid)) out.model = { ...out.model, id: idRemap.get(mid) };
  }
  return out;
}

/** 一段消息里被 idRemap 改指的模型引用数量（要在改写之前统计） */
function countRemapped(conv, idMap) {
  let n = 0;
  for (const m of (Array.isArray(conv && conv.messages) ? conv.messages : [])) {
    const modelId = m && (m.role === 'assistant' ? (m.meta && m.meta.modelId) : (m.model && m.model.id));
    if (modelId && idMap.has(modelId)) n++;
  }
  return n;
}

/**
 * 会话合并：按 id 查重后把导入的会话**追加在当前列表最新位置（最上面）**。
 * @returns {{conversations:object, added:number, skipped:number, messages:number, remapped:number}}
 */
function mergeConversations(current, imported, idRemap) {
  const idMap = idRemap instanceof Map ? idRemap : new Map();
  const cur = (current && Array.isArray(current.conversations)) ? current.conversations : [];
  const imp = (imported && Array.isArray(imported.conversations)) ? imported.conversations : [];
  const have = new Set(cur.map((c) => c && c.id).filter(Boolean));
  const added = [];
  let skipped = 0;
  let remapped = 0;
  for (const c of imp) {
    if (!c || !c.id || have.has(c.id)) { skipped++; continue; }
    have.add(c.id);
    remapped += countRemapped(c, idMap);       // 统计必须在 sanitizeConversation 改写引用之前
    added.push(sanitizeConversation(c, idMap));
  }
  const conversations = [...added, ...cur];
  const tabCounter = Math.max(
    Number((current && current.tabCounter) || 0) || 0,
    Number((imported && imported.tabCounter) || 0) || 0
  );
  const keepActive = !!(current && current.activeId) && conversations.some((c) => c.id === current.activeId);
  const activeId = keepActive
    ? current.activeId
    : ((added[0] && added[0].id) || (conversations[0] && conversations[0].id) || null);

  return {
    conversations: { version: (current && current.version) || 1, tabCounter, activeId, conversations },
    added: added.length,
    skipped,
    messages: added.reduce((n, c) => n + c.messages.length, 0),
    remapped
  };
}

/**
 * 合并整包（纯函数：只算不写盘）。回归脚本可直接断言。
 * @param {object} o
 * @param {object} o.current   {settings, modelSeries, renameConfig, conversations}
 * @param {object} o.imported  同上（可缺项）
 * @param {(dir:string)=>boolean} [o.dirExists] 判断目录是否存在（defaultSavePath 用）
 * @returns {{settings:object, modelSeries:object, renameConfig:object, conversations:object, summary:object, notes:string[]}}
 */
function mergeImport(o) {
  const current = (o && o.current) || {};
  const imported = (o && o.imported) || {};
  const dirExists = (o && typeof o.dirExists === 'function') ? o.dirExists : null;
  const curSettings = current.settings || store.DEFAULT_SETTINGS;
  const impSettings = imported.settings || null;
  const notes = [];

  // 1) 系列定义：先带上「当前没有的自定义系列」，否则第 2 步找不到系列就没法归位模型
  const seriesStep = mergeSeriesDefs(current.modelSeries, imported.modelSeries);
  if (seriesStep.added.length) notes.push(`新增模型系列 ${seriesStep.added.length} 个：${seriesStep.added.join('、')}`);

  // 2) 模型列表：追加 / 查重 / id 映射
  const groupsStep = mergeModelGroups(
    curSettings.modelGroups,
    impSettings && impSettings.modelGroups,
    seriesStep.config
  );
  if (groupsStep.ignoredModels) notes.push(`忽略已存在的模型 ${groupsStep.ignoredModels} 个（相同或同系列同来源同名）`);
  if (groupsStep.skippedSeries.length) notes.push(`跳过无法识别的系列：${[...new Set(groupsStep.skippedSeries)].join('、')}`);
  if (groupsStep.addedGroups.length) notes.push(`自动为 ${[...new Set(groupsStep.addedGroups)].join('、')} 新增系列分组`);

  // 3) 设置本体
  const settings = { ...clone(curSettings) };
  let filledSecrets = 0;
  if (impSettings && typeof impSettings === 'object') {
    for (const k of OPTION_KEYS) {
      const v = impSettings[k];
      if (v !== undefined && v !== null && v !== '') settings[k] = v;
    }
    const savePath = String(impSettings.defaultSavePath || '').trim();
    if (savePath) {
      if (!dirExists || dirExists(savePath)) settings.defaultSavePath = savePath;
      else notes.push('导入的默认保存路径在本机不存在，已保留当前设置');
    }
    settings.renameModel = mergeRenameModel(curSettings.renameModel, impSettings.renameModel);
    const sc = mergeSourceConfig(curSettings.sourceConfig, impSettings.sourceConfig);
    settings.sourceConfig = sc.config;
    filledSecrets = sc.filled;
    if (sc.kept) notes.push(`保留本机已有的 ${sc.kept} 组「系列·来源」密钥 / 地址（不被导入覆盖）`);
  }
  settings.modelGroups = groupsStep.groups;

  // 4) defaultModelId：导入值在合并后的列表里存在就用它（选项类设置按导入改动），否则保留当前 / 退回第一个
  const allModels = settings.modelGroups.flatMap((g) => g.models || []);
  const exists = (id) => !!id && allModels.some((m) => m.id === id);
  const importedDefault = impSettings && impSettings.defaultModelId;
  if (exists(importedDefault)) settings.defaultModelId = importedDefault;
  else if (!exists(settings.defaultModelId)) settings.defaultModelId = allModels.length ? allModels[0].id : '';

  // 5) 规整（未知系列 / 重复 id / 未知来源统一在这里被清掉）
  const normalized = store.normalizeModelGroups(settings, seriesStep.config);

  // 6) 系列定义：合并后确实有模型的系列一律放出来（hidden=false）
  const usedSeries = new Set(normalized.modelGroups.filter((g) => g.models.length).map((g) => g.seriesId));
  const modelSeries = unhideSeries(seriesStep.config, usedSeries);

  // 7) 重命名模型配置 + 会话
  const renameConfig = mergeRenameConfig(current.renameConfig, imported.renameConfig);
  const convStep = mergeConversations(current.conversations, imported.conversations, groupsStep.idRemap);

  return {
    settings: normalized,
    modelSeries,
    renameConfig,
    conversations: convStep.conversations,
    notes,
    summary: {
      conversations: convStep.added,
      skippedConversations: convStep.skipped,
      messages: convStep.messages,
      remappedModels: convStep.remapped,
      addedModels: groupsStep.addedModels,
      ignoredModels: groupsStep.ignoredModels,
      addedSeries: seriesStep.added.length,
      filledSecrets
    }
  };
}

// =====================================================================
// 图片落盘
// =====================================================================

/**
 * 包内媒体 → 数据目录（叠加：目录 / 文件不存在就创建；同名已存在则忽略 = 查重）。
 * @returns {{copied:number, skipped:number, failed:string[]}}
 */
function copyMedia(root, paths) {
  const out = { copied: 0, skipped: 0, failed: [] };
  for (const area of MEDIA_DIRS) {
    const from = path.join(root, area);
    if (!isDir(from)) continue;
    const to = paths && paths[area];
    if (!to) continue;
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      if (!isFile(src)) continue;
      const dest = path.join(to, safeBaseName(name));
      if (fs.existsSync(dest)) { out.skipped++; continue; }
      try {
        fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        out.copied++;
      } catch (e) {
        if (e.code === 'EEXIST') out.skipped++;
        else out.failed.push(`${area}/${name}: ${e.message}`);
      }
    }
  }
  return out;
}

// =====================================================================
// 导入总入口（解压 → 校验 → 合并 → 图片叠加）
// =====================================================================

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响导入结果 */ }
}

/**
 * 导入一个导出包：先把包名 / 目录协议两道校验做完，再合并。
 * 解压到 `<dataRoot>/cache/ss-import-*`（程序缓存目录），无论成败都会清掉。
 * **不写配置文件**：由调用方拿到 merged 后统一落盘（便于出错时不留下半套数据）。
 * @returns {Promise<{ok:true, merged:object, media:object, manifest:object, imported:object}
 *                   | {ok:false, code:string, message:string}>}
 */
async function importData(o) {
  const opts = o || {};
  const zipPath = String(opts.zipPath || '');
  const paths = opts.paths || {};
  if (!zipPath || !isFile(zipPath)) return { ok: false, code: 'BAD_ZIP', message: '选择的压缩包不存在或不可读。' };

  // ---- 第一道：包名协议（先于解压）----
  const nameCheck = parseZipName(path.basename(zipPath));
  if (!nameCheck.ok) {
    log.warn('导入被拒绝：包名不符合协议', { file: path.basename(zipPath) });
    return { ok: false, code: 'BAD_NAME', message: nameCheck.message };
  }
  if (!paths.cache) return { ok: false, code: 'BAD_DEST', message: '数据目录不可用，无法解压导入包。' };

  // ---- 解压到程序缓存目录 ----
  const workDir = path.join(paths.cache, `ss-import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    try {
      await zip.extractAll(zipPath, workDir);
    } catch (e) {
      const code = e && e.code === 'BAD_NAME' ? 'BAD_STRUCTURE' : 'BAD_ZIP';
      log.error('导入失败：解压出错', { file: path.basename(zipPath), error: e.message, code });
      return { ok: false, code, message: `压缩包解压失败：${e.message}` };
    }

    // ---- 第二道：包内目录协议 ----
    const check = inspectDir(workDir);
    if (!check.ok) {
      log.warn('导入被拒绝：包内目录不符合协议', { file: path.basename(zipPath), message: check.message });
      return check;
    }
    const bundle = readBundle(check.root);
    if (!bundle.ok) return bundle;

    // ---- 合并（纯计算）----
    const merged = mergeImport({ current: opts.current, imported: bundle.data, dirExists: opts.dirExists });

    // ---- 图片叠加到数据目录 ----
    const media = copyMedia(check.root, paths);
    if (media.failed.length) {
      log.error('导入失败：图片写入数据目录出错', { failed: media.failed });
      return { ok: false, code: 'COPY_FAILED', message: `图片写入数据目录失败：${media.failed.slice(0, 3).join('；')}` };
    }

    log.info('导入解析完成', {
      file: path.basename(zipPath), manifest: check.manifest,
      media, summary: merged.summary, notes: merged.notes
    });
    return { ok: true, merged, media, manifest: check.manifest, imported: bundle.data };
  } finally {
    cleanup(workDir);
  }
}

module.exports = {
  // 协议常量
  EXPORT_PREFIX,
  ROOT_DIR,
  MANIFEST_FILE,
  FORMAT,
  FORMAT_VERSION,
  SETTINGS_FILE,
  CONVERSATIONS_FILE,
  SERIES_FILE,
  RENAME_FILE,
  MEDIA_DIRS,
  ZIP_NAME_RE,
  // 包名
  zipNameFor,
  parseZipName,
  // 导出
  referencedImages,
  exportData,
  // 导入
  inspectDir,
  readBundle,
  importData,
  copyMedia,
  // 合并（纯函数，回归脚本直接断言）
  mergeImport,
  mergeModelGroups,
  mergeSeriesDefs,
  mergeConversations,
  mergeRenameConfig,
  mergeRenameModel,
  mergeSourceConfig,
  sanitizeConversation
};
