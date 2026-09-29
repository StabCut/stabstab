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
