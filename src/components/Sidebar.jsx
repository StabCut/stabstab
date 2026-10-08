import React, { useEffect, useRef, useState } from 'react';
import { useApp, useToast, conversationDot, dropIndexFor } from '../lib/store.jsx';
import { useSearch } from '../lib/searchState.jsx';
import Icon from './Icon.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import SearchPanel from './SearchPanel.jsx';

/** 圆点文案：黄 = 后台还在等结果 · 绿 = 后台生成成功 · 红 = 后台生成失败 */
const DOT_TITLE = {
  running: '后台生成中，等待结果…',
  success: '后台生成成功',
  error: '后台生成失败'
};

/**
 * 会话标签上的状态圆点（三种状态复用同一个组件 / 同一段样式：绿、红只是 .conv-dot 的颜色修饰类）。
 * kind = conversationDot(...)：'running' | 'success' | 'error' | null（null = 不渲染）。
 */
function ConvDot({ kind }) {
  if (!kind) return null;
  return <span className={`conv-dot ${kind}`} title={DOT_TITLE[kind] || ''} />;
}

/**
 * 一条会话标签。
 * @param drag Sidebar 下发的拖动排序接口（{id, hover, onStart, onOver, onDrop, onEnd}，见 AIDEV.md §4.11）：
 *   id     = 正在被拖动的会话 id（null = 没在拖）
 *   hover  = {id, pos} 落点提示（pos: 'before' | 'after'）
 */
function ConversationItem({ conv, isActive, drag, search }) {
  const { state, dispatch } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conv.name);
  const menuRef = useRef(null);
  const inputRef = useRef(null);
  // 黄=后台还在生成 · 绿=后台成功 · 红=后台失败；点开这个标签即消费掉（见 store.jsx#conversationDot）
  const dot = conversationDot(state, conv);
  // 正在被拖起的标签淡出；落点指示线只画在别人身上（拖到自己身上不算落点）
  const dragging = drag.id === conv.id;
  const dropPos = !dragging && drag.hover && drag.hover.id === conv.id ? drag.hover.pos : '';
  // 搜索当前跳转目标所在的对话：标一下，便于在长列表里认出「刚跳过去的是它」
  const searchTarget = !!(search && search.jump && search.jump.convId === conv.id);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const commitRename = () => {
    const name = draft.trim();
    if (name) dispatch({ type: 'CONV_RENAME', id: conv.id, name });
    setRenaming(false);
  };

  return (
    <div
      className={`conv-item ${isActive ? 'active' : ''}${dragging ? ' dragging' : ''}${dropPos ? ` drop-${dropPos}` : ''}${searchTarget ? ' search-target' : ''}`}
      // 拖动排序（HTML5 DnD）：整条标签都是把手；重命名中关掉 draggable，否则输入框里选不了字
      draggable={!renaming}
      onDragStart={(e) => drag.onStart(conv.id, e)}
      onDragOver={(e) => drag.onOver(conv.id, e)}
      onDrop={(e) => drag.onDrop(conv.id, e)}
      onDragEnd={() => drag.onEnd()}
      onClick={() => dispatch({ type: 'CONV_ACTIVATE', id: conv.id })}
      title={conv.name}
      data-conv-id={conv.id}
      data-search-target={searchTarget ? '1' : '0'}
    >
      <ConvDot kind={dot} />
      {renaming ? (
        <input
          ref={inputRef}
          className="conv-rename-input"
          value={draft}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <span className="conv-name">{conv.name}</span>
      )}
      <div className="conv-menu-wrap" ref={menuRef}>
        <button
          className="icon-btn conv-more"
          title="更多操作"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        ><Icon name="more" size={16} /></button>
        {menuOpen && (
          <div className="pop-menu" onClick={(e) => e.stopPropagation()}>
            <button
              className="pop-item"
              onClick={() => { setDraft(conv.name); setRenaming(true); setMenuOpen(false); }}
            >
              <Icon name="pencil" size={15} /> 重命名
            </button>
            <button
              className="pop-item danger"
              onClick={() => {
                dispatch({ type: 'CONV_DELETE', id: conv.id });
                setMenuOpen(false);
              }}
            >
              <Icon name="trash" size={15} /> 删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Sidebar() {
  const { state, dispatch } = useApp();
  const toast = useToast();
  // 全局搜索面板的开关（状态在 lib/searchState.jsx：跨标签命中列表与跳转意图都放那边）
  const search = useSearch();
  const { conversations, activeId } = state.conversations;
  // 侧栏顺序 = conversations 的数组顺序（不再按 createdAt 排序）：拖动排序直接改数组顺序，
  // 落盘后就是用户看到的顺序（见 AIDEV.md §4.11）。
  const [dragId, setDragId] = useState(null);
  const [hover, setHover] = useState(null);      // {id, pos} 落点指示线
  // 「删除全部对话」的二次确认：点按钮只打开弹窗，**真正删除要用户在弹窗里确认**
  // （Enter 确定 / Esc 取消，见 ConfirmDialog）
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const dragIdRef = useRef(null);                // 供 dragover/drop 读到最新值（避免闭包拿到旧 state）
  const listRef = useRef(null);

  const openCache = async () => {
    const r = await window.stab.openCacheDir();
    if (!r.ok) toast('打开缓存目录失败: ' + r.message, 'error');
  };

  /** 指针在目标条目上半 → 插到它前面；下半 → 插到它后面 */
  const posOf = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY - r.top > r.height / 2 ? 'after' : 'before';
  };

  /** 拖完（松手 / 取消 / 拖出窗口）都要复位，只影响本次拖动的视觉 */
  const endDrag = () => {
    dragIdRef.current = null;
    setDragId(null);
    setHover(null);
  };

  /** 落点 → 新顺序：下标换算在 store.jsx#dropIndexFor（纯函数，QA 直接断言） */
  const commitDrop = (overId, pos) => {
    const id = dragIdRef.current;
    const toIndex = dropIndexFor(conversations, id, overId, pos);
    if (toIndex >= 0) dispatch({ type: 'CONV_REORDER', id, toIndex });
    endDrag();
  };

  /** 拖到列表末尾空白处 = 放到最后一条之后（拖到底部是最常见的手势） */
  const tailAfter = (e) => {
    if (!dragIdRef.current) return null;
    if (e.target !== e.currentTarget) return null;    // 落在条目上：由条目自己处理
    const items = listRef.current ? listRef.current.querySelectorAll('.conv-item') : [];
    const last = items[items.length - 1];
    if (!last) return null;
    if (e.clientY < last.getBoundingClientRect().bottom) return null;   // 条目之间的小空隙不算
    const id = last.dataset.convId;                    // 最后一条自己 / 没有可落点 → 不提示
    if (!id || id === dragIdRef.current) return null;
    return id;
  };

  const drag = {
    id: dragId,
    hover,
    onStart(id, e) {
      dragIdRef.current = id;
      setDragId(id);
      setHover(null);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // 必须写一个数据类型，否则部分平台不认为这是一次有效拖动
        try { e.dataTransfer.setData('text/plain', id); } catch (err) { /* 忽略 */ }
      }
    },
    onOver(id, e) {
      const dragging = dragIdRef.current;
      if (!dragging || dragging === id) return;        // 拖到自己身上：不算落点
      e.preventDefault();                              // 允许落下
      e.stopPropagation();                             // 别让列表末尾的空白区判定抢走
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const pos = posOf(e);
      setHover((h) => (h && h.id === id && h.pos === pos ? h : { id, pos }));
    },
    onDrop(id, e) {
      if (!dragIdRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      commitDrop(id, posOf(e));
    },
    onEnd: endDrag
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img className="app-logo" src="./icon.svg" alt="logo" draggable={false} />
        <span className="app-title">StabStab</span>
        {/* 全局搜索（Ctrl+F）：展开后占据侧栏上半，对话列表往下让位 */}
        <button
          className={`icon-btn header-search-btn${search.open ? ' active' : ''}`}
          title="搜索全部对话（Ctrl+F）"
          onClick={search.toggleSearch}
        >
          <Icon name="search" size={17} />
        </button>
      </div>

      {search.open && <SearchPanel />}

      <button
        className="primary-btn new-conv-btn"
        onClick={() => dispatch({ type: 'CONV_NEW' })}
      >
        <Icon name="plus" size={16} /> 新建对话
      </button>

      <div
        className="conv-list"
        ref={listRef}
        onDragOver={(e) => {
          const id = tailAfter(e);
          if (!id) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          setHover((h) => (h && h.id === id && h.pos === 'after' ? h : { id, pos: 'after' }));
        }}
        onDrop={(e) => {
          const id = tailAfter(e);
          if (!id) return;
          e.preventDefault();
          commitDrop(id, 'after');
        }}
      >
        {conversations.length === 0 && (
          <div className="conv-empty">暂无对话，点击上方新建</div>
        )}
        {conversations.map((c) => (
          <ConversationItem key={c.id} conv={c} isActive={c.id === activeId} drag={drag} search={search} />
        ))}
      </div>

      <div className="sidebar-footer">
        <button className="icon-btn footer-btn" title="打开缓存目录（可安全清空）" onClick={openCache}>
          <Icon name="folder" size={20} />
        </button>
        <button
          className="icon-btn footer-btn"
          title="删除全部对话"
          onClick={() => {
            if (conversations.length === 0) return;
            setConfirmDeleteAll(true);      // 有对话才弹确认；确认后才是真的删
          }}
        >
          <Icon name="trash" size={20} />
        </button>
        <div className="footer-spacer" />
        <button
          className="icon-btn footer-btn"
          title="设置"
          onClick={() => dispatch({ type: 'SETTINGS_OPEN', open: true })}
        >
          <Icon name="gear" size={20} />
        </button>
      </div>

      {/* 删除全部对话：二次确认（图标沿用底部按钮同一个 trash；Enter 确定 / Esc 取消） */}
      {confirmDeleteAll && (
        <ConfirmDialog
          icon="trash"
          danger
          title="删除全部对话？"
          message={`将删除全部 ${conversations.length} 个对话（共 ${
            conversations.reduce((n, c) => n + (c.messages || []).length, 0)
          } 条消息），此操作不可恢复。`}
          lines={[
            '每个对话里还没发送的输入草稿也会一起清空。',
            '正在等待返回的生成请求，其结果会随之丢弃。',
            '缓存目录里的图片不会被删除（如需清理，用左下角文件夹按钮打开目录）。'
          ]}
          confirmText="删除全部"
          cancelText="取消"
          onConfirm={() => {
            setConfirmDeleteAll(false);
            dispatch({ type: 'CONV_DELETE_ALL' });
            toast('已删除全部对话', 'info');
          }}
          onCancel={() => setConfirmDeleteAll(false)}
        />
      )}
    </aside>
  );
}
