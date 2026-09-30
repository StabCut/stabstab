'use strict';
/*
 * 复制图片到系统剪贴板时的载荷构造（纯函数，便于直接测试）
 * ==========================================================
 * 一次写入三个格式，尽量把「图片 + 提示词 + 输入图文件名」都带走：
 *   1) image：位图（任何程序都能粘贴）—— 位图格式**没有任何元数据**，这是系统剪贴板的限制；
 *   2) html ：内嵌**原图字节**的 data URI（不是重新编码的位图），元数据才能跟着走；
 *              同时把可读信息放进属性：data-filename / data-prompt / data-pics；
 *   3) text ：文件名 + 提示词（粘到纯文本框时也能拿到）。
 *
 * 调用方（electron/main.js#copyImageToClipboard）负责把图片字节补上缺失的 pic 项再传进来
 * —— 于是旧图复制出来也带着输入图文件名（缓存文件本身不改，只改剪贴板里那一份）。
 */

// 复制时把原图字节嵌进 HTML 的大小上限：超过就不带 HTML（避免剪贴板里塞过大的 base64），位图照常复制
const COPY_HTML_MAX_BYTES = 12 * 1024 * 1024;

/** HTML 属性转义（文件名 / 提示词里可能有引号、尖括号、换行） */
function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;');
}

/** 纯文本格式：文件名 + 提示词（两者都为空则给空串） */
function buildText({ name, prompt }) {
  return [name, prompt].filter((s) => s && String(s).trim()).join('\n');
}

/**
 * HTML 格式：内嵌原图字节 + 附属信息属性。
 * data-pics 只在「本次图片带过输入图」时出现（与元数据记录里 pic 项的规则一致）：
 * 值为 JSON 数组字符串，读不到名字的位置是空串，例如 data-pics='["参考图.png",""]'。
 * 字节超过上限时返回空串（调用方就不带 HTML，位图照常复制）。
 * @returns {{html:string, pics:string[]}}
 */
function buildHtml({ mime, buf, name, prompt, pics }) {
  const list = Array.isArray(pics) ? pics : [];
  if (!buf || !buf.length || buf.length > COPY_HTML_MAX_BYTES) return { html: '', pics: list };
  let html = '<meta charset="utf-8"><img src="data:' + (mime || 'image/png') + ';base64,' + buf.toString('base64') +
    '" alt="' + escapeAttr(name) + '" data-filename="' + escapeAttr(name) +
    '" data-prompt="' + escapeAttr(prompt) + '"';
  if (list.length) html += ' data-pics="' + escapeAttr(JSON.stringify(list)) + '"';
  return { html: html + '>', pics: list };
}

module.exports = { COPY_HTML_MAX_BYTES, escapeAttr, buildText, buildHtml };
