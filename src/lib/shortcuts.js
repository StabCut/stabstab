/*
 * 全局快捷键 —— 渲染进程这一半（设置 → 基础设置 →「全局快捷键」）
 * ==================================================================
 * 职责：
 *   · 三个动作的展示文案（label / hint）；
 *   · 把键盘事件录成 Electron accelerator（acceleratorFromKeyEvent）；
 *   · 组合键的显示写法（formatAccelerator）；
 *   · **保存前**的即时提示：录制时就地判断有没有和别的动作重复（duplicateOf），
 *     以及把主进程试探性注册的结果翻译成一句话（shortcutStatusText）。
 *
 * ★ 真正的注册、以及「被别的程序占用」的判定都在主进程 electron/src/shortcuts.js
 *   （globalShortcut.register 返回 false 才知道被别人占了，渲染进程不可能知道）。
 *   下面这几张表（修饰键别名 / 修饰键顺序 / 可识别的键名 / 键名归一）与它**同口径**
 *   —— 与 modelSeries.js 的两处 resolveModel 是同一套路：改一处必须改另一处（见 AIDEV.md 不变量 36）。
 *   两边不一致的后果：录制时看着「没重复」，保存后主进程却报重复 —— QA 有对照断言盯着。
 */

/** 修饰键别名 → 规范名（主进程 electron/src/shortcuts.js#MODIFIER_ALIASES 同口径） */
export const MODIFIER_ALIASES = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  cmdorcontrol: 'CommandOrControl',
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  win: 'Super',
  windows: 'Super'
};

/** 规范写法里的修饰键顺序（同一组合换个顺序写也算同一个） */
export const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];

/** 键名别名 → 规范写法 */
export const KEY_ALIASES = {
  enter: 'Return',
  esc: 'Escape',
  printscreen: 'PrintScreen',
  plus: 'Plus'
};

/** 允许作为「普通键」的键名（小写比较，与主进程同表） */
export const KEY_NAMES = [
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  'space', 'tab', 'backspace', 'delete', 'insert', 'return', 'enter', 'escape', 'esc',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'printscreen',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numadd', 'numsub', 'nummult', 'numdiv', 'numdec',
  '`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/',
  '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_',
  '{', '}', '|', ':', '"', '<', '>', '?', 'plus'
];

/** 键名归一：字母与 F1~F24 走大写，其余（数字 / num* / 标点）原样（与主进程同口径） */
export function normalizeKeyName(lower) {
  const key = String(lower || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, key)) return KEY_ALIASES[key];
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  return key;
}

/** 三个动作（顺序 = 设置页展示顺序；id 与主进程 electron/src/shortcuts.js 的 ACTIONS 一致） */
export const SHORTCUT_ACTIONS = [
  {
    id: 'toggleWindow',
    label: '显示 / 隐藏主界面',
    hint: '按一次藏到托盘（进程继续在后台跑，正在等待的生成不会中断），再按一次把窗口唤回来 —— 与点托盘图标等价。'
  },
  {
    id: 'toggleTheme',
    label: '切换外观主题（白天 / 黑夜）',
    hint: '在当前实际显示的主题上取反：正显示黑暗就切到白天，正显示白天就切到黑暗（原来选「跟随系统」会被改成具体主题）。'
  },
  {
    id: 'newConversation',
    label: '新建对话',
    hint: '与点侧栏「新建对话」按钮等价：新增一个空对话并切过去（窗口不会因此弹出）。'
  }
];

export const SHORTCUT_ACTION_IDS = SHORTCUT_ACTIONS.map((a) => a.id);

/** 空设置：三个动作都未设置（与主进程 DEFAULT_SHORTCUTS / store.js 的默认值一致） */
export const EMPTY_SHORTCUTS = Object.freeze(
  SHORTCUT_ACTION_IDS.reduce((acc, id) => { acc[id] = ''; return acc; }, {})
);

/**
 * 设置里的快捷键字段规整（只认三个动作 id + 字符串），缺失/脏值一律回 ''。
 * 注意：这里**不做合法性校验**（非法组合交给主进程判定并回报 'invalid'），只保证结构可用。
 */
export function normalizeShortcutValues(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  return SHORTCUT_ACTION_IDS.reduce((acc, id) => {
    acc[id] = typeof src[id] === 'string' ? src[id].trim() : '';
    return acc;
  }, {});
}

/**
 * 规范化比较串（与主进程 canonicalOf 同口径）：修饰键按固定顺序排、键名归一、全小写。
 * 用来判断「两项是不是同一个组合」——Ctrl+Shift+S 与 shift+ctrl+s 应当算同一个。
 * 不合法的组合（普通键没带修饰键、只有修饰键、认不出的键）一律回 ''，与主进程一致。
 */
export function canonicalize(accel) {
  const parsed = splitAccelerator(accel);
  return parsed ? parsed.canonical : '';
}

/**
 * 拆解 + 规范化；不合法回 null（口径与主进程 parseAccelerator 一致）：
 * 必须恰好一个普通键，且「普通键 + 修饰键」或「功能键 / PrintScreen 单用」。
 */
export function splitAccelerator(accel) {
  const raw = String(accel === null || accel === undefined ? '' : accel).trim();
  if (!raw) return null;
  const tokens = raw.split('+').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return null;
  const modifiers = [];
  const keys = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MODIFIER_ALIASES, lower)) {
      const name = MODIFIER_ALIASES[lower];
      if (!modifiers.includes(name)) modifiers.push(name);
      continue;
    }
    if (!KEY_NAMES.includes(lower)) return null;
    keys.push(normalizeKeyName(lower));
  }
  if (keys.length !== 1) return null;
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  // 普通键必须带修饰键；功能键 / PrintScreen 可以单用（与主进程同一个判定）
  if (!ordered.length && !STANDALONE_KEYS.has(keys[0])) return null;
  return {
    key: keys[0],
    modifiers: ordered,
    accelerator: [...ordered, keys[0]].join('+'),
    canonical: [...ordered, keys[0]].join('+').toLowerCase()
  };
}

/** 两个组合是否相同（都会先规范化；两个都为空 = 都没设置，也算没变） */
export function sameShortcut(a, b) {
  const x = canonicalize(a);
  const y = canonicalize(b);
  if (!x && !y) return true;
  return !!x && x === y;
}

/**
 * 这套组合里，某动作与谁重复。
 * @returns 另一个动作 id（没有重复回 ''）
 */
export function duplicateOf(shortcuts, actionId) {
  const values = normalizeShortcutValues(shortcuts);
  const mine = canonicalize(values[actionId]);
  if (!mine) return '';
  return SHORTCUT_ACTION_IDS.find((id) => id !== actionId && canonicalize(values[id]) === mine) || '';
}

/** 动作 id → 展示名（找不到就回 id 本身） */
export function actionLabel(id) {
  const a = SHORTCUT_ACTIONS.find((x) => x.id === id);
  return a ? a.label : String(id || '');
}

/**
 * 纯逻辑校验（**不碰系统**，格式 + 与本程序其它动作是否重复）——与主进程 planShortcuts 同口径。
 * 录制完立刻调它：用户不用等主进程回来的那一下，就能看到「和谁重复」。
 * 「被别的程序占用」只能靠主进程真注册一次（globalShortcut.register 返回 false），所以
 * 紧接着还会调一次 window.stab.checkShortcuts()，用它的结果覆盖这里的结论。
 * @returns {[actionId]: {ok, code:'empty'|'ok'|'invalid'|'duplicate', accelerator, conflictWith?}}
 */
export function planShortcuts(raw) {
  const values = normalizeShortcutValues(raw);
  const results = {};
  for (const id of SHORTCUT_ACTION_IDS) {
    const value = values[id];
    if (!value) { results[id] = { ok: true, code: 'empty', accelerator: '' }; continue; }
    if (!splitAccelerator(value)) { results[id] = { ok: false, code: 'invalid', accelerator: '' }; continue; }
    const other = duplicateOf(values, id);
    results[id] = other
      ? { ok: false, code: 'duplicate', accelerator: value, conflictWith: other }
      : { ok: true, code: 'ok', accelerator: value };
  }
  return results;
}

// ---------- 录制：键盘事件 → accelerator ----------

/** 可以不带修饰键单独使用的键（功能键 / PrintScreen 天生不会和打字冲突，与主进程一致） */
const STANDALONE_KEYS = new Set([
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'PrintScreen'
]);

/** 只按了修饰键时的 e.code / e.key（录制中要提示「再按一个普通键」，而不是当成一次非法输入） */
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
  'MetaLeft', 'MetaRight', 'CapsLock', 'NumLock', 'ScrollLock'
]);
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

/** e.code → Electron 键名（走物理键位，不受键盘布局影响，正是全局快捷键该有的口径） */
const CODE_KEYS = {
  Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Escape: 'Escape', PrintScreen: 'PrintScreen',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`'
};

/** e.code → 键名；识别不了回 '' */
function keyNameFromEvent(e) {
  const code = String(e.code || '');
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  // 兜底：合成事件（QA 断言里手造 KeyboardEvent）常常没有 code，用 e.key 认单个字母
  const key = String(e.key || '');
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
  return '';
}

/** 按下的键是不是「纯修饰键」（录制中要提示用户继续按普通键，而不是当成一次非法输入） */
export function isModifierKeyEvent(e) {
  if (!e) return false;
  return MODIFIER_CODES.has(String(e.code || '')) || MODIFIER_KEYS.has(String(e.key || ''));
}

/**
 * 把一次 keydown 录成 Electron accelerator。
 * 规则：至少一个修饰键（Ctrl / Alt / Shift / Win）；功能键与 PrintScreen 可以单用。
 * @returns {{ok:true, accelerator:string} | {ok:false, code:'MODIFIER_ONLY'|'NO_MODIFIER'|'UNKNOWN', message:string}}
 */
export function acceleratorFromKeyEvent(e) {
  if (!e) return { ok: false, code: 'UNKNOWN', message: '无法识别的按键' };
  const key = keyNameFromEvent(e);
  if (!key) {
    return isModifierKeyEvent(e)
      ? { ok: false, code: 'MODIFIER_ONLY', message: '再按一个普通键（如 A、F5、1）' }
      : { ok: false, code: 'UNKNOWN', message: '这个键不支持，换一个试试' };
  }
  const modifiers = [];
  if (e.ctrlKey) modifiers.push('CommandOrControl');   // 跨平台写法：Win/Linux = Ctrl，macOS = Cmd
  if (e.altKey) modifiers.push('Alt');
  if (e.shiftKey) modifiers.push('Shift');
  if (e.metaKey) modifiers.push('Super');              // Win 键 / macOS 的 Cmd 键
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  if (!ordered.length && !STANDALONE_KEYS.has(key)) {
    return { ok: false, code: 'NO_MODIFIER', message: '需要至少一个修饰键（Ctrl / Alt / Shift / Win）' };
  }
  return { ok: true, accelerator: [...ordered, key].join('+') };
}

// ---------- 显示 ----------

const MODIFIER_LABELS = {
  CommandOrControl: 'Ctrl',       // 见下：macOS 用 Cmd（formatAccelerator 里按平台换）
  Command: 'Cmd',
  Control: 'Ctrl',
  Alt: 'Alt',
  AltGr: 'AltGr',
  Shift: 'Shift',
  Super: 'Win'
};

const KEY_LABELS = {
  Return: 'Enter', Escape: 'Esc', Space: '空格', Plus: '+', PrintScreen: 'PrtSc',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '退格'
};

/** 组合键的显示写法：Ctrl + Shift + S（macOS 上把 Ctrl/Win 换成 Cmd） */
export function formatAccelerator(accel, platform) {
  const parsed = splitAccelerator(accel);
  if (!parsed) return String(accel || '');
  const mac = platform === 'darwin';
  const parts = parsed.modifiers.map((m) => {
    if (m === 'CommandOrControl') return mac ? 'Cmd' : 'Ctrl';
    if (m === 'Super') return mac ? 'Cmd' : 'Win';
    return MODIFIER_LABELS[m] || m;
  });
  parts.push(KEY_LABELS[parsed.key] || parsed.key);
  return parts.join(' + ');
}

/**
 * 一行状态文案（设置页每个动作下面那行小字）。
 * @param value      草稿里的组合（'' = 未设置）
 * @param savedValue 已保存生效的组合（用于区分「已生效」与「待保存」）
 * @param result     主进程回报的结果 {ok, code, conflictWith, message}（可空）
 * @returns {{kind:'empty'|'ok'|'pending'|'warn', text:string}}
 */
export function shortcutStatusText(value, savedValue, result) {
  if (!value) return { kind: 'empty', text: '未设置：这个动作没有全局快捷键' };
  if (result && result.ok === false) {
    const other = result.conflictWith ? `「${actionLabel(result.conflictWith)}」` : '';
    const text = {
      duplicate: `与 ${other} 的快捷键重复，保存后不会生效`,
      taken: '已被其它程序占用（系统不允许注册），换一个组合试试',
      invalid: '不支持的组合，换一个试试',
      'no-modifier': '需要至少一个修饰键（Ctrl / Alt / Shift / Win）',
      'no-key': '只有修饰键，还需要一个普通键',
      'too-many-keys': '一个组合只能有一个普通键'
    }[result.code] || (result.message || '这个组合不能用');
    return { kind: 'warn', text };
  }
  if (value !== String(savedValue || '')) return { kind: 'pending', text: '待保存：点右下角「保存」后生效' };
  return { kind: 'ok', text: '已生效' };
}
