import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { useApp, useActiveConversation, useToast } from '../lib/store.jsx';
import { PROMPT_MESSAGES } from '../lib/promptReuse.jsx';
import { useSearch } from '../lib/searchState.jsx';
import UserMessage from './UserMessage.jsx';
import AssistantMessage from './AssistantMessage.jsx';
import Composer from './Composer.jsx';
import { ImagePromptModal } from './PromptDrop.jsx';
import Icon from './Icon.jsx';

function EmptyState() {
  return (
    <div className="empty-state">
      <img className="empty-logo" src="./icon.svg" alt="" draggable={false} />
      <h2>StabStab</h2>
      <p>输入提示词进行文生图，或粘贴 / 拖入图片进行图生图</p>
      <p className="empty-sub">支持多图输入（最多 3 张）· 回车发送 · Shift+回车换行</p>
    </div>
  );
}

export default function ChatView() {
  const { state, dispatch } = useApp();
  const conv = useActiveConversation();
  const toast = useToast();
  // 搜索：待定位目标 + 用完即清的 consumeJump（定位与滚动抑制在第 2 / 3 步接上）
  const { jump: searchJump, consumeJump } = useSearch();
  // 待复用提示词存在全局 store 里（见 lib/store.jsx 的 temporary），这里只读 + 清理
  const temporary = state.temporary;

  const busy = conv ? state.busy[conv.id] : null;
  // 这个对话此刻有几个请求还在等返回（伪异步下可以同时等多个，见 AIDEV.md §4.12）
  const waiting = busy ? Object.keys(busy).length : 0;

  // ---------- 滚动：进入标签页默认停在最后一条消息 ----------
  // 规则（见 AIDEV.md §4.9）：
  //   · 进入一个标签（或该标签新增了消息 = 自己刚发出去）→ 瞬时跳到最底部，不用往上翻；
  //   · 之后内容长高（结果图加载完成 / 文字换行）继续贴底，但**用户自己往回滚过**就不再拽他；
  //   · 只有本来就贴着底部时才自动跟随，读历史时来的新结果不会把视线拉走。
  const scrollRef = useRef(null);
  const contentRef = useRef(null);      // .message-list：内容真实高度变化靠它观察
  const pinnedRef = useRef(true);       // 是否贴着底部（用户主动往上翻 → false）
  const prevConvRef = useRef(undefined);
  const prevCountRef = useRef(0);
  const prevTailRef = useRef(null);     // 末尾消息 {id, createdAt}：编辑重发会「删旧回复 + 加新回复」
  const convId = conv ? conv.id : null;
  const msgCount = conv ? conv.messages.length : 0;
  const tail = msgCount ? conv.messages[msgCount - 1] : null;
  const tailId = tail ? tail.id : null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const entered = prevConvRef.current !== convId;         // 切换 / 新建标签
    const appended = msgCount > prevCountRef.current;       // 这条标签里又多了消息（自己刚发出）
    // 末尾换成了一条**更新的**消息：编辑重发的「删旧回复 + 加新回复」在同一拍里完成，
    // 条数可能不变，但末尾 id / 时间变了（删掉末尾消息时新末尾更旧，不算）。
    const tailIsNew = !!tail && !!prevTailRef.current && tail.id !== prevTailRef.current.id
      && (tail.createdAt || 0) >= (prevTailRef.current.createdAt || 0);
    prevConvRef.current = convId;
    prevCountRef.current = msgCount;
    prevTailRef.current = tail ? { id: tail.id, createdAt: tail.createdAt || 0 } : null;
    if (!entered && !appended && !tailIsNew) return;
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;                         // 瞬时（layout 阶段）跳到底，切换标签不闪烁
  }, [convId, msgCount, tailId]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const stick = () => { if (pinnedRef.current) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(stick);                   // 图片加载完成等导致的内容变高
    ro.observe(content);
    return () => ro.disconnect();
  }, [convId, msgCount, tailId]);

  // 贴底判定：距底部 48px 以内算「在底下」，用户往上翻则停止自动跟随
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };

  // 右上角文件夹按钮：打开数据目录下的 downloads（开发模式即 dev-data/downloads），
  // 与左下角标签栏底部「打开缓存目录」按钮区分开。
  const openDownloads = async () => {
    const r = await window.stab.openDownloadsDir();
    if (!r.ok) toast('打开下载目录失败: ' + r.message, 'error');
  };

  // 右上角「下载」按钮：打开系统「下载」目录（Windows = 用户目录\Downloads；Ubuntu 24.04 = ~/Downloads）。
  // 与左侧文件夹按钮的区别：那个开的是应用数据目录里的 downloads，这个是操作系统自己的下载目录。
  const openSystemDownloads = async () => {
    const r = await window.stab.openSystemDownloadsDir();
    if (!r.ok) toast('打开下载目录失败: ' + r.message, 'error');
  };

  // 「插入」= 先把输入框内容放到末尾追加（append），再聚焦并把光标落到文本末尾
  const insertReuse = () => {
    const text = temporary ? temporary.text : '';
    dispatch({ type: 'CONV_REUSE_CLEAR' });      // 先取到本次内容，再清理临时状态
    if (text) window.dispatchEvent(new CustomEvent('stabstab:insert-prompt', { detail: { text } }));
  };

  const copyReuse = async () => {
    const text = temporary ? temporary.text : '';
    dispatch({ type: 'CONV_REUSE_CLEAR' });
    const r = await window.stab.copyText(text);
    if (r && r.ok) toast('提示词已复制', 'info');
    else toast(`${PROMPT_MESSAGES.clipboardFailed}${r && r.message ? '：' + r.message : ''}`, 'error');
  };

  return (
    <main className="chat-main">
      <header className={`chat-header ${temporary ? 'has-reuse' : ''}`}>
        <div className="chat-title">
          <span className="chat-title-name">{conv ? conv.name : 'StabStab'}</span>
          {waiting > 0 && (
            <span className="busy-badge" title="这个对话里还在等待返回的请求数量（可同时等多个，互不干扰）">
              等待返回中{waiting > 1 ? ` ×${waiting}` : '…'}
            </span>
          )}
        </div>
        <div className="chat-header-right">
          {temporary && (
            <div className="prompt-reuse-actions">
              <button className="ghost-btn small" title="把该提示词追加到输入框末尾" onClick={insertReuse}>插入</button>
              <button className="ghost-btn small" title="把该提示词复制到剪贴板" onClick={copyReuse}>复制</button>
            </div>
          )}
          <button className="icon-btn" title="一键打开下载目录（保存结果图片的位置）" onClick={openDownloads}><Icon name="folder" size={19} /></button>
          <button className="icon-btn" title="一键打开系统「下载」目录（Windows：下载 / Ubuntu：~/Downloads）" onClick={openSystemDownloads}><Icon name="folderDownloadLine" size={19} /></button>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {(!conv || conv.messages.length === 0) ? (
          <EmptyState />
        ) : (
          <div className="message-list" ref={contentRef}>
            {conv.messages.map((m) => (
              // 外层这层 div 只是「搜索定位」的抓手：ref 回调在目标消息挂上 DOM 的那一拍
              // 清掉待定位意图（见 lib/searchState.jsx#consumeJump），第 2 / 3 步会在同一拍滚动过去。
              <div
                key={m.id}
                className="msg-slot"
                ref={(el) => {
                  if (el && searchJump && searchJump.msgId === m.id) consumeJump(searchJump.seq);
                }}
              >
                {m.role === 'user'
                  ? <UserMessage conv={conv} msg={m} />
                  : <AssistantMessage conv={conv} msg={m} />}
              </div>
            ))}
          </div>
        )}
      </div>

      <Composer conv={conv} busy={busy} />
      <ImagePromptModal />
    </main>
  );
}