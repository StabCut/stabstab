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
 * 切换会话会重置输入框，旧的待复用提示词随之失效，必须一起清掉。
 */
function clearReuse(state) {
  return state.temporary ? { ...state, temporary: null } : state;
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
        unread: false,
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
      // 删除任意会话（含非当前会话）都清空待复用提示词
      return { ...clearReuse(state), busy, conversations: { ...state.conversations, activeId, conversations: rest } };
    }
    case 'CONV_DELETE_ALL':
      return {
        ...clearReuse(state),
        busy: {},
        conversations: { ...state.conversations, activeId: null, conversations: [] }
      };
    case 'CONV_ACTIVATE': {
      if (state.conversations.activeId === action.id) {
        // 仍然清空黄点
        return updateConv(state, action.id, (c) => ({ ...c, unread: false }));
      }
      return clearReuse({
        ...state,
        conversations: {
          ...state.conversations,
          activeId: action.id,
          conversations: state.conversations.conversations.map((c) =>
            c.id === action.id ? { ...c, unread: false } : c
          )
        }
      });
    }
    case 'CONV_MARK_UNREAD':
      return updateConv(state, action.id, (c) => ({ ...c, unread: true }));

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
