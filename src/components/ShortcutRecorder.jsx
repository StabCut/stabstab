import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { acceleratorFromKeyEvent, formatAccelerator, shortcutStatusText } from '../lib/shortcuts.js';

/**
 * 一个全局快捷键的录制框（设置 → 基础设置 →「全局快捷键」）。
 *
 * 交互：点方框开始录制 → 按下想用的组合键即写入（不需要点保存前先「确定」）；
 *   · 只按修饰键 → 提示继续按普通键，不算一次输入；
 *   · Esc（不带修饰键）= 取消录制、不改动原值；退格 / 删除 = 清除这个快捷键；
 *   · 录制中点别处 = 放弃录制。
 * 录制监听挂在 window 的**捕获**阶段：既不让设置弹窗的 ESC 顺手把整个弹窗关掉，
 * 也尽量拦住浏览器自己的组合键（如 Ctrl+W）。
 *
 * 状态行由 shortcutStatusText 生成：未设置 / 待保存 / 已生效 / 被别的程序占用 / 与别的动作重复。
 *
 * @param action      {id,label,hint}（见 lib/shortcuts.js）
 * @param value       草稿里的组合（'' = 未设置）
 * @param savedValue  已保存生效的组合（用于区分「已生效」与「待保存」）
 * @param result      主进程回报的注册结果 {ok,code,conflictWith,message}
 * @param onChange    (accelerator) => void
 */
export default function ShortcutRecorder({ action, value, savedValue, result, platform, onChange }) {
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState('');   // 录制中的提示（如「再按一个普通键」）
  const boxRef = useRef(null);

  // 录制中：抓键盘（捕获阶段，先于其它所有 keydown 处理）
  useEffect(() => {
    if (!recording) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      // 「不带修饰键」的 Esc / 退格 / 删除是录制控制键；带修饰键时它们才是要录的组合键
      const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (bare && e.key === 'Escape') { setRecording(false); setMessage(''); return; }
      if (bare && (e.key === 'Backspace' || e.key === 'Delete')) { onChange(''); setRecording(false); setMessage(''); return; }
      const r = acceleratorFromKeyEvent(e);
      if (!r.ok) { setMessage(r.message || ''); return; }
      onChange(r.accelerator);
      setRecording(false);
      setMessage('');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onChange]);

  // 录制中点别处 = 放弃（不写入任何值，也不清空原值）
  useEffect(() => {
    if (!recording) return;
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) { setRecording(false); setMessage(''); }
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [recording]);

  const status = shortcutStatusText(value, savedValue, result);
  const shown = recording
    ? (message || '请按下组合键…')
    : (value ? formatAccelerator(value, platform) : '');

  return (
    <div className="shortcut-row">
      <div className="shortcut-meta">
        <div className="shortcut-label">{action.label}</div>
        <div className="shortcut-hint">{action.hint}</div>
      </div>

      <div className="shortcut-control">
        <div className="shortcut-line">
          <button
            ref={boxRef}
            type="button"
            className={`shortcut-box${recording ? ' recording' : ''}${value && !recording ? ' set' : ''}`}
            title="点击后按下想用的组合键（Esc 取消录制，退格清除）"
            onClick={() => { setRecording(true); setMessage(''); }}
          >
            {shown || <span className="shortcut-placeholder">点击后按下组合键</span>}
          </button>
          <button
            className="icon-btn"
            title="清除这个快捷键"
            disabled={!value}
            onClick={() => { onChange(''); setRecording(false); setMessage(''); }}
          ><Icon name="close" size={14} /></button>
        </div>
        <div className={`shortcut-status ${status.kind}`}>{status.text}</div>
      </div>
    </div>
  );
}
