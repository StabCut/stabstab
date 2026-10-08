import React from 'react';

/*
 * 气泡里的命中高亮（全局搜索用，见 AIDEV.md §4.19）
 * ================================================
 * 输入是「这段文字里的命中区间」（半开区间，由 lib/search.js#matchRanges 在**同一段文字**上算出），
 * 输出是按区间切好的 React 元素 —— 一律走元素拼接，**不用 innerHTML**：
 * 消息文字来自用户输入与远端返回，绝不能当 HTML 插进 DOM。
 *
 * 一个 `.msg-text` 可能有几段命中（例如 messages 里的同一条消息命中多个字段，
 * 而这些字段在气泡里是同一段文字），所以 marks 是数组：任意一段标成「当前」就整体突出。
 */
export default function HighlightText({ text, marks, className = 'msg-text' }) {
  const s = String(text == null ? '' : text);
  const clean = (Array.isArray(marks) ? marks : []).filter((m) => m && (m.ranges || []).length);
  if (!clean.length) return <div className={className}>{s}</div>;

  const isCurrent = clean.some((m) => m.current);
  // 各段区间合并后再切分：同一处文字被两段命中覆盖时不会嵌套出重复的 <mark>
  const spans = [];
  clean.forEach((m) => m.ranges.forEach(([a, b]) => spans.push([a, b])));
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  const out = [];
  let at = 0;
  merged.forEach(([a, b], i) => {
    if (a > at) out.push(s.slice(at, a));
    out.push(<mark key={`m${i}`} className={isCurrent ? 'current' : ''}>{s.slice(a, b)}</mark>);
    at = b;
  });
  if (at < s.length) out.push(s.slice(at));

  return <div className={className}>{out}</div>;
}
