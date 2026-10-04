'use strict';
/*
 * 数据根目录解析（会话 / 设置 / 模型系列 / 重命名模型 / 缓存 / 上传 / 日志 / 下载）
 * =====================================================================
 * 铁律：**打包后的数据绝不放在安装目录里。**
 *   NSIS 覆盖安装时会先调用旧版卸载器（app-builder-lib/templates/nsis/installSection.nsh
 *   的 uninstallOldVersion），而卸载器里有 `RMDir /r $INSTDIR`（同目录 uninstaller.nsh）——
 *   安装目录里的任何东西都会被删干净，「数据放 exe 同级」等于每次覆盖安装都清零配置。
 *
 * 因此打包后按形态分别落到：
 *   · 便携版（electron-builder portable 目标会给 PORTABLE_EXECUTABLE_DIR）
 *       → 便携 exe 同级的 stabstab-data/。便携包每次运行都把应用解压到临时目录再跑
 *         （portable.nsi 跑完还 RMDir /r），process.execPath 指的是临时目录，
 *         写在那里等于每次启动都是全新数据；PORTABLE_EXECUTABLE_DIR 才是 exe 真正所在。
 *   · exe 同级放了 stabstab-portable.txt 标记（Linux 便携 tar.gz 由 scripts/package.sh 放置）
 *       → 同样写 exe 同级，保持「解压即用、数据跟着走」的便携语义。
 *   · 其余打包形态（Windows/macOS 安装版、Linux deb）
 *       → <userData>/stabstab-data，即 Windows = %APPDATA%\StabStab\stabstab-data、
 *         Linux = ~/.config/StabStab/stabstab-data。卸载 / 覆盖安装都不碰它
 *         （卸载器只删安装目录；只有显式 --delete-app-data 或 deleteAppDataOnUninstall 才删 AppData）。
 *   · 开发模式（未打包）→ 项目内 dev-data/，不污染 node_modules。
 *
 * 旧版本的数据留在 exe 同级（安装目录里），所以新位置第一次启动还会做一次**旧数据迁移**
 * （migrateLegacyData）：小配置同步拷（本次启动就要读），历史图片/上传图/日志后台异步拷。
 * 一律**只拷不删**源目录，用户随时能自己找回。Windows 上安装器还会在删安装目录之前先抢一份
 * （build/installer.nsh 的 customInit），两道保险。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR_NAME = 'stabstab-data';
/** 便携标记文件：放在 exe 同级 = 数据也放 exe 同级 */
const PORTABLE_MARKER = 'stabstab-portable.txt';
/** 迁移记录：写在新数据根里，既告诉用户「数据是从哪儿搬来的」，也用来断点续搬 */
const MIGRATION_FILE = '.migration.json';
/** 小配置：迁移时同步拷贝（毫秒级，本次启动就要读） */
const CONFIG_FILES = ['settings.json', 'conversations.json', 'model-series.json', 'rename-model.json'];
/** 大目录：可能几个 G（历史结果图 / 上传图），后台异步拷，不阻塞窗口 */
const MEDIA_DIRS = ['cache', 'uploads', 'downloads', 'log'];

let cachedInfo = null;

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.w_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/** 一个目录看起来是不是「数据根」：里面有任一配置文件（空目录 / 只有 cache 的目录不算） */
function looksLikeDataRoot(dir) {
  return !!dir && CONFIG_FILES.some((f) => isFile(path.join(dir, f)));
}

/** 去重（Windows 文件名不区分大小写，同一个目录可能以两种大小写出现） */
function uniqueDirs(list) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    if (!d) continue;
    const key = process.platform === 'win32' ? d.toLowerCase() : d;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * 规划数据根目录 —— 纯函数（回归脚本见 dev-data/qa/paths-test.js）。
 * @param {object} env
 * @param {boolean} env.isPackaged    是否打包后运行
 * @param {string}  env.appPath       项目目录（开发模式用）
 * @param {string}  env.exeDir        可执行文件所在目录
 * @param {string}  env.userDataDir   Electron 的 userData 目录
 * @param {string|null} env.portableDir  PORTABLE_EXECUTABLE_DIR（便携目标才有）
 * @param {boolean} env.markerExists  exe 同级是否存在 stabstab-portable.txt
 * @param {(dir:string)=>boolean} env.writable 目录可写判定
 * @returns {{root:string, kind:'dev'|'portable'|'user', usedFallback:boolean}}
 */
function planDataRoot(env) {
  if (!env.isPackaged) {
    return { root: path.join(env.appPath, 'dev-data'), kind: 'dev', usedFallback: false };
  }
  // 便携形态：electron-builder portable 目标的环境变量，或 exe 同级的标记文件
  const portableBase = env.portableDir || (env.markerExists ? env.exeDir : null);
  if (portableBase) {
    // 便携目录不可写（只读 U 盘 / 网络盘）时只能退回用户目录，并标记出来（设置页/日志可见）
    if (env.writable(portableBase)) {
      return { root: path.join(portableBase, DATA_DIR_NAME), kind: 'portable', usedFallback: false };
    }
    return { root: path.join(env.userDataDir, DATA_DIR_NAME), kind: 'user', usedFallback: true };
  }
  // 安装版（NSIS / deb / macOS）：用户目录，卸载与覆盖安装都不会碰
  return { root: path.join(env.userDataDir, DATA_DIR_NAME), kind: 'user', usedFallback: false };
}

/**
 * 旧数据可能在哪儿（按可信度排序）。只认本软件自己的目录名，不做全盘扫描。
 * 当前目标目录本身会被剔除。
 */
function legacyCandidates(env, root) {
  const list = [
    path.join(env.exeDir, DATA_DIR_NAME),                                       // 旧版：exe 同级（安装目录里）
    env.portableDir ? path.join(env.portableDir, DATA_DIR_NAME) : null,         // 便携版搬到安装版
    path.join(env.userDataDir, DATA_DIR_NAME),                                  // 反过来：安装版搬到便携版
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'StabStab', DATA_DIR_NAME) : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'stabstab', DATA_DIR_NAME) : null
  ];
  return uniqueDirs(list).filter((d) => d !== root);
}

function readMigration(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, MIGRATION_FILE), 'utf8')); } catch (e) { return null; }
}

function writeMigration(root, info) {
  try { fs.writeFileSync(path.join(root, MIGRATION_FILE), JSON.stringify(info, null, 2)); } catch (e) { /* 记不上不影响迁移本身 */ }
}

/** 同步拷小配置（不覆盖新位置已有的同名文件） */
function copyConfigFiles(from, root, notes) {
  const copied = [];
  for (const f of CONFIG_FILES) {
    const src = path.join(from, f);
    const dest = path.join(root, f);
    try {
      if (isFile(src) && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        copied.push(f);
      }
    } catch (e) {
      notes.push(`配置 ${f} 拷贝失败：${e.message}`);
    }
  }
  return copied;
}

/**
 * 旧数据迁移（**只拷不删**）。新位置已有配置、且没有「上次没搬完」的记录时什么都不做。
 * @returns {{from:string, copied:string[], mediaCopy:Promise<{dirs:string[],failed:string[]}>|null}|null}
 */
function migrateLegacyData(root, sources, notes) {
  const prev = readMigration(root);
  const rootHasConfig = looksLikeDataRoot(root);
  const unfinished = (prev && prev.media !== true && isDir(prev.from)) ? prev.from : null;

  let from = unfinished;
  if (!from && !rootHasConfig) from = sources.find((d) => looksLikeDataRoot(d)) || null;
  if (!from) {
    // 上次没搬完但源目录已经没了（比如安装器把它删了）→ 收尾，别每次启动都试
    if (prev && prev.media !== true) writeMigration(root, { ...prev, media: true, failed: prev.failed || [], finishedAt: Date.now() });
    return null;
  }

  const first = !prev || prev.from !== from;
  const copied = first ? copyConfigFiles(from, root, notes) : [];
  writeMigration(root, {
    from,
    startedAt: (prev && prev.from === from && prev.startedAt) || Date.now(),
    media: false
  });

  // 历史结果图 / 上传图 / 下载 / 旧日志：可能很大，后台异步拷（force:false = 只补缺，不覆盖新写入的）
  const dirs = MEDIA_DIRS.filter((d) => isDir(path.join(from, d)));
  const mediaCopy = dirs.length
    ? (async () => {
      const done = [];
      const failed = [];
      for (const d of dirs) {
        try {
          await fs.promises.cp(path.join(from, d), path.join(root, d), { recursive: true, force: false, errorOnExist: false });
          done.push(d);
        } catch (e) {
          failed.push(`${d}: ${e.message}`);
        }
      }
      writeMigration(root, { from, media: true, dirs: done, failed, finishedAt: Date.now() });
      return { dirs: done, failed };
    })()
    : null;

  if (!mediaCopy) writeMigration(root, { from, media: true, dirs: [], failed: [], finishedAt: Date.now() });
  return { from, copied, mediaCopy };
}

/** 采集规划数据根所需的环境（Electron 相关调用集中在这里，便于其它函数保持纯粹） */
function buildEnv(app) {
  const exeDir = path.dirname(process.execPath);
  return {
    isPackaged: !!app.isPackaged,
    appPath: app.getAppPath(),
    exeDir,
    userDataDir: app.getPath('userData'),
    portableDir: String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim() || null,
    markerExists: isFile(path.join(exeDir, PORTABLE_MARKER)),
    writable: isWritable
  };
}

/**
 * 解析数据根目录（带缓存）。返回规划结果 + 迁移信息 + 需要主进程收尾/记录的说明。
 * @returns {{root:string, kind:string, usedFallback:boolean, migration:object|null, notes:string[]}}
 */
function resolveDataRoot(app) {
  if (cachedInfo) return cachedInfo;

  const env = buildEnv(app);
  const planned = planDataRoot(env);
  const root = planned.root;
  fs.mkdirSync(root, { recursive: true });

  const notes = [];
  let migration = null;
  if (planned.kind !== 'dev') {
    migration = migrateLegacyData(root, legacyCandidates(env, root), notes);
  }

  cachedInfo = { ...planned, root, migration, notes };
  return cachedInfo;
}

function getPaths(app) {
  const info = resolveDataRoot(app);
  const root = info.root;
  const p = {
    root,
    kind: info.kind,                                     // dev | portable | user
    portable: info.kind === 'portable',
    usedFallback: info.usedFallback,
    migratedFrom: info.migration ? info.migration.from : null,
    migration: info.migration,
    mediaCopy: info.migration ? info.migration.mediaCopy : null,
    notes: info.notes,
    conversations: path.join(root, 'conversations.json'),
    settings: path.join(root, 'settings.json'),
    modelSeries: path.join(root, 'model-series.json'),   // 内置模型系列配置（数据目录副本，可写）
    renameModel: path.join(root, 'rename-model.json'),   // 重命名模型配置：提示模板 / 温度 / Top-P（可写）
    cache: path.join(root, 'cache'),
    uploads: path.join(root, 'uploads'),
    log: path.join(root, 'log'),
    downloads: path.join(root, 'downloads')
  };
  for (const k of ['cache', 'uploads', 'log', 'downloads']) {
    fs.mkdirSync(p[k], { recursive: true });
  }
  return p;
}

module.exports = {
  resolveDataRoot,
  getPaths,
  isWritable,
  // 以下导出供回归脚本直接断言（打包运行不依赖）
  planDataRoot,
  migrateLegacyData,
  legacyCandidates,
  looksLikeDataRoot,
  DATA_DIR_NAME,
  PORTABLE_MARKER,
  MIGRATION_FILE
};
