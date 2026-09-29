# assets/icons —— 界面图标源文件

**这里就是图标的源文件。** 修改本目录的 SVG，应用界面即刻生效
（`src/components/Icon.jsx` 通过 Vite 的 `?raw` 导入它们）。

## 怎么替换图标

1. 把新 SVG 覆盖到对应文件名，例如换删除图标就覆盖 `trash.svg`
2. 跑一次 `npm run check:icons` 确认符合规范
3. 完成 —— 不需要改任何 JS，也不需要重新导出

**新增一个图标**（文件名用小写英文）：

1. 新建 `assets/icons/xxx.svg`
2. 在 `src/components/Icon.jsx` 里加两行：
   ```js
   import xxxSrc from '../../assets/icons/xxx.svg?raw';   // 顶部 import 区
   const RAW = { ..., xxx: xxxSrc };                      // RAW 表里加一行
   ```
3. 用 `<Icon name="xxx" size={16} />`

## 规格（`npm run check:icons` 会检查）

| 项 | 要求 |
|---|---|
| 根标签 | 要有 `viewBox`（推荐 `0 0 24 24`） |
| 颜色 | 不要硬编码 `#333` 这类颜色，统一用 `currentColor` |
| 宽高 | 根 `<svg>` 不要写 `width`/`height`，尺寸由 `<Icon size>` 决定 |
| 画布 | 任意尺寸都行（靠 viewBox 缩放），但建议 24×24 以保持视觉重量一致 |

## 颜色与样式：全自动判断，替换时不用管

`Icon.jsx` 会读你的 SVG 自动决定两件事，**你只需要把文件放进来**：

### 1) 描边式还是填充式

| 你的 SVG | 判定 | 渲染方式 |
|---|---|---|
| 根标签带 `stroke` / `stroke-width` | 描边式 | 细线造型，描边跟随主题色 |
| 没有 stroke、靠 fill 画实心形状 | **填充式** | 实心造型，填充跟随主题色 |

iconfont 导出的实心图标会自动识别为填充式。
（早期版本会一律套描边样式，导致实心图标变成又细又灰的描边——已修。）

### 2) 用主题色还是保留自带颜色

| 你的 SVG | 行为 | 结果 |
|---|---|---|
| 没写颜色（`<path d="..."/>`） | 补 `currentColor` | 跟随按钮文字色，深浅主题自适应 |
| 写 `fill="currentColor"` | 同上 | 跟随主题 |
| 写具体颜色（`#d81e06` 等） | **原样保留** | 保持你的颜色 |
| 一个文件里多个颜色 | **全部保留** | 多色图标正常 |

### ⚠️ 两个注意点

**颜色建议写在内部图形元素上，别写在根 `<svg>` 上。**

- ✅ `<svg viewBox="0 0 24 24"><path d="..." fill="#d81e06"/></svg>`
- ❌ `<svg viewBox="0 0 24 24" fill="#d81e06"><path d="..."/></svg>`

根标签上的颜色会被 `.icon--stroke` / `.icon--fill` 覆盖（CSS 优先级高于 SVG 呈现属性），
而且检测逻辑只看内部元素。`npm run check:icons` 会报错提示。

**图形标签请写成自闭合 `<path ... />`。**
不写的话，在 HTML 解析规则下后一个图形会变成前一个的**子元素**——
曾导致「关闭」图标只画出一条斜线。`Icon.jsx` 现在会自动补自闭合兜住，
但源文件写规范些更安全（`check:icons` 会提示）。

多色图标建议在文件顶部标注一行：
```svg
<!-- icon-color: multi -->
```


## 当前 12 个图标

| 文件 | 用途 | 渲染尺寸（px） |
|---|---|---|
| `plus.svg` | 新建对话 / 添加 | 15 / 16 / 18 |
| `close.svg` | 关闭 / 移除 | 13（线宽 2.2）、16 |
| `folder.svg` | 缓存目录 | 19、20 |
| `trash.svg` | 删除（5 处） | 15、16、20 |
| `gear.svg` | 设置 | 20 |
| `pencil.svg` | 重命名 / 编辑重发 | 15 |
| `copy.svg` | 复制（3 处） | 13、15 |
| `download.svg` | 下载保存 | 15 |
| `sliders.svg` | 参数 | 15 |
| `minus.svg` | 灯箱缩小 | 16 |
| `reset.svg` | 灯箱重置 | 16 |
| `more.svg` | 更多操作 | 16 |

## 相关脚本与文件

| 路径 | 说明 |
|---|---|
| `src/components/Icon.jsx` | 导入源文件 + 规范化 + 渲染（`<Icon name size strokeWidth variant />`） |
| `scripts/check-icons.js` | 校验源文件 / 导入 / 代码引用是否一致（`npm run check:icons`） |
| `public/*.svg`（中文名等） | 手工放置的备选图标，**不参与构建、未被引用**；要启用请按上面的步骤搬进来 |

## 非界面图标

| 资产 | 说明 |
|---|---|
| `build/icon.svg` · `public/icon.svg` · `build/icon.png` · `build/icon.ico` · `electron/assets/icon.png` | 应用图标（彭罗斯三角），由 `scripts/gen-logo.js` 生成（`npm run logo`） |
| 灯箱左右翻页 `‹` `›` | 纯文本字符，非 SVG |
