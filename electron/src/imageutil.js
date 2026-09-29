'use strict';
/*
 * 图片工具：
 *  - 从 PNG / JPEG 字节流嗅探分辨率（不依赖第三方库）
 *  - 生成唯一文件名
 *  - 将远程图片 URL 下载至缓存目录
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

/** 从图片字节中解析宽高；失败返回 {width:null,height:null} */
function sniffDimensions(buf) {
  try {
    // PNG: 89 50 4E 47 0D 0A 1A 0A，随后 IHDR 中 4字节宽 + 4字节高（大端）
    if (buf.length > 24 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF: 'GIF8'，6,7 字节为宽（小端），8,9 为高
    if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // WEBP: RIFF....WEBP
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8 ') {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff
        };
      }
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG: FF D8 起，扫描 SOF 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        // SOF0..SOF15（排除 DHT/C4、JPG/ C8、DAC/CC 与 RST/独立标记）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          off += 2;
          continue;
        }
        const segLen = buf.readUInt16BE(off + 2);
        off += 2 + segLen;
      }
    }
  } catch (e) {
    log.warn('图片尺寸解析失败', { error: e.message });
  }
  return { width: null, height: null };
}

/** 由 URL / mime 推断扩展名 */
function extFromUrl(url, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
    'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp'
  };
  if (map[ct]) return map[ct];
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(png|jpe?g|webp|gif|bmp)$/i);
    if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  } catch (e) { /* ignore */ }
  return '.png';
}

function uniqueName(prefix, ext) {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const t = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}_${t}_${crypto.randomBytes(4).toString('hex')}${ext}`;
}

/** 解析 data:image/...;base64,... → {mime, buf}；不是 data URL 返回 null */
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = m[1] || 'image/png';
  const isB64 = !!m[2];
  const buf = isB64 ? Buffer.from(m[3].replace(/\s+/g, ''), 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime, buf };
}

/** 把一段图片字节写入目录，返回 {file, path, width, height, bytes} */
function saveImageBuffer(buf, dir, prefix = 'result', ext = '.png') {
  fs.mkdirSync(dir, { recursive: true });
  const file = uniqueName(prefix, ext);
  const full = path.join(dir, file);
  fs.writeFileSync(full, buf);
  const dim = sniffDimensions(buf);
  log.info('图片已写入缓存', { file, bytes: buf.length, ...dim });
  return { file, path: full, width: dim.width, height: dim.height, bytes: buf.length };
}

/**
 * 下载远程图片到目录，返回 {file, path, width, height, bytes}。
 * 兼容两种输入：
 *   - http(s) URL（带独立超时，默认 120s，失败抛错）
 *   - data:image/...;base64,... （部分协议直接返回 b64_json 结果）
 */
async function downloadImage(url, dir, prefix = 'result', timeoutMs = 120000) {
  if (String(url || '').startsWith('data:')) {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error('无效的 data URL 结果');
    if (!parsed.buf.length) throw new Error('结果内容为空');
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[parsed.mime] || '.png';
    return saveImageBuffer(parsed.buf, dir, prefix, ext);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`下载图片失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('下载图片失败: 内容为空');
    const ext = extFromUrl(url, res.headers.get('content-type'));
    const file = uniqueName(prefix, ext);
    const full = path.join(dir, file);
    fs.writeFileSync(full, buf);
    const dim = sniffDimensions(buf);
    log.info('图片已下载至缓存', { file, bytes: buf.length, ...dim });
    return { file, path: full, width: dim.width, height: dim.height, bytes: buf.length };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sniffDimensions, extFromUrl, uniqueName, downloadImage, parseDataUrl, saveImageBuffer };
