import React, { useEffect, useRef, useState } from 'react';
import { CUSTOM_SIZE, parseSizeDims, sizeLabel, sizeSeparator, ratioText, sizeRatioOf } from '../lib/models.js';

/** 输入框里只留数字：去掉符号 / 空格 / 前后多余的 0，最多 5 位 */
function digits(v) {
  const s = String(v === undefined || v === null ? '' : v).replace(/[^\d]/g, '').replace(/^0+/, '');
  return s ? s.slice(0, 5) : '';
}

/** 两个数字都 > 0 才算一个可用的尺寸（宽或高为 0 → 比例与方框都显示 '-'） */
function dimsOrNull(w, h) {
  const a = parseInt(digits(w), 10);
  const b = parseInt(digits(h), 10);
  if (!a || !b) return null;
  return { w: a, h: b };
}

/**
 * 比例 + 方框示例：按比例**真实绘制**一个小矩形（长边固定，短边按比例缩），
 * 取不到比例（auto / 1K / 2K / 4K，或宽/高有一个是 0）时方框位置显示 '-'。
 */
export function SizeRatioPreview({ ratio, className = '' }) {
  const MAX_W = 26;
  const MAX_H = 18;
  const text = ratio ? ratioText(ratio.w, ratio.h) : '-';
  let box = null;
  if (ratio) {
    const k = Math.min(MAX_W / ratio.w, MAX_H / ratio.h);
    const w = Math.max(3, Math.round(ratio.w * k));
    const h = Math.max(3, Math.round(ratio.h * k));
    box = <span className="size-ratio-box" style={{ width: w, height: h }} aria-hidden="true" />;
  } else {
    box = <span className="size-ratio-box none" aria-hidden="true">-</span>;
  }
  return (
    <span
      className={`size-ratio ${className}`.trim()}
      title={ratio
        ? `宽 : 高 = ${ratio.w} : ${ratio.h}（比例 ${text}），方框按这个比例真实绘制`
        : '这个尺寸没有确定的比例（自动 / 1K / 2K / 4K 这类档位由模型决定），所以比例与方框都显示 -'}
    >
      <span className="size-ratio-text">{text}</span>
      {box}
    </span>
  );
}

/**
 * 尺寸选择器 = 当前模型来源的候选尺寸（sizeOptions） + 末尾的「自定义…」。
 *
 * 选中「自定义」后，右边出现两个数字输入框，中间的乘号是一个**小按钮**：
 *   - 常态（×）= 宽高各自独立输入，交给 API 的值由本组件按当前协议拼成
 *     `宽*高`（DashScope / Qwen）或 `宽x高`（Seedream / New API / Grsai），见 models.js#sizeSeparator；
 *   - 点一下变成比例模式（:）= 后面多出两个比例输入框（中间是 `:`），
 *     此时改「宽」或「高」的任意一边，另一边都按这个比例四舍五入自动填进去；改比例则按当前宽度重算高度。
 * 两种情况下面都会实时显示**比例**与一个按比例真实绘制的**方框示例**（见 SizeRatioPreview）。
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
  // 比例模式（中间那个符号是 `:`）+ 比例输入框的两个数字
  const [ratioMode, setRatioMode] = useState(false);
  const [rw, setRw] = useState('');
  const [rh, setRh] = useState('');
  // 本次 value 变化是不是自己 emit 出去的：是就不要回写输入框（否则会把 "007" 这类中间态抹掉）
  const selfRef = useRef(false);

  // 外部把尺寸改成像素值 → 自定义态 + 两个输入框跟着走；
  // 改成 auto / 1K 这类候选值 → 收起输入框（比例模式一起退出），数字留着下次选「自定义」还能用。
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
    setRatioMode(false);
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

  /** 比例输入框里的一对数字（两个都 > 0 才有效） */
  const ratioPair = () => {
    const a = parseInt(digits(rw), 10);
    const b = parseInt(digits(rh), 10);
    if (!a || !b) return null;
    return { w: a, h: b };
  };

  /** 比例模式下：由已知的一边按比例算另一边（四舍五入；算不出 → 空串表示「不改」） */
  const counterpart = (side, value0, ratio) => {
    const v = parseInt(digits(value0), 10);
    if (!v || !ratio) return '';
    const out = side === 'w'
      ? Math.round(v * ratio.h / ratio.w)
      : Math.round(v * ratio.w / ratio.h);
    if (!Number.isFinite(out) || out < 1) return '';
    return String(Math.min(out, 99999));
  };

  const onChangeW = (v) => {
    setW(v);
    if (ratioMode) {
      const nh = counterpart('w', v, ratioPair());
      if (nh) { setH(nh); emit(v, nh); return; }
    }
    emit(v, h);
  };

  const onChangeH = (v) => {
    setH(v);
    if (ratioMode) {
      const nw = counterpart('h', v, ratioPair());
      if (nw) { setW(nw); emit(nw, v); return; }
    }
    emit(w, v);
  };

  /** 改比例：宽度不动，按新比例重算高度（宽度还没填就只更新比例与方框） */
  const onChangeRatio = (nextW, nextH) => {
    setRw(nextW);
    setRh(nextH);
    const ratio = (() => {
      const a = parseInt(digits(nextW), 10);
      const b = parseInt(digits(nextH), 10);
      return (a && b) ? { w: a, h: b } : null;
    })();
    const nh = counterpart('w', w, ratio);
    if (nh) { setH(nh); emit(w, nh); }
  };

  /**
   * 中间那个小按钮：× ⇄ : 切换比例模式。
   * 进入比例模式时用**当前宽高的最简比**预填（2048×1152 → 16:9），方框立刻跟着更新。
   */
  const toggleRatioMode = () => {
    if (ratioMode) { setRatioMode(false); return; }
    const d = dimsOrNull(w, h) || parseSizeDims(value);
    if (d) {
      const t = ratioText(d.w, d.h).split(':');
      // 小数比（3.00:1）没法当整数比例用 → 退回当前宽高原样
      if (t.length === 2 && !t[0].includes('.')) { setRw(t[0]); setRh(t[1]); }
      else { setRw(String(d.w)); setRh(String(d.h)); }
    } else {
      setRw((prev) => digits(prev) || '1');
      setRh((prev) => digits(prev) || '1');
    }
    setRatioMode(true);
  };

  const onSelect = (e) => {
    const v = e.target.value;
    if (v !== CUSTOM_SIZE) { setCustom(false); setRatioMode(false); onChange(v); return; }
    // 选中「自定义」：沿用上次填过的数字（第一次 1024×1024 打底）并立即生效，不必再点别处
    const d = parseSizeDims(value);
    const nw = digits(w) || (d ? String(d.w) : '1024');
    const nh = digits(h) || (d ? String(d.h) : '1024');
    setCustom(true);
    setW(nw);
    setH(nh);
    emit(nw, nh);
  };

  const selectValue = custom ? CUSTOM_SIZE : (opts.includes(value) ? value : (opts[0] || 'auto'));

  // 方框/比例取哪一对数字：自定义看输入框（比例模式下优先看比例），候选值看自己
  const preview = custom
    ? ((ratioMode ? ratioPair() : null) || dimsOrNull(w, h))
    : sizeRatioOf(value);

  return (
    <>
      <select
        className={className}
        value={selectValue}
        onChange={onSelect}
        title={selectTitle || '输出尺寸 / 比例（最后一项可自定义：填两个数字即可，右侧实时显示比例与方框）'}
      >
        {opts.map((s) => <option key={s} value={s}>{sizeLabel(s)}</option>)}
        <option value={CUSTOM_SIZE}>尺寸：自定义…</option>
      </select>
      {custom && (
        <span
          className={`size-custom${ratioMode ? ' ratio-mode' : ''}`}
          title={customTitle || `自定义尺寸：填两个数字即可（实际发送 ${sep === '*' ? '宽*高' : '宽x高'}）；点中间的符号可切到比例模式`}
        >
          <input
            type="number"
            className="size-custom-input size-dim-input"
            min="64"
            max="8192"
            step="1"
            inputMode="numeric"
            aria-label="自定义尺寸 - 宽"
            value={w}
            onChange={(e) => onChangeW(e.target.value)}
          />
          <button
            type="button"
            className="size-custom-sep size-mode-btn"
            aria-label={ratioMode ? '切回宽高独立输入' : '切换到比例模式'}
            aria-pressed={ratioMode}
            title={ratioMode
              ? '当前是比例模式（:）：改任一边，另一边按这个比例自动算；点一下回到宽高独立输入'
              : '点一下进入比例模式（:）：填一个比例，改任一边另一边自动按比例计算'}
            onClick={toggleRatioMode}
          >{ratioMode ? ':' : '×'}</button>
          <input
            type="number"
            className="size-custom-input size-dim-input"
            min="64"
            max="8192"
            step="1"
            inputMode="numeric"
            aria-label="自定义尺寸 - 高"
            value={h}
            onChange={(e) => onChangeH(e.target.value)}
          />
          {ratioMode && (
            <span className="size-ratio-inputs">
              <span className="size-ratio-tag">比例</span>
              <input
                type="number"
                className="size-custom-input size-ratio-input"
                min="1"
                max="999"
                step="1"
                inputMode="numeric"
                aria-label="比例 - 宽"
                value={rw}
                onChange={(e) => onChangeRatio(e.target.value, rh)}
              />
              <span className="size-custom-sep" aria-hidden="true">:</span>
              <input
                type="number"
                className="size-custom-input size-ratio-input"
                min="1"
                max="999"
                step="1"
                inputMode="numeric"
                aria-label="比例 - 高"
                value={rh}
                onChange={(e) => onChangeRatio(rw, e.target.value)}
              />
            </span>
          )}
          <SizeRatioPreview ratio={preview} />
        </span>
      )}
      {!custom && <SizeRatioPreview ratio={preview} />}
    </>
  );
}
