/*
 * 把「用户气泡的内容」搬进输入区草稿的过路通道
 * ================================================
 * 场景（AIDEV.md §4.13「Alt 式复用」）：在用户气泡的「当前对话发送 / 新对话发送」按钮上
 * **按住 Ctrl / Shift 点击**时，不直接发请求，而是把这条气泡的文字 + 输入图**原封不动**
 * 拷进底部输入框，等用户自己改完再发。
 *
 * 为什么需要一条通道：写的一方（UserMessage，在消息列表里）与读的一方（Composer，在底部）
 * 之间隔着 ChatView 的中间层，而且「新对话发送」那一支还要先切标签（新建 + 激活），
 * 目标是**另一个**输入区 —— 一次性事件不够用：
 *
 * ```
 * [UserMessage] 读回图片 → dispatch CONV_ADD（新会话，立刻成为当前标签）
 *                              └─ Composer 的 convId 变了 → 它会去取「新会话自己的草稿」
 * [Composer 的取草稿 effect] 取到的就是这里 push 进来的这一份 → 落到 text / attachments
 * ```
 *
 * 于是这里存的是**按会话 id 排队的待落草稿**：谁（哪个标签）的输入区认领它，谁就消费掉它。
 * 认领的判定由调用方自己做（会话 id 命中），本模块只负责存取，不碰 React 状态。
 *
 * 生命周期：纯内存、进程内单例。没有会话认领的项（比如用户在这期间删掉了目标标签）会在
 * 下一次 push 时被顺带清理掉上限之外的旧项，不会无限增长。
 */

/** @type {Map<string, {text:string, attachments:Array}>} 会话 id → 待落草稿 */
const pending = new Map();

/** 最多同时挂几份待落草稿（正常只会有 1 份；超出的当过期数据丢弃，避免无人认领时越积越多） */
const MAX_PENDING = 8;

/**
 * 等这个标签的输入区去落草稿。
 * @param {string} convId 目标会话 id（输入区归属的标签）
 * @param {{text?:string, attachments?:Array}} draft 草稿内容（attachments 见 Composer 的形态：
 *        [{file,name,srcName,mime,width,height,dataUrl}]）
 */
export function pushComposerDraft(convId, draft) {
  if (!convId) return;
  pending.delete(convId);                 // 同一个标签只留最新一份
  pending.set(convId, {
    text: (draft && draft.text) || '',
    attachments: (draft && draft.attachments) || []
  });
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
  }
}

/**
 * 认领这个标签的待落草稿（认领即删除，只会落一次）。
 * @returns {{text:string, attachments:Array}|null} 没有待落草稿时 null
 */
export function takeComposerDraft(convId) {
  if (!convId) return null;
  const item = pending.get(convId);
  if (!item) return null;
  pending.delete(convId);
  return item;
}

/**
 * 通知「这个标签的输入区现在就在眼前，立刻把它认领走」。
 * 存在的唯一理由：push 与激活标签在**同一拍**里完成（Ctrl+点击「新对话发送」）时，
 * Composer 的取草稿 effect 可能已经跑过了 —— 没有这一声通知，那份草稿要等下次
 * 切标签回来才落进输入框。Composer 监听这个事件并立即认领（见 components/Composer.jsx）。
 * @param {string} convId 目标会话 id
 */
export function announceComposerDraft(convId) {
  if (!convId) return;
  const detail = { convId };
  window.dispatchEvent(new CustomEvent('stabstab:bubble-draft', { detail }));
}

/**
 * 这次点击是不是「按住修饰键的克隆点击」（只把气泡内容拷进输入框，不发送）。
 *
 * 三个修饰键都算：Ctrl（Windows / Linux 主力）、Cmd（macOS 上的 ⌘）、Shift。Electron 里
 * 按住 Ctrl 点左键不会触发任何系统级行为，所以在三个平台上都安全。要求左键 ——
 * 中键 / 右键点击另有系统行为，不该被当成克隆。
 *
 * 单独抽成纯函数（只读事件对象上那几个布尔值）是为了能直接断言，见
 * dev-data/qa/composer-draft-test.mjs。
 *
 * @param {{button?:number, ctrlKey?:boolean, metaKey?:boolean, shiftKey?:boolean}} e 点击事件
 */
export function isCloneClick(e) {
  if (!e) return false;
  if (e.button !== 0) return false;
  return !!(e.ctrlKey || e.metaKey || e.shiftKey);
}
