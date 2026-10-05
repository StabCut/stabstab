'use strict';
/*
 * 最小 ZIP 打包 / 解包（**零第三方依赖**，只用 Node 自带的 zlib）
 * ============================================================
 * 为什么自己写：主进程是纯 CommonJS、随包进 asar，本项目的生产依赖一直是空的
 * （见 AIDEV.md §8.1）；为一次「配置+聊天记录导出导入」引入运行时依赖不值得。
 *
 * 写（writeZip）：
 *   · 文本（json / manifest）走 DEFLATE（zlib.deflateRawSync），压不动就退回 STORE；
 *   · 图片（png/jpg…）本来就是压缩格式，走 STORE 直接落盘 —— 只读一次源文件算 CRC32，
 *     再流式拷进包，全程不把整张图读进内存（导出几个 G 也不会爆内存）。
 *   · 文件名统一 UTF-8（置通用位标记 bit 11），路径分隔符统一 `/`，不写目录条目
 *     （解包端按 `/` 建目录即可，Windows 资源管理器 / 7-Zip / .NET 都能正常打开）。
 *   · 单条目 / 中央目录 / 起始偏移超过 4G 或条目数超过 65535 时自动切 ZIP64
 *     （写 ZIP64 扩展字段 + ZIP64 结尾记录），失败写 `.tmp` 由调用方收拾。
 *
 * 读（listZip / extractEntry / extractAll / readEntry）：
 *   · 从文件尾部找 EOCD（允许注释），必要时经 ZIP64 定位器读 ZIP64 结尾记录；
 *   · 中央目录在内存里解析（正常只有几 KB），条目数据分流式解压 / 落盘，边写边算 CRC32，
 *     结束后校验 CRC 与长度 —— 包被改坏 / 传坏时明确报错，不产生「看起来导入成功」的脏数据；
 *   · 只支持 STORE(0) 与 DEFLATE(8)；加密条目明确拒绝。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 一次校验失败都抛这个类型，调用方按 code 分辨「不是 zip / 加密 / 校验失败」 */
class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

/** 增量 CRC32（seed 用 0xffffffff 起步，最后再 ^ 0xffffffff） */
function crc32Update(crc, buf) {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function crc32(buf) {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

/** 流式算一个文件的 CRC32（不把文件读进内存） */
async function crc32OfFile(file, highWaterMark = 1 << 22) {
  let crc = 0xffffffff;
  const rs = fs.createReadStream(file, { highWaterMark });
  for await (const chunk of rs) crc = crc32Update(crc, chunk);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- 小工具 ----------
/** ZIP 里的路径：统一 `/`，禁止绝对路径 / 盘符 / `..` / 反斜杠 / 控制字符 */
function normalizeEntryName(name) {
  const raw = String(name === undefined || name === null ? '' : name);
  if (!raw || /[\u0000-\u001f]/.test(raw)) throw new ZipError('BAD_NAME', `非法的压缩包条目名：${JSON.stringify(raw)}`);
  const s = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) throw new ZipError('BAD_NAME', `压缩包条目名不允许绝对路径：${raw}`);
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length) throw new ZipError('BAD_NAME', `压缩包条目名为空：${raw}`);
  if (parts.some((p) => p === '..')) throw new ZipError('BAD_NAME', `压缩包条目名不允许向上跳目录：${raw}`);
  return parts.join('/');
}

/** 等可写流排空（`drain` / `error` 两个监听器成对摘除） */
function waitDrain(ws) {
  return new Promise((resolve, reject) => {
    const onDrain = () => { ws.removeListener('error', onError); resolve(); };
    const onError = (err) => { ws.removeListener('drain', onDrain); reject(err); };
    ws.once('drain', onDrain);
    ws.once('error', onError);
  });
}

/** MS-DOS 时间 / 日期（ZIP 头里用的 2 字节格式，2 秒精度） */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date: day };
}

function findExtra(buf, id) {
  let p = 0;
  while (p + 4 <= buf.length) {
    const tag = buf.readUInt16LE(p);
    const len = buf.readUInt16LE(p + 2);
    if (p + 4 + len > buf.length) return null;
    if (tag === id) return buf.subarray(p + 4, p + 4 + len);
    p += 4 + len;
  }
  return null;
}

/** ZIP64 扩展字段：只写「固定字段里放不下」的那几项，顺序 size → compSize → localOffset */
function zip64Extra(parts) {
  const n = parts.length;
  const buf = Buffer.alloc(4 + n * 8);
  buf.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  buf.writeUInt16LE(n * 8, 2);
  parts.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return buf;
}

// ---------- 写 ----------

/**
 * 写一个 ZIP 文件（先写 `<dest>.tmp` 再改名，中途失败不留半截包）。
 * @param {string}   destPath       目标 .zip 路径
 * @param {Array<{name:string, file?:string, data?:Buffer|string}>} entries
 *        给 `file` = 直接把磁盘文件装进包（STORE，流式）；给 `data` = 内存内容（DEFLATE）
 * @param {object}   [opts]
 * @param {Date}     [opts.now]         包内时间戳（默认当前时间）
 * @param {boolean}  [opts.forceZip64]  强制 ZIP64（回归脚本用来验证 ZIP64 分支）
 * @returns {Promise<{path:string, entries:number, bytes:number}>}
 */
async function writeZip(destPath, entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const now = opts.now instanceof Date ? opts.now : new Date();
  const { time: dosTime, date: dosDate } = dosDateTime(now);
  const forceZip64 = !!opts.forceZip64;
  const tmp = `${destPath}.${process.pid}.tmp`;
  const out = fs.createWriteStream(tmp);
  const central = [];
  let offset = 0;

  /** 流式写一块，回调告诉你这块是否已经落盘（顺带处理背压） */
  const put = (buf) => new Promise((resolve, reject) => {
    offset += buf.length;
    out.write(buf, (err) => (err ? reject(err) : resolve()));
  });

  try {
    for (const e of list) {
      const name = normalizeEntryName(e && e.name);
      const nameBuf = Buffer.from(name, 'utf8');
      const entryOffset = offset;      // 本地头起始偏移（必须在写之前取，写完之后 offset 已经跑到条目末尾）
      let method;
      let crc;
      let compSize;
      let size;
      let buffered = null;      // Buffer（DEFLATE / STORE 内存块）
      let sourceFile = null;    // 磁盘文件（STORE 流式）

      if (e && e.file) {
        const st = await fsp.stat(e.file);
        if (!st.isFile()) throw new ZipError('BAD_SOURCE', `不是文件：${e.file}`);
        size = st.size;
        crc = await crc32OfFile(e.file);
        method = METHOD_STORE;   // 图片等已压缩内容不再二次压缩
        compSize = size;
        sourceFile = e.file;
      } else if (e && e.data !== undefined) {
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
        size = raw.length;
        crc = crc32(raw);
        const deflated = raw.length ? zlib.deflateRawSync(raw, { level: 6 }) : Buffer.alloc(0);
        if (deflated.length < raw.length) {
          method = METHOD_DEFLATE;
          compSize = deflated.length;
          buffered = deflated;
        } else {
          method = METHOD_STORE;
          compSize = size;
          buffered = raw;
        }
      } else {
        throw new ZipError('BAD_SOURCE', `条目 ${name} 既没有 file 也没有 data`);
      }

      const needZip64 = forceZip64 || size >= U32_MAX || compSize >= U32_MAX || entryOffset >= U32_MAX;
      const extra = needZip64 ? zip64Extra([size, compSize]) : Buffer.alloc(0);

      const head = Buffer.alloc(30);
      head.writeUInt32LE(SIG_LOCAL, 0);
      head.writeUInt16LE(needZip64 ? 45 : 20, 4);          // version needed
      head.writeUInt16LE(0x0800, 6);                       // bit 11 = 文件名是 UTF-8
      head.writeUInt16LE(method, 8);
      head.writeUInt16LE(dosTime, 10);
      head.writeUInt16LE(dosDate, 12);
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(needZip64 ? U32_MAX : compSize, 18);
      head.writeUInt32LE(needZip64 ? U32_MAX : size, 22);
      head.writeUInt16LE(nameBuf.length, 26);
      head.writeUInt16LE(extra.length, 28);
      await put(head);
      await put(nameBuf);
      if (extra.length) await put(extra);

      if (buffered) {
        if (buffered.length) await put(buffered);
      } else {
        const rs = fs.createReadStream(sourceFile, { highWaterMark: 1 << 22 });
        for await (const chunk of rs) await put(chunk);
      }

      central.push({ name, nameBuf, method, crc, compSize, size, offset: entryOffset, needZip64, dosTime, dosDate });
    }

    // ---- 中央目录 ----
    const cdStart = offset;
    for (const c of central) {
      const extra = c.needZip64 ? zip64Extra([c.size, c.compSize, c.offset]) : Buffer.alloc(0);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(0x0014, 4);                          // version made by（MS-DOS / FAT）
      h.writeUInt16LE(c.needZip64 ? 45 : 20, 6);           // version needed
      h.writeUInt16LE(0x0800, 8);                          // UTF-8 名
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.dosTime, 12);
      h.writeUInt16LE(c.dosDate, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.needZip64 ? U32_MAX : c.compSize, 20);
      h.writeUInt32LE(c.needZip64 ? U32_MAX : c.size, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32);                              // comment len
      h.writeUInt16LE(0, 34);                              // disk start
      h.writeUInt16LE(0, 36);                              // internal attrs
      h.writeUInt32LE(0, 38);                              // external attrs
      h.writeUInt32LE(c.needZip64 ? U32_MAX : c.offset, 42);
      await put(h);
      await put(c.nameBuf);
      if (extra.length) await put(extra);
    }
    const cdSize = offset - cdStart;

    // ---- 结尾记录（必要时 ZIP64）----
    const needEocd64 = central.length > U16_MAX || cdSize >= U32_MAX || cdStart >= U32_MAX;
    if (needEocd64) {
      const e64 = Buffer.alloc(56);
      e64.writeUInt32LE(SIG_EOCD64, 0);
      e64.writeBigUInt64LE(BigInt(44), 4);                 // 本记录后续字节数
      e64.writeUInt16LE(0x0014, 12);
      e64.writeUInt16LE(45, 14);
      e64.writeUInt32LE(0, 16);                            // 本磁盘号
      e64.writeUInt32LE(0, 20);                            // 中央目录起始磁盘号
      e64.writeBigUInt64LE(BigInt(central.length), 24);
      e64.writeBigUInt64LE(BigInt(central.length), 32);
      e64.writeBigUInt64LE(BigInt(cdSize), 40);
      e64.writeBigUInt64LE(BigInt(cdStart), 48);
      const eocd64Offset = offset;
      await put(e64);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_LOCATOR64, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(eocd64Offset), 8);
      loc.writeUInt32LE(1, 16);
      await put(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(needEocd64 ? U16_MAX : central.length, 8);
    eocd.writeUInt16LE(needEocd64 ? U16_MAX : central.length, 10);
    eocd.writeUInt32LE(needEocd64 ? U32_MAX : cdSize, 12);
    eocd.writeUInt32LE(needEocd64 ? U32_MAX : cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await put(eocd);

    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  await fsp.rename(tmp, destPath);
  const st = await fsp.stat(destPath);
  return { path: destPath, entries: central.length, bytes: st.size };
}

// ---------- 读 ----------

/**
 * 列出压缩包里的条目（只读中央目录，不解压）。
 * @returns {Promise<Array<{name:string, rel:string|null, method:number, flags:number, crc:number,
 *          compSize:number, size:number, localOffset:number}>>}
 *          name = 包里的原始名（Windows 工具可能用反斜杠）；rel = 归一后的相对路径（不合规为 null）
 */
async function listZip(zipPath) {
  const st = await fsp.stat(zipPath);
  const total = st.size;
  if (total < 22) throw new ZipError('BAD_ZIP', '不是有效的 ZIP 文件（文件太小）');

  const tailLen = Math.min(total, 22 + 0xffff + 64);
  const fh = await fsp.open(zipPath, 'r');
  try {
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, total - tailLen);

    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
      const commentLen = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= tail.length) { eocdPos = i; break; }
    }
    if (eocdPos < 0) throw new ZipError('BAD_ZIP', '不是有效的 ZIP 文件（找不到中央目录结尾记录）');

    let count = tail.readUInt16LE(eocdPos + 10);
    let cdSize = tail.readUInt32LE(eocdPos + 12);
    let cdOffset = tail.readUInt32LE(eocdPos + 16);

    if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      const locPos = eocdPos - 20;
      if (locPos < 0 || tail.readUInt32LE(locPos) !== SIG_LOCATOR64) {
        throw new ZipError('BAD_ZIP', 'ZIP64 结尾定位器缺失，压缩包结构损坏');
      }
      const eocd64Offset = Number(tail.readBigUInt64LE(locPos + 8));
      const head = Buffer.alloc(56);
      await fh.read(head, 0, 56, eocd64Offset);
      if (head.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('BAD_ZIP', 'ZIP64 结尾记录损坏');
      count = Number(head.readBigUInt64LE(32));
      cdSize = Number(head.readBigUInt64LE(40));
      cdOffset = Number(head.readBigUInt64LE(48));
    }

    if (cdSize < 0 || cdOffset < 0 || cdOffset + cdSize > total) {
      throw new ZipError('BAD_ZIP', '中央目录位置越界，压缩包结构损坏');
    }
    const cd = Buffer.alloc(cdSize);
    if (cdSize) await fh.read(cd, 0, cdSize, cdOffset);

    const out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new ZipError('BAD_ZIP', '中央目录条目损坏');
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) {
        throw new ZipError('BAD_ZIP', '中央目录条目长度越界');
      }
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

      if (compSize === U32_MAX || size === U32_MAX || localOffset === U32_MAX) {
        const z = findExtra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), ZIP64_EXTRA_ID);
        if (!z) throw new ZipError('BAD_ZIP', `条目 ${name} 缺少 ZIP64 扩展字段`);
        let q = 0;
        const take = () => {
          if (q + 8 > z.length) throw new ZipError('BAD_ZIP', `条目 ${name} 的 ZIP64 扩展字段不完整`);
          const v = Number(z.readBigUInt64LE(q));
          q += 8;
          return v;
        };
        if (size === U32_MAX) size = take();
        if (compSize === U32_MAX) compSize = take();
        if (localOffset === U32_MAX) localOffset = take();
      }

      out.push({ name, rel: normalizeRel(name), method, flags, crc, compSize, size, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** 压缩包里的条目名 → 规范相对路径（防目录穿越）。
 *  · 目录条目（以 `/` 结尾）→ { rel, isDir: true }
 *  · 名字不合规（绝对路径 / 盘符 / `..` / 空）→ null
 *  注意：Windows 的「压缩到 zip」/ PowerShell Compress-Archive 会写反斜杠，这里一并归一。 */
function safeRelativePath(name) {
  let s = String(name || '').replace(/\\/g, '/');
  const isDir = s.endsWith('/');
  if (isDir) s = s.slice(0, -1);
  if (!s) return null;
  try {
    return { rel: normalizeEntryName(s), isDir };
  } catch (e) {
    return null;
  }
}

/** 只取规范化路径（不合规返回 null），listZip 用 */
function normalizeRel(name) {
  const r = safeRelativePath(name);
  return r ? r.rel : null;
}

/**
 * 解出单个条目到 destPath（流式，边写边校验 CRC32 与长度）。
 * @returns {Promise<{name:string, bytes:number, path:string}>}
 */
async function extractEntry(zipPath, entry, destPath) {
  if (entry.flags & 0x0001) throw new ZipError('ENCRYPTED', `条目 ${entry.name} 已加密，无法解压`);
  if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
    throw new ZipError('UNSUPPORTED_METHOD', `条目 ${entry.name} 使用了不支持的压缩方式（method=${entry.method}）`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (!entry.compSize) {
    // 空文件：直接建，不用走流
    await fsp.writeFile(destPath, Buffer.alloc(0));
    const emptyCrc = crc32(Buffer.alloc(0));
    if (entry.crc !== emptyCrc || entry.size !== 0) {
      throw new ZipError('CRC_MISMATCH', `条目 ${entry.name} 校验失败（内容与记录不一致）`);
    }
    return { name: entry.name, bytes: 0, path: destPath };
  }

  const fh = await fsp.open(zipPath, 'r');
  let ws = null;
  try {
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, entry.localOffset);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('BAD_ZIP', `条目 ${entry.name} 的本地头损坏`);
    const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);

    const input = fh.createReadStream({ start: dataStart, end: dataStart + entry.compSize - 1 });
    const src = entry.method === METHOD_STORE ? input : input.pipe(zlib.createInflateRaw());
    ws = fs.createWriteStream(destPath);

    let crc = 0xffffffff;
    let written = 0;
    for await (const chunk of src) {
      crc = crc32Update(crc, chunk);
      written += chunk.length;
      // 背压：写完再读下一块（监听器成对摘除，避免长包累积 MaxListeners 警告）
      if (!ws.write(chunk)) await waitDrain(ws);
    }
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    ws = null;

    const got = (crc ^ 0xffffffff) >>> 0;
    if (written !== entry.size || got !== entry.crc) {
      throw new ZipError('CRC_MISMATCH', `条目 ${entry.name} 校验失败（大小或 CRC32 与记录不一致，压缩包可能已损坏）`);
    }
    return { name: entry.name, bytes: written, path: destPath };
  } catch (err) {
    if (ws) ws.destroy();
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fh.close();
  }
}

/**
 * 整个包解压到 destDir（目录按需创建）。目录条目只建目录。
 * 条目名不合规（绝对路径 / `..`）直接抛错 —— 宁可报错也不把文件写到数据目录之外。
 * @returns {Promise<{files:string[], dirs:number, bytes:number}>}
 */
async function extractAll(zipPath, destDir) {
  const entries = await listZip(zipPath);
  const files = [];
  let dirs = 0;
  let bytes = 0;
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    const safe = safeRelativePath(e.name);
    if (!safe) throw new ZipError('BAD_NAME', `压缩包里的条目名不合法：${e.name}`);
    const target = path.join(destDir, ...safe.rel.split('/'));
    if (safe.isDir) {
      fs.mkdirSync(target, { recursive: true });
      dirs++;
      continue;
    }
    const r = await extractEntry(zipPath, e, target);
    files.push(safe.rel);
    bytes += r.bytes;
  }
  return { files, dirs, bytes };
}

/** 读单个条目的内容（小文件用，例如 manifest.json / 回归脚本） */
async function readEntry(zipPath, name) {
  const entries = await listZip(zipPath);
  const want = normalizeEntryName(name);
  const hit = entries.find((e) => e.rel === want || e.name === name);
  if (!hit) throw new ZipError('NOT_FOUND', `压缩包里没有条目：${name}`);
  const tmp = path.join(require('os').tmpdir(), `stabstab-zip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await extractEntry(zipPath, hit, tmp);
    return await fsp.readFile(tmp);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/** 读单个条目的文本内容（UTF-8） */
async function readEntryText(zipPath, name) {
  return (await readEntry(zipPath, name)).toString('utf8');
}

module.exports = {
  ZipError,
  crc32,
  crc32OfFile,
  writeZip,
  listZip,
  extractEntry,
  extractAll,
  readEntry,
  readEntryText,
  normalizeEntryName,
  METHOD_STORE,
  METHOD_DEFLATE
};
