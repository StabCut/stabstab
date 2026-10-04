import React, { useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { uploadUrl, formatClock } from '../lib/util.js';
import { resendEdited, resolveResendTarget } from '../lib/send.js';
import { sizeLabel } from '../lib/models.js';
import { useComposerSelection, getComposerSelection } from '../lib/composerSelection.js';
import { missingImageMessage } from '../lib/imageActions.js';
import Icon from './Icon.jsx';
import ImageContextMenu, { useImageMenu } from './ImageContextMenu.jsx';

export default function UserMessage({ conv, msg }) {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(msg.text);
  const [kept, setKept] = useState(msg.images || []);
  // 重发尺寸：null = 跟随下方输入框的当前尺寸；在下拉框里选过 = 只覆盖这一次重发
  const [sizeOverride, setSizeOverride] = useState(null);
  const [resending, setResending] = useState(false);
  // 图片右键菜单（复制 / 保存到下载 / 另存为）：菜单状态由组件持有，菜单项见 lib/imageActions.js
  const imageMenu = useImageMenu();

  // ---- 编辑重发用的设置 = 输入区当前设置（模型 / 尺寸 / 参数），不是这条消息当时的设置 ----
  // 订阅输入区（Composer）的实时选择：下方换模型、换尺寸、调参数，这里跟着变。
  // 只在编辑气泡打开时订阅：不在编辑态的消息不必跟着参数面板打字重渲染。
  const selection = useComposerSelection(editing);
  const target = editing
    ? resolveResendTarget({
      settings: state.settings,
      modelSeries: state.modelSeries,
      protocols: state.protocols,
      selection,
      fallbackModelId: msg.model && msg.model.id,
      fallbackParams: msg.params,
      sizeOverride
    })
    : null;
  const mode = (target && target.model) ? target.model.mode : 'sync';
  const modelChanged = !!(target && target.model && msg.model && target.model.id !== msg.model.id);

  const busy = state.busy[conv.id];

  const openLightbox = (index) => {
    const images = (msg.images || [])
      .filter((im) => im.file)
      .map((im, i) => ({ src: uploadUrl(im.file), kind: 'upload', file: im.file, name: im.name || '', title: `输入图 ${i + 1} · ${im.width || '?'}×${im.height || '?'}` }));
    if (!images.length) { toast('图片文件不存在（可能已被清理）', 'warn'); return; }
    // 找到被点击图在过滤后列表中的下标
    const validIdx = (msg.images || []).slice(0, index + 1).filter((im) => im.file).length - 1;
    dispatch({ type: 'LIGHTBOX_OPEN', images, index: Math.max(0, validIdx) });
  };

  const startEdit = () => {
    setDraftText(msg.text);
    setKept(msg.images || []);
    setSizeOverride(null);      // 尺寸默认跟随下方输入框的当前值
    setEditing(true);
  };

  const confirmEdit = async () => {
    if (!draftText.trim() && kept.length === 0) { toast('内容不能为空', 'warn'); return; }
    if (busy && mode === 'sync') { toast('当前对话正在等待 API 返回，请稍候', 'warn'); return; }
    // 点「确定并重新发送」这一刻再取一次输入区设置：气泡打开期间改了下方的模型 / 尺寸也要用最新的
    const finalTarget = resolveResendTarget({
      settings: state.settings,
      modelSeries: state.modelSeries,
      protocols: state.protocols,
      selection: getComposerSelection(),
      fallbackModelId: msg.model && msg.model.id,
      fallbackParams: msg.params,
      sizeOverride
    });
    setResending(true);
    try {
      const { resolved } = await resendEdited({
        dispatch, state, conv, userMsg: msg,
        newText: draftText.trim(),
        keptImages: kept,
        params: finalTarget.params,
        modelId: finalTarget.modelId,
        log: (l, m, e) => window.stab.log(l, m, e)
      });
      setEditing(false);
      const changed = !!(resolved && msg.model && resolved.id !== msg.model.id);
      toast(changed
        ? `已按下方当前设置用「${resolved.name}」重新发送，旧结果已删除`
        : '已重新发送，旧结果已删除', 'info');
    } catch (e) {
      toast('重发失败: ' + e.message, 'error');
    } finally {
      setResending(false);
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(msg.text || '');
      toast('已复制文字', 'info');
    } catch (e) {
      toast('复制失败', 'error');
    }
  };

  const copyImage = async (im) => {
    const r = await window.stab.copyUploadImage(im.file);
    if (!r.ok) { toast(r.message || '复制失败', 'error'); return; }
    toast(r.withPics ? '图片已复制到剪贴板（含提示词与输入图文件名）'
      : (r.withPrompt ? '图片已复制到剪贴板（含提示词元数据）' : '图片已复制到剪贴板'), 'info');
  };

  const remove = () => {
    dispatch({ type: 'MSG_DELETE', convId: conv.id, msgId: msg.id });
  };

  if (editing) {
    return (
      <div className="msg user editing">
        <div className="msg-bubble user-bubble edit-bubble">
          {kept.length > 0 && (
            <div className="attach-row">
              {kept.map((im, i) => (
                <div className="attach-item" key={im.file || i}>
                  <img src={uploadUrl(im.file)} alt={im.name} />
                  <button className="attach-remove" onClick={() => setKept((prev) => prev.filter((_, j) => j !== i))}><Icon name="close" size={13} strokeWidth={2.2} /></button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="composer-textarea edit-textarea"
            value={draftText}
            rows={3}
            autoFocus
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmEdit();
            }}
          />
          <div className="edit-size-row">
            <select
              value={target.size}
              onChange={(e) => setSizeOverride(e.target.value)}
              title="尺寸：默认跟随下方输入框的当前尺寸；在这里选择只覆盖这一次重发"
            >
              {target.sizeOptions.map((s) => (
                <option key={s} value={s}>{sizeLabel(s)}</option>
              ))}
            </select>
            {target.model && (
              <span
                className="edit-hint edit-model-hint"
                title={`重发使用下方输入框的当前设置（模型 / 尺寸 / 参数）；本条消息当时用的是「${(msg.model && msg.model.name) || '未知模型'}」${modelChanged ? '，本次将改用上面的模型' : ''}`}
              >
                重发模型：{target.model.name}
              </span>
            )}
            <span className="edit-hint edit-hint-end">Ctrl+Enter 确定</span>
          </div>
          <div className="edit-actions">
            <button className="ghost-btn" onClick={() => setEditing(false)}>取消</button>
            <button className="send-btn" disabled={resending} onClick={confirmEdit}>
              {resending ? '发送中…' : '确定并重新发送'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="msg user">
      {imageMenu.menu && <ImageContextMenu menu={imageMenu.menu} onClose={imageMenu.closeMenu} />}
      <div className="msg-bubble user-bubble">
        {(msg.images && msg.images.length > 0) && (
          <div className="msg-images">
            {msg.images.map((im, i) =>
              im.file ? (
                <div className="user-img-wrap" key={i}>
                  <img
                    className="msg-thumb"
                    src={uploadUrl(im.file)}
                    title={`输入图 ${i + 1}：${im.width || '?'}×${im.height || '?'} · 点击预览`}
                    onClick={() => openLightbox(i)}
                    onContextMenu={(e) => imageMenu.openMenu(e, { kind: 'upload', file: im.file, name: im.name })}
                  />
                  <button className="thumb-copy" title="复制图片" onClick={() => copyImage(im)}><Icon name="copy" size={13} /></button>
                </div>
              ) : (
                <div
                  key={i}
                  className="msg-thumb missing"
                  title="图片文件不存在（可能已被清理）"
                  onContextMenu={(e) => { e.preventDefault(); toast(missingImageMessage('upload'), 'warn'); }}
                >图片缺失</div>
              )
            )}
          </div>
        )}
        {msg.text && <div className="msg-text">{msg.text}</div>}
        <div className="msg-meta">{formatClock(msg.createdAt)}</div>
      </div>
      <div className="msg-actions">
        {msg.text && <button className="icon-btn" title="复制文字" onClick={copyText}><Icon name="copy" size={16} /></button>}
        <button className="icon-btn" title="编辑并重新发送" onClick={startEdit}><Icon name="pencil" size={16} /></button>
        <button className="icon-btn" title="删除该条消息" onClick={remove}><Icon name="trash" size={16} /></button>
      </div>
    </div>
  );
}
