'use strict';
/*
 * StabStab —— Electron 主进程入口
 * - 隐藏默认菜单栏（文件/编辑…），保留系统标题栏的最小化/最大化/关闭按钮
 * - 关闭窗口行为可选：直接退出程序 / 最小化到托盘（点 × 只隐藏窗口、进程继续跑）
 *   —— 用户设置优先，未设置时开发模式直接退出、打包后最小化到托盘（见 src/closeBehavior.js）
 * - 数据目录：可执行文件同级 stabstab-data/（不可写时回退用户目录）
 * - 自定义协议 appfile:// 提供本地图片（缓存/附件）给渲染进程
 * - 全部 IPC 服务：设置、会话、生成请求、对话框、剪贴板、日志
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, nativeTheme, Menu, Tray, protocol, net, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { getPaths } = require('./src/paths');
const log = require('./src/logger');
const store = require('./src/store');
const closeBehavior = require('./src/closeBehavior');
const shortcutsLib = require('./src/shortcuts');
const modelSeriesLib = require('./src/modelSeries');
const renameModel = require('./src/renameModel');
const registry = require('./src/api/registry');
const runner = require('./src/api/runner');
const { sniffDimensions, uniqueName } = require('./src/imageutil');
const promptMeta = require('./src/promptmeta');
const exportImage = require('./src/exportImage');
const conversationMeta = require('./src/conversationMeta');
const clipboardPayload = require('./src/clipboardPayload');
const dataTransfer = require('./src/dataTransfer');

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
let tray = null;            // 托盘图标（只在「最小化到托盘」时创建，见下面的 ensureTray）
let isQuitting = false;     // 正在退出（托盘菜单「退出程序」/ 系统关机 / app.quit）：close 事件不再拦截
let PATHS = null;
let settings = null;
let modelSeries = null;     // 内置模型系列配置（含来源 / 默认地址 / 尺寸；只有同步一种请求模式）
let renameConfig = null;    // 重命名模型配置（提示模板 / 温度 / Top-P / 默认地址，见 electron/assets/rename-model.json）
let conversations = null;   // 主进程内存副本（权威数据由渲染进程通过 state:save 同步）
let hiddenToTray = false;   // 窗口此刻是不是「藏在托盘里」（隐藏期间托盘绝不允许被撤掉，否则没有回到界面的入口）
let shortcutApplied = null; // 已经注册生效的那套全局快捷键（= settings.shortcuts 的快照，用于避免重复注册）
let shortcutStatus = {};    // 上一次注册的结果：actionId -> {ok, code, accelerator}（设置页显示用）

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

// ---------- 启动时规范化会话（标记中断的请求 / 清理旧字段） ----------
// 只有同步一种请求模式：应用退出时所有等待中的请求都随之中断，重启后一律标记为失败，
// 由用户重新发送（老版本数据里可能带着异步 task_id，同样按中断处理 —— 异步模式已删除）。
function normalizeConversationsOnStartup() {
  if (!conversations || !Array.isArray(conversations.conversations)) return;
  for (const conv of conversations.conversations) {
    // 重启后清空侧栏圆点（结果已在会话中可见）：旧数据里的 unread 布尔字段就地删除，
    // 现在由 dot 三态（success/error）+ 渲染进程推导的 running 表达。
    if ('unread' in conv) delete conv.unread;
    conv.dot = null;
    for (const msg of (conv.messages || [])) {
      if (msg.role !== 'assistant') continue;
      if (['pending', 'running', 'polling'].includes(msg.status)) {
        msg.status = 'error';
        msg.error = { code: 'INTERRUPTED', message: '应用重启，该请求被中断，请重新发送。' };
        msg.finishedAt = Date.now();
        // 旧版本留下的异步任务字段一并清掉（异步模式已删除）
        if (msg.taskId) msg.taskId = null;
        if (msg.taskStatus) msg.taskStatus = null;
        if (msg.meta && msg.meta.mode) delete msg.meta.mode;
      }
    }
  }
}

// ---------- 关闭窗口：直接退出 / 最小化到托盘 ----------
// 生效行为由 electron/src/closeBehavior.js 决定（用户设置优先，未设置时按是否打包给默认值）。
// 「最小化到托盘」= 只是 win.hide()，**进程继续在后台运行**（正在等待的生成请求照常出结果），
// 入口在托盘图标：单击 / 双击 / 菜单「显示主界面」都能把窗口叫回来，菜单「退出程序」才是真退出。
/**
 * 按当前设置让托盘图标存在（要托盘）/ 撤掉（不要托盘）；设置页改完立即生效，不必重启。
 * ★ 窗口正藏在托盘里时（hiddenToTray）托盘**必须保留**：它是当前唯一能回到界面的入口，
 *   这时候按设置把它撤掉，窗口就再也叫不回来了（全局快捷键「显示 / 隐藏主界面」也走这条路）。
 */
function syncTrayWithSettings() {
  if (hiddenToTray || closeBehavior.resolveCloseAction(settings, app.isPackaged) === 'tray') ensureTray();
  else destroyTray();
}

/** 创建托盘图标（已存在则直接返回）。失败返回 null —— 调用方据此退回「真关窗口」，不让窗口藏进虚空 */
function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error('托盘图标读取失败');
    // 托盘图标要小：Windows 16px（高 DPI 由系统放大）、macOS 菜单栏 18px
    image = image.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16, quality: 'best' });
    tray = new Tray(image);
    tray.setToolTip(`${APP_NAME} —— 仍在后台运行`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出程序', click: () => quitApp() }
    ]));
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    log.info('托盘图标已就绪（关闭窗口将最小化到托盘）', { platform: process.platform });
    return tray;
  } catch (e) {
    tray = null;
    log.warn('创建托盘图标失败，关闭窗口将直接退出程序', { error: e && e.message });
    return null;
  }
}

function destroyTray() {
  if (!tray || tray.isDestroyed()) { tray = null; return; }
  try { tray.destroy(); } catch (e) { /* 已经被系统回收，忽略 */ }
  tray = null;
  log.info('托盘图标已移除（关闭窗口将直接退出程序）');
}

/** 把窗口叫回来（托盘点击 / 第二实例 / macOS 点 Dock / 全局快捷键）：最小化就还原、隐藏就显示、已销毁就重建 */
function showMainWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  // 回到界面后「藏在托盘里」这个事实就结束了：托盘是否保留重新交给用户设置说了算
  if (hiddenToTray) {
    hiddenToTray = false;
    // 刚从托盘菜单 / 托盘点击进来时，这里可能正在处理托盘自己的事件：推迟一拍再撤，避免自毁中的引用
    setImmediate(syncTrayWithSettings);
  }
}

/** 真正退出程序（托盘菜单「退出程序」）：先把 isQuitting 立起来，close 事件才不会被拦成隐藏 */
function quitApp() {
  isQuitting = true;
  app.quit();
}

/**
 * 隐藏到托盘（**不发系统通知**：点 × 是用户的明确操作，再弹一条通知属于打扰；
 * 托盘图标与它的右键菜单已经足够说明「程序还在后台运行」）。
 * 调用方必须先保证托盘可用（ensureTray），否则窗口藏起来就回不去了。
 */
function hideToTray() {
  hiddenToTray = true;
  win.hide();
  log.info('窗口已最小化到托盘，进程继续在后台运行');
}

// ---------- 全局快捷键（设置 → 基础设置 →「全局快捷键」） ----------
// 规则：shortcuts.js 是全程序唯一注册 globalShortcut 的地方（注册 / 冲突检测都在那里）。
//   生效时机：启动时注册一次；设置里改动后（state:save）按需重新注册，不必重启。
//   窗口控制（显示 / 隐藏）在主进程做；主题切换与新建对话都在**渲染进程**做
//   （它才是设置与会话数据的编辑主体，见 store.jsx），主进程只把动作转发过去。
//   「被别的程序占用」只有真注册一次才知道：注册结果记在 shortcutStatus，设置页据此提示。

/**
 * 按当前设置注册全局快捷键（快捷键变化 / 启动时调用；没变化就跳过，避免一次次抢占组合键）。
 * 注册结果（谁生效、谁被占用）记在 shortcutStatus，设置页打开时经 shortcuts:status 读它。
 * @param force 启动时强制注册一遍
 */
function applyShortcutsIfChanged(force) {
  const wanted = shortcutsLib.normalizeShortcuts(settings.shortcuts);
  if (!force && shortcutApplied && shortcutsLib.sameShortcuts(shortcutApplied, wanted)) return;
  const { results } = shortcutsLib.apply(globalShortcut, wanted, onShortcutTrigger);
  shortcutApplied = wanted;
  shortcutStatus = results;
  const taken = shortcutsLib.ACTION_IDS.filter((id) => results[id] && results[id].code === 'taken');
  const invalid = shortcutsLib.ACTION_IDS.filter((id) => results[id] && !results[id].ok && results[id].code !== 'empty' && results[id].code !== 'taken');
  const active = shortcutsLib.ACTION_IDS.filter((id) => results[id] && results[id].ok && results[id].accelerator);
  log.info('全局快捷键已应用', {
    active: active.map((id) => `${id}=${results[id].accelerator}`).join(',') || '（未设置）',
    taken: taken.map((id) => `${id}=${results[id].accelerator}`).join(',') || undefined,
    invalid: invalid.map((id) => `${id}(${results[id].code})`).join(',') || undefined
  });
}

/** 快捷键触发入口（three actions） */
function onShortcutTrigger(actionId) {
  if (actionId === 'toggleWindow') { toggleWindowByShortcut(); return; }
  // 主题 / 新建对话：转发给渲染进程（它才是设置与会话的编辑主体）。
  // 窗口藏到托盘时也照发：渲染进程还活着，改完会立即落盘，用户下次打开就是这个状态。
  if (!win || win.isDestroyed()) { createWindow(); return; }
  win.webContents.send('shortcut:action', { action: actionId });
  log.info('全局快捷键触发', { action: actionId });
}

/**
 * 「显示 / 隐藏主界面」：可见 → 藏到托盘；不可见 / 最小化 → 唤回。
 * 藏之前一定要有托盘（那是唯一的回程入口）：托盘建不出来就退回「最小化到任务栏」，
 * 绝不把窗口藏进虚空（判定在 shortcuts.js#planWindowToggle，与 close 事件的 shouldHideOnClose 同一条铁律）。
 */
function toggleWindowByShortcut() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  // 不可见 / 最小化 → 唤回（这一步与托盘无关）
  if (shortcutsLib.planWindowToggle({ visible: win.isVisible(), minimized: win.isMinimized(), trayAvailable: !!tray }) === 'show') {
    showMainWindow();
    return;
  }
  // 可见 → 要藏起来：先把托盘准备好，托盘可用才允许 hide
  ensureTray();
  if (shortcutsLib.planWindowToggle({ visible: true, minimized: false, trayAvailable: !!tray }) === 'hide') {
    hideToTray();
    return;
  }
  win.minimize();
  log.warn('托盘不可用，全局快捷键改为「最小化到任务栏」');
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

  // 点标题栏 × 的去向（见 electron/src/closeBehavior.js）：
  //   · 生效行为 = 'tray' 且托盘可用 → 拦下来，只隐藏窗口，进程继续跑
  //   · 其余情况（用户选了「直接退出程序」/ 开发模式默认 / 正在退出 / 托盘建不出来）→ 放行 = 真关
  win.on('close', (e) => {
    const action = closeBehavior.resolveCloseAction(settings, app.isPackaged);
    if (action === 'tray') ensureTray();          // 首次用到才建托盘（开发模式默认直接退出，不必建）
    const hide = closeBehavior.shouldHideOnClose({ isQuitting, closeAction: action, trayAvailable: !!tray });
    if (!hide) {
      log.info('窗口关闭：直接退出程序', { action, quitting: isQuitting, tray: !!tray });
      if (action !== 'tray' && tray) destroyTray();  // 用户改回「直接退出」后，托盘图标一并撤掉
      return;
    }
    e.preventDefault();
    hideToTray();
  });
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
//   downloads       —— 数据目录下的下载目录（对话区右上角的文件夹按钮）
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

// ---------- 数据目录：形态与迁移结果写日志 ----------
// 覆盖安装后配置还在不在，全看数据目录落在哪（见 electron/src/paths.js 顶部注释）。
// 启动时把形态 + 旧数据迁移结果记下来，用户排查「我的配置去哪了」时一眼能看到。
function logDataRootInfo() {
  if (PATHS.notes && PATHS.notes.length) {
    log.warn('数据目录迁移出现问题', { notes: PATHS.notes, root: PATHS.root });
  }
  if (PATHS.migration) {
    log.info('检测到旧版本数据，已迁移到新的数据目录（只拷不删）', {
      from: PATHS.migration.from, root: PATHS.root, config: PATHS.migration.copied
    });
  }
  if (PATHS.mediaCopy) {
    PATHS.mediaCopy.then((r) => {
      if (r.failed.length) {
        log.warn('旧数据目录（图片/日志）迁移部分失败', { from: PATHS.migratedFrom, failed: r.failed });
      } else {
        log.info('旧数据目录（图片/日志）迁移完成', { from: PATHS.migratedFrom, dirs: r.dirs });
      }
    }).catch((e) => log.warn('旧数据目录迁移失败', { from: PATHS.migratedFrom, error: e.message }));
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
        kind: PATHS.kind,                         // dev | portable | user（数据目录形态）
        cache: PATHS.cache,
        uploads: PATHS.uploads,
        log: PATHS.log,
        downloads: PATHS.downloads,
        modelSeriesFile: PATHS.modelSeries,
        renameModelFile: PATHS.renameModel,
        migratedFrom: PATHS.migratedFrom,         // 本次启动前迁移过的旧数据目录（没有则 null）
        usedFallback: PATHS.usedFallback
      }
    };
  });

  // 状态保存（渲染进程为编辑主体，防抖后整包保存）
  ipcMain.handle('state:save', (_e, payload) => {
    try {
      if (payload && payload.settings) {
        settings = store.normalizeModelGroups({ ...settings, ...payload.settings }, modelSeries);
        store.saveSettings(PATHS.settings, settings);
        nativeTheme.themeSource = settings.theme === 'system' ? 'system' : (settings.theme === 'dark' ? 'dark' : 'light');
        // 关闭窗口行为可能刚被改过：立即让托盘图标与之对齐（改完就生效，不必重启）
        syncTrayWithSettings();
        // 全局快捷键可能刚被改过：按需重新注册（没变就跳过，不会反复抢占组合键）
        applyShortcutsIfChanged(false);
      }
      if (payload && payload.modelSeries) {
        // 只允许改「隐藏哪些系列」以及自定义系列，内置结构由 merge 保证不被破坏
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

  // ---- 全局快捷键 ----
  // 当前生效的组合与上一次注册结果（设置页打开时读一次，用来显示「已生效 / 被其它程序占用」）
  ipcMain.handle('shortcuts:status', () => ({
    ok: true,
    shortcuts: shortcutsLib.normalizeShortcuts(settings.shortcuts),
    results: shortcutStatus
  }));
  // 试探性冲突检测（不改设置）：录完一个组合就调一次，用来在保存前就发现「被别的程序占用」。
  // 内部会真注册一遍再恢复当前生效的那套（毫秒级，见 shortcuts.js#check）。
  ipcMain.handle('shortcuts:check', (_e, candidates) => {
    const r = shortcutsLib.check(globalShortcut, candidates, settings.shortcuts, onShortcutTrigger);
    return { ok: true, shortcuts: r.shortcuts, results: r.results };
  });

  // ---- 生成请求 ----
  // 渲染进程只传「模型 id」；协议 / 来源 / 密钥 / 地址在这里统一解析（主进程才是权威口径）。
  // 每个请求一个 jobId（= 助手消息 id）：同一对话可同时有多个请求在等待，互不影响。
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

  // ---- 配置 + 聊天记录：导出 / 导入（见 electron/src/dataTransfer.js） ----
  // 导出：设置 + 会话 + 模型系列 + 重命名模型配置 + 被会话引用到的图片，zip 名字固定协议
  //       `ss-YYYYMMDD-HHmm.zip`（精确到分钟）。渲染进程先 flushSave，保证导出的是最新数据。
  ipcMain.handle('data:export', async () => {
    const now = new Date();
    const defaultDir = systemDownloadsDir();
    try { fs.mkdirSync(defaultDir, { recursive: true }); } catch (e) { /* 建不出来就交给对话框 */ }
    const opts = {
      title: '导出配置与聊天记录',
      buttonLabel: '导出',
      defaultPath: path.join(defaultDir, dataTransfer.zipNameFor(now)),
      filters: [{ name: 'StabStab 导出包', extensions: ['zip'] }]
    };
    const ret = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (ret.canceled || !ret.filePath) return { ok: true, canceled: true };

    // 包名是导入时的第一道校验，所以这里强制回到协议名（用户在对话框里改了名也能被导入）
    const wanted = path.basename(ret.filePath);
    let dest = ret.filePath;
    let renamedFrom = '';
    if (dataTransfer.parseZipName(wanted).ok) {
      dest = ret.filePath;
    } else if (dataTransfer.parseZipName(`${wanted}.zip`).ok) {
      dest = `${ret.filePath}.zip`;               // 用户在对话框里漏了扩展名
    } else {
      dest = path.join(path.dirname(ret.filePath), dataTransfer.zipNameFor(now));
      renamedFrom = wanted;
    }

    const r = await dataTransfer.exportData({
      destPath: dest,
      settings,
      conversations,
      modelSeries,
      renameConfig,
      paths: PATHS,
      appVersion: app.getVersion(),
      now
    });
    return { ...r, renamedFrom };
  });

  // 导入：包名协议 → 解压到缓存目录 → 包内目录协议 → 智能合并 → 叠加图片 → 落盘
  // 两道校验各自有自己的错误码（BAD_NAME / BAD_STRUCTURE），渲染进程分别提示。
  ipcMain.handle('data:import', async () => {
    const opts = {
      title: '导入配置与聊天记录',
      buttonLabel: '导入',
      properties: ['openFile'],
      filters: [
        { name: 'StabStab 导出包 (ss-*.zip)', extensions: ['zip'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    const ret = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (ret.canceled || !ret.filePaths.length) return { ok: true, canceled: true };

    const r = await dataTransfer.importData({
      zipPath: ret.filePaths[0],
      paths: PATHS,                                   // 解压到 <data>/cache/ss-import-*（导入结束即清理）
      current: { settings, modelSeries, renameConfig, conversations },
      dirExists: (p) => {
        try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
      }
    });
    if (!r.ok) return r;                              // {ok:false, code, message}

    // 落盘 + 更新内存：四份数据一起换（写失败就整体报错，内存保持原样）
    try {
      const nextSeries = modelSeriesLib.save(PATHS.modelSeries, r.merged.modelSeries);
      const nextRename = renameModel.save(PATHS.renameModel, r.merged.renameConfig);
      const nextSettings = r.merged.settings;
      store.saveSettings(PATHS.settings, nextSettings);
      store.saveConversations(PATHS.conversations, r.merged.conversations);
      settings = nextSettings;
      modelSeries = nextSeries;
      renameConfig = nextRename;
      conversations = r.merged.conversations;
      nativeTheme.themeSource = settings.theme === 'system' ? 'system' : (settings.theme === 'dark' ? 'dark' : 'light');
      syncTrayWithSettings();   // 导入的设置里可能带着关闭窗口行为
    } catch (e) {
      log.error('导入失败：数据落盘出错', { error: e.message });
      return { ok: false, code: 'SAVE_FAILED', message: `导入数据写入失败：${e.message}` };
    }

    return {
      ok: true,
      source: path.basename(ret.filePaths[0]),
      manifest: r.manifest,
      media: r.media,
      summary: r.merged.summary,
      notes: r.merged.notes,
      // 渲染进程据此整体替换本地状态（随后由既有的防抖落盘保持一致）
      state: { settings, modelSeries, renameConfig, conversations }
    };
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

  // 左侧标签栏底部的文件夹按钮：打开结果图缓存目录（可安全清空）
  ipcMain.handle('cache:open', () => openDataDir('cache'));

  // 对话区右上角的文件夹按钮：打开数据目录下的 downloads（dev-data/downloads）
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
    // 再次启动 = 把已有窗口叫到前面（可能正最小化、或已经隐藏到托盘）
    showMainWindow();
  });

  app.whenReady().then(() => {
    PATHS = getPaths(app);
    log.init(PATHS.log);
    log.info('应用启动', {
      name: APP_NAME, version: app.getVersion(), platform: process.platform,
      electron: process.versions.electron, dataRoot: PATHS.root, dataRootKind: PATHS.kind,
      usedFallback: PATHS.usedFallback, dev: isDev
    });
    logDataRootInfo();

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
    syncTrayWithSettings();     // 打包后默认行为是托盘：启动即把托盘图标挂上；开发模式默认直接退出，不建托盘
    applyShortcutsIfChanged(true);   // 全局快捷键：启动即按设置注册（被占用的会在日志里点名）
    createWindow();

    app.on('activate', () => {
      // macOS 点 Dock：窗口没了就重建，隐藏着就叫回来
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    // 托盘模式下窗口消失（异常销毁）但托盘还在：退出交给托盘菜单，别把托盘变成没人管的孤儿进程
    if (!isQuitting && tray && closeBehavior.resolveCloseAction(settings, app.isPackaged) === 'tray') {
      log.warn('窗口已不存在，但仍处于托盘模式：保留进程与托盘，等待托盘菜单退出');
      return;
    }
    app.quit();
  });

  // 系统关机 / 注销（仅 Windows）：必须放行窗口关闭，否则会拖住关机
  app.on('session-end', () => { isQuitting = true; });

  app.on('before-quit', () => {
    isQuitting = true;          // 先立标记：随后的 win close 事件才会真的关（不拦成隐藏）
    log.info('应用退出');
    globalShortcut.unregisterAll();   // 让出全局组合键（不给系统留一堆指向已退出进程的快捷键）
    destroyTray();
    runner.cancelAll();
  });
}
