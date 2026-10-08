/*
 * 全局搜索 —— 纯逻辑层（不碰 React / DOM，导出便于 QA 直接断言）
 * ==================================================================
 * 搜索范围（「用户气泡 + API 返回」两类都覆盖，见 AIDEV.md §4.17）：
 *   · 用户气泡：提示词正文 text、输入图文件名（name / srcName）、当时用的模型名
 *   · 助手气泡：API 返回文本 texts[]、错误信息（code / message / requestId）、任务 ID
 *
 * ★ 数据源就是 state.conversations.conversations（渲染进程内存里的权威数据）：
 *   列表已经全量渲染（没有虚拟滚动），所以搜索不需要 IPC、不需要落盘索引、
 *   也不需要主进程配合。日志/字节流那一层完全不参与。
 *
 * 性能取舍：**不做倒排索引**。消息只增不改（编辑重发是「删旧建新」，见 send.js），
 *   一次全量线性扫描在正常数据量下是毫秒级；省下的复杂度比省下的时间值钱。
 */

/** 结果条数上限（超出的用 truncated 标记，UI 提示「还有更多」） */
export const HIT_LIMIT = 200;

/** 片段（snippet）上下各留的上下文字符数 */
export const SNIPPET_PAD = 24;

/** 命中片段最多贴多长（超出中间省略） */
const SNIPPET_MAX = 120;

/**
 * 一条消息被搜集出来的「可搜字段」。
 * @typedef {{text:string, kind:'user'|'assistant', label:string}} SearchField
 * @typedef {{convId:string, convName:string, msgId:string, createdAt:number, updatedAt:number,
 *            role:'user'|'assistant', index:number, status:string,
 *            fields:SearchField[], text:string, lastText:boolean}} SearchRecord
 */

/**
 * 从一条消息里取出全部可搜文字（**顺序即结果展示的优先级**）。
 * @param {object} msg 会话里的消息对象（见 store.jsx / send.js）
 * @returns {SearchField[]}
 */
export function fieldsOfMessage(msg) {
  if (!msg) return [];
  const out = [];
  if (msg.role === 'user') {
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (text) out.push({ text, kind: 'user', label: '提示词' });
    for (const im of msg.images || []) {
      if (im && im.name) out.push({ text: im.name, kind: 'user', label: '输入图' });
      if (im && im.srcName) out.push({ text: im.srcName, kind: 'user', label: '输入图' });
    }
    const model = (msg.model && msg.model.name) || '';
    if (model) out.push({ text: model, kind: 'user', label: '模型' });
    return out;
  }

  // 助手消息：API 返回内容
  const texts = (msg.texts || []).filter((t) => typeof t === 'string' && t);
  for (const t of texts) out.push({ text: t, kind: 'assistant', label: '返回文字' });
  if (msg.error) {
    if (msg.error.message) out.push({ text: String(msg.error.message), kind: 'assistant', label: '错误信息' });
    if (msg.error.code) out.push({ text: String(msg.error.code), kind: 'assistant', label: '错误码' });
    if (msg.error.requestId) out.push({ text: String(msg.error.requestId), kind: 'assistant', label: 'Request ID' });
  }
  if (msg.taskId) out.push({ text: String(msg.taskId), kind: 'assistant', label: 'Task ID' });

  // 结果图文件名（带 name 的才是磁盘下载下来的那份）
  for (const im of msg.images || []) {
    if (im && im.name) out.push({ text: im.name, kind: 'assistant', label: '结果文件' });
  }
  return out;
}

/**
 * 把全部会话拍平成一条条可搜记录。
 * 消息对象上用 WeakMap 缓存「可搜字段」——同一份消息只收集一次，
 * 之后每敲一个字都只是字符串比较（编辑重发会造新对象，自动失效）。
 * @param {Array} conversations state.conversations.conversations
 * @returns {SearchRecord[]} 顺序 = 会话数组顺序，会话内 = 消息顺序
 */
export function collectRecords(conversations) {
  const list = Array.isArray(conversations) ? conversations : [];
  const cache = collectRecords._cache || (collectRecords._cache = new WeakMap());
  const out = [];
  for (const conv of list) {
    if (!conv || !Array.isArray(conv.messages)) continue;
    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      let fields = cache.get(msg);
      if (!fields) { fields = fieldsOfMessage(msg); cache.set(msg, fields); }
      if (!fields.length) continue;
      out.push({
        convId: conv.id,
        convName: conv.name || '',
        msgId: msg.id,
        createdAt: msg.createdAt || 0,
        updatedAt: conv.updatedAt || 0,
        role: msg.role,
        status: msg.status || '',
        index: i,
        fields,
        text: fields[0].text,
        lastText: i === conv.messages.length - 1
      });
    }
  }
  return out;
}

/**
 * 只在给定的这些记录里找（跨标签跳转时用来解析「这个会话里的命中有哪些」）。
 * @param {SearchRecord[]} records
 * @param {string} query
 * @param {{convId?:string}} [opts]
 */
export function searchRecords(records, query, opts = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const out = { query: String(query || '').trim(), records: 0, hits: [], total: 0, truncated: false };
  if (!needle) return out;
  const scope = opts.convId ? (records || []).filter((r) => r.convId === opts.convId) : (records || []);
  for (const rec of scope) {
    out.records++;
    for (let fi = 0; fi < rec.fields.length; fi++) {
      const text = rec.fields[fi].text;
      if (!text || text.toLowerCase().indexOf(needle) < 0) continue;
      out.total++;
      if (out.hits.length < HIT_LIMIT) {
        out.hits.push({
          convId: rec.convId,
          convName: rec.convName,
          msgId: rec.msgId,
          role: rec.role,
          status: rec.status,
          fieldIndex: fi,
          label: rec.fields[fi].label,
          text,
          snippet: snippetOf(text, needle),
          ranges: matchRanges(text, needle)
        });
      } else {
        out.truncated = true;
      }
    }
  }
  return out;
}

/**
 * 一次搜索：拍平 + 扫描 + 分组（UI 直接可用）。
 * @param {Array} conversations state.conversations.conversations
 * @param {string} query
 * @param {{limit?:number}} [opts]
 * @returns {{query:string, flat:Array, hits:Array, total:number, truncated:boolean,
 *            convCount:number, msgCount:number, byConv:Map<string, Array>}}
 */
export function searchConversations(conversations, query, opts = {}) {
  const flat = collectRecords(conversations);
  const r = searchRecords(flat, query);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
  const msgIds = new Set();
  for (const h of r.hits) msgIds.add(h.msgId);
  const conversationsWithHits = new Set();
  for (const h of r.hits) conversationsWithHits.add(h.convId);

  return {
    query: r.query,
    flat,
    hits: r.hits,
    total: r.total,
    truncated: r.truncated,
    msgCount: msgIds.size,
    convCount: conversationsWithHits.size,
    limitReached: !!limit && r.total > limit
  };
}

/**
 * 命中片段：以第一个命中为中心截取 ±SNIPPET_PAD，保留首尾省略号。
 * 命中本身过长时从中间截断（避免一条结果占满整屏）。
 * @param {string} text
 * @param {string} needle 已小写化的查询串
 */
export function snippetOf(text, needle) {
  const s = String(text == null ? '' : text);
  const at = needle ? s.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return clip(s, SNIPPET_MAX);
  const start = Math.max(0, at - SNIPPET_PAD);
  const end = Math.min(s.length, at + needle.length + SNIPPET_PAD);
  const body = clip(s.slice(start, end), SNIPPET_MAX + SNIPPET_PAD);
  return (start > 0 ? '…' : '') + body + (end < s.length ? '…' : '');
}

/** 中间截断（保留首尾，读起来仍像一句话） */
function clip(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  const head = Math.ceil(max / 2);
  const tail = Math.max(0, max - head);
  return `${str.slice(0, head)}…${str.slice(str.length - tail)}`;
}

/**
 * 一段文字里**全部**命中的区间（半开区间 [start, end)，按出现顺序）。
 * 索引与原文一致，由调用方按区间切分渲染 <mark> —— 不做 innerHTML，避免注入。
 * @param {string} text
 * @param {string} needle 已小写化的查询串
 * @returns {Array<[number, number]>}
 */
export function matchRanges(text, needle) {
  const s = String(text == null ? '' : text);
  const n = needle || '';
  const out = [];
  if (!n) return out;
  const hay = s.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(n, from);
    if (at < 0) break;
    out.push([at, at + n.length]);
    from = at + n.length;          // 区间不重叠，下一个从命中末尾继续
    if (from >= hay.length) break;
  }
  return out;
}

/**
 * 一条消息里所有命中区间的并集（用于「切到某个会话时，高亮它内部的所有命中」）。
 * @param {SearchRecord[]} records 全部记录（searchConversations 返回的 flat）
 * @param {string} convId
 * @param {string} query
 * @returns {Map<string, Array<[number,number]>>} msgId -> 区间（按 fieldIndex 归并后的每个字段各自一段）
 */
export function hitsOfConversation(records, convId, query) {
  const r = searchRecords(records, query, { convId });
  const map = new Map();
  for (const h of r.hits) {
    const list = map.get(h.msgId) || [];
    list.push({ fieldIndex: h.fieldIndex, ranges: h.ranges });
    map.set(h.msgId, list);
  }
  return map;
}
