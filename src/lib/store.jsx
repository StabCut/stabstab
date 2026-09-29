/*
 * 全局状态：设置 / 会话 / 忙碌标记 / 弹层。
 * 渲染进程是会话数据的编辑主体；变更后防抖写盘（经主进程原子落盘）。
 */
import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef, useCallback } from 'react';
import { uid } from './util.js';

const initialState = {
  ready: false,
  platform: '',
  appVersion: '',
  settings: null,
  paths: null,
  protocols: [],
  modelSeries: { version: 1, series: [] },   // 内置模型系列配置（含 API 来源 / 默认地址）
  conversations: { tabCounter: 0, activeId: null, conversations: [] },
  busy: {},          // conversationId -> {jobId, mode}
  lightbox: null,    // {images:[{src, title}], index}
  settingsOpen: false,
  toasts: []
};

function updateConv(state, convId, fn) {
  const conversations = state.conversations.conversations.map((c) =>
    c.id === convId ? fn(c) : c
  );
  return { ...state, conversations: { ...state.conversations, conversations } };
}

function reducer(state, action) {
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
        conversations: data.conversations || state.conversations
      };
    }
    case 'SET_PROTOCOLS':
      return { ...state, protocols: action.protocols };
    case 'SETTINGS_UPDATE':
      return {
        ...state,
        settings: { ...state.settings, ...action.settings },
        modelSeries: action.modelSeries ? { ...state.modelSeries, ...action.modelSeries } : state.modelSeries
      };

    // ---- 会话 ----
    case 'CONV_NEW': {
      const n = state.conversations.tabCounter + 1;
      const conv = {
        id: uid('c'),
        name: String(n),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        unread: false,
        messages: []
      };
      return {
        ...state,
        conversations: {
          tabCounter: n,
          activeId: conv.id,
          conversations: [conv, ...state.conversations.conversations]
        }
      };
    }
    case 'CONV_RENAME':
      return updateConv(state, action.id, (c) => ({ ...c, name: action.name, updatedAt: Date.now() }));
    case 'CONV_DELETE': {
      const rest = state.conversations.conversations.filter((c) => c.id !== action.id);
      let activeId = state.conversations.activeId;
      if (activeId === action.id) activeId = rest.length ? rest[0].id : null;
      const busy = { ...state.busy };
      delete busy[action.id];
      return { ...state, busy, conversations: { ...state.conversations, activeId, conversations: rest } };
    }
    case 'CONV_DELETE_ALL':
      return {
        ...state,
        busy: {},
        conversations: { ...state.conversations, activeId: null, conversations: [] }
      };
    case 'CONV_ACTIVATE': {
      if (state.conversations.activeId === action.id) {
        // 仍然清空黄点
        return updateConv(state, action.id, (c) => ({ ...c, unread: false }));
      }
      return {
        ...state,
        conversations: {
          ...state.conversations,
          activeId: action.id,
          conversations: state.conversations.conversations.map((c) =>
            c.id === action.id ? { ...c, unread: false } : c
          )
        }
      };
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
        modelSeries: s.modelSeries
      }).catch(() => {});
    }
  }, []);

  // 变更防抖落盘
  useEffect(() => {
    if (!state.ready) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 400);
    return () => clearTimeout(saveTimer.current);
  }, [state.settings, state.conversations, state.modelSeries, state.ready, flushSave]);

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

/** toast 便捷方法 */
export function useToast() {
  const { dispatch } = useApp();
  return useCallback((message, kind = 'info') => {
    const toast = { id: uid('t'), message, kind };
    dispatch({ type: 'TOAST_PUSH', toast });
    setTimeout(() => dispatch({ type: 'TOAST_REMOVE', id: toast.id }), 3200);
  }, [dispatch]);
}
