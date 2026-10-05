/*
 * 会话标签自动命名（渲染进程侧）
 * =================================
 * 规则（与 electron/src/renameModel.js 同口径）：
 *   1. 新建会话先按序号命名（序号只增不减，见 store.jsx 的 CONV_NEW）；
 *      → 空对话始终保持序号。
 *   2. 会话里出现第一条「带文字」的用户输入后：
 *        · 配置了重命名模型（设置 → 重命名模型 里填了 API Key）→ 由它生成短标题；
 *        · 未配置 / 调用失败 / 超时 → 直接截取首条文字。
 *   3. 只对「还没被命名过」的会话生效：
 *        · nameAuto === false（用户手动改过名）→ 不再自动改；
 *        · 会话里已经有一条带文字的用户消息 → 这不是首条文字，不再自动改。
 *
 * 4. 手动「生成重命名」（侧栏标签菜单 → 生成重命名，见 regenerateTitle）：
 *      用户明确要求重算 → 不受上面 2 / 3 的守卫限制，结果直接覆盖当前标签名；失败则保留原名。
 *
 * 真正的 HTTP 请求与密钥都在主进程（window.stab.generateTitle，见 electron/preload.js）；
 * 本文件只负责「什么时候触发」与「拿不到标题时怎么回退」。
 */

/** 本地兜底默认值：正常由主进程 bootstrap 下发（state.renameConfig，来自 rename-model.json） */
export const TITLE_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-flash',
  temperature: 0.5,
  topP: 0.5,
  maxTitleChars: 18
};

/** 内置默认值（主进程下发优先，缺失时用本地兜底：QA 预览 / 旧数据） */
export function titleDefaults(state) {
  const d = (state && state.renameConfig) || {};
  return {
    baseUrl: d.baseUrl || TITLE_DEFAULTS.baseUrl,
    modelId: d.modelId || TITLE_DEFAULTS.modelId,
    temperature: d.temperature === undefined || d.temperature === null ? TITLE_DEFAULTS.temperature : d.temperature,
    topP: d.topP === undefined || d.topP === null ? TITLE_DEFAULTS.topP : d.topP,
    promptTemplate: d.promptTemplate || '',
    maxTitleChars: d.maxTitleChars || TITLE_DEFAULTS.maxTitleChars
  };
}

/** 是否配置了重命名模型的 API Key（没配就直接用首条文字，不打扰主进程） */
export function hasRenameKey(settings) {
  const rm = (settings && settings.renameModel) || {};
  return !!String(rm.apiKey || '').trim();
}

/**
 * 回退标题：取首条文字的第一行，压缩空白并截断到上限。
 * @param max 字符上限（按码点计，避免把 emoji 截成半个）
 */
export function fallbackTitle(text, max = TITLE_DEFAULTS.maxTitleChars) {
  const line = String(text || '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .find(Boolean) || '';
  const t = line.replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : t;
}

/**
 * 首条文字发出后调用：自动给会话标签命名。
 * 不阻塞发送流程（调用方不需要 await）；只派发一次 CONV_RENAME_AUTO。
 * @returns {Promise<string|null>} 最终写入的名字（未触发改名时为 null）
 */
export async function maybeAutoTitle({ dispatch, state, conv, text, log = () => {} }) {
  const first = String(text || '').trim();
  if (!first || !conv) return null;                                  // 首条是纯图片：等第一条带文字的消息

  const live = ((state.conversations && state.conversations.conversations) || [])
    .find((c) => c.id === conv.id) || conv;
  if (live.nameAuto === false) return null;                          // 用户手动改过名：不覆盖
  const hasTextMsg = (live.messages || []).some((m) => m.role === 'user' && String(m.text || '').trim());
  if (hasTextMsg) return null;                                       // 已经有文字消息：不是首条文字

  const expectName = live.name;
  let name = '';
  if (hasRenameKey(state.settings)) {
    try {
      const r = await window.stab.generateTitle(first);
      if (r && r.ok && r.name) name = r.name;
      else log('warn', '重命名模型未返回标题，改用首条文字', { code: r && r.code, message: r && r.message });
    } catch (e) {
      log('warn', '重命名模型调用异常，改用首条文字', { error: e && e.message });
    }
  }

  if (!name) name = fallbackTitle(first);
  if (!name) return null;

  dispatch({ type: 'CONV_RENAME_AUTO', id: conv.id, name, expectName });
  return name;
}

/** 手动「生成重命名」送给模型的文字上限（多轮对话只取开头一段，主进程还会再按 4000 字截一次） */
export const MANUAL_INPUT_CHARS = 2000;

/**
 * 收集一个会话里可用于重新命名的文字：按时间顺序拼接**全部用户消息**的文字
 * （纯图片消息没有文字，跳过；没有任何文字时返回空串）。
 * @param conv 会话对象
 * @param max  字符上限（按码点计，避免把 emoji 截成半个）
 */
export function conversationText(conv, max = MANUAL_INPUT_CHARS) {
  const parts = ((conv && conv.messages) || [])
    .filter((m) => m && m.role === 'user')
    .map((m) => String(m.text || '').trim())
    .filter(Boolean);
  const cps = Array.from(parts.join('\n'));
  return cps.length > max ? cps.slice(0, max).join('') : cps.join('');
}

/**
 * 手动「生成重命名」：立刻用重命名模型（设置 → 重命名模型）重算一次标签名。
 * 与自动命名（maybeAutoTitle）的区别：
 *   · 不受「只认首条文字」与 nameAuto 守卫限制 —— 用户点按钮就是要重算，结果直接覆盖；
 *   · 送给模型的是这个会话里全部用户文字（不是只有首条），更适合「不满意 / 自动命名失效」时重来；
 *   · **失败不改名**：模型没给出标题时保留现有标签名，只回错误让调用方提示（不做截取回退）。
 * @returns {Promise<{ok:true,name:string}|{ok:false,code:string,message:string}>} 永不抛异常
 */
export async function regenerateTitle({ dispatch, state, conv, log = () => {} }) {
  const list = (state.conversations && state.conversations.conversations) || [];
  const live = list.find((c) => conv && c.id === conv.id) || conv;
  const text = conversationText(live);
  if (!text) {
    return { ok: false, code: 'EMPTY_INPUT', message: '这个对话还没有文字内容，暂时无法生成命名。' };
  }
  if (!hasRenameKey(state.settings)) {
    return { ok: false, code: 'NO_API_KEY', message: '尚未配置重命名模型的 API Key（设置 → 重命名模型）。' };
  }

  let r = null;
  try {
    r = await window.stab.generateTitle(text);
  } catch (e) {
    log('warn', '生成重命名调用异常', { error: e && e.message });
    return { ok: false, code: 'REQUEST_ERROR', message: String((e && e.message) || e) };
  }
  if (!r || !r.ok || !r.name) {
    log('warn', '生成重命名未拿到标题（保留原标签名）', { code: r && r.code, message: r && r.message });
    return {
      ok: false,
      code: (r && r.code) || 'REQUEST_ERROR',
      message: (r && r.message) || '模型没有返回可用标题。'
    };
  }

  dispatch({ type: 'CONV_RENAME_AI', id: live.id, name: r.name });
  log('info', '生成重命名已更新标签名', { convId: live.id, name: r.name, chars: text.length });
  return { ok: true, name: r.name };
}
