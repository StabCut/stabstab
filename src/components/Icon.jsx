import React, { useMemo } from 'react';

/*
 * 界面图标集
 * ===========
 * 图标源文件在 assets/icons/*.svg —— 那才是唯一真相，改了就生效。
 * 本组件只负责「导入 + 规范化 + 渲染」，不再内联任何 path 数据。
 *
 * 新增 / 替换图标的步骤：
 *   1. 把新 SVG 放进 assets/icons/，文件名用小写英文（如 trash.svg）
 *   2. 在下面 RAW 表里加一行 import（路径要对得上文件名）
 *   3. 在 ICON_NAMES 或直接用 <Icon name="trash" />
 *
 * 规范化（prepare）会自动处理从 iconfont / Figma 直接下载的 SVG：
 *   - 去掉 width / height，尺寸交给调用方（size 属性）
 *   - 硬编码颜色（#333 等）换成 currentColor -> 深浅主题都能正确显示
 *   - fill="none" / stroke="none" 这种语义性取值保留不动
 *   - 给 <svg> 补上 currentColor / 圆头圆角，缺少 viewBox 时补 0 0 24 24
 *
 * 实心（填充）图标：<Icon name="xxx" variant="fill" />，会走 .icon--fill 样式
 * （描边置 none、填充用 currentColor），这样实心与线性可以共存不打架。
 */

// 显式 import + ?raw：Vite 原生能力，视图标为「可被读取的源文件内容」
import plusSrc from '../../assets/icons/plus.svg?raw';
import closeSrc from '../../assets/icons/close.svg?raw';
import folderSrc from '../../assets/icons/folder.svg?raw';
import trashSrc from '../../assets/icons/trash.svg?raw';
import gearSrc from '../../assets/icons/gear.svg?raw';
import pencilSrc from '../../assets/icons/pencil.svg?raw';
import copySrc from '../../assets/icons/copy.svg?raw';
import downloadSrc from '../../assets/icons/download.svg?raw';
import slidersSrc from '../../assets/icons/sliders.svg?raw';
import minusSrc from '../../assets/icons/minus.svg?raw';
import resetSrc from '../../assets/icons/reset.svg?raw';
import moreSrc from '../../assets/icons/more.svg?raw';
import warningSrc from '../../assets/icons/warning.svg?raw';

const RAW = {
  plus: plusSrc,
  close: closeSrc,
  folder: folderSrc,
  trash: trashSrc,
  gear: gearSrc,
  pencil: pencilSrc,
  copy: copySrc,
  download: downloadSrc,
  sliders: slidersSrc,
  minus: minusSrc,
  reset: resetSrc,
  more: moreSrc,
  warning: warningSrc
};

export const ICON_NAMES = Object.keys(RAW);

/** 归一化 SVG 内容，使其服从调用方的尺寸与主题色。 */
function normalize(raw, name) {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let s = raw
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // 取出 <svg ...> 与 </svg> 之间的图形内容
  const open = s.match(/<svg\b[^>]*>/i);
  if (!open) return null;
  const start = s.indexOf(open[0]) + open[0].length;
  const end = s.lastIndexOf('</svg>');
  const inner = (end > start ? s.slice(start, end) : '').trim();
  if (!inner) return null;

  const attrs = open[0];
  const viewBox = (attrs.match(/viewBox\s*=\s*"([^"]+)"/i) || [])[1] || '0 0 24 24';

  // 去掉根 <svg> 与内部元素上的 width/height，尺寸交给调用方的 size 属性
  let body = inner.replace(/\b(width|height)\s*=\s*"[^"]*"/gi, '');

  // ---- 1) 判定这是「描边式」还是「填充式」图标 ----
  // 关键：填充式图标若被强加 fill:none + stroke，实心形状会变成细描边（变灰、变虚甚至看不见）。
  const rootStroke = /\bstroke\s*=\s*"/i.test(attrs);
  const rootStrokeWidth = /stroke-width\s*=/i.test(attrs);
  const innerDeclaresFill = /\bfill\s*=\s*"/i.test(inner);
  const innerDeclaresStroke = /\bstroke\s*=\s*"/i.test(inner);
  const isStrokeIcon = innerDeclaresFill
    ? innerDeclaresStroke          // 内部同时声明：尊重内部写法
    : (rootStroke || rootStrokeWidth);

  // ---- 2) 颜色：具体颜色原样保留；none / currentColor 不算「自带颜色」 ----
  const declared = [...(attrs + ' ' + inner).matchAll(/\b(?:fill|stroke)\s*=\s*"([^"]+)"/gi)]
    .map((m) => m[1].trim().toLowerCase())
    .filter((v) => v && v !== 'none' && v !== 'currentcolor');
  const hasOwnColor = declared.length > 0;

  // ---- 3) 补默认色 / 兜住未闭合标签 ----
  // 必须保留原标签的自闭合斜杠（<path ... />），否则在 HTML 解析规则下，
  // 后面那个元素会变成前一个的**子元素**（表现为图形缺一半，如关闭图标只剩一条斜线）。
  const rewriteTags = (extraFor) => body.replace(
    /<([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/g,
    (full, tag, rest, slash) => {
      if (/^(svg|title)$/i.test(tag)) return full;
      const extra = extraFor(tag, rest);
      // 图形类标签统一补自闭合，避免未闭合写法把后续图形嵌套成子元素
      const needSlash = !slash && /^(path|circle|rect|polygon|ellipse|line|polyline)$/i.test(tag);
      return (extra || needSlash) ? `<${tag}${rest}${extra}${needSlash ? '/' : slash}>` : full;
    }
  );

  if (!hasOwnColor) {
    body = rewriteTags((tag, rest) => {
      if (isStrokeIcon) {
        return (!/\bfill\s*=/i.test(rest) ? ' fill="none"' : '')
          + (!/\bstroke\s*=/i.test(rest) ? ' stroke="currentColor"' : '');
      }
      return !/\bfill\s*=/i.test(rest) ? ' fill="currentColor"' : '';
    });
  } else {
    // 自带颜色的图标不改样式，但仍要兜住未闭合的图形标签
    body = rewriteTags(() => '');
  }

  return { viewBox, inner: body, keepsOwnColor: hasOwnColor, isStrokeIcon };
}

export default function Icon({
  name,
  size = 16,
  className = '',
  strokeWidth = 1.75,
  variant = 'stroke',
  ...rest
}) {
  const prepared = useMemo(() => normalize(RAW[name], name), [name]);
  if (!prepared) return null; // 未知名称或空文件：静默渲染空，避免破坏布局

  return (
    <svg
      className={[
        'icon',
        prepared.isStrokeIcon ? 'icon--stroke' : 'icon--fill',
        prepared.keepsOwnColor ? 'icon--brand' : '',
        className
      ].filter(Boolean).join(' ').trim()}
      width={size}
      height={size}
      viewBox={prepared.viewBox}
      strokeWidth={strokeWidth}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: prepared.inner }}
      {...rest}
    />
  );
}