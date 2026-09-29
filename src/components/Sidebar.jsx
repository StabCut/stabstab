import React, { useEffect, useRef, useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import Icon from './Icon.jsx';

function ConversationItem({ conv, isActive }) {
  const { dispatch } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conv.name);
  const menuRef = useRef(null);
  const inputRef = useRef(null);

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
      className={`conv-item ${isActive ? 'active' : ''}`}
      onClick={() => dispatch({ type: 'CONV_ACTIVATE', id: conv.id })}
      title={conv.name}
    >
      {conv.unread && <span className="conv-dot" title="有新结果" />}
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
  const { conversations, activeId } = state.conversations;
  const sorted = [...conversations].sort((a, b) => b.createdAt - a.createdAt);

  const openCache = async () => {
    const r = await window.stab.openCacheDir();
    if (!r.ok) toast('打开缓存目录失败: ' + r.message, 'error');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img className="app-logo" src="./icon.svg" alt="logo" draggable={false} />
        <span className="app-title">StabStab</span>
      </div>

      <button
        className="primary-btn new-conv-btn"
        onClick={() => dispatch({ type: 'CONV_NEW' })}
      >
        <Icon name="plus" size={16} /> 新建对话
      </button>

      <div className="conv-list">
        {sorted.length === 0 && (
          <div className="conv-empty">暂无对话，点击上方新建</div>
        )}
        {sorted.map((c) => (
          <ConversationItem key={c.id} conv={c} isActive={c.id === activeId} />
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
            dispatch({ type: 'CONV_DELETE_ALL' });
            toast('已删除全部对话', 'info');
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
    </aside>
  );
}
