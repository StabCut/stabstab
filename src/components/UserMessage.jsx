import React, { useRef, useState } from 'react';
import { useApp, useToast, makeConversation } from '../lib/store.jsx';
import { uploadUrl, formatClock } from '../lib/util.js';
import { contentOfMessage, resendEdited, resolveResendTarget, sendBubbleAgain, sendBubbleToNewConversation } from '../lib/send.js';
import { useComposerSelection, getComposerSelection } from '../lib/composerSelection.js';
import { pushComposerDraft, announceComposerDraft, isCloneClick } from '../lib/composerDraft.js';
import { missingImageMessage } from '../lib/imageActions.js';
import { fileToDataUrl, readImageMeta, isImageFile, sourceFileName } from '../lib/images.js';
import { usePromptReuse } from '../lib/promptReuse.jsx';
import Icon from './Icon.jsx';
import SizePicker from './SizePicker.jsx';
import ImageContextMenu, { useImageMenu } from './ImageContextMenu.jsx';
import HighlightText from './HighlightText.jsx';
import { MAX_IMAGES } from './Composer.jsx';

/**
 * @param marks 全局搜索在**这条消息里**的命中区间（`lib/search.js#messageMarks` 算出）；
 *   没在搜索 / 这条没命中时是 undefined 或空数组 —— 此时渲染结果与不做搜索时完全一致。
 */
export default function UserMessage({ conv, msg, marks = null, flash = false }) {
  const { state, dispatch } = useApp();
  const toast = useToast();
  // 编辑中的气泡也是「图片接收区域」之一：指针拖到它上面时不弹左右解析区，交给这里接收补图
  const { registerReceiver } = usePromptReuse();
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(msg.text);
  const [kept, setKept] = useState(msg.images || []);
  // 重发尺寸：null = 跟随下方输入框的当前尺寸；在下拉框里选过 = 只覆盖这一次重发
  const [sizeOverride, setSizeOverride] = useState(null);
  const [resending, setResending] = useState(false);
  // 「新对话发送 / 当前对话发送」进行中（读图 + 提交）：防止连点重复发出
  const [resendingAgain, setResendingAgain] = useState(false);
  // 把图片拖到这个气泡上时的高亮（与输入区同一套 .drop-mask 观感）
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  // 图片右键菜单（复制 / 保存到下载 / 另存为）：菜单状态由组件持有，菜单项见 lib/imageActions.js
  const imageMenu = useImageMenu();

  // ---- 编辑重发用的设置 = 输入区当前设置（模型 / 尺寸 / 参数），不是这条消息当时的设置 ----
  // 订阅输入区（Composer）的实时选择：下方换模型、换尺寸、调参数，这里跟着变。
  // 只在编辑气泡打开时订阅：不在编辑态的消息不必跟着参数面板打字重渲染。
  const selection = useComposerSelection(editing);
  const target = editing
    ? resolveResendTarget({
      settings: state.settings,
      modelSeries: state.modelSeries,
      protocols: state.protocols,
      selection,
      fallbackModelId: msg.model && msg.model.id,
      fallbackParams: msg.params,
      sizeOverride
    })
    : null;
  const modelChanged = !!(target && target.model && msg.model && target.model.id !== msg.model.id);

  const openLightbox = (index) => {
    const images = (msg.images || [])
      .filter((im) => im.file)
      .map((im, i) => ({ src: uploadUrl(im.file), kind: 'upload', file: im.file, name: im.name || '', title: `输入图 ${i + 1} · ${im.width || '?'}×${im.height || '?'}` }));
    if (!images.length) { toast('图片文件不存在（可能已被清理）', 'warn'); return; }
    // 找到被点击图在过滤后列表中的下标
    const validIdx = (msg.images || []).slice(0, index + 1).filter((im) => im.file).length - 1;
    dispatch({ type: 'LIGHTBOX_OPEN', images, index: Math.max(0, validIdx) });
  };

  const startEdit = () => {
    setDraftText(msg.text);
    setKept(msg.images || []);
    setSizeOverride(null);      // 尺寸默认跟随下方输入框的当前值
    setDragActive(false);
    dragCounter.current = 0;
    setEditing(true);
  };

  /* ---------------- 编辑气泡里补图：粘贴 / 拖入 / 「＋」多选 ----------------
   * 只改这一条消息**本地**的 kept 列表，点「确定并重新发送」时才真正落盘（见 lib/send.js#resendEdited）。
   * 与输入区同一套规则：最多 MAX_IMAGES 张、剪贴板来源拿不到真实文件名（picN 记空串）。
   */

  /** 这次拖入的是不是文件（拖动选中的文字 / 气泡内文本时不该弹出补图蒙版） */
  const isFileDrag = (e) => {
    const dt = e && e.dataTransfer;
    if (!dt) return false;
    return Array.from(dt.types || []).includes('Files');
  };

  /**
   * @param {boolean} named 这些 File 是否带着用户文件的真实名字（拖入 = true；剪贴板粘贴 = false）
   */
  const addKeptFiles = async (fileList, named = true) => {
    const files = Array.from(fileList || []).filter(isImageFile);
    if (!files.length) { toast('未识别到图片文件', 'warn'); return; }
    const room = MAX_IMAGES - kept.length;
    if (room <= 0) { toast(`最多只能添加 ${MAX_IMAGES} 张图片`, 'warn'); return; }
    const use = files.slice(0, room);
    if (files.length > room) toast(`最多只能添加 ${MAX_IMAGES} 张图片，已忽略多余部分`, 'warn');

    const added = [];
    for (const f of use) {
      try {
        const dataUrl = await fileToDataUrl(f);
        const meta = await readImageMeta(dataUrl);
        const saved = await window.stab.saveAttachment({ name: f.name || 'image.png', mime: f.type || 'image/png', dataUrl });
        if (!saved.ok) throw new Error(saved.message);
        added.push({
          file: saved.file, name: f.name || 'image.png', mime: f.type || 'image/png',
          width: meta.width || saved.width, height: meta.height || saved.height,
          bytes: saved.bytes, srcName: named ? sourceFileName(f) : ''
        });
      } catch (e) {
        toast(`添加图片失败: ${e.message}`, 'error');
        window.stab.log('error', '编辑气泡添加图片失败', { name: f.name, error: e.message });
      }
    }
    // 兜底再截一次：连续两次拖入时，room 是按上一拍算的
    if (added.length) setKept((prev) => [...prev, ...added].slice(0, MAX_IMAGES));
  };

  /** 气泡里粘贴：**光标必须在这个编辑框里**（onPaste 只挂在编辑 textarea 上）；纯文字粘贴走默认行为 */
  const onEditPaste = (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && isImageFile(f)) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addKeptFiles(files, false);     // 剪贴板图片：拿不到真实文件名 → pic 项留空
    }
  };

  /** 「＋」：资源管理器多选（主进程返回的就是磁盘上的真实文件名） */
  const pickKeptFiles = async () => {
    const r = await window.stab.pickImages();
    if (!r.ok || !r.files || !r.files.length) return;
    const room = MAX_IMAGES - kept.length;
    if (room <= 0) { toast(`最多只能添加 ${MAX_IMAGES} 张图片`, 'warn'); return; }
    const use = r.files.slice(0, room);
    if (r.files.length > room) toast(`最多只能添加 ${MAX_IMAGES} 张图片，已忽略多余部分`, 'warn');

    const added = [];
    for (const f of use) {
      try {
        const meta = await readImageMeta(f.dataUrl);
        const saved = await window.stab.saveAttachment({ name: f.name, mime: f.mime, dataUrl: f.dataUrl });
        if (!saved.ok) throw new Error(saved.message);
        added.push({
          file: saved.file, name: f.name, mime: f.mime,
          width: meta.width || saved.width, height: meta.height || saved.height,
          bytes: saved.bytes, srcName: sourceFileName(f)
        });
      } catch (e) {
        toast(`添加图片失败: ${e.message}`, 'error');
      }
    }
    if (added.length) setKept((prev) => [...prev, ...added].slice(0, MAX_IMAGES));
  };

  /** 拖入气泡：接收区域就是「这条用户气泡」（.edit-bubble）本身 */
  const onEditDrop = (e) => {
    if (!isFileDrag(e)) return;      // 拖进来的是文字 / 应用内文本：交给 textarea 的默认行为
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    if (e.dataTransfer && e.dataTransfer.files) addKeptFiles(e.dataTransfer.files, true);   // 拖入：File.name 即真实文件名
  };

  const confirmEdit = async () => {
    if (!draftText.trim() && kept.length === 0) { toast('内容不能为空', 'warn'); return; }
    // 点「确定并重新发送」这一刻再取一次输入区设置：气泡打开期间改了下方的模型 / 尺寸也要用最新的
    const finalTarget = resolveResendTarget({
      settings: state.settings,
      modelSeries: state.modelSeries,
      protocols: state.protocols,
      selection: getComposerSelection(),
      fallbackModelId: msg.model && msg.model.id,
      fallbackParams: msg.params,
      sizeOverride
    });
    setResending(true);
    try {
      const { resolved } = await resendEdited({
        dispatch, state, conv, userMsg: msg,
        newText: draftText.trim(),
        keptImages: kept,
        params: finalTarget.params,
        modelId: finalTarget.modelId,
        log: (l, m, e) => window.stab.log(l, m, e)
      });
      setEditing(false);
      const changed = !!(resolved && msg.model && resolved.id !== msg.model.id);
      toast(changed
        ? `已按下方当前设置用「${resolved.name}」重新发送，旧结果已删除`
        : '已重新发送，旧结果已删除', 'info');
    } catch (e) {
      toast('重发失败: ' + e.message, 'error');
    } finally {
      setResending(false);
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(msg.text || '');
      toast('已复制文字', 'info');
    } catch (e) {
      toast('复制失败', 'error');
    }
  };

  /**
   * 气泡重发：把这条消息的**文字 + 全部输入图**再发一遍（模型 / 尺寸 / 参数取输入区当前设置，
   * 与「编辑重发」同一口径，见 AIDEV.md §4.7）。原消息与原回复都不动，只是新增一条请求。
   *
   * @param {'new'|'current'} where 'new' = 新开一个对话发送；'current' = 在当前对话里再发一次。
   *   两者在等待上完全等价 —— 每个请求各占一个 jobId，同一个对话里可以同时等多个互不干扰的结果。
   *   注意：按住 Ctrl / Shift 点击走的是另一条路（cloneBubble：只拷进输入框、不发请求）。
   */
  const resendBubble = async (where) => {
    if (resendingAgain) return;
    if (!String(msg.text || '').trim() && !(msg.images || []).length) { toast('这条消息没有可发送的内容', 'warn'); return; }
    const t = resolveResendTarget({
      settings: state.settings,
      modelSeries: state.modelSeries,
      protocols: state.protocols,
      selection: getComposerSelection(),
      fallbackModelId: msg.model && msg.model.id,
      fallbackParams: msg.params
    });
    setResendingAgain(true);
    try {
      if (where === 'new') {
        const { conv: next } = await sendBubbleToNewConversation({
          dispatch, state, msg, params: t.params, modelId: t.modelId,
          log: (l, m, e) => window.stab.log(l, m, e)
        });
        toast(`已在「${next.name}」新对话中发送`, 'info');
      } else {
        await sendBubbleAgain({
          dispatch, state, conv, msg, params: t.params, modelId: t.modelId,
          log: (l, m, e) => window.stab.log(l, m, e)
        });
        toast('已在当前对话中发送（与其它等待互不干扰）', 'info');
      }
    } catch (e) {
      toast('发送失败: ' + e.message, 'error');
    } finally {
      setResendingAgain(false);
    }
  };

  /**
   * 把这条气泡的**文字 + 输入图原封不动**拷进底部输入框，但**不发**（等用户自己改 / 自己发）。
   * 触发方式：在「当前对话发送 / 新对话发送」按钮上**按住 Ctrl（或 Cmd / Shift）点击**。
   *
   * @param {'new'|'current'} where 'current' = 拷进当前标签的输入框（不切标签、不新建会话）；
   *   'new' = 先新开一个对话标签（立刻成为当前标签，与点「新建对话」一致），再拷进它的输入框。
   *   两者都只写「草稿」：文字与图片可随意编辑，按发送键才真正发出去。
   *   是否进入克隆分支由调用方判定（onSendButtonClick），这里只管拷。
   */
  const cloneBubble = async (where) => {
    if (!String(msg.text || '').trim() && !(msg.images || []).length) { toast('这条消息没有可复制的内容', 'warn'); return; }
    setResendingAgain(true);
    try {
      // 先把图片读回来再落草稿：输入框一次性拿到「文字 + 图片」，不会先闪一下纯文字。
      // 图读不回来（文件被清理）时不算失败：文字照样拷，缺几张在提示里说清楚。
      const content = await contentOfMessage(msg);
      if (!content.text.trim() && !content.attachments.length) {
        toast('这条消息的内容已经不可用（图片文件可能已被清理），无法复制。', 'warn');
        return;
      }

      let targetConv = conv;
      let targetName = '';
      if (where === 'new') {
        // 与「新对话发送」同一套：先造会话对象再 CONV_ADD（新标签立刻成为当前标签，见 AIDEV.md §4.13）
        const { conv: next, counter } = makeConversation(state.conversations.tabCounter);
        targetConv = next;
        targetName = next.name;
        // 顺序要紧：先把草稿挂到新标签名下，再激活它 —— 切换会话时 Composer 正好取走这一份
        pushComposerDraft(next.id, { text: content.text, attachments: content.attachments });
        dispatch({ type: 'CONV_ADD', conv: next, counter });
        announceComposerDraft(next.id);   // 同一拍里 push + 激活：喊一声让已经在眼前的输入区立刻认领
      } else {
        // 读图是异步的：等回来的这一拍，标签可能已经被删掉（相当于没点过），别往不存在的标签塞草稿
        if (!state.conversations.conversations.some((c) => c.id === conv.id)) return;
        pushComposerDraft(conv.id, { text: content.text, attachments: content.attachments });
        announceComposerDraft(conv.id);
      }

      const lost = content.missing ? `，另有 ${content.missing} 张图片文件已丢失` : '';
      toast(where === 'new'
        ? `已把内容复制到新对话「${targetName}」的输入框${lost}，可编辑后自行发送`
        : `已把内容复制到输入框${lost}，可编辑后自行发送`, 'info');
      window.stab.log('info', '按住 Ctrl/Shift 复制气泡内容到输入框', {
        where, convId: targetConv.id, images: content.attachments.length, missing: content.missing
      });
    } catch (e) {
      toast('复制失败: ' + e.message, 'error');
      window.stab.log('error', '复制气泡内容到输入框失败', { error: e.message });
    } finally {
      setResendingAgain(false);
    }
  };

  /**
   * 两个按钮共用的点击处理：普通点击 = 直接发送；按住 Ctrl / Shift = 拷进输入框等用户自己发。
   * 「按住修饰键了吗」由 lib/composerDraft.js#isCloneClick 判定（纯函数，便于断言）。
   *
   * 克隆只做「读文件 + 填输入框」，不发任何请求（见 AIDEV.md §4.13.1），因此它**不受**
   * 「正在再发一遍」的拦截：`resendingAgain` 只挡普通点击（防一次点击发出两个请求）。
   * 否则上一拍还在提交时，用户按住修饰键点下去会毫无反应 —— 而按钮并没有真的 disabled。
   */
  const onSendButtonClick = (where) => (e) => {
    if (e.button !== 0) return;              // 只认左键（中键 / 右键另有系统行为）
    if (isCloneClick(e)) { cloneBubble(where); return; }
    if (resendingAgain) return;              // 上一拍还在提交：不得再发一个请求
    resendBubble(where);
  };

  const copyImage = async (im) => {
    const r = await window.stab.copyUploadImage(im.file);
    if (!r.ok) { toast(r.message || '复制失败', 'error'); return; }
    toast(r.withPics ? '图片已复制到剪贴板（含提示词与输入图文件名）'
      : (r.withPrompt ? '图片已复制到剪贴板（含提示词元数据）' : '图片已复制到剪贴板'), 'info');
  };

  const remove = () => {
    dispatch({ type: 'MSG_DELETE', convId: conv.id, msgId: msg.id });
  };

  if (editing) {
    return (
      <div className="msg user editing">
        <div
          ref={registerReceiver}
          className={`msg-bubble user-bubble edit-bubble ${dragActive ? 'drag-over' : ''}`}
          onDragEnter={(e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragCounter.current++;
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragCounter.current--;
            if (dragCounter.current <= 0) setDragActive(false);
          }}
          onDragOver={(e) => { if (isFileDrag(e)) e.preventDefault(); }}
          onDrop={onEditDrop}
        >
          {/* 拖入时盖一层虚线蒙版（与底部输入区同一套观感） */}
          {dragActive && <div className="drop-mask">松开以添加图片</div>}

          <div className="attach-row">
            {kept.map((im, i) => (
              <div className="attach-item" key={im.file || i} title={`${im.name || ''}${im.width ? ` · ${im.width}×${im.height}` : ''}`}>
                <img src={uploadUrl(im.file)} alt={im.name} />
                <button className="attach-remove" title="移除图片" onClick={() => setKept((prev) => prev.filter((_, j) => j !== i))}><Icon name="close" size={13} strokeWidth={2.2} /></button>
              </div>
            ))}
            {kept.length < MAX_IMAGES && (
              <button
                className="attach-add"
                title={`添加图片（可直接粘贴 / 拖入这个气泡；还可添加 ${MAX_IMAGES - kept.length} 张）`}
                onClick={pickKeptFiles}
              ><Icon name="plus" size={16} /></button>
            )}
          </div>

          <textarea
            className="composer-textarea edit-textarea"
            value={draftText}
            rows={3}
            autoFocus
            onChange={(e) => setDraftText(e.target.value)}
            onPaste={onEditPaste}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmEdit();
            }}
          />
          <div className="edit-size-row">
            <SizePicker
              className="size-select"
              value={target.size}
              options={target.sizeOptions}
              model={target.model}
              onChange={setSizeOverride}
              selectTitle="尺寸：默认跟随下方输入框的当前尺寸；在这里选择只覆盖这一次重发（最后一项可自定义）"
            />
            {target.model && (
              <span
                className="edit-hint edit-model-hint"
                title={`重发使用下方输入框的当前设置（模型 / 尺寸 / 参数）；本条消息当时用的是「${(msg.model && msg.model.name) || '未知模型'}」${modelChanged ? '，本次将改用上面的模型' : ''}`}
              >
                重发模型：{target.model.name}
              </span>
            )}
            <span className="edit-hint edit-hint-end">Ctrl+Enter 确定</span>
          </div>
          <div className="edit-actions">
            <button className="ghost-btn" onClick={() => setEditing(false)}>取消</button>
            <button className="send-btn" disabled={resending} onClick={confirmEdit}>
              {resending ? '发送中…' : '确定并重新发送'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`msg user${flash ? ' search-flash' : ''}`} data-msg-id={msg.id}>
      {imageMenu.menu && <ImageContextMenu menu={imageMenu.menu} onClose={imageMenu.closeMenu} />}
      <div className="msg-bubble user-bubble">
        {(msg.images && msg.images.length > 0) && (
          <div className="msg-images">
            {msg.images.map((im, i) =>
              im.file ? (
                <div className="user-img-wrap" key={i}>
                  <img
                    className="msg-thumb"
                    src={uploadUrl(im.file)}
                    title={`输入图 ${i + 1}：${im.width || '?'}×${im.height || '?'} · 点击预览`}
                    onClick={() => openLightbox(i)}
                    onContextMenu={(e) => imageMenu.openMenu(e, { kind: 'upload', file: im.file, name: im.name })}
                  />
                  <button className="thumb-copy" title="复制图片" onClick={() => copyImage(im)}><Icon name="copy" size={13} /></button>
                </div>
              ) : (
                <div
                  key={i}
                  className="msg-thumb missing"
                  title="图片文件不存在（可能已被清理）"
                  onContextMenu={(e) => { e.preventDefault(); toast(missingImageMessage('upload'), 'warn'); }}
                >图片缺失</div>
              )
            )}
          </div>
        )}
        {msg.text && <HighlightText className="msg-text" text={msg.text} marks={marks} />}
        {/* 本次发送使用的模型：显示在时间左侧（模型名字右对齐贴住时间，长名字省略号截断） */}
        <div className={`msg-meta${msg.model && msg.model.name ? ' has-model' : ''}`}>
          {msg.model && msg.model.name && (
            <span
              className="msg-model"
              title={`本次发送使用的模型：${msg.model.name}${msg.model.seriesId ? `（系列：${msg.model.seriesId}${msg.model.sourceId ? ` · 来源：${msg.model.sourceId}` : ''}）` : ''}`}
            >
              {msg.model.name}
            </span>
          )}
          <span className="msg-time">{formatClock(msg.createdAt)}</span>
        </div>
      </div>
      <div className="msg-actions">
        {/* 两个发送按钮：普通点击 = 原样再发一遍；按住 Ctrl / Shift 点击 = 只把内容复制到输入框
            （新对话那一支先开一个标签再放进去），等用户编辑后自己发。
            所以这里**不用** disabled 属性：置灰只表示「上一拍还在提交、普通点击会再发一个请求」，
            按住修饰键的克隆不受影响（保留响应性），样式见 .icon-btn.is-pending。
            aria-disabled 只是给辅助技术一个提示（不改变可点性，克隆仍然可用）。 */}
        <button
          className={`icon-btn${resendingAgain ? ' is-pending' : ''}`}
          title="新对话发送（按住 Ctrl / Shift 点击 = 把文字与图片复制到新对话的输入框，先不发送）"
          aria-disabled={resendingAgain ? 'true' : 'false'}
          onClick={(e) => onSendButtonClick('new')(e)}
        ><Icon name="chatPlus" size={16} /></button>
        <button
          className={`icon-btn${resendingAgain ? ' is-pending' : ''}`}
          title="当前对话发送（按住 Ctrl / Shift 点击 = 把文字与图片复制到下方输入框，先不发送）"
          aria-disabled={resendingAgain ? 'true' : 'false'}
          onClick={(e) => onSendButtonClick('current')(e)}
        ><Icon name="send" size={16} /></button>
        {msg.text && <button className="icon-btn" title="复制文字" onClick={copyText}><Icon name="copy" size={16} /></button>}
        <button className="icon-btn" title="编辑并重新发送" onClick={startEdit}><Icon name="pencil" size={16} /></button>
        <button className="icon-btn" title="删除该条消息" onClick={remove}><Icon name="trash" size={16} /></button>
      </div>
    </div>
  );
}
