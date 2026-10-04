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
const renameModel = require('./src/renameModel');
const registry = require('./src/api/registry');
const runner = require('./src/api/runner');
const { sniffDimensions, uniqueName } = require('./src/imageutil');
const promptMeta = require('./src/promptmeta');
const exportImage = require('./src/exportImage');
const conversationMeta = require('./src/conversationMeta');
const clipboardPayload = require('./src/clipboardPayload');

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
let renameConfig = null;    // 重命名模型配置（提示模板 / 温度 / Top-P / 默认地址，见 electron/assets/rename-model.json）
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

/** 兜底：从会话记录里找该结果图对应的「提示词 + 输入图文件名」（旧缓存图元数据缺失时用） */
function metaFromConversations(file) {
  return conversationMeta.metaFromConversations(conversations, file);
}

// ---------- 聊天区图片（用户输入图 / API 返回图）的公共操作 ----------
// 图片右键菜单的「复制 / 保存到下载 / 另存为」与聊天流里原有的复制、下载按钮共用这一组实现，
// 避免同一份文件读写 / 剪贴板逻辑出现两份会各自漂移的实现。
// kind: 'upload'（用户输入图，存于 <data>/uploads）| 'result'（API 返回图，存于 <data>/cache）
const IMAGE_KINDS = {
  upload: { dir: 'uploads', label: '输入图' },
  result: { dir: 'cache', label: '结果图' }
};

/** 由 kind（upload / result）+ 文件名解析出真实路径（结果图额外带上用于兜底的提示词与输入图文件名） */
function resolveImageSource(kind, file) {
  const spec = IMAGE_KINDS[kind];
  if (!spec) return { ok: false, message: '未知的图片类型。' };
  const name = path.basename(String(file || ''));
  if (!name) return { ok: false, message: '图片参数无效。' };
  const src = path.join(PATHS[spec.dir], name);
  if (!fs.existsSync(src)) return { ok: false, message: spec.label + '不存在（可能已被清理）。' };
  const meta = imageMetaOf(src, kind === 'result' ? metaFromConversations(name) : null);
  return {
    ok: true,
    src,
    name,
    // 提示词 / 输入图文件名：图片自带元数据优先（生成时写进去 / 拖入时自带），
    // 结果图缺失时用会话记录兜底。保存时的文件名、复制时的附带信息、写回元数据的兜底值都取这一份。
    prompt: meta.prompt,
    pics: meta.pics
  };
}

/** 图片的有效元数据：文件自带值优先，缺失的那一项（提示词 / 输入图文件名）才用兜底值 */
function imageMetaOf(srcPath, fallback) {
  const fb = fallback || { prompt: '', pics: [] };
  try {
    const r = promptMeta.extractPromptFromFile(srcPath);
    if (r && r.ok) {
      return {
        prompt: r.prompt || fb.prompt || '',
        pics: (r.pics && r.pics.length) ? r.pics : (fb.pics || [])
      };
    }
  } catch (e) {
    log.warn('读取图片提示词元数据失败', { error: e && e.message });
  }
  return { prompt: fb.prompt || '', pics: fb.pics || [] };
}

/** 保存文件名里使用提示词前 N 个字（设置 - 高级设置；0 / 未设置 = 不用提示词命名） */
function saveNameChars() {
  const v = parseInt(settings && settings.saveNamePromptChars, 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 50) : 0;
}

/** 提示词前 N 个字 -> 文件名主干；取不到可用内容返回空串（调用方退回原文件名） */
function stemFromPrompt(prompt) {
  const n = saveNameChars();
  if (!n || !prompt) return '';
  const head = Array.from(String(prompt).replace(/\s+/g, ' ').trim()).slice(0, n).join('');
  return head
    .replace(/[\\/:*?"<>|]/g, '_')         // 文件名非法字符
    .replace(/[\u0000-\u001f]/g, '')       // 控制字符
    .replace(/[. ]+$/, '')                 // Windows 不允许以点 / 空格结尾
    .trim();
}

/** 保存时的目标文件名：提示词前 N 个字优先（设置里可调），取不到就沿用原文件名 */
function saveFileNameFor(r) {
  const ext = path.extname(r.name) || '.png';
  const stem = stemFromPrompt(r.prompt) || path.basename(r.name, ext);
  return stem + ext;
}

/**
 * 复制图片到系统剪贴板：一次写入三个格式，尽量把「图片 + 提示词 + 输入图文件名（picN）」都带走
 *   1) image：位图（任何程序都能粘贴，保持原有行为不变）
 *      —— 位图在系统剪贴板里没有元数据容器，粘到「只认位图」的程序（画图等）或由系统把它
 *         另存为文件时，元数据仍会丢，这是系统剪贴板本身的限制，无法绕过。
 *   2) html ：内嵌**原图字节**的 data URI（不是重新编码的位图）+ data-filename / data-prompt / data-pics。
 *             元数据（含 pic1…picN）随这份字节一起走；宿主若把图存回文件，记录完整保留。
 *   3) text ：文件名 + 提示词（粘到纯文本框时也能拿到这两项）
 * 老图缺 picN 时在这里补上（只改剪贴板这一份，缓存文件不动），与保存 / 另存为的规则一致。
 */
function copyImageToClipboard(kind, file) {
  const r = resolveImageSource(kind, file);
  if (!r.ok) return r;
  try {
    const img = nativeImage.createFromPath(r.src);
    if (img.isEmpty()) return { ok: false, message: '图片解码失败。' };
    const buf = fs.readFileSync(r.src);
    // 剪贴板里的字节：自带元数据优先，缺失的 pic 项用会话记录补齐（不改缓存文件）
    const out = exportImage.applyPromptToBuffer(buf, r.prompt, r.pics);
    const meta = promptMeta.extractPromptFromBuffer(out);
    const prompt = (meta.ok && meta.prompt) || r.prompt || '';
    const pics = (meta.ok && meta.pics && meta.pics.length) ? meta.pics : (r.pics || []);
    const text = clipboardPayload.buildText({ name: r.name, prompt });
    const { html } = clipboardPayload.buildHtml({ mime: extToMime(path.extname(r.src)), buf: out, name: r.name, prompt, pics });
    clipboard.write({ image: img, text, html });
    log.info('图片已复制到剪贴板', {
      kind, file: r.name, bytes: buf.length, prompt: !!prompt, pics: pics.length, html: !!html,
      patched: out !== buf
    });
    return { ok: true, withPrompt: !!prompt, withPics: pics.length > 0, withHtml: !!html };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/** 系统「下载」目录：右键菜单「保存到下载」的目标（Windows 的「下载」文件夹 / macOS 的 Downloads） */
function systemDownloadsDir() {
  try {
    const p = app.getPath('downloads');
    if (p && String(p).trim()) return p;
  } catch (e) {
    log.warn('读取系统下载目录失败，改用数据目录下的 downloads', { error: e && e.message });
  }
  return PATHS.downloads;
}

/** 保存到系统「下载」目录（右键菜单的「保存到下载」；文件名按提示词前 N 个字，重名自动 -1、-2） */
function saveImageToSystemDownloads(kind, file) {
  const r = resolveImageSource(kind, file);
  if (!r.ok) return r;
  return exportImage.exportResultImage({
    srcPath: r.src,
    destDir: systemDownloadsDir(),
    fallbackPrompt: r.prompt,
    fallbackPics: r.pics,             // 输入图文件名：老图缺 picN 时在保存这一步补上
    fileName: saveFileNameFor(r)      // 提示词前 N 个字（设置里可调），取不到沿用原文件名
  });
}

/** 保存到应用内设置好的默认保存路径（聊天流里原有的「下载」按钮沿用） */
function saveImageToDefaultDir(kind, file) {
  const r = resolveImageSource(kind, file);
  if (!r.ok) return r;
  return exportImage.exportResultImage({
    srcPath: r.src,
    destDir: effectiveSavePath(),
    fallbackPrompt: r.prompt,
    fallbackPics: r.pics,
    fileName: saveFileNameFor(r)
  });
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
          // 恢复后的结果图仍要带着「本次请求的提示词 + 输入图文件名」落盘：从会话记录里取回
          const req = conversationMeta.metaOfParent(conv, msg);
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
            cacheDir: PATHS.cache,
            prompt: req.prompt,
            pics: req.pics
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

// ---------- 数据目录：在系统文件管理器中打开 ----------
// 三处文件夹按钮共用这一组实现，只是目标目录不同：
//   cache           —— 结果图缓存（左侧标签栏底部的文件夹按钮，可安全清空）
//   downloads       —— 数据目录下的下载目录（对话区右上角「同步模式」右侧的文件夹按钮）
//                      开发模式即项目内 dev-data/downloads；打包后为 stabstab-data/downloads。
//   systemDownloads —— 系统「下载」目录（右上角「下载」按钮）：Windows = %USERPROFILE%\Downloads；
//                      Linux（Ubuntu 24.04）= XDG 下载目录，默认 ~/Downloads。
const OPEN_DIRS = {
  cache: { label: '缓存目录', dir: () => PATHS.cache },
  downloads: { label: '下载目录', dir: () => PATHS.downloads },
  systemDownloads: { label: '系统下载目录', dir: () => systemDownloadsDir() }
};

async function openDataDir(kind) {
  const spec = OPEN_DIRS[kind];
  if (!spec) return { ok: false, message: '未知的目录类型。' };
  const dir = spec.dir();
  try {
    fs.mkdirSync(dir, { recursive: true });   // 目录可能被用户清空/删除，打开前补建
    const err = await shell.openPath(dir);
    return { ok: !err, message: err || '', path: dir };
  } catch (e) {
    return { ok: false, message: e.message, path: dir };
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
      renameConfig,                             // 重命名模型：提示模板 / 温度 / Top-P / 默认地址 / 默认模型
      conversations,
      paths: {
        root: PATHS.root,
        cache: PATHS.cache,
        uploads: PATHS.uploads,
        log: PATHS.log,
        downloads: PATHS.downloads,
        modelSeriesFile: PATHS.modelSeries,
        renameModelFile: PATHS.renameModel,
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
      if (payload && payload.renameConfig) {
        // 重命名模型：提示模板 / 温度 / Top-P（存在数据目录的 rename-model.json，可手工编辑）
        renameConfig = renameModel.save(PATHS.renameModel, payload.renameConfig);
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
      // 用户随这次请求一起发送的输入图文件名（与 opts.images 顺序一一对应，读不到名字的位置是空串）：
      // 由 runner 写进结果图的 pic1…picN，保存 / 另存为时随图片一起带走
      imageNames: Array.isArray(opts.imageNames)
        ? opts.imageNames.map((n) => (n === null || n === undefined ? '' : String(n)))
        : [],
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

  // ---- 会话标签自动命名（重命名模型）----
  // 渲染进程只把「首条用户文字」传进来；密钥 / 地址 / 模型 id / 提示模板 / 温度 / Top-P 由主进程决定。
  // 永不抛异常：失败时回 {ok:false, code, message}，渲染进程回退到「截取首条文字」。
  ipcMain.handle('title:generate', (_e, text) => renameModel.generateTitle(settings, text, renameConfig));

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

  // ---- 图片提示词元数据（拖入解析 / 复用）----
  // 只读：解析外部拖入图片的元数据，不写回、不上传、不触发生成。
  // 返回：{ok:true, prompt:string|null, format} | {ok:false, code, message}
  ipcMain.handle('prompt:read', (_e, filePath) => {
    const r = promptMeta.extractPromptFromFile(String(filePath || ''));
    if (r.ok) log.info('解析图片提示词元数据', { format: r.format, bytes: r.bytes, found: !!r.prompt, pics: (r.pics || []).length });
    return r;
  });

  // 兜底：渲染进程拿不到真实路径时，用 FileReader 读出的 dataUrl
  ipcMain.handle('prompt:read-data', (_e, dataUrl) => {
    try {
      const { buf } = dataUrlToBuffer(dataUrl);
      return promptMeta.extractPromptFromBuffer(buf);
    } catch (e) {
      return { ok: false, code: 'READ_FAILED', message: e.message };
    }
  });

  // 提示词 → 系统剪贴板（文本）
  ipcMain.handle('prompt:copy', (_e, text) => {
    const s = typeof text === 'string' ? text : '';
    if (!s) return { ok: false, message: '提示词为空，未写入剪贴板。' };
    try {
      clipboard.writeText(s);
      return { ok: true };
    } catch (e) {
      log.warn('写入剪贴板失败', { error: e.message });
      return { ok: false, message: e.message };
    }
  });

  // ---- 聊天区图片操作（用户输入图 + API 返回图）----
  // 右键菜单「复制 / 保存到下载 / 另存为」的主进程实现；渲染进程只传 { kind, file }。
  ipcMain.handle('image:copy', (_e, payload) => {
    const { kind, file } = payload || {};
    return copyImageToClipboard(kind, file);
  });

  // 保存到下载：写进系统「下载」目录（不是应用数据目录里的 downloads）
  ipcMain.handle('image:save', (_e, payload) => {
    const { kind, file } = payload || {};
    return saveImageToSystemDownloads(kind, file);
  });

  // 另存为：系统保存对话框选路径与文件名（默认名 = 提示词前 N 个字 > 建议名 > 原文件名）
  ipcMain.handle('image:save-as', async (_e, payload) => {
    const { kind, file, suggestedName } = payload || {};
    const r = resolveImageSource(kind, file);
    if (!r.ok) return r;
    const srcExt = path.extname(r.name) || '.png';
    // 默认文件名：提示词前 N 个字（设置 - 高级设置）> 渲染进程建议名 > 原文件名
    const suggested = String(suggestedName || '').replace(/[\\/:*?"<>|]/g, '_').trim() || r.name;
    const suggestedExt = path.extname(suggested) || srcExt;
    const stem = stemFromPrompt(r.prompt) || path.basename(suggested, path.extname(suggested));
    // 先确保默认目录存在：Linux 的 GTK 保存对话框在目录不存在时会退回「上次用过的目录」，
    // 看起来就像没定位到默认位置；Windows 也存在同样的定位失效问题。
    const defaultDir = effectiveSavePath();
    try { fs.mkdirSync(defaultDir, { recursive: true }); } catch (e) { /* 建不出来就让对话框自己决定 */ }
    const opts = {
      title: '另存为',
      buttonLabel: '保存',
      // 默认名先按「重名就 -1、-2」推到不重复：对话框一打开就是可直接保存的名字；
      // 用户在对话框里自己敲的名字一律尊重（要不要覆盖由系统对话框确认）。
      defaultPath: path.join(defaultDir, path.basename(exportImage.uniqueTarget(defaultDir, stem + suggestedExt))),
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    const ret = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (ret.canceled || !ret.filePath) return { ok: true, canceled: true };
    // 用户在对话框里没写扩展名时补上源图扩展名，避免存出无后缀文件
    const dest = path.extname(ret.filePath) ? ret.filePath : ret.filePath + srcExt;
    const saved = exportImage.exportResultImageAs({
      srcPath: r.src,
      destPath: dest,
      fallbackPrompt: r.prompt,
      fallbackPics: r.pics          // 输入图文件名：老图缺 picN 时在另存为这一步补上
    });
    if (saved.ok) log.info('图片另存为完成', { kind, file: r.name, dest });
    return saved;
  });

  // 原有通道（聊天流里的复制 / 下载按钮）改为复用同一组实现
  ipcMain.handle('result:download', (_e, file) => saveImageToDefaultDir('result', file));
  ipcMain.handle('result:copy-image', (_e, file) => copyImageToClipboard('result', file));
  ipcMain.handle('attachments:copy-image', (_e, file) => copyImageToClipboard('upload', file));

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

  // 左侧标签栏底部的文件夹按钮：打开结果图缓存目录（可安全清空）
  ipcMain.handle('cache:open', () => openDataDir('cache'));

  // 对话区右上角「同步模式」右侧的文件夹按钮：打开数据目录下的 downloads（dev-data/downloads）
  ipcMain.handle('downloads:open', () => openDataDir('downloads'));

  // 该文件夹按钮右侧的「下载」按钮：打开系统「下载」目录（Windows 下载 / Ubuntu ~/Downloads）
  ipcMain.handle('system-downloads:open', () => openDataDir('systemDownloads'));

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

  // 在系统文件管理器中打开文件所在位置（轻提示里点击路径）
  // Windows / macOS：资源管理器 / 访达中「定位并选中」这个文件；
  // Linux（以 Ubuntu 24.04 为例）：FileManager1 的「定位并选中」接口并非所有文件管理器都实现，
  //   为保证一定能看到结果，先用 xdg-open 打开所在目录，失败再退回「定位并选中」。
  ipcMain.handle('shell:reveal-file', async (_e, p) => {
    const raw = String(p || '').trim();
    if (!raw) return { ok: false, message: '文件路径为空。' };
    const target = path.resolve(raw);          // 规范化（相对路径 / 混合分隔符都处理）
    if (!fs.existsSync(target)) return { ok: false, message: '文件不存在或已被移动。' };
    try {
      if (process.platform === 'linux') {
        const err = await shell.openPath(path.dirname(target));
        if (!err) {
          log.info('已用文件管理器打开所在目录', { target });
          return { ok: true, mode: 'open-dir' };
        }
        shell.showItemInFolder(target);
        log.warn('打开所在目录失败，退回定位并选中', { target, error: err });
        return { ok: true, mode: 'select', warning: err };
      }
      shell.showItemInFolder(target);
      log.info('已在文件管理器中定位文件', { target });
      return { ok: true, mode: 'select' };
    } catch (e) {
      log.warn('在文件管理器中打开失败', { target, error: e && e.message });
      return { ok: false, message: e && e.message ? e.message : String(e) };
    }
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
    renameConfig = renameModel.load(PATHS.renameModel);
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
