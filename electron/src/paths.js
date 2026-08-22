'use strict';
/*
 * 数据根目录解析。
 * 目标：优先把数据（会话、缓存、日志、下载）放在「可执行文件同级目录」，
 * 若该目录不可写（如 Windows Program Files / Linux /opt），自动回退到用户数据目录。
 * 开发模式（未打包）则放在项目内 dev-data/，避免污染 node_modules。
 */
const fs = require('fs');
const path = require('path');

let cachedRoot = null;
let usedFallback = false;

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

function resolveDataRoot(app) {
  if (cachedRoot) return cachedRoot;

  let root;
  if (!app.isPackaged) {
    // 开发模式：项目内
    root = path.join(app.getAppPath(), 'dev-data');
  } else {
    const exeDir = path.dirname(process.execPath);
    const candidate = path.join(exeDir, 'stabstab-data');
    if (isWritable(exeDir)) {
      root = candidate;
    } else {
      // 回退到用户数据目录
      root = path.join(app.getPath('userData'), 'stabstab-data');
      usedFallback = true;
    }
  }

  fs.mkdirSync(root, { recursive: true });
  cachedRoot = root;
  return root;
}

function getPaths(app) {
  const root = resolveDataRoot(app);
  const p = {
    root,
    usedFallback,
    conversations: path.join(root, 'conversations.json'),
    settings: path.join(root, 'settings.json'),
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

module.exports = { resolveDataRoot, getPaths, isWritable };
