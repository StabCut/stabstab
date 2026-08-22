#!/usr/bin/env node
/*
 * StabStab捅捅 Logo 生成器
 * 视错觉「彭罗斯三角 / 纪念碑谷」风格图标。
 * 产物：
 *   build/icon.svg   —— 矢量源文件
 *   build/icon.png   —— 1024x1024（Linux / 通用）
 *   build/icon.ico   —— 多尺寸（Windows）
 * 依赖 ImageMagick 的 `convert`（Ubuntu 可 `sudo apt install imagemagick`）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
fs.mkdirSync(BUILD, { recursive: true });

// ---- 向量工具 ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const norm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const perp = (u) => [-u[1], u[0]];

// ---- 画布与三角几何 ----
const W = 1024, H = 1024;
const CX = W / 2, CY = H / 2 + 10;
const R = 310;   // 外接圆半径
const T = 104;   // 梁宽
const O = 62;    // 梁端超出顶点的长度（交叠）

const deg = (d) => d * Math.PI / 180;
const A = [CX, CY - R];
const B = [CX + R * Math.sin(deg(60)), CY + R * Math.cos(deg(60))];
const C = [CX - R * Math.sin(deg(60)), CY + R * Math.cos(deg(60))];

function beam(P, Q, t, o) {
  const u = norm(sub(Q, P));
  const n = perp(u);
  const p0 = sub(P, mul(u, o));
  const p1 = add(Q, mul(u, o));
  return [
    add(p0, mul(n, t / 2)),
    add(p1, mul(n, t / 2)),
    sub(p1, mul(n, t / 2)),
    sub(p0, mul(n, t / 2))
  ];
}

// 三条梁 + 顶部补画的一段（闭合“不可能”循环）
const left     = beam(C, A, T, O);
const bottom   = beam(B, C, T, O);
const right    = beam(A, B, T, O);
const leftTop  = beam(A, add(A, mul(sub(C, A), 0.38)), T, O);

// ---- 纪念碑谷配色 ----
const BG      = '#322B57'; // 深靛紫底
const COL = {
  left:   '#F7C948', // 沙金
  bottom: '#5EC8B7', // 青绿
  right:  '#FF8A7A'  // 珊瑚
};

const pts = (poly) => poly.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="220" fill="${BG}"/>
  <polygon points="${pts(left)}" fill="${COL.left}"/>
  <polygon points="${pts(bottom)}" fill="${COL.bottom}"/>
  <polygon points="${pts(right)}" fill="${COL.right}"/>
  <polygon points="${pts(leftTop)}" fill="${COL.left}"/>
</svg>
`;

const svgPath = path.join(BUILD, 'icon.svg');
fs.writeFileSync(svgPath, svg, 'utf8');
console.log('✓ 生成', path.relative(ROOT, svgPath));

function run(cmd) {
  try { execSync(cmd, { stdio: 'inherit' }); }
  catch (e) { console.error('命令失败:', cmd); process.exit(1); }
}

// 探测可用的 ImageMagick 命令（Linux 多为 convert，Windows 多为 magick）
function detectIM() {
  for (const c of ['magick', 'convert']) {
    try { execSync(`${c} -version`, { stdio: 'ignore' }); return c; } catch (e) { /* try next */ }
  }
  console.error('未找到 ImageMagick（convert / magick）。请安装后重试，或使用已提交的 build/ 图标。');
  process.exit(1);
}
const IM = detectIM();

// 光栅化 PNG（1024）
const pngPath = path.join(BUILD, 'icon.png');
run(`${IM} -background none -density 300 "${svgPath}" -resize 1024x1024 "${pngPath}"`);
console.log('✓ 生成', path.relative(ROOT, pngPath));

// 生成多尺寸 ICO（Windows）
const icoPath = path.join(BUILD, 'icon.ico');
run(`${IM} "${pngPath}" -define icon:auto-resize=256,128,64,48,32,16 "${icoPath}"`);
console.log('✓ 生成', path.relative(ROOT, icoPath));

// 同步一份运行时窗口图标（打包进 asar）
const assetsDir = path.join(ROOT, 'electron', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.copyFileSync(pngPath, path.join(assetsDir, 'icon.png'));
console.log('✓ 同步 electron/assets/icon.png');

console.log('Logo 生成完成。');
