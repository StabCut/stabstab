/*
 * 发送与重发的公共逻辑。
 * 同一个对话不携带上下文：每次请求只包含当前这一条输入（上下文长度为 0）。
 */
import { uid, formatBytes } from './util.js';
import { compressIfNeeded, dataUrlBytes } from './images.js';

export function resolveModel(settings, modelId) {
  const models = settings.models || [];
  let m = models.find((x) => x.id === modelId);
  if (!m) m = models.find((x) => x.id === settings.defaultModelId);
  if (!m) m = models[0];
  return m || null;
}

/** 由参数面板状态构造 API parameters */
export function buildParams(p) {
  const out = {};
  if (p.size && p.size !== 'auto') out.size = p.size;
  if (p.n) out.n = Number(p.n);
  if (typeof p.negative_prompt === 'string' && p.negative_prompt.trim()) out.negative_prompt = p.negative_prompt.trim();
  out.watermark = !!p.watermark;
  out.prompt_extend = p.prompt_extend !== false;
  if (p.seed !== '' && p.seed !== null && p.seed !== undefined && Number.isFinite(Number(p.seed))) {
    out.seed = Number(p.seed);
  }
  return out;
}

/** 按设置压缩一组 dataUrl，返回压缩后的数组（并打日志） */
async function compressAll(items, settings, log) {
  const { compressEnabled, compressMaxMB } = settings;
  const out = [];
  for (const it of items) {
    try {
      const r = await compressIfNeeded(it.dataUrl, it.mime, { enabled: compressEnabled, maxMB: compressMaxMB });
      if (r.compressed) {
        log('info', `图片已压缩 ${formatBytes(r.originalBytes)} → ${formatBytes(r.finalBytes)}`, { name: it.name });
      }
      out.push({ ...it, dataUrl: r.dataUrl, mime: r.mime });
    } catch (e) {
      out.push(it);
    }
  }
  return out;
}

function makeAssistantPlaceholder({ parentId, protocol, model, mode }) {
  return {
    id: uid('m'),
    role: 'assistant',
    parentId,
    status: 'pending',           // pending -> running -> success/error/cancelled
    taskStatus: mode === 'async' ? 'PENDING' : null,
    images: [],
    texts: [],
    error: null,
    createdAt: Date.now(),
    meta: { protocol, model, mode }
  };
}

/**
 * 新建一条「用户消息 + 助手占位」并发起请求。
 * @param attachments 数组 [{file?, name, mime, width, height, dataUrl}]
 */
export async function sendNew({ dispatch, state, conv, text, attachments, params, modelId, log }) {
  const settings = state.settings;
  const model = resolveModel(settings, modelId);
  if (!model) throw new Error('没有可用的模型，请先在设置中添加。');

  const mode = settings.requestMode || 'sync';
  const compressed = await compressAll(attachments, settings, log);

  const userMsg = {
    id: uid('m'),
    role: 'user',
    text: text || '',
    images: compressed.map((a) => ({ file: a.file, name: a.name, mime: a.mime, width: a.width, height: a.height })),
    params,
    model: { id: model.id, name: model.name, protocol: model.protocol },
    createdAt: Date.now()
  };
  const asst = makeAssistantPlaceholder({ parentId: userMsg.id, protocol: model.protocol, model: model.name, mode });

  dispatch({ type: 'MSG_ADD', convId: conv.id, messages: [userMsg, asst] });
  if (mode === 'sync') dispatch({ type: 'BUSY_SET', convId: conv.id, jobId: asst.id, mode });

  await window.stab.generate({
    conversationId: conv.id,
    messageId: asst.id,
    protocol: model.protocol,
    model: model.name,
    mode,
    prompt: text || '',
    images: compressed.map((a) => a.dataUrl),
    params
  });
  return { userMsg, asst };
}

/**
 * 编辑后重发：更新用户消息、删除配对的旧助手回复，重新发起请求（原地覆盖）。
 * @param keptImages 数组 [{file, name, mime, width, height}]（无 dataUrl，需从磁盘读取）
 */
export async function resendEdited({ dispatch, state, conv, userMsg, newText, keptImages, params, modelId, log }) {
  const settings = state.settings;
  const modelRef = userMsg.model || {};
  const model = resolveModel(settings, modelId) || { name: modelRef.name, protocol: modelRef.protocol };
  const mode = settings.requestMode || 'sync';

  // 读取原图并压缩
  const attachments = [];
  for (const img of keptImages) {
    try {
      const r = await window.stab.readAttachment(img.file);
      if (r.ok) attachments.push({ ...img, dataUrl: r.dataUrl, mime: r.mime });
    } catch (e) { /* 缺失则跳过 */ }
  }
  const compressed = await compressAll(attachments, settings, log);

  const patch = {
    text: newText || '',
    images: compressed.map((a) => ({ file: a.file, name: a.name, mime: a.mime, width: a.width, height: a.height })),
    params,
    model: { id: model.id, name: model.name, protocol: model.protocol },
    editedAt: Date.now()
  };
  // 更新用户消息 + 删除配对助手回复
  dispatch({ type: 'MSG_EDIT_PREPARE', convId: conv.id, userMsgId: userMsg.id, patch });

  const asst = makeAssistantPlaceholder({ parentId: userMsg.id, protocol: model.protocol, model: model.name, mode });
  dispatch({ type: 'MSG_ADD', convId: conv.id, messages: [asst] });
  if (mode === 'sync') dispatch({ type: 'BUSY_SET', convId: conv.id, jobId: asst.id, mode });

  await window.stab.generate({
    conversationId: conv.id,
    messageId: asst.id,
    protocol: model.protocol,
    model: model.name,
    mode,
    prompt: newText || '',
    images: compressed.map((a) => a.dataUrl),
    params
  });
  return { asst };
}

export function dataUrlSize(dataUrl) {
  return dataUrlBytes(dataUrl);
}
