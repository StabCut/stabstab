import React, { useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { uploadUrl, formatClock } from '../lib/util.js';
import { buildParams, resendEdited, defaultParams } from '../lib/send.js';
import { resolveModel, sizeLabel } from '../lib/models.js';
import Icon from './Icon.jsx';

export default function UserMessage({ conv, msg }) {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(msg.text);
  const [kept, setKept] = useState(msg.images || []);
  // 编辑时使用「当前参数面板」的值：这里提供与发送时一致的默认
  const [editParams, setEditParams] = useState({ size: 'auto' });
  const [resending, setResending] = useState(false);

  // 该消息当时使用的模型（可能已被用户删除 → current 为 null，此时禁用「编辑重发」）
  const current = resolveModel(state.settings, state.modelSeries, state.protocols, msg.model && msg.model.id);
  const schema = (current && current.paramSchema) || {};
  const sizeOptions = (current && current.sizeOptions) || ['auto'];

  const busy = state.busy[conv.id];
  const mode = current ? current.mode : 'sync';

  const openLightbox = (index) => {
    const images = (msg.images || [])
      .filter((im) => im.file)
      .map((im, i) => ({ src: uploadUrl(im.file), title: `输入图 ${i + 1} · ${im.width || '?'}×${im.height || '?'}` }));
    if (!images.length) { toast('图片文件不存在（可能已被清理）', 'warn'); return; }
    // 找到被点击图在过滤后列表中的下标
    const validIdx = (msg.images || []).slice(0, index + 1).filter((im) => im.file).length - 1;
    dispatch({ type: 'LIGHTBOX_OPEN', images, index: Math.max(0, validIdx) });
  };

  const startEdit = () => {
    setDraftText(msg.text);
    setKept(msg.images || []);
    setEditParams({ size: 'auto', ...defaultParams(schema), ...(msg.params || {}) });
    setEditing(true);
  };

  const confirmEdit = async () => {
    if (!draftText.trim() && kept.length === 0) { toast('内容不能为空', 'warn'); return; }
    if (busy && mode === 'sync') { toast('当前对话正在等待 API 返回，请稍候', 'warn'); return; }
    setResending(true);
    try {
      await resendEdited({
        dispatch, state, conv, userMsg: msg,
        newText: draftText.trim(),
        keptImages: kept,
        params: buildParams(editParams, schema),
        modelId: msg.model && msg.model.id,
        log: (l, m, e) => window.stab.log(l, m, e)
      });
      setEditing(false);
      toast('已重新发送，旧结果已删除', 'info');
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
    if (r.ok) toast('图片已复制到剪贴板', 'info');
    else toast(r.message || '复制失败', 'error');
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
              value={editParams.size}
              onChange={(e) => setEditParams((p) => ({ ...p, size: e.target.value }))}
              title="尺寸（重发时生效）"
            >
              {sizeOptions.map((s) => (
                <option key={s} value={s}>{sizeLabel(s)}</option>
              ))}
            </select>
            <span className="edit-hint">Ctrl+Enter 确定</span>
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
                  />
                  <button className="thumb-copy" title="复制图片" onClick={() => copyImage(im)}><Icon name="copy" size={13} /></button>
                </div>
              ) : (
                <div key={i} className="msg-thumb missing">图片缺失</div>
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
