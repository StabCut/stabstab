'use strict';
/*
 * 轻量日志模块：写入 <dataRoot>/log/app-YYYYMMDD.log
 * 记录关键信息（启动、配置、API 请求/响应摘要、错误），便于排查问题。
 * 不记录 API Key 与完整图片 base64，避免敏感信息 / 巨大日志。
 */
const fs = require('fs');
const path = require('path');

let logDir = null;

function init(dir) {
  logDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

function pad(n, l = 2) { return String(n).padStart(l, '0'); }

function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function fileForToday() {
  const d = new Date();
  return path.join(logDir, `app-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`);
}

function write(level, msg, extra) {
  if (!logDir) return;
  let line = `[${ts()}] [${level}] ${msg}`;
  if (extra !== undefined) {
    try { line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); }
    catch (e) { line += ' [unserializable]'; }
  }
  try { fs.appendFileSync(fileForToday(), line + '\n', 'utf8'); } catch (e) { /* ignore */ }
}

const info = (m, e) => write('INFO', m, e);
const warn = (m, e) => write('WARN', m, e);
const error = (m, e) => write('ERROR', m, e);

module.exports = { init, info, warn, error };
