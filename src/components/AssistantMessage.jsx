import React from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { cacheUrl, formatClock, formatBytes } from '../lib/util.js';

const STATUS_LABEL = {
  PENDING: '排队中（PENDING）',
  RUNNING: '生成中（RUNNING）',
  SUCCEEDED: '已完成',
  UNKNOWN: '未知'
};

export default function AssistantMessage({ conv, msg }) {
  const { dispatch } = useApp();
  const toast = useToast();

  const openLightbox = (index, images) => {
    dispatch({
      type: 'LIGHTBOX_OPEN',
      images: images.map((im, i) => ({
        src: cacheUrl(im.file),
        title: `结果 ${i + 1} · ${im.width || '?'}×${im.height || '?'}`
      })),
      index
    });
  };

  const copyImage = async (im) => {
    const r = await window.stab.copyImage(im.file);
    if (r.ok) toast('图片已复制到剪贴板', 'info');
    else toast(r.message || '复制失败', 'error');
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制文字', 'info');
    } catch (e) { toast('复制失败', 'error'); }
  };

  const downloadImage = async (im) => {
    const r = await window.stab.downloadResult(im.file);
    if (r.ok) toast(`已保存：${r.path}`, 'info');
    else toast(r.message || '保存失败', 'error');
  };

  const cancelTask = async () => {
    const r = await window.stab.cancelJob(msg.id);
    if (!r.ok) toast(r.message || '取消失败', 'warn');
  };

  const remove = () => dispatch({ type: 'MSG_DELETE', convId: conv.id, msgId: msg.id });

  // ---------- 渲染主体 ----------
  let body = null;

  if (msg.status === 'pending') {
    body = (
      <div className="result-card waiting">
        <span className="spinner" />
        <span>{msg.meta && msg.meta.mode === 'async' ? '正在提交异步任务…' : '正在生成，请稍候…'}</span>
      </div>
    );
  } else if (msg.status === 'running') {
    body = (
      <div className="result-card waiting">
        <span className="spinner" />
        <span>
          {msg.meta && msg.meta.mode === 'async'
            ? `异步任务${STATUS_LABEL[msg.taskStatus] || msg.taskStatus || '处理中'}`
            : '正在生成，请稍候…'}
        </span>
        {msg.taskId && <span className="task-id" title="任务 ID">{String(msg.taskId).slice(0, 8)}…</span>}
        {msg.meta && msg.meta.mode === 'async' && (
          <button className="ghost-btn small" onClick={cancelTask} title="PENDING 状态可取消任务；RUNNING 将继续执行直到完成">
            取消任务
          </button>
        )}
      </div>
    );
  } else if (msg.status === 'success') {
    const imgs = msg.images || [];
    body = (
      <div className="result-wrap">
        {imgs.length > 0 && (
          <div className="result-grid">
            {imgs.map((im, i) =>
              im.file ? (
                <div className="result-item" key={i}>
                  <img
                    src={cacheUrl(im.file)}
                    className="result-img"
                    title="点击预览（滚轮缩放 / 拖动 / ESC 关闭）"
                    onClick={() => openLightbox(i, imgs.filter((x) => x.file))}
                  />
                  <div className="result-badge">
                    {im.width && im.height ? `${im.width}×${im.height}` : '分辨率未知'}
                  </div>
                  <div className="result-hover-actions">
                    <button className="icon-btn" title="复制图片到剪贴板" onClick={() => copyImage(im)}>📋</button>
                    <button className="icon-btn" title="下载保存到默认路径" onClick={() => downloadImage(im)}>⬇️</button>
                  </div>
                </div>
              ) : (
                <div className="result-item failed" key={i}>
                  <div className="result-missing">
                    结果图片下载失败{im.downloadError ? `：${im.downloadError}` : ''}
                  </div>
                </div>
              )
            )}
          </div>
        )}
        {imgs.length === 0 && (msg.texts || []).length > 0 && (
          <div className="msg-text assistant-text">{(msg.texts || []).join('\n')}</div>
        )}
        <div className="result-meta">
          {msg.usage && msg.usage.output_image_count != null && `${msg.usage.output_image_count} 张`}
          {msg.usage && msg.usage.output_width != null && ` · ${msg.usage.output_width}×${msg.usage.output_height}`}
          {msg.durationMs != null && ` · 耗时 ${(msg.durationMs / 1000).toFixed(1)}s`}
        </div>
      </div>
    );
  } else if (msg.status === 'error') {
    body = (
      <div className="result-card error">
        <div className="error-title">⚠️ 生成失败</div>
        {msg.error && msg.error.code && <div className="error-code">错误码：{msg.error.code}</div>}
        <div className="error-message">{(msg.error && msg.error.message) || '未知错误'}</div>
        {msg.error && msg.error.requestId && <div className="error-req">Request ID：{msg.error.requestId}</div>}
        {msg.taskId && <div className="error-req">Task ID：{msg.taskId}</div>}
      </div>
    );
  } else if (msg.status === 'cancelled') {
    body = (
      <div className="result-card cancelled">
        ⏹ {(msg.error && msg.error.message) || '已取消 / 已停止等待'}
      </div>
    );
  }

  return (
    <div className="msg assistant">
      <div className="msg-avatar" title="StabStab捅捅">
        <img src="./icon.svg" alt="" draggable={false} />
      </div>
      <div className="msg-bubble assistant-bubble">
        {body}
        <div className="msg-meta">{formatClock(msg.finishedAt || msg.createdAt)}</div>
      </div>
      <div className="msg-actions">
        {(msg.texts || []).length > 0 && (
          <button className="icon-btn" title="复制文字" onClick={() => copyText((msg.texts || []).join('\n'))}>📋</button>
        )}
        <button className="icon-btn" title="删除该条结果" onClick={remove}>🗑</button>
      </div>
    </div>
  );
}
