import React from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { cacheUrl, formatClock, formatBytes } from '../lib/util.js';
import Icon from './Icon.jsx';
import ImageContextMenu, { useImageMenu } from './ImageContextMenu.jsx';

// 协议内部任务兜底（Grsai 某些节点只回任务 id）时的状态文案；常规同步请求不会走到这里
const TASK_STATUS_LABEL = {
  PENDING: '排队中（PENDING）',
  RUNNING: '生成中（RUNNING）',
  SUCCEEDED: '已完成',
  UNKNOWN: '未知'
};

export default function AssistantMessage({ conv, msg }) {
  const { dispatch } = useApp();
  const toast = useToast();
  // 图片右键菜单（复制 / 保存到下载 / 另存为）：菜单项见 lib/imageActions.js
  const imageMenu = useImageMenu();

  const openLightbox = (index, images) => {
    dispatch({
      type: 'LIGHTBOX_OPEN',
      images: images.map((im, i) => ({
        src: cacheUrl(im.file),
        kind: 'result',
        file: im.file,
        name: im.name || '',
        title: `结果 ${i + 1} · ${im.width || '?'}×${im.height || '?'}`
      })),
      index
    });
  };

  const copyImage = async (im) => {
    const r = await window.stab.copyImage(im.file);
    if (!r.ok) { toast(r.message || '复制失败', 'error'); return; }
    // 元数据（提示词 / 输入图文件名）随 HTML 格式里的原图字节走，位图格式本身不携带
    toast(r.withPics ? '图片已复制到剪贴板（含提示词与输入图文件名）'
      : (r.withPrompt ? '图片已复制到剪贴板（含提示词元数据）' : '图片已复制到剪贴板'), 'info');
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制文字', 'info');
    } catch (e) { toast('复制失败', 'error'); }
  };

  const downloadImage = async (im) => {
    const r = await window.stab.downloadResult(im.file);
    if (r.ok) toast('已保存', 'info', { path: r.path, timeout: 6000 });
    else toast(r.message || '保存失败', 'error');
  };

  /**
   * 停止等待：只中止**这一次**请求（jobId = 本消息 id）。
   * 同一个对话里其它还在等待的请求完全不受影响 —— 这正是伪异步的隔离（见 AIDEV.md §4.12）。
   */
  const stopWaiting = async () => {
    const r = await window.stab.cancelJob(msg.id);
    if (!r || !r.ok) toast((r && r.message) || '停止失败（该请求可能已经结束）', 'warn');
  };

  const remove = () => dispatch({ type: 'MSG_DELETE', convId: conv.id, msgId: msg.id });

  // ---------- 渲染主体 ----------
  let body = null;

  if (msg.status === 'pending') {
    body = (
      <div className="result-card waiting">
        <span className="spinner" />
        <span>正在生成，请稍候…</span>
        <button className="ghost-btn small" onClick={stopWaiting} title="只中止这一次请求的等待（其它并行请求不受影响；结果不再显示）">
          停止等待
        </button>
      </div>
    );
  } else if (msg.status === 'running') {
    body = (
      <div className="result-card waiting">
        <span className="spinner" />
        <span>
          {msg.taskStatus
            ? `服务端处理中：${TASK_STATUS_LABEL[msg.taskStatus] || msg.taskStatus}`
            : '正在生成，请稍候…'}
        </span>
        {msg.taskId && <span className="task-id" title="服务端任务 ID（协议内部查询用）">{String(msg.taskId).slice(0, 8)}…</span>}
        <button className="ghost-btn small" onClick={stopWaiting} title="只中止这一次请求的等待（其它并行请求不受影响；结果不再显示）">
          停止等待
        </button>
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
                    onContextMenu={(e) => imageMenu.openMenu(e, { kind: 'result', file: im.file, name: im.name })}
                  />
                  <div className="result-badge">
                    {im.width && im.height ? `${im.width}×${im.height}` : '分辨率未知'}
                  </div>
                  <div className="result-hover-actions">
                    <button className="icon-btn" title="复制图片到剪贴板" onClick={() => copyImage(im)}><Icon name="copy" size={15} /></button>
                    <button className="icon-btn" title="下载保存到默认路径" onClick={() => downloadImage(im)}><Icon name="download" size={15} /></button>
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
        <div className="error-title"><Icon name="warning" size={16} /> 生成失败</div>
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
    <div className="msg assistant" data-msg-id={msg.id}>
      {imageMenu.menu && <ImageContextMenu menu={imageMenu.menu} onClose={imageMenu.closeMenu} />}
      <div className="msg-avatar" title="StabStab">
        <img src="./icon.svg" alt="" draggable={false} />
      </div>
      <div className="msg-bubble assistant-bubble">
        {body}
        <div className="msg-meta">{formatClock(msg.finishedAt || msg.createdAt)}</div>
      </div>
      <div className="msg-actions">
        {(msg.texts || []).length > 0 && (
          <button className="icon-btn" title="复制文字" onClick={() => copyText((msg.texts || []).join('\n'))}><Icon name="copy" size={15} /></button>
        )}
        <button className="icon-btn" title="删除该条结果" onClick={remove}><Icon name="trash" size={15} /></button>
      </div>
    </div>
  );
}
