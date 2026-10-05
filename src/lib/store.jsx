/*
 * 全局状态：设置 / 会话 / 忙碌标记 / 弹层。
 * 渲染进程是会话数据的编辑主体；变更后防抖写盘（经主进程原子落盘）。
 */
import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef, useCallback } from 'react';
import { uid } from './util.js';

/** 初始状态（导出便于 QA 脚本直接构造 reducer 输入：见 dev-data/qa/promptdrop-test.mjs） */
export const initialState = {
  ready: false,
  platform: '',
  appVersion: '',
  settings: null,
  paths: null,
  protocols: [],
  modelSeries: { version: 1, series: [] },   // 内置模型系列配置（含 API 来源 / 默认地址）
  renameConfig: null,                        // 重命名模型配置：提示模板 / 温度 / Top-P / 默认地址（主进程下发，可回写）
  conversations: { tabCounter: 0, activeId: null, conversations: [] },
  // 逐会话「输入区草稿」（文字 + 待发送图片）：conversationId -> {text, attachments}。
  // 切换标签时由 Composer 搬运（离开的存回、进入的取回），所以每个标签的草稿都留到自己被删除。
  // 只活在内存里：不进 saveState、重启软件即消失；会话被删除 / 全部删除时随之删除。
  // ★ 绝不能塞进 conversations —— 那一份会被整包写进 conversations.json（草稿里可能有 base64 图片）。
  drafts: {},
  busy: {},          // conversationId -> {jobId, mode}
  lightbox: null,    // {images:[{src, title}], index}
  settingsOpen: false,
  // 待复用提示词（图片元数据解析结果 + 顶部的「插入／复制」按钮）——
  // 存在全局 state 里，切换会话 / 删除 / 新建时能由 reducer 统一清理（见下面的 clearReuse）；
  // 输入框文字变化由 Composer 显式派发 CONV_REUSE_CLEAR。
  temporary: null,   // {text, source} | null
  toasts: []
};

function updateConv(state, convId, fn) {
  const conversations = state.conversations.conversations.map((c) =>
    c.id === convId ? fn(c) : c
  );
  return { ...state, conversations: { ...state.conversations, conversations } };
}

/**
 * 会话结构发生「切换 / 新建 / 删除」时清空待复用提示词（连同顶部的插入·复制按钮）。
 * 待复用提示词是输入区的临时状态，不跟着草稿走：切走标签即失效，切回来也不再显示
 * （输入区本身的文字与图片是逐会话草稿，见下面的 CONV_DRAFT_* —— 两者生命周期不同）。
 */
function clearReuse(state) {
  return state.temporary ? { ...state, temporary: null } : state;
}

/**
 * 从草稿仓库里摘掉一个会话的草稿（没有该会话时原样返回，便于上层保持同一引用不触发重渲染）。
 * @param {object} drafts 逐会话草稿仓库
 * @param {string} convId 目标会话 id
 */
function dropDraft(drafts, convId) {
  if (!(convId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[convId];
  return next;
}

/** 状态机（导出便于 QA 脚本直接验证 reducer 行为：见 dev-data/qa/title-test.mjs） */
export function reducer(state, action) {
  switch (action.type) {
    case 'BOOT': {
      const { data } = action;
      return {
        ...state,
        ready: true,
        platform: data.platform,
        appVersion: data.appVersion,
        settings: data.settings,
        paths: data.paths,
        modelSeries: data.modelSeries || state.modelSeries,
        renameConfig: data.renameConfig || state.renameConfig,
        conversations: data.conversations || state.conversations
      };
    }
    case 'SET_PROTOCOLS':
      return { ...state, protocols: action.protocols };
    case 'SETTINGS_UPDATE':
      return {
        ...state,
        settings: { ...state.settings, ...action.settings },
        modelSeries: action.modelSeries ? { ...state.modelSeries, ...action.modelSeries } : state.modelSeries,
        renameConfig: action.renameConfig ? { ...state.renameConfig, ...action.renameConfig } : state.renameConfig
      };

    // ---- 会话 ----
    case 'CONV_NEW': {
      const n = state.conversations.tabCounter + 1;
      const conv = {
        id: uid('c'),
        name: String(n),          // 空对话 = 序号；出现首条文字后由自动命名替换（见 lib/title.js）
        nameAuto: true,           // true = 名字仍可由自动命名流程替换
        createdAt: Date.now(),
        updatedAt: Date.now(),
        dot: null,                // 侧栏圆点终态：null | 'success' | 'error'（'running' 由 conversationDot 推导）
        messages: []
      };
      return {
        ...clearReuse(state),
        conversations: {
          tabCounter: n,
          activeId: conv.id,
          conversations: [conv, ...state.conversations.conversations]
        }
      };
    }
    case 'CONV_RENAME':
      // 手动重命名：把 nameAuto 关掉，之后自动命名不再覆盖用户的选择
      return updateConv(state, action.id, (c) => ({ ...c, name: action.name, nameAuto: false, updatedAt: Date.now() }));
    case 'CONV_RENAME_AUTO':
      // 自动命名（重命名模型 / 首条文字）：只改「还没有被命名过」的会话
      return updateConv(state, action.id, (c) => {
        if (c.nameAuto === false) return c;                                    // 用户手动改过名
        if (action.expectName !== undefined && c.name !== action.expectName) return c;  // 名字已被别人改过
        return { ...c, name: action.name, nameAuto: false, updatedAt: Date.now() };
      });
    case 'CONV_DELETE': {
      const rest = state.conversations.conversations.filter((c) => c.id !== action.id);
      let activeId = state.conversations.activeId;
      if (activeId === action.id) activeId = rest.length ? rest[0].id : null;
      const busy = { ...state.busy };
      delete busy[action.id];
      // 删除任意会话（含非当前会话）都清空待复用提示词；被删会话自己的草稿也随之删除，
      // 其它会话的草稿原样保留（每个标签的草稿只管自己那一份）。
      return {
        ...clearReuse(state),
        drafts: dropDraft(state.drafts, action.id),
        busy,
        conversations: { ...state.conversations, activeId, conversations: rest }
      };
    }
    case 'CONV_DELETE_ALL':
      return {
        ...clearReuse(state),
        drafts: {},
        busy: {},
        conversations: { ...state.conversations, activeId: null, conversations: [] }
      };
    case 'CONV_ACTIVATE': {
      // 点开标签 = 圆点被消费（绿/红终态随点击消失，切走再切回来不会复活；黄点由推导得出，见 conversationDot）
      if (state.conversations.activeId === action.id) {
        return updateConv(state, action.id, (c) => (c.dot ? { ...c, dot: null } : c));
      }
      return clearReuse({
        ...state,
        conversations: {
          ...state.conversations,
          activeId: action.id,
          conversations: state.conversations.conversations.map((c) =>
            c.id === action.id ? { ...c, dot: null } : c
          )
        }
      });
    }
    case 'CONV_DOT_SET':
      // 后台（非当前标签）的生成落了终态：成功 → 绿点，失败 → 红点；点开该标签即消费
      return updateConv(state, action.id, (c) => ({ ...c, dot: action.dot || null }));

    // ---- 消息 ----
    case 'MSG_ADD':
      return updateConv(state, action.convId, (c) => ({
        ...c,
        updatedAt: Date.now(),
        messages: [...c.messages, ...action.messages]
      }));
    case 'MSG_UPDATE':
      return updateConv(state, action.convId, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === action.msgId ? { ...m, ...action.patch } : m))
      }));
    case 'MSG_DELETE':
      return updateConv(state, action.convId, (c) => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.filter((m) => m.id !== action.msgId)
      }));
    case 'MSG_EDIT_PREPARE':
      // 更新用户消息内容，并删除与之配对的助手回复
      return updateConv(state, action.convId, (c) => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages
          .filter((m) => !(m.role === 'assistant' && m.parentId === action.userMsgId))
          .map((m) => (m.id === action.userMsgId ? { ...m, ...action.patch } : m))
      }));

    // ---- 忙碌（同步等待）----
    case 'BUSY_SET':
      return { ...state, busy: { ...state.busy, [action.convId]: { jobId: action.jobId, mode: action.mode } } };
    case 'BUSY_CLEAR': {
      const cur = state.busy[action.convId];
      // 只清除匹配的任务（停止等待后可能又有新任务在跑）
      if (action.jobId && cur && cur.jobId !== action.jobId) return state;
      const busy = { ...state.busy };
      delete busy[action.convId];
      return { ...state, busy };
    }

    // ---- 输入区草稿（逐会话，仅内存：切走标签不丢，删除标签才丢）----
    case 'CONV_DRAFT_PARK': {
      // 只接受仍然存在的会话：删除会话后迟到的一拍搬运必须丢弃，
      // 否则草稿会被重新塞回仓库、永远不释放（见 Composer 的搬运 effect）。
      if (!state.conversations.conversations.some((c) => c.id === action.convId)) return state;
      const text = (action.draft && action.draft.text) || '';
      const attachments = (action.draft && action.draft.attachments) || [];
      // 空草稿不占位：输入区被清空后，仓库里也不留空壳
      if (!text && attachments.length === 0) {
        const drafts = dropDraft(state.drafts, action.convId);
        return drafts === state.drafts ? state : { ...state, drafts };
      }
      // 草稿内容原地替换（同一个会话只留最新一份，不做历史）
      return { ...state, drafts: { ...state.drafts, [action.convId]: { text, attachments } } };
    }
    case 'CONV_DRAFT_DROP': {
      // 草稿已被消费（发送成功）：仓库里同步删掉，避免切走再切回来又恢复已发送的内容
      const drafts = dropDraft(state.drafts, action.convId);
      return drafts === state.drafts ? state : { ...state, drafts };
    }

    // ---- 待复用提示词（底部拖入图片解析出的临时状态）----
    case 'CONV_REUSE_SET':
      return { ...state, temporary: action.text ? { text: action.text, source: action.source || 'bottom', at: Date.now() } : null };
    case 'CONV_REUSE_CLEAR':
      return clearReuse(state);

    // ---- 弹层 / 提示 ----
    case 'LIGHTBOX_OPEN':
      return { ...state, lightbox: { images: action.images, index: action.index || 0 } };
    case 'LIGHTBOX_CLOSE':
      return { ...state, lightbox: null };
    case 'LIGHTBOX_INDEX':
      return state.lightbox ? { ...state, lightbox: { ...state.lightbox, index: action.index } } : state;
    case 'SETTINGS_OPEN':
      return { ...state, settingsOpen: action.open };
    case 'TOAST_PUSH':
      return { ...state, toasts: [...state.toasts, action.toast] };
    case 'TOAST_REMOVE':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}

/**
 * 这个会话此刻是否还在生成（= 结果还没回来）。两个口径都要看：
 *   · busy[convId]                —— 同步模式「等待返回中」的本地标记（BUSY_SET / BUSY_CLEAR）
 *   · 助手消息 status=pending/running —— 异步任务、重启后恢复的异步轮询没有 busy，只有消息状态
 * 纯函数，导出便于 QA 脚本直接断言（见 AIDEV.md §4.8）。
 */
export function isGenerating(state, conv) {
  if (!conv) return false;
  if (state.busy && state.busy[conv.id]) return true;
  return (conv.messages || []).some(
    (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'running')
  );
}

/**
 * 侧栏标签上的圆点（复用同一个 .conv-dot 组件的三种状态）：
 *   'running' 黄 = 后台还在等这个标签的结果（生成中切走 / 异步后台轮询 / 重启后恢复的任务）
 *   'success' 绿 = 后台生成成功      'error' 红 = 后台生成失败      null = 不显示
 *
 * - **只在非当前标签上显示**：正看着的会话不打扰；点开标签即把终态清空（reducer 的 CONV_ACTIVATE），
 *   所以绿/红点被消费后切走再切回来不会复活。
 * - 'running' 是**推导**出来的（见 isGenerating），不额外记录「谁在跑」—— 切换标签、异步轮询、
 *   重启恢复三条路径天然一致；正在生成优先于上一次的终态（又跑起来了就回到黄色）。
 * - 终态点由 App.jsx 在结果/失败事件里写入（CONV_DOT_SET），仅当事件到达时会话不是当前标签。
 */
export function conversationDot(state, conv) {
  if (!conv || state.conversations.activeId === conv.id) return null;
  if (isGenerating(state, conv)) return 'running';
  return conv.dot || null;
}

/**
 * API 事件 → 侧栏圆点动作（终态点只在这个条件下写入）：
 *   · 只有 result / error 落终态（status 只是「还在跑」，cancelled 是用户主动停止，都不给点）；
 *   · 事件到达时会话**不是当前标签**（正看着的会话不打扰）；
 *   · 其余事件返回 null（不改圆点）。
 * App.jsx 把返回的动作直接 dispatch；纯函数，导出便于 QA 断言（见 AIDEV.md §4.8）。
 */
export function dotActionForEvent(ev, activeId) {
  if (!ev || (ev.type !== 'result' && ev.type !== 'error')) return null;
  if (!ev.conversationId || ev.conversationId === activeId) return null;
  return { type: 'CONV_DOT_SET', id: ev.conversationId, dot: ev.type === 'result' ? 'success' : 'error' };
}

const AppCtx = createContext(null);

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saveTimer = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const flushSave = useCallback(() => {
    const s = stateRef.current;
    if (!s.ready || !s.settings) return;
    if (window.stab && window.stab.saveState) {
      window.stab.saveState({
        settings: s.settings,
        conversations: s.conversations,
        modelSeries: s.modelSeries,
        renameConfig: s.renameConfig
      }).catch(() => {});
    }
  }, []);

  // 变更防抖落盘
  useEffect(() => {
    if (!state.ready) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 400);
    return () => clearTimeout(saveTimer.current);
  }, [state.settings, state.conversations, state.modelSeries, state.renameConfig, state.ready, flushSave]);

  // 关闭/失焦时立即落盘
  useEffect(() => {
    const onHide = () => flushSave();
    window.addEventListener('beforeunload', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flushSave]);

  const value = useMemo(() => ({ state, dispatch, stateRef, flushSave }), [state, flushSave]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp() {
  return useContext(AppCtx);
}

export function useActiveConversation() {
  const { state } = useApp();
  const id = state.conversations.activeId;
  return state.conversations.conversations.find((c) => c.id === id) || null;
}

/**
 * toast 便捷方法。
 * @param message 提示文字
 * @param kind    info | warn | error
 * @param extra   { path, timeout }：path = 文件路径（提示条里单独一行、可点击打开）；
 *                timeout = 自动消失时长（毫秒，默认 3200）
 * 注意：自动消失的计时器在 Toasts 组件里（悬停可暂停），这里只管把提示推进 state。
 */
export function useToast() {
  const { dispatch } = useApp();
  return useCallback((message, kind = 'info', extra = null) => {
    const toast = {
      id: uid('t'),
      message,
      kind,
      path: (extra && extra.path) || '',
      timeout: (extra && extra.timeout) || 0    // 0 = 用组件里的默认时长
    };
    dispatch({ type: 'TOAST_PUSH', toast });
  }, [dispatch]);
}
