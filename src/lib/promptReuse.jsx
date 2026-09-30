/*
 * 顶部提示词解析拖放区 + 底部「插入／复制」临时按钮的全局状态
 * ==========================================================
 * 两类临时 UI 都挂在主内容区顶部工具栏，互斥关系如下：
 *   - 拖动图片且鼠标位于「应用内、底部输入框接收区域之外」→ 显示左右解析拖放区（遮蔽正常工具栏）
 *   - 鼠标进入底部输入框完整接收区域 / 离开应用 → 立即恢复正常工具栏
 *   - 正常工具栏下，若存在未失效的待复用提示词，则在「同步模式」左侧显示「插入／复制」
 *
 * 显示状态由「鼠标当前所在位置」实时决定（见 useAppFileDrag 的 dragover 处理），
 * 不是只按图片首次进入窗口判断一次；底部输入框区域的判定优先于全局拖入判定。
 *
 * 待复用提示词与两个按钮作为同一组临时状态（temporary）管理：清理时一起清空，
 * 不会出现「按钮没了但失效数据还在」。异步解析用「版本号 + 会话标识」双保险，
 * 过期结果不会把按钮重新冒出来。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './store.jsx';
import { fileToDataUrl, isImageFile } from './images.js';

const PromptCtx = createContext(null);

export const PROMPT_MESSAGES = {
  none: '该图片未包含可识别的提示词元数据。',
  multiple: '请一次拖入一张图片。',
  notImage: '未识别到图片文件。',
  unsupported: '该图片格式暂不支持读取提示词元数据（支持 PNG / JPEG / WebP）。',
  unknownFormat: '无法识别该图片的文件格式。',
  corrupt: '该图片文件损坏或结构异常，无法解析提示词元数据。',
  tooLarge: '图片过大，已跳过提示词解析。',
  readFailed: '读取图片失败。',
  emptyData: '未读取到图片数据。',
  metaFailed: '读取提示词失败。',
  clipboardFailed: '写入剪贴板失败'
};

/** 元数据错误码 → 场景文案（区分「格式不支持」「文件损坏」「读取失败」，不混为「未找到」） */
export function promptErrorText(res) {
  const code = (res && res.code) || '';
  if (code === 'FORMAT_UNSUPPORTED') return PROMPT_MESSAGES.unsupported;
  if (code === 'FORMAT_UNKNOWN') return PROMPT_MESSAGES.unknownFormat;
  if (code === 'CORRUPT') return PROMPT_MESSAGES.corrupt;
  if (code === 'TOO_LARGE') return PROMPT_MESSAGES.tooLarge;
  if (code === 'BAD_PATH' || code === 'READ_FAILED') return PROMPT_MESSAGES.readFailed;
  return (res && res.message) || PROMPT_MESSAGES.metaFailed;
}

/**
 * 解析一个 File 的提示词元数据。
 * 优先用真实文件路径（不读整份字节）；拿不到路径时回退到 dataUrl。
 * @returns {Promise<{ok:true,prompt:string|null,format?}>|{ok:false,code,message}>}
 */
export async function readPromptFromFile(file) {
  if (!file) return { ok: false, code: 'BAD_PATH', message: PROMPT_MESSAGES.readFailed };
  let p = '';
  try { p = file.path || ''; } catch (e) { p = ''; }
  if (p && typeof p === 'string' && window.stab && window.stab.readImagePrompt) {
    const r = await window.stab.readImagePrompt(p);
    if (r && r.ok) return r;
    // 路径读取失败（权限 / 临时文件）时再退回字节解析
    if (r && (r.code === 'READ_FAILED' || r.code === 'BAD_PATH')) {
      // 继续走 dataUrl 兜底
    } else if (r) {
      return r;
    }
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    if (dataUrl && window.stab && window.stab.readImagePromptFromData) {
      const r = await window.stab.readImagePromptFromData(dataUrl);
      return r || { ok: false, code: 'READ_FAILED', message: PROMPT_MESSAGES.emptyData };
    }
  } catch (e) {
    return { ok: false, code: 'READ_FAILED', message: PROMPT_MESSAGES.readFailed };
  }
  return { ok: false, code: 'READ_FAILED', message: PROMPT_MESSAGES.readFailed };
}

/** 按文件接收顺序取「第一张含有效提示词」的图片；不拼接多张图片的提示词 */
export async function readFirstPromptFromFiles(files) {
  const list = Array.from(files || []).filter(isImageFile);
  if (!list.length) return { ok: false, code: 'NOT_IMAGE', message: PROMPT_MESSAGES.notImage };
  let firstError = null;
  for (const f of list) {
    const r = await readPromptFromFile(f);
    if (r && r.ok && r.prompt) return r;
    if (r && !r.ok && !firstError) firstError = r;
  }
  return { ok: true, prompt: null, firstError };
}

/**
 * 顶部工具栏应该显示哪种临时 UI —— 纯函数，便于直接断言（见 dev-data/qa/promptdrop-test.mjs）。
 *
 * 规则（显示取决于拖动过程中鼠标当前所在的位置，而不是「图片是否进过窗口」）：
 *   - 拖动图片且鼠标在应用内、底部输入框接收区域之外 → 'zones'（左右解析拖放区，遮蔽正常工具栏）
 *   - 鼠标进入底部输入框完整接收区域 → 'toolbar'（立即恢复；有未失效的插入／复制就一并恢复）
 *   - 鼠标离开应用 / 未拖动 → 'toolbar'
 *
 * @param {{dragging?:boolean, overComposer?:boolean}} p
 * @returns {'zones'|'toolbar'}
 */
export function topUiPhase(p) {
  const dragging = !!(p && p.dragging);
  const overComposer = !!(p && p.overComposer);
  return dragging && !overComposer ? 'zones' : 'toolbar';
}

/**
 * 应用级拖入追踪：判断「当前鼠标是否在底部输入框接收区域内」，
 * 供顶部解析拖放区实时切换显隐。Composer 自己仍按原有 onDragEnter/Leave 处理接收反馈。
 *
 * @param {() => HTMLElement|null} getComposerEl 返回底部输入框的完整接收容器
 */
export function useAppFileDrag(getComposerEl) {
  const [topZonesVisible, setTopZonesVisible] = useState(false);
  const visibleRef = useRef(false);
  const lastStampRef = useRef(0);
  const draggingRef = useRef(false);

  const update = useCallback((next) => {
    if (visibleRef.current === next) return;
    visibleRef.current = next;
    setTopZonesVisible(next);
  }, []);

  useEffect(() => {
    const isFileDrag = (e) => {
      const dt = e && e.dataTransfer;
      if (!dt) return false;
      const types = dt.types ? Array.from(dt.types) : [];
      return types.indexOf('Files') >= 0;
    };

    /** 鼠标当前是否落在底部输入框完整接收区域内（含其内部子元素） */
    const pointerInComposer = (e) => {
      if (!e || typeof e.clientX !== 'number') return false;
      const el = typeof getComposerEl === 'function' ? getComposerEl() : null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };

    const onDragOver = (e) => {
      if (!isFileDrag(e)) { draggingRef.current = false; update(false); return; }
      draggingRef.current = true;
      lastStampRef.current = Date.now();
      // 每次移动都按实时指针位置判断：进入输入框区域立即恢复工具栏，移出立即重新显示
      update(topUiPhase({ dragging: true, overComposer: pointerInComposer(e) }) === 'zones');
    };

    const onDragLeave = (e) => {
      // relatedTarget 为 null = 指针离开窗口：收起解析区
      if (e && e.relatedTarget === null) { draggingRef.current = false; update(false); }
    };

    const finish = (e) => {
      // 阻止浏览器默认行为：把图片文件拖进窗口不应该变成「用浏览器打开该文件」
      if (e && e.preventDefault) e.preventDefault();
      draggingRef.current = false;
      lastStampRef.current = 0;
      update(false);
    };

    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', finish, true);
    window.addEventListener('dragend', finish, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('blur', finish);
    // 兜底：拖到窗口外松手时 drop/dragend 不一定回到本窗口，用「dragover 静默」判定已离开
    // （阈值给得宽松些：鼠标停在窗口边缘、系统压缩 dragover 事件时都不会误收起）
    const idle = setInterval(() => {
      if (draggingRef.current && Date.now() - lastStampRef.current > 800) finish();
    }, 200);

    return () => {
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', finish, true);
      window.removeEventListener('dragend', finish, true);
      window.removeEventListener('dragleave', onDragLeave, true);
      window.removeEventListener('blur', finish);
      clearInterval(idle);
    };
  }, [getComposerEl, update]);

  return { topZonesVisible };
}

export function PromptReuseProvider({ children }) {
  const { state, dispatch } = useApp();
  const [modal, setModal] = useState(null);           // { text } —— 纯展示，不参与清理规则
  const composerRef = useRef(null);
  const requestRef = useRef(0);

  const registerComposerEl = useCallback((el) => { composerRef.current = el || null; }, []);
  const getComposerEl = useCallback(() => composerRef.current, []);
  const { topZonesVisible } = useAppFileDrag(getComposerEl);

  /**
   * 每次解析分配一个版本号（自增，不依赖时间戳，避免同毫秒碰撞）。
   * 解析是异步的：用户可能在解析完成前就切换会话 / 发送 / 删除 / 修改输入框文字，
   * 只有「分配到的版本号仍是当前版本」的结果才允许写入临时状态。
   */
  const nextRequestId = useCallback(() => {
    requestRef.current += 1;
    return requestRef.current;
  }, []);

  /**
   * 待复用提示词存在全局 store 的 `temporary` 里：
   * 切换会话 / 新建 / 删除由 reducer 的 clearReuse 统一清理，避免「按钮没了数据还在」。
   */
  const setReusePrompt = useCallback((text, source) => {
    dispatch({ type: 'CONV_REUSE_SET', text: typeof text === 'string' ? text : '', source: source || 'bottom' });
  }, [dispatch]);

  const clearTemporary = useCallback(() => {
    dispatch({ type: 'CONV_REUSE_CLEAR' });
  }, [dispatch]);  /** 纯数据展示（查看弹窗）——不参与临时状态的清理规则 */
  const showPromptModal = useCallback((text) => {
    if (typeof text !== 'string' || !text) return;
    setModal({ text });
  }, []);

  const temporary = state.temporary || null;

  const value = useMemo(() => ({
    temporary,
    hasReuse: !!(temporary && temporary.text),
    reuseText: temporary ? temporary.text : '',
    topZonesVisible,
    modal,
    composerRef,
    registerComposerEl,
    clearTemporary,
    setReusePrompt,
    showPromptModal,
    closePromptModal: () => setModal(null),
    nextRequestId
  }), [temporary, topZonesVisible, modal, registerComposerEl, clearTemporary, setReusePrompt, showPromptModal, nextRequestId]);

  return <PromptCtx.Provider value={value}>{children}</PromptCtx.Provider>;
}

export function usePromptReuse() {
  const ctx = useContext(PromptCtx);
  if (!ctx) throw new Error('usePromptReuse 必须在 PromptReuseProvider 内使用');
  return ctx;
}
