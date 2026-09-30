'use strict';
/*
 * 结果图导出：把生成结果写进用户保存目录。
 * ==========================================
 * 三条硬性要求：
 *   1) 用户最终保存 / 导出的图片文件必须带着生成提示词元数据（不能只存在软件内部）；
 *   2) 若本次请求还带过输入图（图生图 / 图像编辑），元数据里必须带上 pic1…picN
 *      （输入图的文件名，读不到名字就是空串，但 pic 项要有）—— 源图是旧版本生成的、
 *      只有提示词没有 picN 时，在保存 / 另存为这一步用会话记录里的名字补齐；
 *   3) 元数据写入失败 / 格式不支持时，图片本身必须完好保存 —— 绝不因为元数据丢图。
 *
 * 与 electron/main.js 的 `result:download` 是同一实现（测试脚本直接调用这里，
 * 避免「测试测的是另一份逻辑」）。
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const promptMeta = require('./promptmeta');

/**
 * 图片字节 + 提示词 / 输入图文件名 → 带元数据的字节（插入元数据分块，不重新编码像素）。
 * 图片自带的提示词不会被覆盖；缺的只是 picN 时才补写（写的是替换，不会重复堆积分块）。
 * 失败 / 不支持的格式 / 已经一致 → 返回原字节。
 */
function applyPromptToBuffer(buf, prompt, pics) {
  const fmt = promptMeta.detectFormat(buf);
  if (!fmt || !promptMeta.formatSupport(fmt)) {
    log.warn('该图片格式暂不支持写入提示词元数据', { format: fmt || 'unknown' });
    return buf;
  }
  const exists = promptMeta.extractPromptFromBuffer(buf);
  if (!exists.ok) {
    log.warn('图片元数据无法解析，保持原样', { code: exists.code });
    return buf;
  }
  const target = promptMeta.mergeMeta(exists, { prompt, pics });
  if (!target.prompt && !target.pics.length) return buf;              // 没有任何可写内容
  if (promptMeta.sameMeta(exists, target)) return buf;               // 已有元数据：保持原样，不覆盖
  const w = promptMeta.writePromptToBuffer(buf, target.prompt, target.pics);
  if (!w.ok) {
    log.warn('写入提示词元数据失败（保留原图）', { code: w.code, message: w.message });
    return buf;
  }
  return w.buffer;
}

/** 文件系统是否大小写不敏感（Windows / macOS 默认不敏感，判断重名时要按同一口径折叠） */
function foldCase() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/**
 * 目标路径：同名文件已存在时，按「主干-i」从 1 开始逐个试，直到不重复。
 * 例：xxx.jpg 已存在 -> xxx-1.jpg -> xxx-2.jpg ...（xxx-4 也存在就是 xxx-5.jpg）。
 * 扩展名保持调用方给的那一个（写的是原图字节，格式不能改）。
 * 目录不存在时按「没有重名」处理（调用方随后会创建目录）。
 */
function uniqueTarget(destDir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  const fold = foldCase();
  const key = (n) => (fold ? n.toLowerCase() : n);
  let taken = new Set();
  try { taken = new Set(fs.readdirSync(destDir).map(key)); } catch (e) { /* 目录还不存在 */ }
  if (!taken.has(key(stem + ext))) return path.join(destDir, stem + ext);
  for (let i = 1; i <= 9999; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(key(candidate))) return path.join(destDir, candidate);
  }
  return path.join(destDir, `${stem}-${Date.now()}${ext}`);
}

/**
 * 把一张结果图导出到目标目录。
 * @param {{srcPath:string, destDir:string, fallbackPrompt?:string, fallbackPics?:string[], fileName?:string}} opts
 *   fallbackPrompt / fallbackPics：源图元数据缺失（旧缓存）时使用的提示词与输入图文件名
 *   （主进程从会话记录里取，见 main.js#metaFromConversations）；已有值优先级更高，不会被兜底值覆盖。
 *   fileName：保存用的文件名（调用方按「提示词前 N 个字」等规则算好）；缺省用源图文件名
 * @returns {{ok:true,path:string,promptApplied:boolean}} | {{ok:false,message:string}}
 */
function exportResultImage({ srcPath, destDir, fallbackPrompt, fallbackPics, fileName }) {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) {
      return { ok: false, message: '缓存图片不存在（缓存可能已被清理）。' };
    }
    fs.mkdirSync(destDir, { recursive: true });
    const outName = fileName || path.basename(srcPath);
    const srcBuf = fs.readFileSync(srcPath);
    // 提示词 / 输入图文件名：图片自带优先；旧缓存图缺失的项用会话记录补写
    const out = applyPromptToBuffer(srcBuf, fallbackPrompt, fallbackPics);
    const dest = uniqueTarget(destDir, outName);
    fs.writeFileSync(dest, out);
    const applied = out !== srcBuf;
    log.info('结果图片已保存', { dest, bytes: out.length, promptMeta: applied });
    return { ok: true, path: dest, promptApplied: applied };
  } catch (e) {
    log.error('保存结果图片失败', { error: e && e.message });
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

/**
 * 把一张图片按用户选定的路径与文件名另存（右键菜单的「另存为」）。
 * 与 exportResultImage 的差别只有一处：目标目录 / 文件名来自系统保存对话框，
 * 覆盖确认已由对话框完成，因此不再做同名去重；元数据透传 / 补写 picN / 失败不丢图的规则完全一致。
 * @param {{srcPath:string, destPath:string, fallbackPrompt?:string, fallbackPics?:string[]}} opts
 * @returns {{ok:true,path:string,promptApplied:boolean,bytes:number}} | {{ok:false,message:string}}
 */
function exportResultImageAs({ srcPath, destPath, fallbackPrompt, fallbackPics }) {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) {
      return { ok: false, message: '图片文件不存在（可能已被清理）。' };
    }
    if (!destPath) return { ok: false, message: '未选择保存位置。' };
    const srcBuf = fs.readFileSync(srcPath);
    // 提示词 / 输入图文件名：图片自带优先；旧缓存图缺失的项用会话记录补写
    const out = applyPromptToBuffer(srcBuf, fallbackPrompt, fallbackPics);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, out);
    log.info('图片已另存为', { dest: destPath, bytes: out.length, promptMeta: out !== srcBuf });
    return { ok: true, path: destPath, promptApplied: out !== srcBuf, bytes: out.length };
  } catch (e) {
    log.error('另存图片失败', { error: e && e.message });
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

module.exports = { exportResultImage, exportResultImageAs, applyPromptToBuffer, uniqueTarget };
