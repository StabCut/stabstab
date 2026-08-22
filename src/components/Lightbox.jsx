import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '../lib/store.jsx';
import { clamp } from '../lib/util.js';

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;

export default function Lightbox() {
  const { state, dispatch } = useApp();
  const lb = state.lightbox;
  const images = lb ? lb.images : [];
  const index = lb ? clamp(lb.index, 0, Math.max(0, images.length - 1)) : 0;
  const current = images[index];

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef(null);
  const wrapRef = useRef(null);

  const reset = useCallback(() => { setScale(1); setTx(0); setTy(0); }, []);
  const close = useCallback(() => dispatch({ type: 'LIGHTBOX_CLOSE' }), [dispatch]);
  const goto = useCallback((i) => {
    if (i < 0 || i >= images.length) return;
    dispatch({ type: 'LIGHTBOX_INDEX', index: i });
    reset();
  }, [dispatch, images.length, reset]);

  // 键盘：ESC 关闭，← → 切换
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') goto(index - 1);
      else if (e.key === 'ArrowRight') goto(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, goto, index]);

  // 滚轮缩放（非 passive，阻止页面滚动）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      setScale((s) => clamp(s * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 拖动
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setTx(d.tx + (e.clientX - d.x));
    setTy(d.ty + (e.clientY - d.y));
  };
  const onPointerUp = () => { dragRef.current = null; };

  if (!current) return null;

  return (
    <div className="lightbox" ref={wrapRef} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="lightbox-top">
        <span className="lightbox-title">{current.title || ''}（{index + 1}/{images.length}）</span>
        <div className="lightbox-tools">
          <button className="icon-btn" title="缩小" onClick={() => setScale((s) => clamp(s / 1.25, MIN_SCALE, MAX_SCALE))}>−</button>
          <span className="zoom-label">{Math.round(scale * 100)}%</span>
          <button className="icon-btn" title="放大" onClick={() => setScale((s) => clamp(s * 1.25, MIN_SCALE, MAX_SCALE))}>＋</button>
          <button className="icon-btn" title="重置视图" onClick={reset}>⟲</button>
          <button className="icon-btn" title="关闭（ESC）" onClick={close}>✕</button>
        </div>
      </div>

      {images.length > 1 && (
        <>
          <button className="lightbox-nav prev" onClick={() => goto(index - 1)} disabled={index === 0}>‹</button>
          <button className="lightbox-nav next" onClick={() => goto(index + 1)} disabled={index === images.length - 1}>›</button>
        </>
      )}

      <img
        key={current.src}
        className="lightbox-img"
        src={current.src}
        draggable={false}
        style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={(e) => e.stopPropagation()}
        onError={(e) => { e.currentTarget.classList.add('broken'); }}
      />
      <div className="lightbox-hint">滚轮缩放 · 拖动查看细节 · ESC 关闭</div>
    </div>
  );
}
