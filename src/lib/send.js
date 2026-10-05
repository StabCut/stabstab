/*
 * 发送与重发的公共逻辑。
 * 同一个对话不携带上下文：每次请求只包含当前这一条输入（上下文长度为 0）。
 *
 * 请求模式只有「同步」一种（见 AIDEV.md §4.12）：提交后阻塞等待返回。但**同一个对话里可以
 * 同时等好几个请求** —— 每次发送各占一个 jobId（= 助手消息 id），互不阻塞、互不影响。
 *
 * 重发不是「照原样再发一次」：模型 / 尺寸 / 参数取**输入区当前设置**（resolveResendTarget），
 * 用户在下方把模型换成 B、改了分辨率，编辑重发 / 气泡重发就用 B 与当前分辨率（见 AIDEV.md §4.7）。
 *
 * 模型相关：渲染进程只把「模型 id」交给主进程，协议 / 来源 / 密钥
 *          一律由主进程按当前设置解析（见 electron/src/modelSeries.js#resolveModel）。
 *          这里解析出来的信息只用于界面展示与消息记录（meta）。
 */
import { uid, formatBytes } from './util.js';
import { compressIfNeeded, dataUrlBytes } from './images.js';
import { resolveModel, normalizeSize, isValidSize } from './models.js';
import { maybeAutoTitle } from './title.js';
import { makeConversation } from './store.jsx';

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
    status: 'pending',           // pending -> success/error/cancelled
    taskStatus: null,            // 仅在协议内部任务兜底（Grsai 只回任务 id）时才有值
    images: [],
    texts: [],
    error: null,
    createdAt: Date.now(),
    meta: {
      protocol: resolved.protocol,
      model: resolved.name,
      modelId: resolved.id,
      seriesId: resolved.seriesId,
      sourceId: resolved.sourceId
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
  // 只登记这一个请求（jobId = 助手消息 id）：同对话里其它还在等待的请求各自有一项，互不影响
  dispatch({ type: 'BUSY_SET', convId: conv.id, jobId: asst.id });

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
 * 「编辑并重新发送」用哪套设置 —— 一句话：**输入区（Composer）当前的模型、尺寸与参数**，
 * 而不是这条消息当时用的那一套（模型换成 B、分辨率改过，重发就按 B 和当前分辨率发）。
 * 编辑气泡里单独选过尺寸时，只覆盖这一次重发的 size，其余仍取输入区当前值。
 *
 * @param selection       输入区当前设置 {modelId, params}（见 lib/composerSelection.js）
 * @param fallbackModelId 输入区没有模型时的兜底（该消息记录里的模型 id）
 * @param fallbackParams  输入区一个设置都没有时的兜底（该消息记录里的参数）
 * @param sizeOverride    编辑气泡里的尺寸覆盖（null / 空 = 跟随输入区当前尺寸；
 *                        可以是候选值，也可以是用户自己填的像素尺寸，见 components/SizePicker.jsx）
 * @returns {{modelId:string, model:object|null, schema:object, sizeOptions:string[], size:string, params:object}}
 *          model = resolveModel 结果（可能为 null）；params = 本次真正要发的参数
 */
export function resolveResendTarget({ settings, modelSeries, protocols, selection, fallbackModelId, fallbackParams, sizeOverride }) {
  const sel = selection || {};
  const selParams = sel.params || {};
  const modelId = sel.modelId || fallbackModelId || '';
  // 输入区还没写出任何设置（Composer 尚未挂载 / 尚未发布）→ 退回这条消息当时那套，行为与旧版一致
  const base = sel.modelId ? selParams : ((fallbackParams && Object.keys(fallbackParams).length) ? fallbackParams : selParams);
  const model = resolveModel(settings, modelSeries, protocols, modelId);
  const schema = (model && model.paramSchema) || {};
  const sizeOptions = (model && model.sizeOptions) || ['auto'];
  // 候选值或自定义像素尺寸都算有效；都没有就退回第一个候选（分隔符按当前协议统一）
  const ok = (v) => !!v && isValidSize(model, v, sizeOptions);
  const requested = ok(sizeOverride) ? sizeOverride : (ok(base.size) ? base.size : (sizeOptions[0] || 'auto'));
  const size = normalizeSize(model, requested);
  return { modelId, model, schema, sizeOptions, size, params: buildParams({ ...base, size }, schema) };
}

/**
 * 把一条消息记录的输入图读回 dataUrl（文件已被清理 / 不存在 → 跳过该张）。
 * @param images 消息里的 images 数组（[{file,name,srcName,mime,width,height}]，没有 dataUrl）
 */
async function attachmentsOfMessage(images) {
  const out = [];
  for (const img of (images || [])) {
    if (!img || !img.file) continue;
    try {
      const r = await window.stab.readAttachment(img.file);
      if (r && r.ok) out.push({ ...img, dataUrl: r.dataUrl, mime: r.mime || img.mime });
    } catch (e) { /* 缺失则跳过 */ }
  }
  return out;
}

/**
 * 编辑后重发：更新用户消息、删除配对的旧助手回复，重新发起请求（原地覆盖）。
 * 模型与参数由调用方（编辑气泡）按**输入区当前设置**给出，见 resolveResendTarget。
 * 旧回复若还在等待中，一并中止（它马上要被删掉，没必要继续占着远端请求与本地等待）。
 * @param keptImages 数组 [{file, name, srcName?, mime, width, height}]（无 dataUrl，需从磁盘读取）
 */
export async function resendEdited({ dispatch, state, conv, userMsg, newText, keptImages, params, modelId, log }) {
  const settings = state.settings;
  const resolved = pickModel(settings, state.modelSeries, state.protocols, modelId || (userMsg.model && userMsg.model.id));

  // 先停掉这条消息名下还在等待的旧请求（通常是「上一个请求还没回来就点了编辑重发」）
  const stale = (conv.messages || []).filter(
    (m) => m.role === 'assistant' && m.parentId === userMsg.id && (m.status === 'pending' || m.status === 'running')
  );
  for (const m of stale) {
    try { await window.stab.cancelJob(m.id); } catch (e) { /* 已经结束 / 不存在：忽略 */ }
  }

  // 读取原图并压缩
  const compressed = await compressAll(await attachmentsOfMessage(keptImages), settings, log);

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
  dispatch({ type: 'BUSY_SET', convId: conv.id, jobId: asst.id });

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
  return { asst, resolved };
}

/**
 * 气泡重发（用户气泡上的「当前对话发送」/「新对话发送」两个按钮的公共实现）：
 * 把这条消息的**文字 + 全部输入图**按给定的模型 / 参数再发一遍 —— 等于把同样的内容
 * 重新输入一次并点发送，与「重新开一个对话来请求并等待结果」没有差别。
 *
 * 与编辑重发的区别：**不改动原消息、也不删原回复**，只是新增一条用户消息 + 它自己的助手结果，
 * 所以同一个对话里可以同时等 2 个以上互不干扰的结果（见 AIDEV.md §4.12）。
 *
 * @param msg        被重发的用户消息（只用它的 text / images）
 * @param params     本次要发的参数（由调用方按输入区当前设置算好，见 resolveResendTarget）
 * @param modelId    本次要发的模型 id
 * @returns {Promise<{userMsg, asst}>}
 */
export async function sendBubbleAgain({ dispatch, state, conv, msg, params, modelId, log }) {
  const text = msg && msg.text ? msg.text : '';
  const attachments = await attachmentsOfMessage(msg && msg.images);
  if (!text.trim() && !attachments.length) {
    throw new Error('这条消息的内容已经不可用（图片文件可能已被清理），无法重发。');
  }
  return sendNew({ dispatch, state, conv, text, attachments, params, modelId, log });
}

/**
 * 「新对话发送」：先建一个新对话，再把气泡内容发进去。
 * 新对话会立刻成为当前标签（与点「新建对话」一致），于是能直接看到它在等结果。
 * @returns {Promise<{conv:object, userMsg:object, asst:object}>} conv = 新建的会话
 */
export async function sendBubbleToNewConversation({ dispatch, state, msg, params, modelId, log }) {
  const { conv, counter } = makeConversation(state.conversations.tabCounter);
  dispatch({ type: 'CONV_ADD', conv, counter });
  const r = await sendBubbleAgain({ dispatch, state, conv, msg, params, modelId, log });
  return { conv, ...r };
}

export function dataUrlSize(dataUrl) {
  return dataUrlBytes(dataUrl);
}
