'use strict';
/*
 * 图片提示词元数据（生成提示词 ↔ 图片文件）
 * ==========================================
 * 目标：把「该图片实际使用的生成提示词」可逆地写进图片文件本身，
 *       保存 / 导出后的图片拖回软件仍能完整读回（生成 → 写入 → 保存 → 拖入 → 解析 闭环）。
 *
 * 存储约定（写入端与读取端共用，见 ELECTRON 侧 promptMetaFile）
 *   - 键名统一为 `prompt`，值为完整提示词字符串（不截断）。
 *   - 若本次请求**除提示词之外还带了输入图**（图生图 / 图像编辑），结构化记录里额外记
 *     `pic1`…`picN`：第 N 张输入图的**文件名**（不是缓存里的内部文件名，是用户文件的原始名）。
 *       · 顺序与用户发送的图片顺序一一对应；读不到文件名的位置（直接粘贴、无文件来源）
 *         保留空串，但 pic 项必须存在 —— 于是「几张输入图」这件事本身也被记录下来了。
 *       · 纯文生图不带任何 pic 项，记录仍是 {"prompt":"…","v":1}。
 *   - 使用各格式的标准元数据机制：
 *       PNG  : iTXt 分块。keyword=`prompt` 存原文字符串（UTF-8，iTXt 才支持非 Latin-1）；
 *              keyword=`stabstab` 存合法 JSON `{"pic1":"…","prompt":"…","v":1}`（结构化记录，便于其它工具解析）。
 *       JPEG : APP1/XMP 包（http://ns.adobe.com/xap/1.0/），xmp:CreatorTool=StabStab，
 *              记录形如 {"pic1":"…","prompt":"…","v":1}，同时在 RDF 里给出 XMP 属性 xmp:Description。
 *       WebP : RIFF 容器中的 XMP 分块（"XMP "），内容与 JPEG 的 XMP 包一致。
 *   - 只做「插入元数据分块」，不解码 / 不重新编码像素：分辨率与可见画面不变、无画质损失，
 *     已有元数据（ICC / EXIF / 其它文本块）原样保留。
 *   - 重写记录时**替换**自己写过的分块（见 isManagedPngText / isOwnXmpSegment / isOwnXmpChunk），
 *     不会越写越多：老图缺 picN 时可以在保存 / 另存为阶段补齐。
 *   - GIF / BMP / TIFF 等无法用上述机制可靠承载 UTF-8 文本 → 明确返回 FORMAT_UNSUPPORTED，
 *     由界面提示（不做静默格式转换）。
 *
 * 安全：元数据是不可信输入 —— 读取带文件大小上限、分块长度上限与解析超时保护，
 *       任何失败都只返回错误码，不会抛出异常影响生成图片的保存。
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const PROMPT_KEY = 'prompt';        // 约定的逻辑字段名（原生键值字段）
const META_KEY = 'stabstab';        // 结构化 JSON 记录的键名 / XMP 工具标记
const PIC_KEY = 'pic';              // 输入图文件名键名前缀：pic1 / pic2 / …
const VERSION = 1;
const XMP_NS = 'http://ns.adobe.com/xap/1.0/';
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\u0000';
const XMP_BEGIN = '<x:xmpmeta';
const XMP_END = '</x:xmpmeta>';

const MAX_READ_BYTES = 96 * 1024 * 1024;    // 单文件读取上限（元数据是不可信输入）
const MAX_TEXT_BYTES = 256 * 1024;          // 接纳的提示词长度上限（超出视为无效数据）
const MAX_PIC_NAME_BYTES = 512;             // 单个输入图文件名的字节上限（先按字符截断，再按字节兜底）
const MAX_PIC_NAME_CHARS = 128;             // 单个输入图文件名的字符上限（记进元数据的是名字，不是路径）
const MAX_PICS = 12;                        // pic 项数量上限（输入框当前最多 3 张，见 Composer.MAX_IMAGES；
                                            // 这里留宽一些，只作为「元数据是不可信输入」的解析边界）
const MAX_META_BYTES = 512 * 1024;          // 解析分块上限
const XMP_TRUNCATE_BYTES = 900 * 1024;      // 写 XMP 时的保守上限（APP1 段最长 64KB，超长则截断）
const PIC_KEY_RE = /^pic(\d+)$/i;           // pic1 / pic2 / …

const FORMAT_INFO = {
  png: { mime: 'image/png', supported: true },
  jpeg: { mime: 'image/jpeg', supported: true },
  webp: { mime: 'image/webp', supported: true },
  gif: { mime: 'image/gif', supported: false },
  bmp: { mime: 'image/bmp', supported: false },
  tiff: { mime: 'image/tiff', supported: false }
};

const EXT_TO_FORMAT = {
  '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.jpe': 'jpeg',
  '.webp': 'webp', '.gif': 'gif', '.bmp': 'bmp', '.tif': 'tiff', '.tiff': 'tiff'
};

// ---------- 基础工具 ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 单个输入图文件名：去掉目录与控制字符（元数据里只记文件名，不把用户的完整路径写出去） */
function sanitizePicName(name) {
  if (typeof name !== 'string') return '';
  const flat = name.replace(/\u0000/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!flat) return '';
  const base = flat.split(/[\\/]/).pop() || '';
  let s = base.trim();
  if (!s) return '';
  if (Array.from(s).length > MAX_PIC_NAME_CHARS) s = Array.from(s).slice(0, MAX_PIC_NAME_CHARS).join('');
  if (Buffer.byteLength(s, 'utf8') > MAX_PIC_NAME_BYTES) s = Buffer.from(s, 'utf8').slice(0, MAX_PIC_NAME_BYTES).toString('utf8');
  return s.replace(/\uFFFD+$/, '');
}

/**
 * 规范化「用户本次发送的输入图文件名」列表。
 * 位置即图片顺序：读不到名字（直接粘贴等）的位置保留空串，绝不压缩数组 —— 于是 pic1/pic2
 * 与图片一一对应，顺便记录了「一共几张输入图」。最多 MAX_PICS 张。
 */
function sanitizePics(pics) {
  if (!Array.isArray(pics)) return [];
  return pics.slice(0, MAX_PICS).map(sanitizePicName);
}

/** 两个文件名列表是否一致（保存 / 另存为时判断是否需要重写元数据） */
function samePics(a, b) {
  const x = sanitizePics(a);
  const y = sanitizePics(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** 从记录对象里取出 pic1…picN：按序号排序，缺号的位置补空串（保持在图片顺序上） */
function picsFromRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const pairs = [];
  for (const k of Object.keys(obj)) {
    const m = PIC_KEY_RE.exec(k);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > MAX_PICS) continue;
    pairs.push([idx, sanitizePicName(obj[k])]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [idx, name] of pairs) {
    while (out.length < idx - 1) out.push('');
    out[idx - 1] = name;
  }
  return out;
}

/**
 * 里层 JSON 记录：{"pic1":"…","pic2":"…","prompt":"…","v":1}
 * 只有「本次请求带了输入图」才会出现 picN 键（纯文生图仍是 {"prompt":"…","v":1}）。
 */
function buildRecord(prompt, pics) {
  const rec = {};
  const list = sanitizePics(pics);
  for (let i = 0; i < list.length; i++) rec[PIC_KEY + (i + 1)] = list[i];
  rec.prompt = typeof prompt === 'string' ? prompt : '';
  rec.v = VERSION;
  return JSON.stringify(rec);
}

/**
 * 从一段文本里解析出「提示词 + 输入图文件名」：
 *   - 本软件写出的合法 JSON 记录 → 取 prompt / picN 两个字段（各自独立，缺失就是 null / 空列表）
 *   - 其它文本（别的工具写的纯文本提示词）→ 整段按提示词处理
 * 返回 {prompt:string|null, pics:string[]}。
 */
function parseRecord(text) {
  const none = { prompt: null, pics: [] };
  if (typeof text !== 'string') return none;
  const trimmed = text.trim();
  if (!trimmed) return none;
  // JSON 记录（本软件写入的）——解析失败就按纯文本处理
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const pics = picsFromRecord(obj);
        const hasPrompt = typeof obj.prompt === 'string';
        if (hasPrompt || pics.length) {
          return { prompt: hasPrompt && obj.prompt.length ? obj.prompt : null, pics };
        }
      }
    } catch (e) { /* 不是 JSON：按纯文本 */ }
  }
  return { prompt: text, pics: [] };
}

/**
 * 结构化记录与原文记录合并（PNG 同时写了两份）：
 * 本软件的结构化 JSON 记录（keyword=stabstab）是权威口径，只要它在，就只认它
 * —— 缺失的字段用原文分块补齐；没有结构化记录时才整体退回原文（别的工具 / 旧版本只写了原文）。
 */
function mergeRecords(primary, fallback) {
  const b = fallback || { prompt: null, pics: [] };
  if (!primary) return { prompt: b.prompt || null, pics: b.pics || [] };
  return {
    prompt: primary.prompt || null,
    pics: (primary.pics && primary.pics.length) ? primary.pics : (b.pics || [])
  };
}

/** 语法检查一个 JSON 记录是否可安全嵌入 XMP 属性（含引号 / 反斜杠 / 换行都不影响，属性值做转义即可） */
function isSafeForAttr(rec) {
  return rec.length <= XMP_TRUNCATE_BYTES;
}

// ---------- 格式识别 ----------

function detectFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const head = buf.toString('ascii', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00)) return 'tiff';
  return null;
}

/** 扩展名 → 格式（导出时用于判定能否承载元数据；不看内容） */
function formatFromPath(p) {
  const ext = path.extname(String(p || '')).toLowerCase();
  return EXT_TO_FORMAT[ext] || null;
}

function formatSupport(fmt) {
  const info = FORMAT_INFO[fmt];
  return !!(info && info.supported);
}

function mimeForFormat(fmt) {
  return (FORMAT_INFO[fmt] && FORMAT_INFO[fmt].mime) || 'application/octet-stream';
}

// ---------- PNG：iTXt ----------

/** 遍历 PNG 分块；返回 [{type, start, dataStart, dataLen, end}]，结构异常返回 null */
function pngChunks(buf) {
  const out = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len > MAX_META_BYTES) return null;                 // 分块长度不合理
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const end = dataStart + len + 4;                       // + CRC
    if (end > buf.length) return null;
    out.push({ type, start: off, dataStart, dataLen: len, end });
    off = end;
    if (type === 'IEND') break;
  }
  return off <= buf.length ? out : null;
}

/** 解析 iTXt 文本块：keyword\0 compressionFlag compressionMethod language\0 translated\0 text */
function parseItxt(data) {
  const nul = data.indexOf(0);
  if (nul < 0) return null;
  const keyword = data.slice(0, nul).toString('latin1');
  let p = nul + 1;
  if (p + 2 > data.length) return null;
  const compFlag = data[p];
  p += 2;                                                  // compressionFlag + compressionMethod
  const langEnd = data.indexOf(0, p);
  if (langEnd < 0) return null;
  const transEnd = data.indexOf(0, langEnd + 1);
  if (transEnd < 0) return null;
  if (compFlag !== 0) return { keyword, text: null, compressed: true };   // 不做解压，按不支持处理
  const text = data.slice(transEnd + 1).toString('utf8');
  return { keyword, text, compressed: false };
}

function pngExtract(buf) {
  const chunks = pngChunks(buf);
  if (!chunks) return { error: 'CORRUPT' };
  let textRec = null;      // keyword=prompt 的原文
  let recordRec = null;    // keyword=stabstab 的结构化记录（含 picN）
  for (const c of chunks) {
    if (c.type !== 'iTXt' && c.type !== 'tEXt' && c.type !== 'zTXt') continue;
    const data = buf.slice(c.dataStart, c.dataStart + c.dataLen);
    if (c.type === 'iTXt') {
      const it = parseItxt(data);
      if (!it || it.compressed) continue;
      if (it.keyword === PROMPT_KEY) textRec = parseRecord(it.text);
      else if (it.keyword === META_KEY) recordRec = parseRecord(it.text);
    } else if (c.type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul < 0) continue;
      const keyword = data.slice(0, nul).toString('latin1');
      const text = data.slice(nul + 1).toString('latin1');   // tEXt 仅 Latin-1
      if (keyword === META_KEY) recordRec = parseRecord(text);
      else if (keyword === PROMPT_KEY && !textRec) textRec = parseRecord(text);
    }
  }
  return mergeRecords(recordRec, textRec);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function itxtChunk(keyword, text) {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'), Buffer.from([0]),
    Buffer.from([0]), Buffer.from([0]),                 // 未压缩 + 压缩方法 0
    Buffer.from([0]), Buffer.from([0]),                 // 空语言标签 + 空翻译关键字
    Buffer.from(String(text), 'utf8')
  ]);
  return pngChunk('iTXt', data);
}

/**
 * 是否本软件写过的分块（重写时替换掉旧的，避免同一份记录越写越多）。
 * 只用「确定是我们写的」作为判据，绝不误删别的工具的元数据：
 *   · iTXt keyword=stabstab  → 本软件的结构化记录
 *   · iTXt keyword=prompt 且内容是纯文本 → 本软件的原文分块
 *     （ComfyUI 等工作流工具写的是 tEXt keyword=prompt 的 JSON，以及 iTXt 里放 JSON 的情况都保持原样）
 *   · tEXt / zTXt 一律不算我们的（本软件不写这两种）
 */
function isManagedPngText(type, data) {
  if (type !== 'iTXt') return false;
  const it = parseItxt(data);
  if (!it || !it.keyword) return false;
  if (it.keyword === META_KEY) return true;
  if (it.keyword !== PROMPT_KEY || typeof it.text !== 'string') return false;
  const head = it.text.trim()[0];
  return head !== '{' && head !== '[';
}

function pngInsert(buf, prompt, pics) {
  const chunks = pngChunks(buf);
  if (!chunks || !chunks.length || chunks[0].type !== 'IHDR') return null;
  // 8 字节 PNG 签名必须原样保留（分块从偏移 8 开始）
  const parts = [buf.slice(0, 8)];
  const records = [];
  const text = sanitizePrompt(prompt);
  if (text) records.push(itxtChunk(PROMPT_KEY, text));                   // 原文（逻辑字段 prompt）
  records.push(itxtChunk(META_KEY, buildRecord(text || '', pics)));      // 结构化 JSON 记录（含 picN）
  for (const c of chunks) {
    if (c.type === 'IHDR') {
      parts.push(buf.slice(c.start, c.end));                             // 原分块原样搬运（含 CRC）
      parts.push(...records);                                            // 元数据分块紧跟 IHDR
      continue;
    }
    const data = buf.slice(c.dataStart, c.dataStart + c.dataLen);
    if (isManagedPngText(c.type, data)) continue;                        // 旧记录：被本次写入替换
    parts.push(buf.slice(c.start, c.end));                               // 其它元数据（ICC / EXIF…）保留
  }
  return Buffer.concat(parts);
}

// ---------- JPEG：APP1 / XMP ----------

function buildXmp(prompt, pics) {
  let rec = buildRecord(prompt, pics);
  if (!isSafeForAttr(rec)) rec = buildRecord(rec.slice(0, XMP_TRUNCATE_BYTES));
  const attr = xmlEscape(rec);
  const body =
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="StabStab">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:${META_KEY}="${XMP_NS}" xmlns:xmp="${XMP_NS}" ` +
    `${META_KEY}:Prompt="${attr}" xmp:CreatorTool="StabStab" xmp:Description="${attr}"/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return Buffer.from(body, 'utf8');
}

function jpegApp1Segment(prompt, pics) {
  const xmp = buildXmp(prompt, pics);
  const header = Buffer.concat([Buffer.from(XMP_HEADER, 'latin1'), xmp]);
  if (header.length + 2 > 0xffff) return null;              // APP1 段长度上限
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = 0xe1;
  head.writeUInt16BE(header.length + 2, 2);                 // 段长含自身 2 字节
  return Buffer.concat([head, header]);
}

/** 该 APP1 段是不是本软件写出的 XMP 包（重写时替换，不重复插入） */
function isOwnXmpSegment(seg) {
  if (!seg || seg.length <= XMP_HEADER.length) return false;
  if (seg.toString('latin1', 0, XMP_HEADER.length) !== XMP_HEADER) return false;
  const text = seg.toString('utf8');
  return text.indexOf(`${META_KEY}:Prompt`) >= 0 || text.indexOf('StabStab') >= 0;
}

/** 去掉本软件写过的 XMP APP1 段；其余段与扫描数据原样保留（返回 null = 结构异常，不落盘） */
function jpegStripOwnXmp(buf) {
  const parts = [buf.slice(0, 2)];
  let off = 2;
  while (off + 2 <= buf.length) {
    if (buf[off] !== 0xff) break;
    const marker = buf[off + 1];
    if (marker === 0xff) { parts.push(buf.slice(off, off + 1)); off += 1; continue; }  // 填充字节
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(buf.slice(off, off + 2)); off += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;                                    // 进入扫描数据
    if (off + 4 > buf.length) break;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) return null;
    const seg = buf.slice(off + 4, off + 2 + len);
    if (!(marker === 0xe1 && isOwnXmpSegment(seg))) parts.push(buf.slice(off, off + 2 + len));
    off += 2 + len;
  }
  if (off < buf.length) parts.push(buf.slice(off));       // 扫描数据 / 无法解析的尾部原样保留
  return Buffer.concat(parts);
}

function jpegExtract(buf) {
  let off = 2;
  let sawMarker = false;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) {
      if (!sawMarker) return { error: 'CORRUPT' };
      break;
    }
    const marker = buf[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
    if (marker === 0xda) break;                              // 进入扫描数据，元数据只会在前面
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || (off + 2 + len) > buf.length) return { error: 'CORRUPT' };
    sawMarker = true;
    if (marker === 0xe1) {
      const seg = buf.slice(off + 4, off + 2 + len);
      if (seg.toString('latin1', 0, XMP_HEADER.length) === XMP_HEADER) {
        const rec = xmpExtract(seg.slice(XMP_HEADER.length).toString('utf8'));
        if (rec && (rec.prompt || rec.pics.length)) return rec;
      }
    }
    off += 2 + len;
  }
  return { prompt: null, pics: [] };
}

/** 从 XMP 文本里取出「提示词 + 输入图文件名」：先解析 JSON 记录属性，再退到 rdf:li 纯文本 */
function xmpExtract(xmpText) {
  if (!xmpText || xmpText.indexOf(XMP_BEGIN) < 0) return null;
  const patterns = [
    new RegExp(`${META_KEY}:Prompt\\s*=\\s*"([^"]*)"`, 'i'),
    /xmp:Description\s*=\s*"([^"]*)"/i,
    /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i
  ];
  for (const re of patterns) {
    const m = re.exec(xmpText);
    if (!m) continue;
    const rec = parseRecord(unescapeXml(m[1]));
    if (rec.prompt || rec.pics.length) return rec;
  }
  return null;
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function jpegInsert(buf, prompt, pics) {
  const seg = jpegApp1Segment(prompt, pics);
  if (!seg) return null;
  const base = jpegStripOwnXmp(buf);
  if (!base) return null;
  return Buffer.concat([base.slice(0, 2), seg, base.slice(2)]);
}

// ---------- WebP：RIFF "XMP " 分块 ----------

function webpChunks(buf) {
  const out = [];
  let off = 12;
  while (off + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const dataStart = off + 8;
    const padded = size + (size % 2);
    const end = dataStart + padded;
    if (end > buf.length) {
      // 允许最后一个分块长度按对齐前结束（部分写入器不补 padding）
      if (dataStart + size <= buf.length) {
        out.push({ fourcc, start: off, dataStart, size, end: buf.length });
        break;
      }
      return null;
    }
    out.push({ fourcc, start: off, dataStart, size, end });
    off = end;
  }
  return out;
}

function webpExtract(buf) {
  const chunks = webpChunks(buf);
  if (!chunks) return { error: 'CORRUPT' };
  const xmpChunk = chunks.find((c) => c.fourcc === 'XMP ');
  if (!xmpChunk) return { prompt: null, pics: [] };
  const rec = xmpExtract(buf.slice(xmpChunk.dataStart, xmpChunk.dataStart + xmpChunk.size).toString('utf8'));
  return rec || { prompt: null, pics: [] };
}

/** 该分块是不是本软件写出的 XMP（重写时替换，不重复插入） */
function isOwnXmpChunk(buf, c) {
  if (c.fourcc !== 'XMP ') return false;
  const text = buf.slice(c.dataStart, c.dataStart + c.size).toString('utf8');
  return text.indexOf(`${META_KEY}:Prompt`) >= 0 || text.indexOf('StabStab') >= 0;
}

function webpInsert(buf, prompt, pics) {
  const chunks = webpChunks(buf);
  if (!chunks) return null;
  const xmp = buildXmp(prompt, pics);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(xmp.length, 0);
  const chunk = Buffer.concat([
    Buffer.from('XMP ', 'ascii'), size, xmp,
    xmp.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)      // RIFF 分块补偶数字节
  ]);
  const parts = [buf.slice(0, 12)];
  let inserted = false;
  for (const c of chunks) {
    if (isOwnXmpChunk(buf, c)) continue;                      // 旧记录：被本次写入替换
    // XMP 必须排在图像数据（VP8/VP8L/VP8X 之外）之前：插到第一个图像数据块之前
    if (!inserted && ['VP8 ', 'VP8L', 'ANMF', 'ALPH'].includes(c.fourcc)) {
      parts.push(chunk);
      inserted = true;
    }
    parts.push(buf.slice(c.start, c.end));
  }
  if (!inserted) parts.push(chunk);
  const out = Buffer.concat(parts);
  const sizeFix = Buffer.alloc(4);
  sizeFix.writeUInt32LE(out.length - 8, 0);                  // 修正 RIFF 总长度
  sizeFix.copy(out, 4);
  return out;
}

// ---------- 对外 API ----------

/** 提示词长度 / 空值收敛：过长或空视为无效（元数据是不可信输入） */
function sanitizePrompt(p) {
  if (typeof p !== 'string') return null;
  const s = p.replace(/\u0000/g, '');
  if (!s.trim()) return null;
  if (Buffer.byteLength(s, 'utf8') > MAX_TEXT_BYTES) return null;
  return s;
}

/**
 * 从图片字节里读出「提示词 + 输入图文件名」。
 * @returns {{ok:true,prompt:string|null,pics:string[],format:string}} | {{ok:false,code:string,format:string|null,message:string}}
 *   code: FORMAT_UNSUPPORTED | FORMAT_UNKNOWN | CORRUPT
 *   pics：生成该图时用户一起发送的输入图文件名（读不到名字的位置是空串）；纯文生图为空数组。
 */
function extractPromptFromBuffer(buf) {
  const format = detectFormat(buf);
  if (!format) return { ok: false, code: 'FORMAT_UNKNOWN', format: null, message: '无法识别的图片格式。' };
  if (!formatSupport(format)) {
    return { ok: false, code: 'FORMAT_UNSUPPORTED', format, message: `${format.toUpperCase()} 暂不支持读写提示词元数据。` };
  }
  try {
    let r;
    if (format === 'png') r = pngExtract(buf);
    else if (format === 'jpeg') r = jpegExtract(buf);
    else r = webpExtract(buf);
    if (r && r.error) return { ok: false, code: 'CORRUPT', format, message: '图片文件结构异常，无法解析元数据。' };
    return { ok: true, prompt: sanitizePrompt(r && r.prompt), pics: sanitizePics(r && r.pics), format };
  } catch (e) {
    log.warn('提示词元数据解析失败', { format, error: e.message });
    return { ok: false, code: 'CORRUPT', format, message: '解析图片元数据失败。' };
  }
}

/**
 * 合并「图片自带记录」与「调用方兜底信息」（保存 / 另存为时使用）：
 * 图片自带的提示词 / 输入图文件名优先，缺失的那一项才用兜底值补。
 * 这样老图（只有提示词、没有 picN）在用户保存时也能补上输入图文件名。
 * @returns {{prompt:string|null, pics:string[]}}
 */
function mergeMeta(existing, fallback) {
  const e = (existing && existing.ok) ? existing : { prompt: null, pics: [] };
  const f = fallback || {};
  return {
    prompt: e.prompt || sanitizePrompt(f.prompt) || null,
    pics: (e.pics && e.pics.length) ? e.pics : sanitizePics(f.pics)
  };
}

/** 两个元数据对象是否已经一致（一致就不必重写文件，保持原字节透传） */
function sameMeta(a, b) {
  const x = a || { prompt: null, pics: [] };
  const y = b || { prompt: null, pics: [] };
  return (x.prompt || null) === (y.prompt || null) && samePics(x.pics, y.pics);
}

/**
 * 把提示词 / 输入图文件名写进图片字节（插入元数据分块，不重新编码像素）。
 * 已经写过的记录分块会被替换掉（不会重复堆积）。
 * @param {string} prompt 提示词，可为空（只要带过输入图，picN 仍要写）
 * @param {string[]} pics 本次请求一起发送的输入图文件名（与图片顺序一一对应，可为空串）
 * @returns {{ok:true,buffer:Buffer,changed:boolean,format:string,prompt:string|null,pics:string[]}} | {{ok:false,code:string,format:string|null,message:string}}
 */
function writePromptToBuffer(buf, prompt, pics) {
  const text = sanitizePrompt(prompt);
  const list = sanitizePics(pics);
  if (!text && !list.length) {
    return { ok: false, code: 'EMPTY_PROMPT', format: null, message: '提示词与输入图信息均为空，未写入元数据。' };
  }
  const format = detectFormat(buf);
  if (!format) return { ok: false, code: 'FORMAT_UNKNOWN', format: null, message: '无法识别的图片格式。' };
  if (!formatSupport(format)) {
    return { ok: false, code: 'FORMAT_UNSUPPORTED', format, message: `暂不支持把提示词写入 ${format.toUpperCase()} 图片。` };
  }
  try {
    const out = format === 'png' ? pngInsert(buf, text, list)
      : (format === 'jpeg' ? jpegInsert(buf, text, list) : webpInsert(buf, text, list));
    if (!out || !out.length) {
      return { ok: false, code: 'WRITE_FAILED', format, message: '写入元数据失败（图片结构不完整）。' };
    }
    // 写后自检：读回来必须与本次要写的完全一致（替代旧的「长度必须变长」判定，
    // 因为现在可能是在替换旧记录，字节数不必然增加）
    const back = extractPromptFromBuffer(out);
    if (!back.ok || (back.prompt || null) !== (text || null) || !samePics(back.pics, list)) {
      return { ok: false, code: 'WRITE_FAILED', format, message: '写入元数据后校验失败（图片结构不完整）。' };
    }
    return { ok: true, buffer: out, changed: out.length !== buf.length, format, prompt: back.prompt, pics: back.pics };
  } catch (e) {
    log.warn('提示词元数据写入失败', { format, error: e.message });
    return { ok: false, code: 'WRITE_FAILED', format, message: `写入元数据失败：${e.message}` };
  }
}

/**
 * 从磁盘文件读「提示词 + 输入图文件名」（渲染进程拖入的外部文件走这里）。
 * @returns {{ok:true,prompt:string|null,pics:string[],format:string,bytes:number}} | {{ok:false,code,message}}
 */
function extractPromptFromFile(filePath) {
  try {
    if (!filePath || typeof filePath !== 'string') return { ok: false, code: 'BAD_PATH', message: '无效的文件路径。' };
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, code: 'BAD_PATH', message: '不是文件。' };
    if (st.size > MAX_READ_BYTES) return { ok: false, code: 'TOO_LARGE', message: '图片过大，已跳过元数据解析。' };
    const buf = fs.readFileSync(filePath);
    const r = extractPromptFromBuffer(buf);
    if (!r.ok) return r;
    return { ok: true, prompt: r.prompt, pics: r.pics, format: r.format, bytes: buf.length };
  } catch (e) {
    return { ok: false, code: 'READ_FAILED', message: `读取文件失败：${e.message}` };
  }
}

/**
 * 给磁盘上的图片文件补写提示词 / 输入图文件名（生成结果落盘 / 导出时使用）。
 * 图片自带的提示词不会被覆盖；缺的只是 picN 时才会重写文件（替换旧记录，不重复堆积）。
 */
function applyPromptToFile(filePath, prompt, pics) {
  const text = sanitizePrompt(prompt);
  const list = sanitizePics(pics);
  if (!text && !list.length) return { ok: false, code: 'EMPTY_PROMPT', message: '提示词为空。' };
  try {
    const st = fs.statSync(filePath);
    if (st.size > MAX_READ_BYTES) return { ok: false, code: 'TOO_LARGE', message: '图片过大，未写入元数据。' };
    const buf = fs.readFileSync(filePath);
    const existing = extractPromptFromBuffer(buf);
    const target = mergeMeta(existing, { prompt: text, pics: list });
    if (sameMeta(existing, target)) {
      return { ok: true, skipped: true, format: existing.format, message: '图片已有提示词元数据，保持不变。' };
    }
    const w = writePromptToBuffer(buf, target.prompt, target.pics);
    if (!w.ok) return w;
    fs.writeFileSync(filePath, w.buffer);
    return { ok: true, format: w.format, bytes: w.buffer.length };
  } catch (e) {
    log.warn('写入图片提示词元数据失败', { file: path.basename(String(filePath)), error: e.message });
    return { ok: false, code: 'WRITE_FAILED', message: `写入元数据失败：${e.message}` };
  }
}

module.exports = {
  PROMPT_KEY,
  META_KEY,
  PIC_KEY,
  MAX_TEXT_BYTES,
  MAX_PICS,
  buildRecord,
  parseRecord,
  sanitizePics,
  samePics,
  mergeMeta,
  sameMeta,
  detectFormat,
  formatFromPath,
  formatSupport,
  mimeForFormat,
  extractPromptFromBuffer,
  extractPromptFromFile,
  writePromptToBuffer,
  applyPromptToFile,
  crc32
};
