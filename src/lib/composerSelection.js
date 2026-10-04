/*
 * 输入区「当前设置」的实时镜像（模型 id + 尺寸 + 高级参数）
 * ======================================================
 * 谁写：底部输入框（Composer）是**唯一**写入方 —— 模型下拉 / 尺寸下拉 / 参数面板一变就写进来。
 * 谁读：「编辑并重新发送」（UserMessage 的「确定并重新发送」）—— 重发一律使用
 *       **输入区当前设置**，而不是这条消息当时用的模型与参数（见 AIDEV.md §4.7）。
 *
 * 为什么不放进 lib/store.jsx 的全局 state：参数面板的数字 / 文本框每敲一个字符就会变，
 * 走全局 reducer 会让整条消息列表（含结果图）跟着重渲染。这里用模块级外部状态 +
 * useSyncExternalStore，只通知真正订阅了它的组件（编辑气泡），消息列表不受影响。
 */
import { useCallback, useSyncExternalStore } from 'react';

/** @type {{modelId: string, params: object}} 当前输入区的模型 id 与参数（未挂载 / 尚未写入时为空） */
let snapshot = { modelId: '', params: {} };
const listeners = new Set();

function shallowEqual(a, b) {
  if (a === b) return true;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** 读当前输入区设置（同步、永远是最新一拍；编辑重发在「点击那一刻」取一次） */
export function getComposerSelection() {
  return snapshot;
}

export function subscribeComposerSelection(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 由 Composer 在模型 / 尺寸 / 高级参数变化后写入。
 * 内容没变就不通知（参数面板重渲染、切协议重置出同样的值都不会惊动订阅者）。
 */
export function setComposerSelection(modelId, params) {
  const next = { modelId: modelId || '', params: params || {} };
  if (snapshot.modelId === next.modelId && shallowEqual(snapshot.params, next.params)) return;
  snapshot = next;
  for (const fn of Array.from(listeners)) fn();
}

/**
 * 订阅输入区当前设置：编辑气泡据此显示「这次重发会用哪个模型 / 哪个尺寸」。
 * @param {boolean} enabled 只在真正需要时订阅（编辑气泡打开时）—— 参数面板里每敲一个字符
 *        都会变一次，没必要让消息列表跟着重渲染；关闭期间依旧可以直接调 getComposerSelection()。
 */
export function useComposerSelection(enabled = true) {
  const subscribe = useCallback(
    (fn) => (enabled ? subscribeComposerSelection(fn) : () => {}),
    [enabled]
  );
  return useSyncExternalStore(subscribe, getComposerSelection, getComposerSelection);
}
