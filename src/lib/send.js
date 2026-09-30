/*
 * 发送与重发的公共逻辑。
 * 同一个对话不携带上下文：每次请求只包含当前这一条输入（上下文长度为 0）。
 *
 * 模型相关：渲染进程只把「模型 id」交给主进程，协议 / 来源 / 密钥 / 同步异步
 *          一律由主进程按当前设置解析（见 electron/src/modelSeries.js#resolveModel）。
 *          这里解析出来的信息只用于界面展示与消息记录（meta）。
 */
import { uid, formatBytes } from './util.js';
import { compressIfNeeded, dataUrlBytes } from './images.js';
import { resolveModel } from './models.js';
import { maybeAutoTitle } from './title.js';

/** 依参数面板的 schema 生成初始参数值（size 由尺寸下拉单独维护） */
export function defaultParams(schema) {
  const out = {};
  for (const [k, def] of Object.entries(schema || {})) {
    if (def.default !== undefined) out[k] = def.default;
    else out[k] = def.type === 'bool' ? false : '';
  }
  return out;
}

/**
 * 由参数面板状态构造 API parameters。
 * 只保留当前协议 schema 里声明过的字段，避免把 A 协议的参数发给 B 协议。
 */
export function buildParams(p, schema) {
  const src = p || {};
  const out = { size: src.size || 'auto' };
  for (const [k, def] of Object.entries(schema || {})) {
    const type = (def && def.type) || 'string';
    let v = src[k];
    if (v === undefined || v === null || v === '') v = def.default;
    if (type === 'bool') { out[k] = !!v; continue; }
    if (v === undefined || v === null || v === '') continue;   // 留空 = 不发送该字段
    if (type === 'int' || type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = Math.round(n);
    } else {
      out[k] = v;
    }
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

function makeAssistantPlaceholder({ parentId, resolved }) {
  return {
    id: uid('m'),
    role: 'assistant',
    parentId,
    status: 'pending',           // pending -> running -> success/error/cancelled
    taskStatus: resolved.mode === 'async' ? 'PENDING' : null,
    images: [],
    texts: [],
    error: null,
    createdAt: Date.now(),
    meta: {
      protocol: resolved.protocol,
      model: resolved.name,
      modelId: resolved.id,
      seriesId: resolved.seriesId,
      sourceId: resolved.sourceId,
      mode: resolved.mode
    }
  };
}

/** 消息里记录的模型引用（用于重发时定位模型 + 界面显示） */
function modelRef(resolved) {
  return {
    id: resolved.id,
    name: resolved.name,
    seriesId: resolved.seriesId,
    sourceId: resolved.sourceId,
    protocol: resolved.protocol
  };
}

function pickModel(settings, modelSeries, protocols, modelId) {
  const resolved = resolveModel(settings, modelSeries, protocols, modelId);
  if (!resolved) throw new Error('没有可用的模型，请先在「设置 → 模型设置」中添加模型系列与模型。');
  if (!resolved.hasKey) {
    throw new Error(`「${resolved.seriesLabel} · ${resolved.sourceLabel}」尚未配置 API Key，请先在设置中填写。`);
  }
  return resolved;
}

/**
 * 用户的输入图 → 写进结果图 picN 的文件名列表（与图片顺序一一对应）。
 * 读不到真实文件名（系统剪贴板粘贴等）的位置留空串，但**位置必须存在** ——
 * 于是「这次请求带了几张输入图」也被记录下来；纯文生图返回空数组（记录里不出现 pic 项）。
 */
function imageNamesOf(items) {
  return (items || []).map((a) => (a && typeof a.srcName === 'string' ? a.srcName : ''));
}

/**
 * 新建一条「用户消息 + 助手占位」并发起请求。
 * @param attachments 数组 [{file?, name, srcName?, mime, width, height, dataUrl}]
 */
export async function sendNew({ dispatch, state, conv, text, attachments, params, modelId, log }) {
  const settings = state.settings;
  const resolved = pickModel(settings, state.modelSeries, state.protocols, modelId);
  const mode = resolved.mode;
  const compressed = await compressAll(attachments, settings, log);

  const userMsg = {
    id: uid('m'),
    role: 'user',
    text: text || '',
    images: compressed.map((a) => ({ file: a.file, name: a.name, srcName: a.srcName || '', mime: a.mime, width: a.width, height: a.height })),
    params,
    model: modelRef(resolved),
    createdAt: Date.now()
  };
  const asst = makeAssistantPlaceholder({ parentId: userMsg.id, resolved });

  dispatch({ type: 'MSG_ADD', convId: conv.id, messages: [userMsg, asst] });
  if (mode === 'sync') dispatch({ type: 'BUSY_SET', convId: conv.id, jobId: asst.id, mode });

  // 会话标签自动命名：首条文字 → 重命名模型（未配置/失败则截取首条文字）。
  // 与图片生成并行，不阻塞请求；结果经 CONV_RENAME_AUTO 异步更新侧栏标签。
  maybeAutoTitle({ dispatch, state, conv, text, log }).catch(() => {});

  await window.stab.generate({
    conversationId: conv.id,
    messageId: asst.id,
    modelId: resolved.id,
    protocol: resolved.protocol,   // 仅用于日志/事件对齐
    model: resolved.name,
    prompt: text || '',
    images: compressed.map((a) => a.dataUrl),
    imageNames: imageNamesOf(compressed),   // → 结果图元数据的 pic1…picN
    params
  });
  return { userMsg, asst };
}

/**
 * 编辑后重发：更新用户消息、删除配对的旧助手回复，重新发起请求（原地覆盖）。
 * @param keptImages 数组 [{file, name, srcName?, mime, width, height}]（无 dataUrl，需从磁盘读取）
 */
export async function resendEdited({ dispatch, state, conv, userMsg, newText, keptImages, params, modelId, log }) {
  const settings = state.settings;
  const resolved = pickModel(settings, state.modelSeries, state.protocols, modelId || (userMsg.model && userMsg.model.id));
  const mode = resolved.mode;

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
    images: compressed.map((a) => ({ file: a.file, name: a.name, srcName: a.srcName || '', mime: a.mime, width: a.width, height: a.height })),
    params,
    model: modelRef(resolved),
    editedAt: Date.now()
  };
  // 更新用户消息 + 删除配对助手回复
  dispatch({ type: 'MSG_EDIT_PREPARE', convId: conv.id, userMsgId: userMsg.id, patch });

  const asst = makeAssistantPlaceholder({ parentId: userMsg.id, resolved });
  dispatch({ type: 'MSG_ADD', convId: conv.id, messages: [asst] });
  if (mode === 'sync') dispatch({ type: 'BUSY_SET', convId: conv.id, jobId: asst.id, mode });

  await window.stab.generate({
    conversationId: conv.id,
    messageId: asst.id,
    modelId: resolved.id,
    protocol: resolved.protocol,
    model: resolved.name,
    prompt: newText || '',
    images: compressed.map((a) => a.dataUrl),
    imageNames: imageNamesOf(compressed),   // 重发后的结果图同样带着输入图文件名
    params
  });
  return { asst };
}

export function dataUrlSize(dataUrl) {
  return dataUrlBytes(dataUrl);
}
