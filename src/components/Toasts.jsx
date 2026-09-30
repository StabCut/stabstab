import React, { useEffect, useRef, useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';

/*
 * 轻提示（右下角）。
 * ==============
 * - 鼠标悬停在提示条上 -> 暂停自动消失（可以慢慢看清路径再点），移开后按「剩余时间」继续计时；
 *   键盘 Tab 聚焦到路径上同样暂停，避免提示在操作途中消失。
 * - 带 path 的提示（保存到下载 / 另存为 / 结果图下载）：第一块是结果文字，第二块是文件路径；
 *   路径默认虚线 + 悬停变成实线下划线（表示这是一个文件链接），左键点击即在系统文件管理器里打开。
 * - 计时器放在提示条组件里而不是 useToast()：只有这里才知道鼠标有没有悬停，也避免父组件重渲染时把计时重置。
 */

const DEFAULT_TIMEOUT = 3200;
const MIN_REMAIN = 600;        // 移开鼠标后至少再显示这么久，避免一移开就立刻消失

function ToastItem({ toast, onClose }) {
  const toastApi = useToast();
  const [hover, setHover] = useState(false);
  const remainRef = useRef(toast.timeout || DEFAULT_TIMEOUT);   // 还剩多少显示时间
  const startedAt = useRef(0);                                 // 本轮计时起点
  const timerRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (hover) return undefined;                               // 悬停中：不计时、不消失
    startedAt.current = Date.now();
    timerRef.current = setTimeout(() => closeRef.current(), remainRef.current);
    return () => clearTimeout(timerRef.current);
  }, [hover]);

  const pause = () => {
    if (hover) return;
    // 已经显示掉的时间从剩余额度里扣掉，移开鼠标后接着计时（而不是重新从满额开始）
    remainRef.current = Math.max(MIN_REMAIN, remainRef.current - (Date.now() - startedAt.current));
    setHover(true);
  };
  const resume = () => setHover(false);

  const openPath = async () => {
    if (!toast.path) return;
    const api = window.stab || {};
    // 优先用新桥接 revealFile；若应用还没重启（preload 是旧版，只有 showInFolder），
    // 退回旧桥接，避免「点了没反应」这种静默失败。
    const call = api.revealFile
      ? () => api.revealFile(toast.path)
      : (api.showInFolder ? () => api.showInFolder(toast.path) : null);
    if (!call) { toastApi('当前版本无法打开路径，请重启应用后再试', 'warn'); return; }
    try {
      const r = (await call()) || {};
      if (r.ok === false) toastApi(r.message || '打开失败', 'error');
    } catch (e) {
      toastApi('打开失败：' + ((e && e.message) || e), 'error');
    }
  };

  return (
    <div
      className={`toast ${toast.kind}`}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <div className="toast-text">{toast.message}</div>
      {toast.path && (
        <button
          type="button"
          className="toast-path"
          title="在文件管理器中打开所在位置"
          onClick={openPath}
        >{toast.path}</button>
      )}
    </div>
  );
}

export default function Toasts() {
  const { state, dispatch } = useApp();
  if (!state.toasts.length) return null;
  return (
    <div className="toasts">
      {state.toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onClose={() => dispatch({ type: 'TOAST_REMOVE', id: t.id })} />
      ))}
    </div>
  );
}