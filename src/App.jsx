import React, { useEffect } from 'react';
import { AppProvider, useApp, dotActionForEvent } from './lib/store.jsx';
import { PromptReuseProvider } from './lib/promptReuse.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import PromptDropZones from './components/PromptDrop.jsx';
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
        // 只可能来自协议内部的任务兜底（Grsai 某些节点只回任务 id）；不是可切换的「异步模式」
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
      // 后台（非当前标签）的生成落了终态 → 侧栏圆点：成功绿、失败红（取消不给点）；点开该标签即消费
      const dotAction = dotActionForEvent(ev, stateRef.current.conversations.activeId);
      if (dotAction) dispatch(dotAction);
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
          conversations: (boot.conversations && boot.conversations.conversations || []).length
        });
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
        <div className="boot-text">StabStab 正在启动…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <ChatView />
      {/* 拖动图片时把整个软件一分为二（左右解析区）；平时完全不占位、不拦截操作 */}
      <PromptDropZones />
      {state.settingsOpen && <SettingsModal />}
      {state.lightbox && <Lightbox />}
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      {/* 顶部解析拖放区 / 待复用提示词（插入·复制）的状态由这里统一持有 */}
      <PromptReuseProvider>
        <Shell />
      </PromptReuseProvider>
    </AppProvider>
  );
}
