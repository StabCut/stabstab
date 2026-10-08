'use strict';
/*
 * 关闭窗口（点标题栏 ×）时的行为 ——「直接退出程序」还是「最小化到托盘」。
 *
 *   'quit' 直接退出程序（进程结束，正在等待的请求随之中断）
 *   'tray' 最小化到托盘：只是把窗口 hide 掉，**进程继续在后台运行**
 *          （正在等待的生成请求不受影响照常出结果），点击托盘图标 / 托盘菜单「显示主界面」再打开
 *
 * 取值来源：`settings.json` 的 `closeAction`（设置 → 基础设置 →「关闭窗口时」）。
 *   · 有显式设置（'tray' / 'quit'）→ 一律按用户的设置走，开发模式也不例外；
 *   · 从未设置（'' 或非法值）→ 按运行形态给默认值：
 *       - 开发模式（npm run dev，未打包）→ 'quit'：调试时经常要直接关掉程序
 *       - 打包后（安装版 / 便携版）      → 'tray'：关窗口不打断后台任务，符合桌面工具习惯
 *
 * 本模块**不 require electron**（纯函数），便于回归脚本直接断言
 * （dev-data/qa/close-behavior-test.js），也便于渲染进程按同一口径显示默认值文案。
 */

/** 合法取值（'' 表示「跟随默认」，不是合法显式值） */
const CLOSE_ACTIONS = ['tray', 'quit'];

/** 界面 / 磁盘上的值 → 合法值；非法（含从未设置的空值、大小写与空格差异）统一回 '' */
function normalizeCloseAction(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  return CLOSE_ACTIONS.includes(s) ? s : '';
}

/**
 * 实际生效的行为。
 * @param {object} settings   当前设置（读 settings.closeAction）
 * @param {boolean} isPackaged 是否打包后运行（Electron 的 app.isPackaged）
 * @returns {'tray'|'quit'}
 */
function resolveCloseAction(settings, isPackaged) {
  return normalizeCloseAction(settings && settings.closeAction) || (isPackaged ? 'tray' : 'quit');
}

/**
 * 窗口收到 close 事件时，要不要拦下来改成「隐藏到托盘」。
 * 三个条件都满足才拦：正在退出 = 否、生效行为 = tray、托盘图标确实可用。
 * 最后一条是安全底线：托盘建不出来（例如 Linux 没有托盘宿主）时**必须放行真关**，
 * 否则窗口一藏，用户再也没有入口把它叫回来（进程变成看不见的僵尸）。
 *
 * @param {object} o
 * @param {boolean} o.isQuitting    正在退出（托盘菜单「退出程序」/ 系统关机）→ 放行
 * @param {string}  o.closeAction   生效行为（resolveCloseAction 的结果）
 * @param {boolean} o.trayAvailable 托盘图标是否已就绪
 */
function shouldHideOnClose(o) {
  const m = o || {};
  if (m.isQuitting) return false;
  if (m.closeAction !== 'tray') return false;
  return m.trayAvailable !== false;
}

module.exports = {
  CLOSE_ACTIONS,
  normalizeCloseAction,
  resolveCloseAction,
  shouldHideOnClose
};
