'use strict';
/*
 * StabStab —— Electron 主进程入口
 * - 隐藏默认菜单栏（文件/编辑…），保留系统标题栏的最小化/最大化/关闭按钮
 * - 数据目录：可执行文件同级 stabstab-data/（不可写时回退用户目录）
 * - 自定义协议 appfile:// 提供本地图片（缓存/附件）给渲染进程
 * - 全部 IPC 服务：设置、会话、生成请求、对话框、剪贴板、日志
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, nativeTheme, Menu, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { getPaths } = require('./src/paths');
const log = require('./src/logger');
const store = require('./src/store');
const modelSeriesLib = require('./src/modelSeries');
const registry = require('./src/api/registry');
const runner = require('./src/api/runner');
const { sniffDimensions, uniqueName } = require('./src/imageutil');

const isDev = !app.isPackaged;
const APP_NAME = 'StabStab';

// ---------- 兼容性：Chromium 进程沙箱与受限环境冲突 ----------
// 症状 A：GPU process launch failed (error_code=1002/57) → "GPU process isn't usable. Goodbye."（主进程直接退出）
// 症状 B：渲染进程 launch-failed（exitCode 57 = ERROR_INVALID_PARAMETER）→ 窗口空白/永不出现
// 成因：企业 EDR / 安全软件（已确认：深信服 aES）挂钩进程创建，Chromium 无法建立受限令牌 / AppContainer。
// Windows 上无法可靠探测，默认整体关闭沙箱以保证开箱即用（主/渲染/GPU 沙箱同时失效，属已知取舍）；
// 需要恢复沙箱时设置环境变量 STABSTAB_KEEP_SANDBOX=1。
if (process.platform === 'win32' && process.env.STABSTAB_KEEP_SANDBOX !== '1') {
  app.commandLine.appendSwitch('no-sandbox');
}
if (process.platform === 'linux') {
  // Linux：仅禁用 GPU 进程沙箱（主/渲染/网络进程仍保留沙箱），保证开箱即用。
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
// 若既无用户命名空间、chrome-sandbox 又非 SUID，则整体禁用沙箱（兜底，确保可启动）。
if (process.platform === 'linux') {
  let usernsOk = true;
  try { require('child_process').execSync('unshare --user true', { stdio: 'ignore' }); }
  catch (e) { usernsOk = false; }
  let sandboxSuid = !app.isPackaged; // dev 模式无 chrome-sandbox，走用户命名空间
  try {
    const sp = path.join(path.dirname(process.execPath), 'chrome-sandbox');
    if (fs.existsSync(sp)) sandboxSuid = (fs.statSync(sp).mode & 0o4000) !== 0;
  } catch (e) { /* ignore */ }
  if (!usernsOk && !sandboxSuid) {
    app.commandLine.appendSwitch('no-sandbox');
  }
}

let win = null;
let PATHS = null;
let settings = null;
let modelSeries = null;     // 内置模型系列配置（含来源 / 默认地址 / 同步异步开关）
let conversations = null;   // 主进程内存副本（权威数据由渲染进程通过 state:save 同步）
let pendingResumes = [];   // 启动时需要恢复轮询的异步任务

// ---------- 自定义协议：appfile://cache|x|x.png ----------
protocol.registerSchemesAsPrivileged([
  { scheme: 'appfile', privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

function registerAppFileProtocol() {
  protocol.handle('appfile', (request) => {
    try {
      const u = new URL(request.url);
      const area = u.host;               // cache | uploads
      const file = path.basename(decodeURIComponent(u.pathname));
      const dir = area === 'cache' ? PATHS.cache : (area === 'uploads' ? PATHS.uploads : null);
      if (!dir || !file) return new Response('not found', { status: 404 });
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(full).href);
    } catch (e) {
      return new Response('error', { status: 500 });
    }
  });
}

// ---------- 工具 ----------
function sendEvent(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('api:event', payload);
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('无效的 dataUrl');
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

function mimeToExt(mime) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
    'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp', 'image/tiff': '.tiff'
  };
  return map[(mime || '').toLowerCase()] || '.png';
}

function extToMime(ext) {
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.tiff': 'image/tiff'
  };
  return map[(ext || '').toLowerCase()] || 'image/png';
}

function effectiveSavePath() {
  const p = settings && settings.defaultSavePath;
  if (p && String(p).trim()) return p;
  return PATHS.downloads;
}

// ---------- 启动时规范化会话（恢复异步轮询 / 标记中断） ----------
function normalizeConversationsOnStartup() {
  pendingResumes = [];
  if (!conversations || !Array.isArray(conversations.conversations)) return;
  for (const conv of conversations.conversations) {
    conv.unread = false; // 重启后清空黄点（结果已在会话中可见）
    for (const msg of (conv.messages || [])) {
      if (msg.role !== 'assistant') continue;
      if (['pending', 'running', 'polling'].includes(msg.status)) {
        const meta = msg.meta || {};
        // 按消息里记录的模型 id 反查「系列 / 来源 / 密钥」，避免把密钥写进会话文件
        const resolved = meta.modelId ? modelSeriesLib.resolveModel(settings, modelSeries, meta.modelId) : null;
        if (meta.taskId && meta.mode === 'async' && resolved && resolved.apiKey && resolved.supportsAsync) {
          msg.status = 'running';
          pendingResumes.push({
            jobId: msg.id,
            conversationId: conv.id,
            messageId: msg.id,
            protocol: resolved.protocol,
            model: resolved.modelName,
            apiKey: resolved.apiKey,
            baseUrl: resolved.baseUrl,
            taskId: meta.taskId,
            timeoutSec: settings.requestTimeoutSec,
            cacheDir: PATHS.cache
          });
        } else {
          msg.status = 'error';
          msg.error = { code: 'INTERRUPTED', message: '应用重启，该请求被中断，请重新发送。' };
          msg.finishedAt = Date.now();
        }
      }
    }
  }
  if (pendingResumes.length) log.info('发现需要恢复的异步任务', { count: pendingResumes.length });
}

// ---------- 窗口 ----------
function createWindow() {
  // 运行时窗口图标使用打包进 asar 的 electron/assets/icon.png
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#1e1f2b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  // 隐藏 Electron 默认菜单栏（文件/编辑/视图…），标题栏窗口按钮不受影响
  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // 诊断：渲染进程异常退出 / 页面加载失败（沙箱被拦截时可据此定位）
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('渲染进程异常退出', details || {});
  });
  win.webContents.on('unresponsive', () => log.error('渲染进程无响应', {}));
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    log.error('页面加载失败', { errorCode, errorDescription, validatedURL });
  });

  // 开发模式：F12 / Ctrl+Shift+I 打开 DevTools
  win.webContents.on('before-input-event', (event, input) => {
    if (!isDev) return;
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ---------- IPC ----------
function registerIpc() {
  // 启动引导：一次拿齐全部初始数据
  ipcMain.handle('app:bootstrap', () => {
    return {
      ok: true,
      appVersion: app.getVersion(),
      platform: process.platform,
      settings,
      modelSeries,
      conversations,
      paths: {
        root: PATHS.root,
        cache: PATHS.cache,
        uploads: PATHS.uploads,
        log: PATHS.log,
        downloads: PATHS.downloads,
        modelSeriesFile: PATHS.modelSeries,
        usedFallback: PATHS.usedFallback
      },
      resumeCount: pendingResumes.length
    };
  });

  // 状态保存（渲染进程为编辑主体，防抖后整包保存）
  ipcMain.handle('state:save', (_e, payload) => {
    try {
      if (payload && payload.settings) {
        settings = store.normalizeModelGroups({ ...settings, ...payload.settings }, modelSeries);
        store.saveSettings(PATHS.settings, settings);
        nativeTheme.themeSource = settings.theme === 'system' ? 'system' : (settings.theme === 'dark' ? 'dark' : 'light');
      }
      if (payload && payload.modelSeries) {
        // 只允许改「隐藏哪些系列」「同步/异步开关」以及自定义系列，内置结构由 merge 保证不被破坏
        modelSeries = modelSeriesLib.save(PATHS.modelSeries, payload.modelSeries);
      }
      if (payload && payload.conversations) {
        conversations = payload.conversations;
        store.saveConversations(PATHS.conversations, conversations);
      }
      return { ok: true };
    } catch (e) {
      log.error('保存状态失败', { error: e.message });
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('protocols:list', () => ({ ok: true, protocols: registry.listProtocols() }));

  // ---- 生成请求 ----
  // 渲染进程只传「模型 id」；协议 / 来源 / 密钥 / 同步异步在这里统一解析（主进程才是权威口径）
  ipcMain.handle('api:generate', (_e, opts) => {
    const base = { conversationId: opts.conversationId, messageId: opts.messageId };
    const resolved = modelSeriesLib.resolveModel(settings, modelSeries, opts.modelId);
    if (!resolved) {
      sendEvent({
        ...base, type: 'error', ok: false,
        error: { code: 'NO_MODEL', message: '未找到该模型：它可能已被删除。请在「设置 → 模型设置」中重新添加或改选模型。' }
      });
      return { jobId: opts.messageId };
    }
    if (!resolved.protocol) {
      sendEvent({
        ...base, type: 'error', ok: false,
        error: { code: 'NO_PROTOCOL', message: `模型「${resolved.modelName}」所属来源没有可用的协议适配器。` }
      });
      return { jobId: opts.messageId };
    }
    if (!String(resolved.apiKey || '').trim()) {
      const sLabel = (resolved.series && resolved.series.label) || resolved.seriesId;
      const srcLabel = (resolved.source && resolved.source.label) || resolved.sourceId;
      sendEvent({
        ...base, type: 'error', ok: false,
        error: { code: 'NO_API_KEY', message: `尚未配置 API Key：请在「设置 → 模型设置 → ${sLabel} → ${srcLabel}」中填写。` }
      });
      return { jobId: opts.messageId };
    }

    const full = {
      ...opts,
      jobId: opts.messageId,
      protocol: resolved.protocol,
      model: resolved.modelName,
      seriesId: resolved.seriesId,
      sourceId: resolved.sourceId,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      mode: resolved.mode,
      timeoutSec: settings.requestTimeoutSec,
      cacheDir: PATHS.cache
    };
    return runner.start(full, sendEvent);
  });

  ipcMain.handle('api:cancel', (_e, jobId) => runner.cancel(jobId, sendEvent));

  ipcMain.handle('api:resume', () => {
    const list = pendingResumes;
    pendingResumes = [];
    for (const r of list) runner.resume(r, sendEvent);
    return { ok: true, resumed: list.length };
  });

  // ---- 附件 ----
  ipcMain.handle('attachments:save', async (_e, att) => {
    try {
      const { mime, buf } = dataUrlToBuffer(att.dataUrl);
      const file = uniqueName('up', mimeToExt(att.mime || mime));
      fs.writeFileSync(path.join(PATHS.uploads, file), buf);
      const dim = sniffDimensions(buf);
      log.info('附件已保存', { file, bytes: buf.length });
      return { ok: true, file, width: dim.width, height: dim.height, bytes: buf.length };
    } catch (e) {
      log.error('附件保存失败', { error: e.message });
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('attachments:read', (_e, file) => {
    try {
      const full = path.join(PATHS.uploads, path.basename(file));
      const buf = fs.readFileSync(full);
      const mime = extToMime(path.extname(full));
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime };
    } catch (e) {
      return { ok: false, message: '附件文件不存在（可能已被清理）' };
    }
  });

  // ---- 结果图片 ----
  ipcMain.handle('result:download', (_e, file) => {
    try {
      const src = path.join(PATHS.cache, path.basename(file));
      if (!fs.existsSync(src)) return { ok: false, message: '缓存图片不存在（缓存可能已被清理）。' };
      const dir = effectiveSavePath();
      fs.mkdirSync(dir, { recursive: true });
      let dest = path.join(dir, path.basename(src));
      if (fs.existsSync(dest)) {
        const ext = path.extname(src);
        const base = path.basename(src, ext);
        dest = path.join(dir, `${base}_${Date.now()}${ext}`);
      }
      fs.copyFileSync(src, dest);
      log.info('结果图片已保存', { dest });
      return { ok: true, path: dest };
    } catch (e) {
      log.error('保存结果图片失败', { error: e.message });
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('result:copy-image', (_e, file) => {
    try {
      const src = path.join(PATHS.cache, path.basename(file));
      if (!fs.existsSync(src)) return { ok: false, message: '缓存图片不存在（缓存可能已被清理）。' };
      const img = nativeImage.createFromPath(src);
      if (img.isEmpty()) return { ok: false, message: '图片解码失败。' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('attachments:copy-image', (_e, file) => {
    try {
      const src = path.join(PATHS.uploads, path.basename(file));
      if (!fs.existsSync(src)) return { ok: false, message: '输入图片不存在（可能已被清理）。' };
      const img = nativeImage.createFromPath(src);
      if (img.isEmpty()) return { ok: false, message: '图片解码失败。' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // ---- 对话框 / Shell ----
  ipcMain.handle('dialog:pick-images', async () => {
    const ret = await dialog.showOpenDialog(win, {
      title: '选择图片',
      buttonLabel: '选择',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (ret.canceled) return { ok: true, files: [] };
    const files = [];
    for (const p of ret.filePaths.slice(0, 12)) {
      try {
        const st = fs.statSync(p);
        if (st.size > 25 * 1024 * 1024) {
          log.warn('跳过过大图片', { p, size: st.size });
          continue;
        }
        const buf = fs.readFileSync(p);
        const mime = extToMime(path.extname(p));
        files.push({ name: path.basename(p), mime, size: st.size, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
      } catch (e) {
        log.warn('读取图片失败', { p, error: e.message });
      }
    }
    return { ok: true, files };
  });

  ipcMain.handle('dialog:pick-folder', async (_e, defaultPath) => {
    const opts = { title: '选择文件夹', buttonLabel: '选择', properties: ['openDirectory', 'createDirectory'] };
    if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
    const ret = await dialog.showOpenDialog(win, opts);
    if (ret.canceled || !ret.filePaths.length) return { ok: false };
    return { ok: true, path: ret.filePaths[0] };
  });

  ipcMain.handle('cache:open', async () => {
    fs.mkdirSync(PATHS.cache, { recursive: true });
    const err = await shell.openPath(PATHS.cache);
    return { ok: !err, message: err || '' };
  });

  ipcMain.handle('shell:open-path', async (_e, p) => {
    const err = await shell.openPath(p);
    return { ok: !err, message: err || '' };
  });

  // 打开外部链接（如各来源的 API Key 申请页）：只允许 http(s)
  ipcMain.handle('shell:open-external', async (_e, url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, message: '仅支持 http/https 链接' };
    try {
      await shell.openExternal(u);
      return { ok: true };
    } catch (e) {
      log.warn('打开外部链接失败', { url: u, error: e.message });
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('shell:show-in-folder', (_e, p) => {
    shell.showItemInFolder(p);
    return { ok: true };
  });

  ipcMain.on('log:write', (_e, { level, message, extra }) => {
    const fn = level === 'error' ? log.error : (level === 'warn' ? log.warn : log.info);
    fn(`[renderer] ${message}`, extra);
  });
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    PATHS = getPaths(app);
    log.init(PATHS.log);
    log.info('应用启动', {
      name: APP_NAME, version: app.getVersion(), platform: process.platform,
      electron: process.versions.electron, dataRoot: PATHS.root, usedFallback: PATHS.usedFallback, dev: isDev
    });

    modelSeries = modelSeriesLib.load(PATHS.modelSeries);
    const loaded = store.loadSettings(PATHS.settings, modelSeries);
    settings = loaded.settings;
    if (loaded.migrated) {
      try { store.saveSettings(PATHS.settings, settings); } catch (e) { log.warn('迁移后的设置落盘失败', { error: e.message }); }
    }
    conversations = store.loadConversations(PATHS.conversations);
    nativeTheme.themeSource = settings.theme === 'system' ? 'system' : (settings.theme === 'dark' ? 'dark' : 'light');
    normalizeConversationsOnStartup();

    registerAppFileProtocol();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    log.info('应用退出');
    runner.cancelAll();
  });
}
