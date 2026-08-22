'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** 给渲染进程的 API（window.stab） */
contextBridge.exposeInMainWorld('stab', {
  // ---- 启动 / 环境 ----
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  platform: process.platform,

  // ---- 设置 & 会话持久化 ----
  saveState: (payload) => ipcRenderer.invoke('state:save', payload),

  // ---- 协议 / 模型 ----
  listProtocols: () => ipcRenderer.invoke('protocols:list'),

  // ---- 生成请求 ----
  generate: (opts) => ipcRenderer.invoke('api:generate', opts),
  cancelJob: (jobId) => ipcRenderer.invoke('api:cancel', jobId),
  resumeJobs: () => ipcRenderer.invoke('api:resume'),
  onApiEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('api:event', handler);
    return () => ipcRenderer.removeListener('api:event', handler);
  },

  // ---- 附件（用户输入图片持久化） ----
  saveAttachment: (att) => ipcRenderer.invoke('attachments:save', att),   // {name, mime, dataUrl} -> {file}
  readAttachment: (file) => ipcRenderer.invoke('attachments:read', file), // file -> {dataUrl, mime}

  // ---- 结果图片操作 ----
  downloadResult: (file) => ipcRenderer.invoke('result:download', file),  // 存入默认保存路径
  copyImage: (file) => ipcRenderer.invoke('result:copy-image', file),     // 复制到剪贴板
  copyUploadImage: (file) => ipcRenderer.invoke('attachments:copy-image', file), // 复制输入图到剪贴板

  // ---- 对话框 / Shell ----
  pickImages: () => ipcRenderer.invoke('dialog:pick-images'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
  openCacheDir: () => ipcRenderer.invoke('cache:open'),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show-in-folder', p),

  // ---- 日志 ----
  log: (level, message, extra) => ipcRenderer.send('log:write', { level, message, extra })
});
