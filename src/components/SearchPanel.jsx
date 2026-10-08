/*
 * 全局搜索面板（挂在侧栏里，见 components/Sidebar.jsx）
 * ==================================================================
 * 三步实现的分工（见 AIDEV.md §4.17）：
 *   · 第 1 步（本文件）：只读搜索 —— 全部会话的用户气泡文字 + API 返回文本，列出命中；
 *   · 第 2 步：点结果 / ↑↓ / Enter → 定位到那条消息（同对话内滚动 + 文字高亮）；
 *   · 第 3 步：目标在别的标签时自动切过去再定位（滚动抑制在 ChatView 里）。
 *
 * 高亮一律用「按区间切分 + 渲染 <mark>」实现，**不用 innerHTML** ——
 * 消息文字是用户 / 远端返回的，绝不能当 HTML 插进 DOM。
 */
import React, { useEffect, useRef } from 'react';
import Icon from './Icon.jsx';
import { useSearch } from '../lib/searchState.jsx';
import { matchRanges } from '../lib/search.js';

/** 把 text 按 ranges（半开区间）切成 [纯文本, <mark>命中</mark>, ...] */
export function renderMarks(text, query) {
  const s = String(text == null ? '' : text);
  const needle = String(query || '').trim().toLowerCase();
  const ranges = needle ? matchRanges(s, needle) : [];
  if (!ranges.length) return s;
  const out = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(s.slice(at, a));
    out.push(<mark key={`${a}-${i}`}>{s.slice(a, b)}</mark>);
    at = b;
  });
  if (at < s.length) out.push(s.slice(at));
  return out;
}

export default function SearchPanel() {
  const s = useSearch();
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  // 打开面板时输入框已经挂上 DOM 了：在这里聚焦最稳（provider 里那次 setTimeout 只是兜底，
  // 面板本来就开着再按 Ctrl+F 时靠它重新聚焦）
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  // 输入框元素登记给 provider
  useEffect(() => { s.inputRef.current = inputRef.current; }, [s.inputRef, s.open]);

  // 当前命中的那一条滚进视野（结果列表自己的滚动，与聊天区滚动互不相干）
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !s.cursor) return;
    const el = box.querySelector('.search-hit.current');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [s.cursor]);

  const onKeyDown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;      // 中文输入法组字中：回车/箭头不当作操作
    if (e.key === 'Escape') { e.preventDefault(); s.closeSearch(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) s.gotoPrev(); else s.gotoNext();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); s.gotoNext(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); s.gotoPrev(); }
  };

  const r = s.result;
  const summary = !String(s.term).trim()
    ? ''
    : (r && r.total
      ? `${r.total} 处命中 · ${r.msgCount} 条消息 · ${r.convCount} 个对话${r.truncated ? `（只列出前 ${s.hits.length} 处）` : ''}`
      : '没有匹配的内容');

  return (
    <div className="search-panel">
      <div className="search-bar">
        <Icon name="search" size={15} className="search-bar-icon" />
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          value={s.query}
          placeholder="搜索全部对话（提示词 / 返回内容）"
          spellCheck={false}
          onChange={(e) => s.onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {!!s.query && (
          <button className="icon-btn search-clear" title="清空" onClick={() => s.onQueryChange('')}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      <div className="search-tools">
        <span className="search-count" title={summary}>{s.cursor > 0 ? `${s.cursor} / ${s.hitCount}` : (summary || '输入关键词开始搜索')}</span>
        {/* 没有命中时不占位：把宽度留给统计文案（侧栏只有 264px，长文案很容易被截断） */}
        {s.hitCount > 0 && (
          <div className="search-nav">
            <button
              className="icon-btn"
              title="上一个命中（Shift+Enter / ↑）"
              onClick={s.gotoPrev}
            ><Icon name="chevronUp" size={15} /></button>
            <button
              className="icon-btn"
              title="下一个命中（Enter / ↓）"
              onClick={s.gotoNext}
            ><Icon name="chevronDown" size={15} /></button>
          </div>
        )}
        <button className="icon-btn search-close" title="关闭搜索（Esc）" onClick={s.closeSearch}>
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="search-results" ref={boxRef}>
        {/* 关键词为空：给出查询历史，点一下就回到那次搜索 */}
        {!String(s.term).trim() && (
          s.history.length ? (
            <div className="search-history">
              <div className="search-history-title">最近搜索</div>
              {s.history.map((q) => (
                <button key={q} className="search-history-item" title={`搜索「${q}」`} onClick={() => s.setQueryTerm(q)}>
                  <Icon name="search" size={13} /> <span>{q}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="search-empty">输入关键词，搜索全部对话里的提示词与返回内容。</div>
          )
        )}

        {!!String(s.term).trim() && r && r.total === 0 && (
          <div className="search-empty">没有匹配的内容。</div>
        )}

        {!!String(s.term).trim() && s.hits.map((h, i) => (
          <button
            key={`${h.msgId}-${h.fieldIndex}-${i}`}
            className={`search-hit${s.cursor === i + 1 ? ' current' : ''}`}
            title={`${h.convName} · ${h.role === 'user' ? '用户气泡' : '返回内容'} · ${h.label}`}
            onClick={() => s.gotoHit(i)}
          >
            <div className="search-hit-head">
              <span className="search-hit-conv">{h.convName || '未命名对话'}</span>
              <span className={`search-hit-kind ${h.role}`}>{h.role === 'user' ? '用户' : '返回'}</span>
              <span className="search-hit-label">{h.label}</span>
            </div>
            <div className="search-hit-snippet">{renderMarks(h.snippet, s.term)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
