'use strict';
/*
 * 会话标签自动命名 —— 「重命名模型」（设置 → 重命名模型）
 * ==================================================
 * 作用：把用户的第一条文字输入交给大模型精简成一句短标题，作为左侧会话标签的名字。
 *       （新会话在没有文字之前仍然叫序号，例如「3」。）
 *
 * 协议：DeepSeek **Responses API**（是 /responses，**不是** chat/completions，见工作区 deepseek系列.md）
 *   POST {baseUrl}/responses
 *   {
 *     "model": "deepseek-flash",              // 设置里留空时用配置里的默认模型
 *     "instructions": "<渲染后的标题生成模板>",
 *     "input": "{\"text\":\"<用户首条文字>\"}",  // 与模板中的 {$$} 同源
 *     "temperature": 0.5,
 *     "top_p": 0.5,
 *     "reasoning": { "effort": "none" },      // 非思考模式：标题任务不需要思维链，更快更省
 *     "text": { "format": { "type": "json_object" } },
 *     "stream": false
 *   }
 *   响应为 OpenAI Responses 结构：output[] 中 type=message 的 item → content[] 中
 *   type=output_text 的 text（形如 {"title":"智能客服提效"}）即标题。
 *
 * 配置（两份，职责不同）：
 *   1) electron/assets/rename-model.json —— 随包发布的内置默认值：默认 API 地址、默认模型 id、
 *      temperature(0.5)、topP(0.5) 与标题生成提示模板（含 $$ 占位）；首次启动复制到数据目录，
 *      之后的读写都在数据目录副本（<dataRoot>/rename-model.json，可手工编辑，UI 里的滑动条也写它）。
 *   2) settings.json 的 renameModel = { apiKey, baseUrl, modelId } —— 用户填写的凭据与覆盖值；
 *      地址 / 模型 id 留空 = 用上面 json 里的默认值。
 *
 * 约定：本文件不打印任何 Key；失败只回 {ok:false, code, message}，绝不抛异常。
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { endpoint, errorMessage, errorCode, isHttpError } = require('./api/util');

/** 内置配置（随包发布，只读） */
const SEED_FILE = path.join(__dirname, '..', 'assets', 'rename-model.json');
/** 配置缺失/损坏时的兜底默认值（正常情况下用不到：一切以内置 json 为准） */
const FALLBACK_BASE_URL = 'https://api.deepseek.com';
const FALLBACK_MODEL_ID = 'deepseek-flash';
const FALLBACK_PROMPT = '你是一个标题生成助手。请根据输入 JSON 中的 text 字段提炼核心内容，'
  + '生成一个 5 或 6 个汉字的简洁中文标题；只输出 {"title":"五至六字标题"} 形式的 JSON，不要任何解释。\n\n'
  + '以下为实际输入 JSON：\n{$$}';

/** 标题是「顺手做的事」：超时就回退，不拖累界面 */
const TIMEOUT_MS = 20000;
/** 侧栏标签宽度有限：标题最多 18 个字符（按码点计，emoji 不会被截断） */
const MAX_TITLE_CHARS = 18;
/** 发给模型的文字上限（首条输入可能很长，标题只看开头一段） */
const MAX_INPUT_CHARS = 4000;

// ---------- 配置文件读写（与 model-series.json 同一套做法） ----------

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

function seedConfig() {
  return readJson(SEED_FILE) || { version: 1 };
}

const toNum = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/**
 * 合并「内置默认值 + 数据目录本地副本」。
 * 本地值合法（非空 / 数值在区间内）就用本地值，否则回退内置默认值。
 */
function mergeConfig(seed, cur) {
  const s = (seed && typeof seed === 'object') ? seed : {};
  const c = (cur && typeof cur === 'object') ? cur : {};
  const pick = (k) => (c[k] === undefined || c[k] === null || c[k] === '' ? s[k] : c[k]);

  const seedTemp = toNum(s.temperature, 0.5, 0, 2);
  const seedTopP = toNum(s.topP, 0.5, 0, 1);
  const tpl = String(pick('promptTemplate') || '').trim();
  const seedTpl = String(s.promptTemplate || '').trim();

  return {
    version: 1,
    baseUrl: String(pick('baseUrl') || '').trim() || FALLBACK_BASE_URL,
    modelId: String(pick('modelId') || '').trim() || FALLBACK_MODEL_ID,
    temperature: toNum(pick('temperature'), seedTemp, 0, 2),
    topP: toNum(pick('topP'), seedTopP, 0, 1),
    promptTemplate: tpl || seedTpl || FALLBACK_PROMPT,
    maxTitleChars: MAX_TITLE_CHARS
  };
}

/** 读取并合并配置；数据目录副本不存在时自动落地一份 */
function load(file) {
  const cur = readJson(file);
  const merged = mergeConfig(seedConfig(), cur);
  if (!cur) {
    try {
      writeJsonAtomic(file, merged);
      log.info('重命名模型配置已初始化到数据目录', { file });
    } catch (e) {
      log.warn('重命名模型配置落地失败（将只在内存中使用）', { file, error: e.message });
    }
  }
  return merged;
}

/** 保存（渲染进程提交的是整份配置；这里再合并一次，保证默认值与字段类型不被破坏） */
function save(file, data) {
  const merged = mergeConfig(seedConfig(), data);
  writeJsonAtomic(file, merged);
  return merged;
}

// ---------- 请求 / 解析 ----------

/** 用户填写的凭据与覆盖值（settings.json → renameModel） */
function config(settings) {
  const rm = (settings && settings.renameModel) || {};
  const apiKey = String(rm.apiKey || '').trim();
  return { apiKey, hasKey: !!apiKey, baseUrl: String(rm.baseUrl || '').trim(), modelId: String(rm.modelId || '').trim() };
}

/** 把模板里的 $$ 换成实际的输入 JSON 片段：$$ → "text":"<首条文字>"（模板中写作 {$$}） */
function renderTemplate(template, text) {
  const inputJson = JSON.stringify({ text });
  const fragment = inputJson.slice(1, -1);                 // 去掉外层花括号：\"text\":\"…\"
  const tpl = String(template || '');
  if (!tpl.trim()) return `以下为实际输入 JSON：\n${inputJson}`;
  if (tpl.includes('$$')) return tpl.replace(/\$\$/g, fragment);
  return `${tpl}\n\n以下为实际输入 JSON：\n${inputJson}`;   // 用户把占位符删掉时的兜底
}

/** 清洗模型输出：去引号 / 前后缀 / 结尾标点，并截到长度上限 */
function sanitizeTitle(raw) {
  let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  t = t.replace(/^(标题|会话标题|会话名称|title|name)\s*[:：]\s*/i, '');
  // 反复剥掉首尾的引号 / 括号 / 句末标点：模型常给「“xxx”。」这种双层包裹
  const edgeQuotes = /^["'“”‘’「」『』《》〈〉【】\[\]()（）]+|["'“”‘’「」『』《》〈〉【】\[\]()（）]+$/g;
  const endPunct = /[。．.!！?？,，、;；:：~～]+$/;
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(edgeQuotes, '').replace(endPunct, '').trim();
    if (t === before) break;
  }
  const cps = Array.from(t);
  if (cps.length > MAX_TITLE_CHARS) t = cps.slice(0, MAX_TITLE_CHARS).join('');
  return t;
}

/** 从 Responses 响应里取出正文（跳过 reasoning / function_call 等 item） */
function extractText(json) {
  if (!json || typeof json !== 'object') return '';
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text;

  const parts = [];
  const pushContent = (content) => {
    if (typeof content === 'string') { parts.push(content); return; }
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (!c) continue;
      if (typeof c === 'string') { parts.push(c); continue; }
      if (typeof c.text === 'string' && (!c.type || c.type === 'output_text' || c.type === 'text')) parts.push(c.text);
    }
  };

  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (!item || typeof item !== 'object') continue;
      if (item.type && item.type !== 'message') continue;   // 思维链 / 工具调用等一律忽略
      pushContent(item.content);
    }
  }
  // 兜底：地址被误配成 chat/completions 时也能取到文本
  if (!parts.length && json.choices && json.choices[0] && json.choices[0].message) {
    pushContent(json.choices[0].message.content);
  }
  return parts.join(' ').trim();
}

/** 正文 → 标题：优先按 {"title": "…"} 解析，解析不出来就按纯文本用 */
function pickTitle(text) {
  const t = String(text || '').trim();
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      for (const k of ['title', '标题', 'name']) {
        const v = obj && obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    } catch (e) { /* 不是合法 JSON：按纯文本处理 */ }
  }
  return t;
}

/**
 * 用重命名模型生成会话标题。
 * @param settings settings.json 内容（取 renameModel 里的 Key / 覆盖地址 / 覆盖模型 id）
 * @param text     用户首条文字
 * @param cfg      重命名模型配置（load() 的返回值；缺省时用内置默认值）
 * @returns {Promise<{ok:true,name:string}|{ok:false,code:string,message:string}>} 永不抛异常
 */
async function generateTitle(settings, text, cfg) {
  const prompt = String(text || '').trim();
  if (!prompt) return { ok: false, code: 'EMPTY_INPUT', message: '没有可用的用户文字。' };

  const sc = config(settings);
  if (!sc.hasKey) {
    return { ok: false, code: 'NO_API_KEY', message: '尚未配置重命名模型的 API Key（设置 → 重命名模型）。' };
  }

  const conf = mergeConfig(seedConfig(), cfg);
  const baseUrl = sc.baseUrl || conf.baseUrl;               // 设置里的地址优先，其次配置文件的默认地址
  const modelId = sc.modelId || conf.modelId;
  const url = endpoint(baseUrl, '/responses', conf.baseUrl);
  const inputText = prompt.slice(0, MAX_INPUT_CHARS);
  const body = {
    model: modelId,
    instructions: renderTemplate(conf.promptTemplate, inputText),
    input: JSON.stringify({ text: inputText }),
    temperature: conf.temperature,
    top_p: conf.topP,
    reasoning: { effort: 'none' },                          // 非思考模式
    text: { format: { type: 'json_object' } },              // 只要 {"title": "…"}
    stream: false
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    log.info('重命名模型请求', {
      url, model: modelId, chars: inputText.length,
      temperature: conf.temperature, topP: conf.topP
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sc.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { json = { __raw: raw }; }
    const durationMs = Date.now() - startedAt;

    if (isHttpError(res.status)) {
      const message = errorMessage(json, res.status);
      log.warn('重命名模型返回错误', { http: res.status, code: errorCode(json, res.status), message, durationMs });
      return { ok: false, code: errorCode(json, res.status), message: `HTTP ${res.status}：${message}` };
    }

    const name = sanitizeTitle(pickTitle(extractText(json)));
    if (!name) {
      log.warn('重命名模型没有返回可用标题', { http: res.status, durationMs });
      return { ok: false, code: 'EMPTY_TITLE', message: '模型没有返回可用标题。' };
    }
    const chars = Array.from(name).length;
    log.info('重命名模型已生成标题', { name, chars, model: modelId, durationMs });
    if (chars < 5 || chars > 6) {
      log.warn('标题字数不在模板要求的 5~6 字内（已按原样使用，可在 rename-model.json 里改模板）', { name, chars });
    }
    return { ok: true, name, chars };
  } catch (e) {
    const aborted = controller.signal.aborted;
    log.warn('重命名模型调用失败', { aborted, error: e && e.message });
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'REQUEST_ERROR',
      message: aborted ? `请求超时（${TIMEOUT_MS / 1000}s）。` : String((e && e.message) || e)
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  SEED_FILE,
  FALLBACK_BASE_URL,
  FALLBACK_MODEL_ID,
  FALLBACK_PROMPT,
  MAX_TITLE_CHARS,
  MAX_INPUT_CHARS,
  load,
  save,
  mergeConfig,
  config,
  renderTemplate,
  sanitizeTitle,
  extractText,
  pickTitle,
  generateTitle
};
