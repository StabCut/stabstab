#!/usr/bin/env node
/*
 * StabStab Logo 生成器
 * 视错觉「彭罗斯三角 / 纪念碑谷」风格图标。
 *
 * 产物：
 *   build/icon.svg          —— 矢量源文件（唯一真相；光栅化直接读它）
 *   build/icon.png          —— 1024x1024（Linux / 通用）
 *   build/icon.ico          —— 多尺寸（Windows：256/128/64/48/32/16）
 *   public/icon.svg         —— 渲染进程侧边栏 logo（Vite public/，须与 build/ 一致）
 *   electron/assets/icon.png —— 运行时窗口图标（打包进 asar）
 *
 * 光栅化后端按可用性自动选择：
 *   1. ImageMagick（magick）—— 不再使用 Windows 自带的 convert.exe（那是文件系统工具）
 *   2. Python + Pillow（scripts/icon-raster.py）—— 跨平台兜底，无需 cairo
 * 两者都缺失时仅更新 SVG，保留已提交的 PNG/ICO，不破坏构建。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

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

/**
 * 由中心线 P->Q 生成梁的四边形。
 * 返回顺序为 [P+n·t/2, Q+n·t/2, Q-n·t/2, P-n·t/2]，直接作为 SVG 的 points 输出。
 */
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
const left = beam(C, A, T, O);
const bottom = beam(B, C, T, O);
const right = beam(A, B, T, O);
const leftTop = beam(A, add(A, mul(sub(C, A), 0.38)), T, O);

// ---- 纪念碑谷配色 ----
const BG = '#322B57'; // 深靛紫底
const COL = {
  left: '#F7C948',   // 沙金
  bottom: '#5EC8B7', // 青绿
  right: '#FF8A7A'   // 珊瑚
};

const pts = (poly) => poly.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');

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

// 渲染进程侧边栏 logo 走 Vite 的 public/，保持同一份文件
const publicSvg = path.join(ROOT, 'public', 'icon.svg');
fs.mkdirSync(path.dirname(publicSvg), { recursive: true });
fs.copyFileSync(svgPath, publicSvg);
console.log('✓ 同步 public/icon.svg');

// 只重写矢量文件（用于校验几何是否与原版一致，不改动已提交的 PNG/ICO）
if (process.argv.includes('--svg-only')) {
  console.log('（--svg-only：跳过光栅化）');
  process.exit(0);
}

// ---- 光栅化 ----
function has(cmd, arg = '--version') {
  try { execSync(`${cmd} ${arg}`, { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

const IM = ['magick'].find((c) => has(c)); // 不再探测 convert.exe（Windows 系统工具）
const HAS_PY = process.platform === 'win32'
  ? (has('python', '-V') ? 'python' : (has('py', '-V') ? 'py' : null))
  : (has('python3', '-V') ? 'python3' : (has('python', '-V') ? 'python' : null));

const pngPath = path.join(BUILD, 'icon.png');
const icoPath = path.join(BUILD, 'icon.ico');
const assetsDir = path.join(ROOT, 'electron', 'assets');
const assetPng = path.join(assetsDir, 'icon.png');

if (IM) {
  execFileSync(IM, ['-background', 'none', svgPath, '-resize', `${W}x${H}`, pngPath], { stdio: 'inherit' });
  console.log('✓ 生成', path.relative(ROOT, pngPath), `(ImageMagick: ${IM})`);
  execFileSync(IM, [pngPath, '-define', 'icon:auto-resize=256,128,64,48,32,16', icoPath], { stdio: 'inherit' });
  console.log('✓ 生成', path.relative(ROOT, icoPath));
} else if (HAS_PY) {
  execFileSync(HAS_PY, [path.join(__dirname, 'icon-raster.py'), svgPath, pngPath, icoPath], { stdio: 'inherit' });
  console.log('✓ 生成', path.relative(ROOT, pngPath), '(Pillow)');
  console.log('✓ 生成', path.relative(ROOT, icoPath));
} else {
  console.warn('! 未找到 ImageMagick，也未找到 Python：仅更新了 SVG，保留已提交的 PNG/ICO。');
  console.warn('  安装任一后端后重跑 `npm run logo` 即可刷新位图图标。');
  process.exit(0);
}

fs.mkdirSync(assetsDir, { recursive: true });
fs.copyFileSync(pngPath, assetPng);
console.log('✓ 同步 electron/assets/icon.png');
console.log('Logo 生成完成。');
