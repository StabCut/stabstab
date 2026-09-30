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
const promptMeta = require('./promptmeta');

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

/** 本次要写进图片的元数据是否为空（提示词 / 输入图文件名都为空就不动字节） */
function hasMeta(meta) {
  return !!(meta && ((typeof meta.prompt === 'string' && meta.prompt.trim()) ||
    (Array.isArray(meta.pics) && meta.pics.length)));
}

/** 把一段图片字节写入目录，返回 {file, path, width, height, bytes} */
function saveImageBuffer(buf, dir, prefix = 'result', ext = '.png', meta = null) {
  fs.mkdirSync(dir, { recursive: true });
  const file = uniqueName(prefix, ext);
  const full = path.join(dir, file);
  // 生成提示词 / 输入图文件名写进图片文件元数据（插入分块，不重新编码像素；失败不影响写盘）
  const out = hasMeta(meta) ? withPromptMeta(buf, meta.prompt, meta.pics) : buf;
  fs.writeFileSync(full, out);
  const dim = sniffDimensions(buf);
  log.info('图片已写入缓存', { file, bytes: out.length, ...dim });
  return { file, path: full, width: dim.width, height: dim.height, bytes: out.length };
}

/**
 * 尽力把提示词 / 输入图文件名写进图片字节：失败只记日志并返回原字节（图片本身必须保留）。
 * @returns {Buffer} 带元数据的字节；不支持 / 失败时返回原字节
 */
function withPromptMeta(buf, prompt, pics) {
  try {
    const w = promptMeta.writePromptToBuffer(buf, prompt, pics);
    if (!w.ok) {
      log.warn('生成图片未写入提示词元数据', { format: w.format, code: w.code, message: w.message });
      return buf;
    }
    return w.buffer;
  } catch (e) {
    log.warn('生成图片未写入提示词元数据', { error: e && e.message });
    return buf;
  }
}

/**
 * 下载远程图片到目录，返回 {file, path, width, height, bytes}。
 * 兼容两种输入：
 *   - http(s) URL（带独立超时，默认 120s，失败抛错）
 *   - data:image/...;base64,... （部分协议直接返回 b64_json 结果）
 * meta.prompt：该图片对应的实际生成提示词 → 落盘时写入图片元数据
 * meta.pics  ：本次请求一起发送的输入图文件名（与图片顺序一一对应）→ 一并写进元数据
 */
async function downloadImage(url, dir, prefix = 'result', timeoutMs = 120000, meta = null) {
  if (String(url || '').startsWith('data:')) {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error('无效的 data URL 结果');
    if (!parsed.buf.length) throw new Error('结果内容为空');
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[parsed.mime] || '.png';
    return saveImageBuffer(parsed.buf, dir, prefix, ext, meta);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`下载图片失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('下载图片失败: 内容为空');
    if (hasMeta(meta)) {
      const fmt = promptMeta.detectFormat(buf);
      if (fmt && !promptMeta.formatSupport(fmt)) {
        log.info('该结果图格式暂不支持提示词元数据', { format: fmt });
      }
    }
    const ext = extFromUrl(url, res.headers.get('content-type'));
    const file = uniqueName(prefix, ext);
    const full = path.join(dir, file);
    const out = hasMeta(meta) ? withPromptMeta(buf, meta.prompt, meta.pics) : buf;
    fs.writeFileSync(full, out);
    const dim = sniffDimensions(buf);
    log.info('图片已下载至缓存', { file, bytes: out.length, ...dim });
    return { file, path: full, width: dim.width, height: dim.height, bytes: out.length };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sniffDimensions, extFromUrl, uniqueName, downloadImage, parseDataUrl, saveImageBuffer, withPromptMeta };
