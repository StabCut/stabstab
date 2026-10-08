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
import { searchConversations, hitsOfConversation } from './search.js';

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

  // 输入 → 防抖 → 真正查询
  const onQueryChange = useCallback((next) => {
    setQuery(next);
    if (!String(next).trim()) setCursor(0);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setTerm(query), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

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

  // 结果集变了（改了词 / 删了消息）：把游标收回「还没站上」，避免指向已消失的命中
  useEffect(() => { setCursor(0); }, [term]);

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

  const gotoNext = useCallback(() => gotoHit(cursor), [gotoHit, cursor]);            // cursor 是 1-based，下一个正好是下标 cursor
  const gotoPrev = useCallback(() => gotoHit(cursor - 2), [gotoHit, cursor]);

  /** ChatView 滚到位之后回来说一声（清掉 pending，避免下次切标签又被抑制） */
  const consumeJump = useCallback((seq) => {
    setJump((cur) => (cur && cur.seq === seq ? null : cur));
  }, []);

  /**
   * 当前标签里的全部命中（用于高亮）：msgId -> [{fieldIndex, ranges}]。
   * 光标站上的那一条由 ChatView 额外加 .current 强调。
   */
  const activeHits = useMemo(() => {
    if (!open || !result || !activeId) return null;
    return hitsOfConversation(result.flat, activeId, term);
  }, [open, result, activeId, term]);

  const current = cursor > 0 && cursor <= hitCount ? hits[cursor - 1] : null;

  const value = useMemo(() => ({
    open, query, term, history, result,
    hits, hitCount, cursor, current, jump,
    activeHits,
    openSearch, closeSearch, toggleSearch,
    onQueryChange: (v) => onQueryChange(v),
    setQueryTerm: (v) => { setQuery(String(v)); setTerm(String(v)); },
    gotoHit, gotoNext, gotoPrev, consumeJump,
    inputRef
  }), [
    open, query, term, history, result, hits, hitCount, cursor, current, jump, activeHits,
    openSearch, closeSearch, toggleSearch, onQueryChange, gotoHit, gotoNext, gotoPrev, consumeJump
  ]);

  return <SearchCtx.Provider value={value}>{children}</SearchCtx.Provider>;
}

export function useSearch() {
  const ctx = useContext(SearchCtx);
  if (!ctx) throw new Error('useSearch 必须在 SearchProvider 内使用');
  return ctx;
}
