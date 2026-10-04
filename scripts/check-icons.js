#!/usr/bin/env node
/*
 * 图标源文件校验
 * ==============
 * 图标源文件在 assets/icons/*.svg，由 src/components/Icon.jsx 通过 ?raw 导入。
 * 本脚本不生成任何东西，只检查「引用 / 源文件 / 规范」三者是否一致。
 *
 * 用法： node scripts/check-icons.js
 * 退出码：0 = 全部通过；1 = 有问题（可接进 CI / pre-commit）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const ICON_JSX = path.join(ROOT, 'src', 'components', 'Icon.jsx');
const DIR = path.join(ROOT, 'assets', 'icons');
const problems = [];
const warnings = [];

// 注意：行注释只匹配「行首」，否则会把 xmlns="http://..." 里的 // 当成注释截断
const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '');  // 整行行注释

/** kebab-case 文件名 -> camelCase 变量名主干（folder-download-line -> folderDownloadLine） */
const kebabToCamel = (s) => s.replace(/-+([a-z0-9])/g, (_m, c) => c.toUpperCase());

// ---------- 1) Icon.jsx ----------
const jsxRaw = fs.readFileSync(ICON_JSX, 'utf8');
const jsx = stripComments(jsxRaw);

const imported = new Map();  // 变量名 -> 文件名
const impRe = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+?)\?raw['"]/g;
let m;
while ((m = impRe.exec(jsx)) !== null) {
  const p = m[2];
  if (!p.includes('assets/icons/')) continue;
  imported.set(m[1], p.split('assets/icons/').pop());
}
if (!imported.size) problems.push('Icon.jsx 里没有找到 assets/icons/*.svg?raw 的导入');

const rawBody = jsx.slice(jsx.indexOf('const RAW = {'), jsx.indexOf('};', jsx.indexOf('const RAW = {')));
const rawNames = [];
for (const line of rawBody.split('\n')) {
  const hit = /^\s*([a-z][A-Za-z0-9]*)\s*:\s*([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(line);
  if (!hit) continue;
  rawNames.push(hit[1]);
  if (!imported.has(hit[2])) problems.push(`RAW 里的 "${hit[1]}" 指向未导入的变量 ${hit[2]}`);
}
if (!rawNames.length) problems.push('Icon.jsx 的 RAW 表为空');

// ---------- 2) 源文件规范 ----------
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.svg')) : [];
for (const [varName, file] of imported) {
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) { problems.push(`缺少源文件：assets/icons/${file}`); continue; }
  const svg = stripComments(fs.readFileSync(full, 'utf8'));

  // 只检查根 <svg> 标签上的属性；内部 <rect width="11"> 属于图形本身，是正常的。
  // 先把换行折叠成空格，避免 [^>]* 碰到换行就停止匹配（根标签常写成多行）。
  const flat = svg.replace(/\s*\n\s*/g, ' ');
  const rootTag = (flat.match(/<svg\b[^>]*>/i) || [''])[0];
  if (!rootTag) problems.push(`${file}: 没有 <svg> 根元素`);
  if (!/viewBox\s*=\s*"/i.test(rootTag)) problems.push(`${file}: 根 <svg> 缺 viewBox`);
  // 根标签的 width/height 只是提示：运行时 Icon.jsx 会去掉，不影响显示。
  // （iconfont 导出的文件普遍带 width="200" height="200"）
  if (/(?<!stroke-)width\s*=\s*"/i.test(rootTag) || /(?<!stroke-)height\s*=\s*"/i.test(rootTag)) {
    warnings.push(`${file}: 根 <svg> 带 width/height（运行时会被去掉，建议手动删除更干净）`);
  }

  // 根标签上的具体颜色会被 .icon--stroke / .icon--fill 覆盖（CSS 优先于呈现属性），
  // 想保留就得放进内部元素，或让组件自动加 .icon--brand。
  const rootColors = [...rootTag.matchAll(/\b(?:fill|stroke)\s*=\s*"([^"]+)"/gi)]
    .map((m) => m[1].trim().toLowerCase())
    .filter((v) => v && v !== 'none' && v !== 'currentcolor');
  if (rootColors.length) {
    problems.push(`${file}: 根 <svg> 上的颜色（${rootColors.join(', ')}）会被 CSS 覆盖，`
      + '请移到内部图形元素上，或改用 currentColor');
  }

  // 具体颜色统计：单色 -> 会加 .icon--brand 保留原色；多色 -> 必须标注 icon-color: multi
  const concrete = [...flat.matchAll(/\b(?:fill|stroke)\s*=\s*"([^"]+)"/gi)]
    .map((m) => m[1].trim().toLowerCase())
    .filter((v) => v && v !== 'none' && v !== 'currentcolor');
  const distinct = [...new Set(concrete)];
  const annotated = /icon-color\s*:\s*multi/i.test(fs.readFileSync(full, 'utf8'));

  if (distinct.length > 1 && !annotated) {
    problems.push(`${file}: 含 ${distinct.length} 种颜色（多色图标），请在文件顶部加一行 `
      + '`<!-- icon-color: multi -->` 说明这是有意为之（当前会被图标校验拦下）');
  }

  // 未闭合的图形标签（HTML 解析规则下，后面的图形会变成前一个的**子元素**，
  // 曾导致「关闭」图标只画出一条斜线）。Icon.jsx 已会自动补自闭合兜住，
  // 但源文件写规范些更安全，故仅作提示。
  const unclosed = (flat.match(/<(?:path|circle|rect|polygon|ellipse|line|polyline)\b[^>]*?(?<!\/)>/gi) || []);
  if (unclosed.length) {
    warnings.push(`${file}: 有 ${unclosed.length} 个图形标签未自闭合，建议写成 \`<path ... />\``);
  }

  // 文件名与导入变量名的约定：xxx.svg -> xxxSrc；允许 iconfont 那种中划线文件名，
  // 按 kebab -> camel 归一后比较（folder-download-line.svg -> folderDownloadLineSrc）。
  if (varName.replace(/Src$/, '') !== kebabToCamel(path.basename(file, '.svg'))) {
    problems.push(`${file}: 导入变量名 ${varName} 与文件名不匹配（约定 kebab 文件名 -> camel 变量：`
      + `${path.basename(file, '.svg')} -> ${kebabToCamel(path.basename(file, '.svg'))}Src）`);
  }
}

// ---------- 3) 孤儿文件 ----------
for (const f of files) {
  if (![...imported.values()].includes(f)) problems.push(`assets/icons/${f} 未被 Icon.jsx 引用（孤儿文件）`);
}

// ---------- 4) 代码里用到的 name ----------
const used = new Set();
const jsxFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jsx$/.test(e.name) && e.name !== 'Icon.jsx') jsxFiles.push(p);
  }
})(path.join(ROOT, 'src'));

for (const f of jsxFiles) {
  const t = stripComments(fs.readFileSync(f, 'utf8'));
  const re = /<Icon\s[^>]*\bname="([a-z][A-Za-z0-9]*)"/g;
  let x;
  while ((x = re.exec(t)) !== null) used.add(x[1]);
}
for (const u of [...used].sort()) {
  if (!rawNames.includes(u)) problems.push(`代码里用了 <Icon name="${u}"> 但 RAW 表里没有`);
}

// ---------- 输出 ----------
console.log(`源文件      assets/icons/  ${files.length} 个 SVG`);
console.log(`Icon.jsx    ${imported.size} 个导入 / ${rawNames.length} 个 RAW 条目`);
console.log(`代码引用    ${used.size} 个：${[...used].sort().join(', ')}`);
console.log('');
if (problems.length) {
  console.log(`发现 ${problems.length} 个问题：`);
  problems.forEach((p) => console.log('  ✗ ' + p));
  if (warnings.length) {
    console.log(`另有 ${warnings.length} 条提示：`);
    warnings.forEach((w) => console.log('  · ' + w));
  }
  process.exit(1);
}
if (warnings.length) {
  console.log(`${warnings.length} 条提示（不影响运行）：`);
  warnings.forEach((w) => console.log('  · ' + w));
  console.log('');
}
console.log('✓ 全部通过：源文件 / 导入 / 引用一致，且符合规范');