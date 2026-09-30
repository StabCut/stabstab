import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { useToast } from '../lib/store.jsx';
import { clamp } from '../lib/util.js';
import { IMAGE_MENU_ITEMS } from '../lib/imageActions.js';

/*
 * 聊天区图片的右键菜单（复制 / 保存到下载 / 另存为）。
 * ==================================================
 * 用户发送的输入图（UserMessage）与 API 返回的结果图（AssistantMessage、全屏预览 Lightbox）
 * 共用这一个菜单：打开方式统一走下面的 useImageMenu()，菜单项定义在 lib/imageActions.js。
 * 菜单用 createPortal 挂到 body：固定定位不受消息气泡的层叠上下文 / overflow 裁剪影响。
 */

/** 右键菜单的开关状态；target = { kind, file, name } */
export function useImageMenu() {
  const [menu, setMenu] = useState(null);

  const openMenu = useCallback((event, target) => {
    if (!event || !target || !target.file) return;   // 图片文件缺失（已被清理）时不弹菜单
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      kind: target.kind,
      file: target.file,
      name: target.name || ''
    });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  return { menu, openMenu, closeMenu };
}

export default function ImageContextMenu({ menu, onClose }) {
  const toast = useToast();
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [busy, setBusy] = useState('');

  // 贴着窗口右 / 下边缘弹出时把菜单收回可视区域，避免被裁掉
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: clamp(menu.x, pad, Math.max(pad, window.innerWidth - rect.width - pad)),
      y: clamp(menu.y, pad, Math.max(pad, window.innerHeight - rect.height - pad))
    });
  }, [menu.x, menu.y]);

  // 关闭时机：点击别处 / ESC / 滚动 / 窗口尺寸变化
  useEffect(() => {
    const onPointerDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();   // 不要把 ESC 继续传给全屏预览（Lightbox 会因此关闭）
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('wheel', onClose, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('wheel', onClose, { capture: true });
    };
  }, [onClose]);

  const choose = async (item) => {
    if (busy) return;
    setBusy(item.key);
    try {
      const r = await item.run(menu);
      if (r && r.canceled) return;                              // 保存对话框里点了取消：静默返回
      if (!r || r.ok === false) {
        toast((r && r.message) || '操作失败', 'error');
      } else {
        const done = item.done ? item.done(r) : null;
        // done 可以是字符串，也可以是 { message, path }：带路径的提示会多出一行可点击的路径
        if (done && typeof done === 'object') toast(done.message || '操作完成', 'info', { path: done.path, timeout: 6000 });
        else toast(done || '操作完成', 'info');
      }
    } catch (e) {
      toast('操作失败：' + ((e && e.message) || e), 'error');
    } finally {
      setBusy('');
      onClose();
    }
  };

  return createPortal(
    <div
      className="img-ctx-menu"
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {IMAGE_MENU_ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          className="img-ctx-item"
          role="menuitem"
          title={item.hint}
          disabled={!!busy}
          onClick={() => choose(item)}
        >
          <Icon name={item.icon} size={15} />
          <span className="img-ctx-label">{item.label}</span>
          {busy === item.key && <span className="img-ctx-busy">处理中</span>}
        </button>
      ))}
    </div>,
    document.body
  );
}