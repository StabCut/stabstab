import React, { useEffect } from 'react';
import { AppProvider, useApp } from './lib/store.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import Lightbox from './components/Lightbox.jsx';
import Toasts from './components/Toasts.jsx';

function Shell() {
  const { state, dispatch, stateRef } = useApp();

  // 注册 API 事件监听（先于 bootstrap 完成）
  useEffect(() => {
    const off = window.stab.onApiEvent((ev) => {
      const convId = ev.conversationId;
      const msgId = ev.messageId;
      if (ev.type === 'status') {
        dispatch({
          type: 'MSG_UPDATE', convId, msgId,
          patch: { status: 'running', taskStatus: ev.status, taskId: ev.taskId }
        });
      } else if (ev.type === 'result') {
        dispatch({
          type: 'MSG_UPDATE', convId, msgId,
          patch: {
            status: 'success',
            images: ev.images || [],
            texts: ev.texts || [],
            usage: ev.usage || null,
            requestId: ev.requestId || null,
            taskId: ev.taskId || null,
            finishedAt: Date.now(),
            durationMs: ev.durationMs
          }
        });
        dispatch({ type: 'BUSY_CLEAR', convId, jobId: msgId });
        const activeId = stateRef.current.conversations.activeId;
        if (convId !== activeId) {
          dispatch({ type: 'CONV_MARK_UNREAD', id: convId });
        }
      } else if (ev.type === 'error') {
        dispatch({
          type: 'MSG_UPDATE', convId, msgId,
          patch: { status: 'error', error: ev.error, taskId: ev.taskId || null, finishedAt: Date.now(), durationMs: ev.durationMs }
        });
        dispatch({ type: 'BUSY_CLEAR', convId, jobId: msgId });
      } else if (ev.type === 'cancelled') {
        dispatch({
          type: 'MSG_UPDATE', convId, msgId,
          patch: { status: 'cancelled', error: ev.error, finishedAt: Date.now() }
        });
        dispatch({ type: 'BUSY_CLEAR', convId, jobId: msgId });
      }
    });
    return off;
  }, [dispatch, stateRef]);

  // 启动引导
  useEffect(() => {
    (async () => {
      try {
        const boot = await window.stab.bootstrap();
        dispatch({ type: 'BOOT', data: boot });
        const prot = await window.stab.listProtocols();
        dispatch({ type: 'SET_PROTOCOLS', protocols: prot.protocols || [] });
        window.stab.log('info', '渲染进程启动完成', {
          conversations: (boot.conversations && boot.conversations.conversations || []).length,
          resumeCount: boot.resumeCount
        });
        if (boot.resumeCount > 0) {
          window.stab.resumeJobs();
        }
      } catch (e) {
        console.error('bootstrap failed', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题
  useEffect(() => {
    const apply = () => {
      const t = state.settings ? state.settings.theme : 'system';
      let theme = t;
      if (t === 'system') {
        theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.dataset.theme = theme;
    };
    apply();
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq) mq.addEventListener('change', apply);
    return () => { if (mq) mq.removeEventListener('change', apply); };
  }, [state.settings]);

  if (!state.ready) {
    return (
      <div className="boot-screen">
        <div className="boot-logo" />
        <div className="boot-text">StabStab捅捅 正在启动…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <ChatView />
      {state.settingsOpen && <SettingsModal />}
      {state.lightbox && <Lightbox />}
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
