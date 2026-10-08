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
  // 每个请求独立：generate 立即返回，结果经 onApiEvent 推送；cancelJob 只中止指定的那一个。
  generate: (opts) => ipcRenderer.invoke('api:generate', opts),
  cancelJob: (jobId) => ipcRenderer.invoke('api:cancel', jobId),
  onApiEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('api:event', handler);
    return () => ipcRenderer.removeListener('api:event', handler);
  },

  // ---- 会话标签自动命名（重命名模型：DeepSeek Responses API）----
  generateTitle: (text) => ipcRenderer.invoke('title:generate', text),

  // ---- 全局快捷键（设置 → 基础设置 →「全局快捷键」）----
  // 注册 / 冲突检测都在主进程（electron/src/shortcuts.js）：这里只负责「试一下」与「读当前状态」，
  // 真正生效靠 settings.shortcuts 随 state:save 落盘（主进程按需重新注册）。
  // onShortcutAction = 主进程把「切换主题 / 新建对话」两个动作转发给渲染进程（窗口控制由主进程自己做）。
  checkShortcuts: (shortcuts) => ipcRenderer.invoke('shortcuts:check', shortcuts),
  shortcutStatus: () => ipcRenderer.invoke('shortcuts:status'),
  onShortcutAction: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('shortcut:action', handler);
    return () => ipcRenderer.removeListener('shortcut:action', handler);
  },

  // ---- 附件（用户输入图片持久化） ----
  saveAttachment: (att) => ipcRenderer.invoke('attachments:save', att),   // {name, mime, dataUrl} -> {file}
  readAttachment: (file) => ipcRenderer.invoke('attachments:read', file), // file -> {dataUrl, mime}

  // ---- 图片提示词元数据（只读解析 + 剪贴板）----
  // 顶部拖放解析区 / 底部拖入图片后的附加检查共用这两个入口
  readImagePrompt: (filePath) => ipcRenderer.invoke('prompt:read', filePath),
  readImagePromptFromData: (dataUrl) => ipcRenderer.invoke('prompt:read-data', dataUrl),
  copyText: (text) => ipcRenderer.invoke('prompt:copy', text),

  // ---- 聊天区图片操作（右键菜单：复制 / 保存到下载 / 另存为）----
  // kind: 'upload'（用户输入图）| 'result'（API 返回图）；file = 数据目录里的文件名
  copyImageFile: (kind, file) => ipcRenderer.invoke('image:copy', { kind, file }),
  saveImageFile: (kind, file) => ipcRenderer.invoke('image:save', { kind, file }),   // 系统下载目录
  saveImageFileAs: (kind, file, suggestedName) => ipcRenderer.invoke('image:save-as', { kind, file, suggestedName }),

  // ---- 结果图片操作（聊天流里的按钮沿用，保留兼容）----
  downloadResult: (file) => ipcRenderer.invoke('result:download', file),  // 存入默认保存路径
  copyImage: (file) => ipcRenderer.invoke('result:copy-image', file),     // 复制到剪贴板
  copyUploadImage: (file) => ipcRenderer.invoke('attachments:copy-image', file), // 复制输入图到剪贴板

  // ---- 配置 + 聊天记录：导出 / 导入（zip 打包 + 智能合并，见 electron/src/dataTransfer.js）----
  // exportData() → {ok, canceled?} | {ok:true, path, bytes, counts…}；导入成功回 {ok:true, state, summary, notes}
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),

  // ---- 对话框 / Shell ----
  pickImages: () => ipcRenderer.invoke('dialog:pick-images'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
  openCacheDir: () => ipcRenderer.invoke('cache:open'),        // 结果图缓存目录（标签栏底部按钮）
  openDownloadsDir: () => ipcRenderer.invoke('downloads:open'), // 数据目录下的 downloads（对话区右上角文件夹按钮）
  openSystemDownloadsDir: () => ipcRenderer.invoke('system-downloads:open'), // 系统「下载」目录（右上角「下载」按钮）
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  showInFolder: (p) => ipcRenderer.invoke('shell:show-in-folder', p),
  revealFile: (p) => ipcRenderer.invoke('shell:reveal-file', p),   // 在文件管理器中打开文件所在位置

  // ---- 日志 ----
  log: (level, message, extra) => ipcRenderer.send('log:write', { level, message, extra })
});
