import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp, useActiveConversation, useToast } from '../lib/store.jsx';
import { PROMPT_MESSAGES } from '../lib/promptReuse.jsx';
import { useSearch } from '../lib/searchState.jsx';
import { messageMarks } from '../lib/search.js';
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
  // 搜索：当前命中（current）、命中表（index / records）、按会话分页（pageHit）、待定位意图（jump）
  const search = useSearch();
  const { current: currentHit, index: hitIndex, records: hitRecords, jump: searchJump, consumeJump, pageHit, syncToTerm } = search;
  // 待复用提示词存在全局 store 里（见 lib/store.jsx 的 temporary），这里只读 + 清理
  const temporary = state.temporary;

  const busy = conv ? state.busy[conv.id] : null;
  // 这个对话此刻有几个请求还在等返回（伪异步下可以同时等多个，见 AIDEV.md §4.12）
  const waiting = busy ? Object.keys(busy).length : 0;

  // ---------- 搜索定位：本条会话里的命中表 + 待闪烁的消息 ----------
  // 高亮表按「消息 id → 命中区间」算好一次性传进消息组件（见 lib/search.js#messageMarks）：
  //   · current 标出「当前站上的那一处」（强调色 mark + 整条闪烁）；
  //   · 没在搜索 / 本条没命中 → null，渲染与不做搜索时完全一致。
  const convId = conv ? conv.id : null;
  const marks = useMemo(
    () => (currentHit && hitIndex && hitRecords && conv
      ? messageMarks(conv.messages, hitRecords, conv.id, search.term, currentHit)
      : null),
    [currentHit, hitIndex, hitRecords, conv, search.term]
  );
  // 刚定位过去的消息 id（用于闪烁）—— 存 id 而不是布尔：同一条上再点一次也能重新闪
  const [flashId, setFlashId] = useState(null);

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
    // ★ 搜索定位期间不贴底：否则「切过去 + 滚到命中」会被这里的 scrollTop = scrollHeight 立刻冲掉
    //   （定位 effect 写在后面，同一个组件里按书写顺序执行 → 它先贴底、后定位，所以定位能赢）。
    if (searchJump) { pinnedRef.current = false; return; }
    if (!entered && !appended && !tailIsNew) return;
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;                         // 瞬时（layout 阶段）跳到底，切换标签不闪烁
  }, [convId, msgCount, tailId, searchJump]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    // 贴底；但「刚刚搜索定位过」的那几拍要放过 —— 图还没解码时贴底会把视线从命中处拽回底部
    const stick = () => { if (pinnedRef.current && !isRecentNav()) el.scrollTop = el.scrollHeight; };
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

  // ---------- 搜索跳转的落点与「别被自动贴底拽走」（见 AIDEV.md §4.19 / §4.9） ----------
  // 定位后的一小段时间里，内容变高（结果图解码完成）不再贴底，而是先把目标重新对齐；
  // 超过这段时间就放行 —— 用户自己继续往下滚、贴回底部时能恢复原来的自动跟随。
  const NAV_GUARD_MS = 700;
  const NAV_ALIGN_MS = 1500;
  const navAtRef = useRef(0);
  const navGuardRef = useRef(null);
  const termBoundRef = useRef('');     // 已经自动落位过的查询词（每个词只落一次）
  const isRecentNav = () => Date.now() - navAtRef.current < NAV_GUARD_MS;
  // 依赖项用的「标量」：对象每次都会新建，直接当依赖会让 effect 每拍都跑一遍
  const searchTerm = search.term;
  const jumpSeq = searchJump ? searchJump.seq : 0;
  const curMsgId = currentHit ? currentHit.msgId : null;
  const curField = currentHit ? currentHit.fieldIndex : -1;

  const scrollToMessage = (msgId) => {
    const box = scrollRef.current;
    if (!box) return;
    const node = box.querySelector(`[data-msg-id="${msgId}"]`);
    if (!node || typeof node.scrollIntoView !== 'function') return;
    navAtRef.current = Date.now();
    node.scrollIntoView({ block: 'center' });
    pinnedRef.current = false;       // 站到命中处 = 不贴底
  };

  useLayoutEffect(() => {
    if (!currentHit || !conv) return undefined;
    // 高亮表先落地再滚动：这里已经是 layout 阶段，mark 与原文字高一致，滚动位置一次到位
    scrollToMessage(currentHit.msgId);
    setFlashId(currentHit.msgId);
    const t = window.setTimeout(() => {
      // ★ 到点只清「还是这一条」的闪烁标记：换词/换标签之后 flashId 可能已经指向别处，
      //   这里若无条件清空，会把已经开始的下一次定位闪烁也给抹掉。
      setFlashId((cur) => (cur === currentHit.msgId ? null : cur));
    }, 1400);
    return () => window.clearTimeout(t);
  }, [jumpSeq, curMsgId, curField, convId]);

  /**
   * 图片解码会持续把内容撑高（§4.9 那个 ResizeObserver 的由来），目标可能因此漂出视野：
   * 定位后的 1.5s 内，只要目标明显偏了就重新对齐一次（不做动画，避免来回晃）。
   */
  useEffect(() => {
    if (!currentHit || !conv) return undefined;
    const box = scrollRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const since = Date.now() - navAtRef.current;
      if (navAtRef.current && since > NAV_ALIGN_MS) { ro.disconnect(); return; }
      const node = box.querySelector(`[data-msg-id="${currentHit.msgId}"]`);
      if (!node) return;
      const nb = node.getBoundingClientRect();
      const bb = box.getBoundingClientRect();
      const centre = bb.top + bb.height / 2;
      const nodeCentre = nb.top + nb.height / 2;
      if (Math.abs(nodeCentre - centre) > 48) { navAtRef.current = Date.now(); node.scrollIntoView({ block: 'center' }); }
    });
    ro.observe(box);
    window.clearTimeout(navGuardRef.current);
    navGuardRef.current = window.setTimeout(() => { ro.disconnect(); }, NAV_ALIGN_MS + 200);
    return () => { ro.disconnect(); window.clearTimeout(navGuardRef.current); };
  }, [jumpSeq, curMsgId, curField, convId]);

  /**
   * 查询词生效后的自动落位：**同一批结果只落位一次**（term + gen 记账，见 searchState 的 gen）。
   * ★ 直接跳到「这个词的第一处命中」（可能因此切标签），不要再走「切到当前会话的第一处」那条路径 ——
   *   那条路径只看当前标签，换词后当前标签也有命中时会在本标签内乱跳，两个 effect 互相覆盖。
   * ★ 记账必须带上 gen：同一个词「清空输入框 → 再输一遍」时词没变，但结果集是新的一批
   *   （游标已被归零），只看词的记账会让它永远停在 0。
   */
  useEffect(() => {
    if (!search.open || !searchTerm || !convId) return;
    const key = `${search.gen}|${searchTerm}`;
    if (termBoundRef.current === key) return;      // 这一批结果已经落过位，不再打扰用户
    termBoundRef.current = key;
    search.gotoHit(0);
  }, [search.open, searchTerm, convId, search]);

  /**
   * 切换标签时：如果新标签里也有命中，自动站到它的第一处（换成没命中的标签就不动）。
   * 与上面那个 effect 的分工：那边管「换了词」，这边管「换了标签」。
   */
  useEffect(() => {
    if (!search.open || !searchTerm || !convId) return;
    if (currentHit && currentHit.convId === convId) return;      // 已经站在本会话的命中上
    pageHit(convId, 0);
  }, [search.open, searchTerm, convId, currentHit, pageHit]);

  /**
   * 关掉搜索时把闪烁标记清掉（开着的期间不清）：否则 1.4s 内关掉面板，那条消息要等到计时器
   * 到点才会褪色，看起来像「关了搜索还留着痕迹」。
   */
  useEffect(() => {
    if (!search.open || !searchTerm) setFlashId(null);
  }, [search.open, searchTerm]);

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
    <main
      className="chat-main"
      // 搜索状态挂一份只读镜像到 DOM 上：QA 断言（以及出问题时肉眼查 DOM）用得上，
      // 见 dev-data/qa/search-dom-test.js。不参与任何逻辑。
      data-search-term={searchTerm || ''}
      data-search-cursor={String(search.cursor)}
      data-search-hits={String(search.hitCount)}
      data-search-jump={String(jumpSeq)}
      data-current-hit={curMsgId || ''}
      data-current-range={currentHit ? JSON.stringify(currentHit.ranges || null) : ''}
    >
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
            {conv.messages.map((m) => {
              // 这条消息在本次搜索里的命中（null = 没命中 / 没在搜索）：交给消息组件切分 <mark>
              const mmarks = marks ? marks.get(m.id) : null;
              const hit = marks ? !!mmarks : false;
              return (
                // 外层这层 div 只是「搜索定位」的抓手：ref 回调在目标消息挂上 DOM 的那一拍
                // 清掉待定位意图（见 lib/searchState.jsx#consumeJump）。data-hit 供 QA / 样式使用。
                <div
                  key={m.id}
                  className="msg-slot"
                  data-hit={hit ? '1' : '0'}
                  ref={(el) => {
                    if (el && searchJump && searchJump.msgId === m.id) consumeJump(searchJump.seq);
                  }}
                >
                  {m.role === 'user'
                    ? <UserMessage conv={conv} msg={m} marks={mmarks} flash={flashId === m.id} />
                    : <AssistantMessage conv={conv} msg={m} marks={mmarks} flash={flashId === m.id} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Composer conv={conv} busy={busy} />
      <ImagePromptModal />
    </main>
  );
}