import React from 'react';
import { useApp, useActiveConversation, useToast } from '../lib/store.jsx';
import UserMessage from './UserMessage.jsx';
import AssistantMessage from './AssistantMessage.jsx';
import Composer from './Composer.jsx';

function EmptyState() {
  return (
    <div className="empty-state">
      <img className="empty-logo" src="./icon.svg" alt="" draggable={false} />
      <h2>StabStab捅捅</h2>
      <p>输入提示词进行文生图，或粘贴 / 拖入图片进行图生图</p>
      <p className="empty-sub">支持多图输入（最多 3 张）· 回车发送 · Shift+回车换行</p>
    </div>
  );
}

export default function ChatView() {
  const { state } = useApp();
  const conv = useActiveConversation();
  const toast = useToast();

  const busy = conv ? state.busy[conv.id] : null;
  const mode = state.settings ? state.settings.requestMode : 'sync';

  const openCache = async () => {
    const r = await window.stab.openCacheDir();
    if (!r.ok) toast('打开缓存目录失败: ' + r.message, 'error');
  };

  return (
    <main className="chat-main">
      <header className="chat-header">
        <div className="chat-title">
          <span className="chat-title-name">{conv ? conv.name : 'StabStab捅捅'}</span>
          {busy && <span className="busy-badge">等待返回中…</span>}
        </div>
        <div className="chat-header-right">
          <span className={`mode-badge ${mode}`} title="可在 设置 → 高级设置 中切换">
            {mode === 'sync' ? '同步模式' : '异步模式'}
          </span>
          <button className="icon-btn" title="一键打开缓存目录（可安全清空）" onClick={openCache}>📁</button>
        </div>
      </header>

      <div className="chat-scroll">
        {(!conv || conv.messages.length === 0) ? (
          <EmptyState />
        ) : (
          <div className="message-list">
            {conv.messages.map((m) =>
              m.role === 'user'
                ? <UserMessage key={m.id} conv={conv} msg={m} />
                : <AssistantMessage key={m.id} conv={conv} msg={m} />
            )}
          </div>
        )}
      </div>

      <Composer conv={conv} busy={busy} />
    </main>
  );
}
