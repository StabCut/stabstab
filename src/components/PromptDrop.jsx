/*
 * 「提示词解析拖放区」与「图片提示词」查看弹窗
 * ==========================================
 * 解析区把整个软件窗口一分为二：左半区 = 解析并复制，右半区 = 解析并查看，
 * 中间一条虚线曲线分隔（与蒙版边缘的圆角虚线同色同风格）。
 *
 * 显隐：只在拖动图片、且鼠标位于「应用内、底部输入框接收区域之外」时出现
 *      （由 lib/promptReuse.jsx 的 useAppFileDrag 按指针实时判断）。
 * 覆盖：整个窗口盖一层半透明蒙版（原界面仍可见、被压暗），蒙版是**圆角矩形容器**，
 *      半区高亮也被裁进这个圆角矩形里，不会溢出虚线边框。
 * 触发：只有真正释放到左/右半区之一才执行解析；释放到输入框走原有接收流程。
 *
 * 几何约定（曲线居中、虚线与高亮边界严丝合缝的关键）：
 *   曲线的控制点**只用 px 坐标**，并按「关于窗口中心点中心对称」定义：
 *       M cx 0  C cx-a h/3 , cx+a 2h/3 , cx h
 *   - 半区裁剪：CSS clip-path 用同一串坐标（高亮的边界就是这条曲线）
 *   - 虚线绘制：SVG viewBox 也用同一串 px 坐标（等比映射，虚线间距才均匀）
 *   两端点恒在窗口水平正中（x = cx），中点最大偏移 a 取「半宽的个位数百分比」，
 *   因此曲线始终贴着中间纵轴、不会被非等比拉伸带偏。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useToast } from '../lib/store.jsx';
import {
  PROMPT_MESSAGES, promptErrorText, readFirstPromptFromFiles, usePromptReuse
} from '../lib/promptReuse.jsx';
import Icon from './Icon.jsx';

/* ---------------- 左右半区解析拖放区 ---------------- */

/**
 * 分割曲线（唯一几何来源）
 * ------------------------
 * 一条关于「垂直中线」中心对称的三次贝塞尔：
 *     M W/2 0  C (W/2 - A) H/3 , (W/2 + A) 2H/3 , W/2 H
 * 两端点恒在中线上（看上去就是一条居中的竖线），中点最多偏移 A 像素（克制的小弧度）。
 *
 * 同一份几何同时喂给两处，保证「高亮边界 == 分隔虚线」：
 *   ① 半区裁剪：CSS clip-path。**坐标原点是各自半区的 padding box**，因此左右半区要按
 *      各自尺寸换算（左半区右边界 = zw，右半区左边界 = 0）——写成整块蒙版的坐标会把
 *      半区裁成整块、反过来盖住中间的虚线（这是本文件最容易踩的坑）。
 *   ② 分隔虚线：SVG，viewBox 与蒙版内容区 px 1:1（虚线间距因此均匀）。
 */
const CURVE_BOW = 18;    // 曲线中点相对中线的最大偏移（px）

/** 左半区裁剪路径（zw = 左半区宽度）：右边界就是曲线 */
function clipLeft(zw, h) {
  const a = CURVE_BOW;
  return `path('M ${zw} 0 C ${zw - a} ${h / 3} ${zw + a} ${(h * 2) / 3} ${zw} ${h} L 0 ${h} L 0 0 Z')`;
}
/** 右半区裁剪路径（zw = 右半区宽度）：左边界是同一条曲线 */
function clipRight(zw, h) {
  const a = CURVE_BOW;
  return `path('M 0 0 C ${a} ${h / 3} ${-a} ${(h * 2) / 3} 0 ${h} L ${zw} ${h} L ${zw} 0 Z')`;
}
/** 分隔虚线（整块蒙版的尺寸） */
function curvePath(w, h) {
  const c = w / 2;
  const a = CURVE_BOW;
  return `M ${c} 0 C ${c - a} ${h / 3} ${c + a} ${(h * 2) / 3} ${c} ${h}`;
}

export default function PromptDropZones() {
  const { topZonesVisible, showPromptModal } = usePromptReuse();
  const toast = useToast();
  // 静态 QA 预览无法产生 hover：用 globalThis.__QA_ZONE_HOVER__ 标记高亮目标（生产中恒为 undefined）
  const qaHover = globalThis.__QA_ZONE_HOVER__ || '';
  const [hovered, setHovered] = useState(qaHover || null);
  // 半区高亮以指针位置为准：进入点亮、离开熄灭，不做「只在首次进入时判断」的缓存
  const interactive = !qaHover;
  const hoverSide = hovered || qaHover || '';

  // 曲线几何取自「蒙版盒子」的真实尺寸；裁剪与虚线共用同一套坐标，必然对齐
  const boxRef = useRef(null);
  const [geo, setGeo] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const read = () => setGeo({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', read);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', read);
    };
  }, []);
  /**
   * 半区宽度：两半都取整块的一半（round），使各自的曲线边界都精确落在整块正中
   * ——与分隔虚线、与蒙版内容区中心同一个像素位置。右半区裁剪多给 2px 余量吸收舍入误差；
   * 这点重叠是安全的：两半的底色本来就是同一块半透明蒙版，重叠处不会被加深。
   */
  const halfW = Math.round(geo.w / 2);
  const ready = halfW > 0 && geo.h > 0;

  const pick = async (dt) => {
    const files = Array.from((dt && dt.files) || []);
    if (files.length !== 1) {
      toast(PROMPT_MESSAGES.multiple, 'warn');
      return null;
    }
    const r = await readFirstPromptFromFiles(files);
    if (!r.ok) { toast(r.message || PROMPT_MESSAGES.notImage, 'error'); return null; }
    if (!r.prompt) {
      // 优先报「格式不支持 / 文件损坏 / 读取失败」，只有都没有才说「未找到」
      toast(r.firstError ? promptErrorText(r.firstError) : PROMPT_MESSAGES.none, 'warn');
      return null;
    }
    return r.prompt;
  };

  const copyPrompt = async (dt) => {
    const prompt = await pick(dt);
    if (typeof prompt !== 'string') return;
    const res = await window.stab.copyText(prompt);
    if (res && res.ok) toast('提示词已复制', 'info');
    else toast(`${PROMPT_MESSAGES.clipboardFailed}${res && res.message ? '：' + res.message : ''}`, 'error');
  };

  const viewPrompt = async (dt) => {
    const prompt = await pick(dt);
    if (typeof prompt !== 'string') return;
    showPromptModal(prompt);
  };

  /** 一个半区：半透明底 + 悬停点亮；用曲线裁剪，边界与分隔虚线重合 */
  const renderHalf = (side, icon, title, hint, onPick) => {
    const active = hoverSide === side;
    return (
      <div
        className={`prompt-zone ${side} ${active ? 'hover' : ''}`}
        style={ready ? { clipPath: side === 'left' ? clipLeft(halfW, geo.h) : clipRight(halfW + 2, geo.h) } : undefined}
        onDragOver={(e) => {
          // 阻止冒泡 + 防默认：避免同一份文件被多处重复处理
          e.preventDefault();
          e.stopPropagation();
          if (!active) setHovered(side);
        }}
        onDragLeave={() => { if (interactive && hoverSide === side) setHovered(null); }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setHovered(null);
          onPick(e.dataTransfer);
        }}
      >
        <div className="prompt-zone-body">
          <div className="prompt-zone-icon"><Icon name={icon} size={30} strokeWidth={1.6} /></div>
          <div className="prompt-zone-title">{title}</div>
          <div className="prompt-zone-hint">{hint}</div>
        </div>
      </div>
    );
  };

  return (
    <div
      className={`prompt-drop-overlay ${topZonesVisible ? 'visible' : ''} ${hoverSide ? 'hover-active' : ''} ${qaHover !== '' ? 'qa-static' : ''}`}
      aria-hidden={!topZonesVisible}
    >
      {/* 圆角矩形蒙版：半透明压暗原界面；半区高亮是它的子元素，因此被裁进同一个圆角里 */}
      <div className="prompt-drop-mask" ref={boxRef}>
        <div className="prompt-drop-zones">
          {renderHalf('left', 'copy', '解析并复制提示词', '拖到此处松开：读取提示词并复制到剪贴板', copyPrompt)}
          {renderHalf('right', 'eye', '解析并查看提示词', '拖到此处松开：读取提示词并打开查看弹窗', viewPrompt)}
        </div>
      </div>

      {/* 曲线虚线分隔：viewBox 与裁剪坐标同为「蒙版内容区 px」，1:1 映射，虚线间距均匀 */}
      {ready && (
        <svg
          className="prompt-curve"
          width={geo.w}
          height={geo.h}
          viewBox={`0 0 ${geo.w} ${geo.h}`}
          aria-hidden="true"
        >
          <path className="prompt-curve-line" d={curvePath(geo.w, geo.h)} />
        </svg>
      )}
    </div>
  );
}

/* ---------------- 图片提示词查看弹窗 ---------------- */

export function ImagePromptModal() {
  const { modal, closePromptModal } = usePromptReuse();
  const toast = useToast();
  const cardRef = useRef(null);
  const boxRef = useRef(null);
  const closeRef = useRef(null);
  const dragRef = useRef(null);
  const prevFocusRef = useRef(null);
  const [size, setSize] = useState(null);     // null = 由内容自适应（受最大尺寸约束）
  const [copied, setCopied] = useState(false);
  const open = !!modal;

  // 打开时记住原焦点，关闭后归还；焦点进入弹窗
  useLayoutEffect(() => {
    if (!open) return undefined;
    prevFocusRef.current = document.activeElement;
    const t = setTimeout(() => { if (closeRef.current) closeRef.current.focus(); }, 0);
    return () => {
      clearTimeout(t);
      const prev = prevFocusRef.current;
      if (prev && prev.focus && document.contains(prev)) { try { prev.focus(); } catch (e) { /* ignore */ } }
    };
  }, [open]);

  // Esc 关闭 + 焦点锁在弹窗内
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closePromptModal(); return; }
      if (e.key !== 'Tab') return;
      const root = cardRef.current;
      if (!root) return;
      const list = Array.from(root.querySelectorAll('button, [href], textarea, input, select, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, closePromptModal]);

  // 拖边缘 / 右下角调整尺寸
  useEffect(() => {
    if (!open) return undefined;
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const w = Math.min(Math.max(d.w + (e.clientX - d.x), 280), d.maxW);
      const h = Math.min(Math.max(d.h + (e.clientY - d.y), 180), d.maxH);
      setSize({ w, h });
    };
    const onUp = () => { dragRef.current = null; document.body.classList.remove('modal-resizing'); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('modal-resizing');
    };
  }, [open]);

  if (!open) return null;

  const prompt = modal.text;

  const startResize = (e) => {
    if (e.button !== 0) return;
    const el = cardRef.current;
    const box = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const maxH = Math.max(220, Math.min(vh * 0.8, box ? vh - box.top - 12 : vh * 0.8));
    dragRef.current = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, maxW: vw - 40, maxH };
    document.body.classList.add('modal-resizing');
    e.preventDefault();
  };

  const doCopy = async () => {
    const res = await window.stab.copyText(prompt);
    if (res && res.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } else {
      toast(`${PROMPT_MESSAGES.clipboardFailed}${res && res.message ? '：' + res.message : ''}`, 'error');
    }
  };

  const cardStyle = size ? { width: size.w, height: size.h } : undefined;

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closePromptModal(); }}
    >
      <div className="modal prompt-modal" ref={cardRef} style={cardStyle} role="dialog" aria-modal="true" aria-label="图片提示词">
        <div className="modal-header">
          <div className="modal-title">图片提示词</div>
        </div>

        <div className="prompt-modal-scroll">
          {/* 纯文本渲染：元数据内容不会被当作 HTML 执行，换行 / 特殊字符原样保留 */}
          <pre className="prompt-modal-text">{prompt}</pre>
        </div>

        <div className="modal-footer prompt-modal-footer">
          <button className="ghost-btn" onClick={doCopy}>
            <Icon name="copy" size={15} /> {copied ? '已复制' : '复制'}
          </button>
          <button className="send-btn" ref={closeRef} onClick={closePromptModal}>关闭</button>
        </div>

        <div className="prompt-resize-handle" title="拖动调整大小" onPointerDown={startResize} />
      </div>
    </div>
  );
}

