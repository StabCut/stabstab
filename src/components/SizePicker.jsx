import React, { useEffect, useRef, useState } from 'react';
import { CUSTOM_SIZE, parseSizeDims, sizeLabel, sizeSeparator } from '../lib/models.js';

/** 输入框里只留数字：去掉符号 / 空格 / 前后多余的 0，最多 5 位 */
function digits(v) {
  const s = String(v === undefined || v === null ? '' : v).replace(/[^\d]/g, '').replace(/^0+/, '');
  return s ? s.slice(0, 5) : '';
}

/**
 * 尺寸选择器 = 当前模型来源的候选尺寸（sizeOptions） + 末尾的「自定义…」。
 *
 * 选中「自定义」后，右边出现两个数字输入框，中间那个乘号是**固定**的 ——
 * 用户只填两个数字，交给 API 的值由本组件按当前协议拼成
 * `宽*高`（DashScope / Qwen）或 `宽x高`（Seedream / New API / Grsai），见 models.js#sizeSeparator。
 *
 * 受控组件：value = 真正要发出去的尺寸字符串（'auto' / '1K' / '16:9' / '2048x2048' / 自定义的像素值）。
 * 「自定义态」单独记在本地 state（custom），不能只看 value 在不在候选列表里 ——
 * 用户填的数字正好等于某个候选值（例如 2048×2048）时，输入框必须继续留着。
 *
 * @param {string}   value      当前尺寸值
 * @param {string[]} options    候选尺寸（当前模型的 sizeOptions）
 * @param {object}   model      resolveModel 结果（只为取协议决定分隔符）
 * @param {Function} onChange   尺寸变化（自定义时每敲一个数字就回调，两个数字都填了才生效）
 */
export default function SizePicker({ value, options, model, onChange, className, selectTitle, customTitle }) {
  const opts = (options && options.length) ? options : ['auto'];
  const sep = sizeSeparator(model);
  const dimsOf = parseSizeDims(value);

  // 自定义态：外部给的像素尺寸（例如重发跟随输入区）同样以自定义态展示
  const [custom, setCustom] = useState(() => !opts.includes(value) && !!parseSizeDims(value));
  // 两个数字输入框的文本（留空 / 中间态都保留，只有两个都有效时才拼成尺寸回调出去）
  const [w, setW] = useState(dimsOf ? String(dimsOf.w) : '');
  const [h, setH] = useState(dimsOf ? String(dimsOf.h) : '');
  // 本次 value 变化是不是自己 emit 出去的：是就不要回写输入框（否则会把 "007" 这类中间态抹掉）
  const selfRef = useRef(false);

  // 外部把尺寸改成像素值 → 自定义态 + 两个输入框跟着走；
  // 改成 auto / 1K 这类候选值 → 收起输入框，数字留着下次选「自定义」还能用。
  useEffect(() => {
    const self = selfRef.current;
    selfRef.current = false;
    if (self) return;
    const d = parseSizeDims(value);
    if (d) {
      setW(String(d.w));
      setH(String(d.h));
      setCustom(true);
      return;
    }
    setCustom(false);
  }, [value]);

  const emit = (nw, nh) => {
    const a = digits(nw);
    const b = digits(nh);
    if (!a || !b) return;                 // 两个数字都填了才生效（清空输入框不会把尺寸发成空）
    const next = `${a}${sep}${b}`;
    if (next === value) return;
    selfRef.current = true;
    onChange(next);
  };

  const onSelect = (e) => {
    const v = e.target.value;
    if (v !== CUSTOM_SIZE) { setCustom(false); onChange(v); return; }
    // 选中「自定义」：沿用上次填过的数字（第一次用 1024×1024 打底）并立即生效，不必再点别处
    const d = parseSizeDims(value);
    const nw = digits(w) || (d ? String(d.w) : '1024');
    const nh = digits(h) || (d ? String(d.h) : '1024');
    setCustom(true);
    setW(nw);
    setH(nh);
    emit(nw, nh);
  };

  const selectValue = custom ? CUSTOM_SIZE : (opts.includes(value) ? value : (opts[0] || 'auto'));

  return (
    <>
      <select
        className={className}
        value={selectValue}
        onChange={onSelect}
        title={selectTitle || '输出尺寸 / 比例（最后一项可自定义：填两个数字即可）'}
      >
        {opts.map((s) => <option key={s} value={s}>{sizeLabel(s)}</option>)}
        <option value={CUSTOM_SIZE}>尺寸：自定义…</option>
      </select>
      {custom && (
        <span
          className="size-custom"
          title={customTitle || `自定义尺寸：填两个数字即可，中间的 × 是固定的（实际发送 ${sep === '*' ? '宽*高' : '宽x高'}）`}
        >
          <input
            type="number"
            className="size-custom-input"
            min="64"
            max="8192"
            step="1"
            inputMode="numeric"
            aria-label="自定义尺寸 - 宽"
            value={w}
            onChange={(e) => { setW(e.target.value); emit(e.target.value, h); }}
          />
          <span className="size-custom-sep" aria-hidden="true">×</span>
          <input
            type="number"
            className="size-custom-input"
            min="64"
            max="8192"
            step="1"
            inputMode="numeric"
            aria-label="自定义尺寸 - 高"
            value={h}
            onChange={(e) => { setH(e.target.value); emit(w, e.target.value); }}
          />
        </span>
      )}
    </>
  );
}
