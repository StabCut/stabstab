import React, { useCallback, useEffect, useRef } from 'react';
import Icon from './Icon.jsx';

/**
 * 二次确认弹窗（危险操作前的一道闸）。
 *
 * 键盘（都挂在 window 的**捕获**阶段，焦点在哪儿都有效、也不会透给底下的界面）：
 *   · Enter = 确定      · Esc = 取消
 * 中文输入法组字中的回车不算确定（e.isComposing / keyCode 229）。
 * 点弹窗外遮罩 = 取消。首次渲染自动聚焦弹窗本体（这样 ESC / Enter 不必先点一下）。
 *
 * **图标沿用调用方给的那一个**（例如「删除全部对话」继续用 trash，不换成警告三角）——
 * 需求就是这么定的：同一个动作，图标前后保持一致。
 *
 * 重复触发有闸：done 标记保证 onConfirm / onCancel 最多各响一次
 * （Enter 既被这里接住、又可能触发聚焦按钮的原生 click，两者不能各算一次）。
 */
export default function ConfirmDialog({
  icon = 'warning',
  title,
  message = '',
  lines = [],
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel
}) {
  const doneRef = useRef(false);
  const boxRef = useRef(null);

  const finish = useCallback((fn) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (fn) fn();
  }, []);

  useEffect(() => {
    if (boxRef.current) boxRef.current.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;     // 输入法组字中
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(onConfirm); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(onCancel); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [finish, onConfirm, onCancel]);

  return (
    <div
      className="modal-mask confirm-mask"
      onClick={(e) => { if (e.target === e.currentTarget) finish(onCancel); }}
    >
      <div
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="confirm-body">
          <div className={`confirm-icon${danger ? ' danger' : ''}`}>
            <Icon name={icon} size={20} />
          </div>
          <div className="confirm-text">
            <div className="confirm-title">{title}</div>
            {message && <p className="confirm-message">{message}</p>}
            {lines.length > 0 && (
              <ul className="confirm-lines">
                {lines.map((l) => <li key={l}>{l}</li>)}
              </ul>
            )}
          </div>
        </div>

        <div className="modal-footer confirm-footer">
          <span className="confirm-kbd">Enter 确定 · Esc 取消</span>
          <button className="ghost-btn" onClick={() => finish(onCancel)}>{cancelText}</button>
          <button
            className={`send-btn${danger ? ' danger' : ''}`}
            onClick={() => finish(onConfirm)}
          >{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
