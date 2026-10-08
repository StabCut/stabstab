/*
 * 全局搜索的状态与协调（React 一半，纯逻辑在 lib/search.js）
 * ==================================================================
 * 为什么状态必须放在这里（而不是 ChatView / Sidebar 内部）：
 *   · 搜索结果是**跨标签**的，而 ChatView 拿的是「当前标签」的数据 —— 放在它内部，
 *     切标签就会把结果列表和当前命中序号一起重置；
 *   · 跳转要经过「改 activeId → 等目标标签渲染 → 再滚动定位」两拍，
 *     这两拍必须由同一个人持有（pending），否则第二拍无从知道自己在为什么滚。
 *   · 搜索面板挂在 Sidebar 里，而 Sidebar 是常驻组件 —— 状态提升到这里，
 *     切标签时面板本身也不会被卸载。
 *
 * 定位的两拍（见 AIDEV.md §4.17）：
 *   ① 点结果：如果目标会话不是当前标签 → 先 activate（setPendingJump），ChatView 的
 *      自动贴底会被 suppress 掉；
 *   ② ChatView 渲染出目标消息后 consumeJump() —— 清楚 pending，再滚动 + 闪烁。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './store.jsx';
import { searchConversations } from './search.js';

/** 输入防抖：搜索本身是毫秒级，但大数据量下每敲一个字都全量扫一遍没必要 */
const QUERY_DEBOUNCE_MS = 120;

/** 查询历史（输入框空的时候展示，点一下就回到那次搜索） */
const HISTORY_MAX = 8;
const HISTORY_KEY = 'stabstab.searchHistory';

const SearchCtx = createContext(null);

function loadHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x).slice(0, HISTORY_MAX) : [];
  } catch (e) { return []; }
}

function saveHistory(list) {
  try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) { /* 隐私模式 / 配额：搜索历史丢了不影响功能 */ }
}

export function SearchProvider({ children }) {
  const { state, dispatch } = useApp();
  const conversations = state.conversations.conversations;
  const activeId = state.conversations.activeId;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');          // 输入框里的即时值
  const [term, setTerm] = useState('');            // 防抖后的实际查询串（真正跑搜索的那个）
  const [cursor, setCursor] = useState(0);         // 当前命中的下标；0 表示「还没站上任何一条」
  const [jump, setJump] = useState(null);          // {convId,msgId,seq} 待定位目标（seq 让同一目标可重复触发）
  const [history, setHistory] = useState(loadHistory);
  const seqRef = useRef(0);
  const inputRef = useRef(null);

  // 打开时聚焦输入框；关闭时把输入框里的即时值也收回来（下次打开是同一次搜索）
  const openSearch = useCallback(() => {
    setOpen(true);
    window.setTimeout(() => {
      const el = inputRef.current;
      if (el) { el.focus(); el.select(); }
    }, 0);
  }, []);
  const closeSearch = useCallback(() => setOpen(false), []);
  const toggleSearch = useCallback(() => setOpen((v) => !v), []);

  // 输入 → 防抖 → 真正查询。
  // ★ typeSeqRef 是「这次防抖回调是不是还为当前这次输入而发」的闸：用户清空输入框后立刻
  //   点一条历史项（setQueryTerm 直接设 term），清空那一拍排下的防抖原本会把新词覆盖成空串。
  const typeSeqRef = useRef(0);
  const onQueryChange = useCallback((next) => {
    typeSeqRef.current += 1;
    setQuery(next);
  }, []);

  useEffect(() => {
    const mine = typeSeqRef.current;
    const t = window.setTimeout(() => {
      if (typeSeqRef.current === mine) setTerm(query);
    }, QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  /** 直接落一个查询词（点历史项）：跳过防抖，同时作废还没发的那一次 */
  const setQueryTerm = useCallback((value) => {
    typeSeqRef.current += 1;
    const v = String(value == null ? '' : value);
    setQuery(v);
    setTerm(v);
  }, []);

  /**
   * 聊天数据变化（新消息 / 编辑重发 / 删除 / 导入）时结果会自动跟着变 ——
   * 因为 conversations 是依赖项，这里没有「索引过期」这回事。
   */
  const result = useMemo(
    () => (open && String(term).trim() ? searchConversations(conversations, term) : null),
    [open, term, conversations]
  );

  const hits = result ? result.hits : [];
  const hitCount = hits.length;

  // 结果集变了（改了词、删了消息）时把游标收回「还没站上任何一条」——
  // ★ 必须和「换词自动落位」在同一拍里完成：归零在前、落位在后（见 ChatView 的绑定 effect）。
  //   如果只归零不落位，就会出现「hits 已经更新、游标却是 0、界面上一点高亮都没有」的空窗。
  //
  // setGen 同时把「已经落位过的词」作废：否则同一个词「清空输入框 → 再输一遍」时，
  // 绑定端看到词没变就不再落位，游标永远停在 0（界面上没有任何高亮，实际踩过）。
  const [gen, setGen] = useState(0);
  useEffect(() => { setCursor(0); setGen((g) => g + 1); }, [term]);

  /**
   * 记住查询历史：**每个查询词只登记一次**（lastLogged 记账），且只在这次查询真的查到东西时记。
   * 为什么不能只看 result.total：清空输入框（term=''）再点一条历史项时，term 会先回到那个词，
   * 于是「result 变了」和「term 回到旧词」两件事各触发一次，旧词被重复登记，把真正的最近一次挤到后面。
   */
  const lastLoggedRef = useRef('');
  useEffect(() => {
    if (!open) return;
    const q = String(term).trim();
    if (!q || !result || !result.total) return;
    if (lastLoggedRef.current === q) return;
    lastLoggedRef.current = q;
    setHistory((prev) => {
      if (prev[0] === q) return prev;
      const next = [q, ...prev.filter((x) => x !== q)].slice(0, HISTORY_MAX);
      saveHistory(next);
      return next;
    });
  }, [open, term, result]);

  /** 切到第 i 条命中（hits 下标；越界夹紧并循环）。只负责「改游标 + 交给 ChatView 定位」 */
  const gotoHit = useCallback((i) => {
    if (!hits.length) return;
    const idx = ((i % hits.length) + hits.length) % hits.length;
    setCursor(idx + 1);                       // 1-based：0 = 还没站上任何一条
    const h = hits[idx];
    seqRef.current += 1;
    setJump({ convId: h.convId, msgId: h.msgId, seq: seqRef.current, fieldIndex: h.fieldIndex });
    if (h.convId !== activeId) dispatch({ type: 'CONV_ACTIVATE', id: h.convId });
  }, [hits, activeId, dispatch]);

  /**
   * 换查询词时的自动落点：优先停在**当前标签**里的第一处命中；当前标签一处都没有，
   * 就切到有命中的第一个标签并停在它的第一处。留着游标不动是最差的体验（结果在手边却要自己翻）。
   *
   * ★ 必须由 searchState 提供、由 ChatView 在「同一个 term 只调一次」的前提下调用：
   *   调用它会立刻改游标，而「换词 → 游标归零」也发生在同一拍 —— 两者顺序不确定会互相覆盖
   *   （曾经的表现：换词后 hits 已经更新，游标却是 0，界面上任何高亮都没有）。
   * @param {string} convId 当前标签
   * @param {string} term   这一拍生效的查询词（调用方用它去重，保证每个词只自动落位一次）
   */
  const syncToTerm = useCallback((convId, term) => {
    if (!hits.length) return false;
    let pick = -1;
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].convId === convId) { pick = i; break; }
    }
    gotoHit(pick >= 0 ? pick : 0);
    return true;
  }, [hits, gotoHit]);

  /**
   * 切到某个会话里的第 i 处命中（i 是**该会话内**的序号，0-based，超出就夹到两端）。
   * 用在两个场合：切换标签后自动站到该会话的第一处 / 用户自己滚到别处后再点「下一个」。
   * @returns {boolean} 该会话里有没有命中可站
   */
  const pageHit = useCallback((convId, i) => {
    const list = [];
    for (let k = 0; k < hits.length; k++) if (hits[k].convId === convId) list.push(k);
    if (!list.length) return false;
    const at = Math.max(0, Math.min(list.length - 1, Number(i) || 0));
    gotoHit(list[at]);
    return true;
  }, [hits, gotoHit]);

  const gotoNext = useCallback(() => gotoHit(cursor), [gotoHit, cursor]);            // cursor 是 1-based，下一个正好是下标 cursor
  const gotoPrev = useCallback(() => gotoHit(cursor - 2), [gotoHit, cursor]);

  /** ChatView 滚到位之后回来说一声（清掉 pending，避免下次切标签又被抑制） */
  const consumeJump = useCallback((seq) => {
    setJump((cur) => (cur && cur.seq === seq ? null : cur));
  }, []);

  /**
   * 扫描命中表（第 2 / 3 步的定位与高亮要用）：
   *   · records：拍平后的全部记录，交给 messageMarks 算每个会话里的高亮区间；
   *   · index：命中的全局序号（1-based），当前命中 = index.get(current.msgId + 字段下标)。
   * 不直接把「当前是第几处」算进高亮表：那样每次挪游标都要重建整张表。
   */
  const index = useMemo(() => (hits.length ? hits : null), [hits]);

  const current = cursor > 0 && cursor <= hitCount ? hits[cursor - 1] : null;

  const value = useMemo(() => ({
    open, query, term, history, result,
    hits, hitCount, cursor, current, jump,
    records: result ? result.flat : null,
    index,
    gen,
    openSearch, closeSearch, toggleSearch,
    onQueryChange,
    setQueryTerm,
    gotoHit, gotoNext, gotoPrev, pageHit, syncToTerm, consumeJump,
    inputRef
  }), [
    open, query, term, history, result, hits, hitCount, cursor, current, jump, index, activeId, gen,
    openSearch, closeSearch, toggleSearch, onQueryChange, setQueryTerm, gotoHit, gotoNext, gotoPrev, pageHit, syncToTerm, consumeJump
  ]);

  return <SearchCtx.Provider value={value}>{children}</SearchCtx.Provider>;
}

export function useSearch() {
  const ctx = useContext(SearchCtx);
  if (!ctx) throw new Error('useSearch 必须在 SearchProvider 内使用');
  return ctx;
}
