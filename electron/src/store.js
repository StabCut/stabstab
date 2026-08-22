'use strict';
/*
 * JSON 持久化：设置与会话数据。
 * 采用「写临时文件 + rename」的原子写入，避免中断导致数据损坏。
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
  requestMode: 'sync',                 // sync | async（高级设置）
  api: {
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1'
  },
  models: [
    {
      id: 'm_builtin_qwen',
      name: 'qwen-image-3.0-pro',
      protocol: 'dashscope-multimodal',
      builtin: true
    }
  ],
  defaultModelId: 'm_builtin_qwen'
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

function loadSettings(file) {
  const s = readJson(file, null);
  if (!s || typeof s !== 'object') return { ...DEFAULT_SETTINGS };
  // 合并，确保新增字段有默认值
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    api: { ...DEFAULT_SETTINGS.api, ...(s.api || {}) },
    models: Array.isArray(s.models) && s.models.length ? s.models : DEFAULT_SETTINGS.models.slice()
  };
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
  saveConversations
};
