'use strict';
/*
 * 会话侧的「本次请求带了什么」查询
 * ==================================
 * 结果图落盘时会把「提示词 + 用户一起发送的输入图文件名（pic1…picN）」写进图片元数据；
 * 但旧版本生成的缓存图只有提示词、没有 picN，用户保存 / 另存为时要能补上。
 * 会话记录是唯一的兜底来源，于是把这段查询独立成模块（纯函数，便于直接测试）：
 *
 *   metaOfParent(conv, assistantMsg)  → 该助手回复对应的用户消息：{prompt, pics}
 *   metaFromConversations(cs, file)   → 某个结果图文件名对应的 {prompt, pics}
 *
 * pics 与用户发送的图片顺序一一对应：读不到真实文件名（剪贴板粘贴等）的位置是空串，
 * 但位置必须保留（pic 项要有）；没带图片的纯文生图返回空数组（不产生 pic 项）。
 */
const path = require('path');

/** 一条助手回复对应的用户请求信息：提示词 + 输入图文件名（按发送顺序，缺名字的位置是空串） */
function metaOfParent(conv, msg) {
  const parent = ((conv && conv.messages) || []).find((m) => m.id === msg.parentId);
  if (!parent) return { prompt: '', pics: [] };
  const images = Array.isArray(parent.images) ? parent.images : [];
  return {
    prompt: typeof parent.text === 'string' ? parent.text : '',
    pics: images.map((im) => (im && typeof im.srcName === 'string' ? im.srcName : ''))
  };
}

/** 兜底：从会话记录里找某个结果图文件名对应的 {prompt, pics}（找不到就是空值） */
function metaFromConversations(conversations, file) {
  const name = path.basename(String(file || ''));
  if (!name || !conversations || !Array.isArray(conversations.conversations)) return { prompt: '', pics: [] };
  for (const conv of conversations.conversations) {
    for (const msg of (conv.messages || [])) {
      if (msg.role !== 'assistant') continue;
      if (!(msg.images || []).some((im) => im && im.file === name)) continue;
      return metaOfParent(conv, msg);
    }
  }
  return { prompt: '', pics: [] };
}

module.exports = { metaOfParent, metaFromConversations };
