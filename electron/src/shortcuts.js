'use strict';
/*
 * 全局快捷键（设置 → 基础设置 →「全局快捷键」）—— **全程序唯一**注册 globalShortcut 的地方。
 *
 * 三个动作（id 与设置里的字段名一致，见 store.js 的 DEFAULT_SETTINGS.shortcuts）：
 *   toggleWindow     显示 / 隐藏主界面（隐藏 = 最小化到托盘）
 *   toggleTheme      切换白天 / 黑夜主题（渲染进程改设置，见 src/App.jsx）
 *   newConversation  新建对话（同上）
 * 组合键格式 = Electron accelerator（如 CommandOrControl+Shift+S），空串 = 未设置。
 *
 * 冲突检测分两类（都要报给用户，见「基础设置」页的提示文字）：
 *   ① 程序内部冲突：两个动作填了同一个组合（纯逻辑判定，planShortcuts / findDuplicates）；
 *   ② 系统级冲突：组合已被别的程序或系统占用 —— **只有真的注册一次才知道**
 *      （globalShortcut.register 返回 false），所以 save 之后 apply() 的结果 + 设置页的
 *      check() 试探性注册都要跑一遍真实注册。
 *
 * 测试友好：本模块**不 require electron**，globalShortcut 由调用方注入（main.js 传真实模块，
 * dev-data/qa/shortcuts-test.js 传假的），因此纯逻辑与注册流程都能直接在 node 里断言。
 * 渲染进程有一份「同口径」的轻量实现（src/lib/shortcuts.js：录制 / 显示 / 立即提示重复），
 * 修饰键别名表两处必须一起改（见 AIDEV.md 不变量 36）。
 */

/** 三个动作（顺序 = 设置页展示顺序） */
const ACTIONS = [
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

const ACTION_IDS = ACTIONS.map((a) => a.id);

/** 设置默认值：全部未设置（不预置组合键，避免开箱就和别的软件抢快捷键） */
const DEFAULT_SHORTCUTS = Object.freeze(
  ACTION_IDS.reduce((acc, id) => { acc[id] = ''; return acc; }, {})
);

/** 修饰键别名 → 规范名（与 src/lib/shortcuts.js 同口径，两处必须一起改） */
const MODIFIER_ALIASES = {
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

/** 规范写法里的修饰键顺序（比较是否同一个组合时用，与用户输入顺序无关） */
const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];

/** 允许作为「普通键」的键名（规范写法，小写比较）—— 覆盖日常会用的键，不做全表 */
const KEY_NAMES = [
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  'space', 'tab', 'backspace', 'delete', 'insert', 'return', 'enter', 'escape', 'esc',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'printscreen',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numadd', 'numsub', 'nummult', 'numdiv', 'numdec',
  // 标点：Electron 直接接受这些字符当键名（'+' 只能写成 Plus —— '+' 是分隔符）
  '`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/',
  '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_',
  '{', '}', '|', ':', '"', '<', '>', '?', 'plus'
];

/** 键名规范写法（大小写 / 别名归一） */
const KEY_ALIASES = {
  enter: 'Return',
  esc: 'Escape',
  printscreen: 'PrintScreen',
  plus: 'Plus'
};

/** 键名归一：字母与 F1~F24 走大写，其余（数字 / num* / 标点）原样 */
function normalizeKeyName(lower) {
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, lower)) return KEY_ALIASES[lower];
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  return lower;
}

/** 可以不带修饰键单独使用的键（功能键天生不会和打字冲突） */
const STANDALONE_KEYS = new Set([
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'PrintScreen'
]);

const MODIFIER_SET = new Set(MODIFIER_ORDER);

/**
 * 解析一个 accelerator 字符串（校验 + 规范写法）。
 * @returns {{ok:true, accelerator:string, canonical:string, key:string, modifiers:string[]}
 *         | {ok:false, code:'invalid'|'no-key'|'no-modifier'|'too-many-keys', message:string}}
 *   accelerator = 规范写法（可直接交给 globalShortcut.register）
 *   canonical   = 小写比较串（判断两项是否同一个组合）
 */
function parseAccelerator(input) {
  const raw = String(input === null || input === undefined ? '' : input).trim();
  if (!raw) return { ok: false, code: 'invalid', message: '空组合键' };

  const tokens = raw.split('+').map((t) => t.trim()).filter((t) => t !== '');
  if (!tokens.length) return { ok: false, code: 'invalid', message: '空组合键' };

  const modifiers = [];
  const keys = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MODIFIER_ALIASES, lower)) {
      const name = MODIFIER_ALIASES[lower];
      if (!modifiers.includes(name)) modifiers.push(name);
      continue;
    }
    if (!KEY_NAMES.includes(lower)) {
      return { ok: false, code: 'invalid', message: `无法识别的键：${token}` };
    }
    keys.push(normalizeKeyName(lower));
  }

  if (!keys.length) return { ok: false, code: 'no-key', message: '只有修饰键，还需要一个普通键' };
  if (keys.length > 1) return { ok: false, code: 'too-many-keys', message: '一个组合只能有一个普通键' };

  const key = keys[0];
  if (!modifiers.length && !STANDALONE_KEYS.has(key)) {
    return { ok: false, code: 'no-modifier', message: '需要至少一个修饰键（Ctrl / Alt / Shift / Win）' };
  }

  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  const accelerator = [...ordered, key].join('+');
  return {
    ok: true,
    accelerator,
    canonical: accelerator.toLowerCase(),
    key,
    modifiers: ordered
  };
}

/** 规范写法（失败回空串）；纯比较用 */
function canonicalOf(input) {
  const parsed = parseAccelerator(input);
  return parsed.ok ? parsed.canonical : '';
}

/**
 * 设置里的 shortcuts 字段规整：只认三个动作 id，值必须是合法 accelerator，其余一律清成 ''。
 * （手工改坏 settings.json 时靠它兜住，与 store.normalizeModelGroups 的其它字段同一套路）
 */
function normalizeShortcuts(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const id of ACTION_IDS) {
    const parsed = parseAccelerator(src[id]);
    out[id] = parsed.ok ? parsed.accelerator : '';
  }
  return out;
}

/** 两项是否同一个组合（规范写法比较，顺序 / 别名 / 大小写都算同一个；两个都为空 = 都没变） */
function sameShortcut(a, b) {
  const x = canonicalOf(a);
  const y = canonicalOf(b);
  if (!x && !y) return true;
  return !!x && x === y;
}

/** 整套组合是否没变（决定要不要重新注册，见 main.js 的 applyShortcutsIfChanged） */
function sameShortcuts(a, b) {
  const x = normalizeShortcuts(a);
  const y = normalizeShortcuts(b);
  return ACTION_IDS.every((id) => sameShortcut(x[id], y[id]));
}

/**
 * 组合 id → 与它重复的另一个动作 id（没有重复回 ''）。
 * 只看规范化后的写法：Ctrl+Shift+S 与 control+shift+s 算同一个组合。
 */
function findDuplicates(rawShortcuts) {
  const shortcuts = normalizeShortcuts(rawShortcuts);
  const byCanonical = new Map();
  for (const id of ACTION_IDS) {
    const canonical = canonicalOf(shortcuts[id]);
    if (!canonical) continue;
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
    byCanonical.get(canonical).push(id);
  }
  const dup = {};
  for (const ids of byCanonical.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) dup[id] = ids.find((x) => x !== id) || '';
  }
  return dup;
}

/**
 * 纯逻辑校验（不碰系统）：格式是否合法 + 有没有和别的动作重复。
 * @returns {{shortcuts:object, results:{[actionId]:{ok:boolean, code:string, accelerator:string, conflictWith?:string, message?:string}}}}
 *   code：'empty'（未设置，不算错）| 'ok' | 'invalid' | 'no-key' | 'no-modifier' | 'too-many-keys' | 'duplicate'
 */
function planShortcuts(rawShortcuts) {
  const shortcuts = normalizeShortcuts(rawShortcuts);
  const dup = findDuplicates(shortcuts);
  const results = {};
  for (const id of ACTION_IDS) {
    const value = shortcuts[id];
    if (!value) {
      results[id] = { ok: true, code: 'empty', accelerator: '' };
      continue;
    }
    if (dup[id]) {
      results[id] = { ok: false, code: 'duplicate', accelerator: value, conflictWith: dup[id] };
      continue;
    }
    results[id] = { ok: true, code: 'ok', accelerator: value };
  }
  // 格式非法的项：normalizeShortcuts 已经把非法值清成 ''，这里回头看一眼原始输入，好给出原因
  const src = (rawShortcuts && typeof rawShortcuts === 'object') ? rawShortcuts : {};
  for (const id of ACTION_IDS) {
    if (results[id].accelerator || !String(src[id] || '').trim()) continue;
    const parsed = parseAccelerator(src[id]);
    results[id] = { ok: false, code: parsed.code, accelerator: '', message: parsed.message };
  }
  return { shortcuts, results };
}

/**
 * 真正注册（会先注销本程序此前注册的全部快捷键）。
 * ★ 只有这里能调 globalShortcut.register：全程序就这一份账本，重复注册与否由本模块说了算。
 * @param gsc        globalShortcut 模块（注入，便于测试）
 * @param rawShortcuts 设置里的 shortcuts（脏值会被规整掉）
 * @param onTrigger  (actionId) => void
 * @returns {{shortcuts:object, results:object}} results 里 code = 'ok' | 'empty' | 'invalid' | … | 'taken' | 'error'
 */
function apply(gsc, rawShortcuts, onTrigger) {
  const plan = planShortcuts(rawShortcuts);
  const results = { ...plan.results };
  gsc.unregisterAll();
  for (const id of ACTION_IDS) {
    const r = results[id];
    if (!r.ok || !r.accelerator) continue;
    let registered = false;
    try {
      registered = gsc.register(r.accelerator, () => onTrigger(id));
    } catch (e) {
      // 组合写法不合法 / 平台不支持：Electron 会直接抛
      results[id] = { ok: false, code: 'invalid', accelerator: r.accelerator, message: e && e.message };
      continue;
    }
    if (!registered) {
      // 已经返回 false = 这个组合被别的程序或系统占着（Electron 不会告诉我们是谁占的）
      results[id] = { ok: false, code: 'taken', accelerator: r.accelerator };
      continue;
    }
    results[id] = { ok: true, code: 'ok', accelerator: r.accelerator };
  }
  return { shortcuts: plan.shortcuts, results };
}

/**
 * 试探性检查（**不改设置、不留痕**）：把候选组合拿去真的注册一遍，用来发现「被别的程序占用」。
 * 步骤：① 纯逻辑校验（格式 + 组合之间是否重复）；
 *      ② 通过校验的项：把当前生效的注册全部临时注销 → 逐个真注册 → 记录结果 → 全部注销；
 *      ③ finally 里把**当前生效的那套**重新注册回来（所以调用方完全无感）。
 * 这段窗口是毫秒级的（设置页录完一个组合就调一次）；中途抛错也一定恢复。
 * @param live 当前生效的 shortcuts（恢复用，通常就是 settings.shortcuts）
 */
function check(gsc, candidates, live, onTrigger) {
  const plan = planShortcuts(candidates);
  const results = { ...plan.results };
  const probeIds = ACTION_IDS.filter((id) => results[id].ok && results[id].accelerator);
  if (!probeIds.length) return { shortcuts: plan.shortcuts, results };
  const restore = normalizeShortcuts(live);
  gsc.unregisterAll();
  try {
    for (const id of probeIds) {
      const accelerator = results[id].accelerator;
      let registered = false;
      let code = 'ok';
      try {
        registered = gsc.register(accelerator, () => {});
      } catch (e) {
        code = 'invalid';
      }
      if (!registered && code === 'ok') code = 'taken';
      results[id] = registered
        ? { ok: true, code: 'ok', accelerator }
        : { ok: false, code, accelerator };
    }
  } finally {
    apply(gsc, restore, onTrigger || (() => {}));
  }
  return { shortcuts: plan.shortcuts, results };
}

/**
 * 「显示 / 隐藏主界面」这个快捷键此刻该做什么（纯函数，便于断言兜底分支）。
 *   · 窗口不可见 / 被最小化 → 'show'：唤回（还原 + 显示 + 聚焦）
 *   · 窗口可见 + 托盘可用    → 'hide'：藏到托盘
 *   · 窗口可见 + 托盘不可用  → 'minimize'：**不能 hide** —— 没有托盘就没有回到界面的入口，
 *     窗口会藏进虚空再也叫不回来（与 close 事件的 shouldHideOnClose 同一条铁律）。
 * @returns {'show'|'hide'|'minimize'}
 */
function planWindowToggle({ visible, minimized, trayAvailable }) {
  if (!visible || minimized) return 'show';
  return trayAvailable ? 'hide' : 'minimize';
}

module.exports = {
  ACTIONS,
  ACTION_IDS,
  DEFAULT_SHORTCUTS,
  MODIFIER_ORDER,
  parseAccelerator,
  canonicalOf,
  normalizeShortcuts,
  sameShortcut,
  sameShortcuts,
  findDuplicates,
  planShortcuts,
  planWindowToggle,
  apply,
  check
};
