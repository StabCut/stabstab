# StabStab捅捅

<div align="center">

[**中文**](./README.md) &nbsp;·&nbsp; [English](./README.en.md)

</div>

基于 **Electron + React + Vite** 的 AI 图像生成与编辑工作台，界面交互参考 Cherry Studio。

- **文生图**：输入文字生成图片
- **图生图**：输入图片（1–3 张）+ 编辑指令，或纯图片输入
- 首版接入 **Qwen-Image-3.0-Pro**（DashScope 多模态生成协议，同步 + 异步 Task API）
- 通过「协议适配器」架构预留了其它模型 / 另一套 API 请求解析规则的扩展位

> 面向 AI / 开发者的继续开发与调试指南见 **[AIDEV.md](./AIDEV.md)**。

---

## 目录结构

```
stabstab/
├── electron/               # Electron 主进程（入口 main.js + preload.js）
│   └── src/
│       ├── api/            # 协议适配器（dashscope.js）+ 注册表 + 执行器(runner.js)
│       ├── paths.js        # 数据根目录解析（可执行文件同级，不可写则回退用户目录）
│       ├── logger.js       # 日志（<data>/log/app-YYYYMMDD.log）
│       ├── store.js        # 设置 / 会话 JSON 持久化（原子写入）
│       └── imageutil.js    # 图片尺寸嗅探 / 缓存下载
├── src/                    # React 渲染进程（Vite）
│   ├── components/         # 侧边栏、聊天、消息、输入框、设置、灯箱预览、Toast
│   ├── lib/                # 状态 store、图片压缩、发送逻辑
│   └── styles/app.css      # 白天 / 黑暗主题样式
├── build/                  # Logo（icon.svg / icon.png / icon.ico）
├── scripts/
│   ├── gen-logo.js         # 生成 Logo（彭罗斯三角 / 纪念碑谷风）
│   ├── package.sh          # Ubuntu 一键打包
│   └── package.cmd         # Windows 一键打包
├── AIDEV.md                # AI / 开发者继续开发与调试文档
└── electron-builder.yml    # 打包配置
```

---

## 快速开始（开发）

前置：Node.js ≥ 18（推荐 20+）、npm。

```bash
cd stabstab
npm install
npm run dev        # 启动 Vite + Electron（开发模式，F12 打开 DevTools）
```

数据在开发模式下写入项目内的 `dev-data/`。

---

## 一键打包

### Ubuntu 24（当前平台，已验证）

```bash
cd stabstab
./scripts/package.sh
```

产物在 `release/`：

| 文件 | 说明 |
|------|------|
| `stabstab-<版本>-amd64.deb` | deb 安装包 |
| `StabStab捅捅-linux-x64.tar.gz` | 便携目录（解压后内含 `StabStab捅捅.sh`，终端执行即可启动） |

安装 / 运行：

```bash
# deb 安装
sudo dpkg -i release/stabstab-<版本>-amd64.deb

# 便携运行
tar -xzf release/StabStab捅捅-linux-x64.tar.gz
cd linux-unpacked
./StabStab捅捅.sh
```

> 说明：打包需要 ImageMagick（`convert` / `magick`）用于把 SVG Logo 光栅化成 png/ico。
> 未安装时脚本会自动跳过 Logo 生成、沿用已提交的 `build/` 图标。

### Windows（在 Windows 上执行；本机未验证打包效果）

```bat
cd stabstab
scripts\package.cmd
```

产物在 `release\`：

| 文件 | 说明 |
|------|------|
| `StabStab捅捅-<版本>-x64-setup.exe` | NSIS 安装包 |
| `StabStab捅捅-<版本>-x64-portable.exe` | 便携可执行文件 |

---

## 数据与缓存（重要）

应用数据保存在「可执行文件同级目录」下的 `stabstab-data/`：

```
stabstab-data/
├── conversations.json   # 会话与历史（文字 + 图片引用）
├── settings.json        # 设置（含 API Key、模型列表、主题、超时等）
├── cache/               # 生成结果的图片缓存（API 返回 URL 后立即下载到这里）
├── uploads/             # 用户输入图片（粘贴/拖入/选择）
├── downloads/           # 默认保存路径（下载结果图片）
└── log/                 # 日志（app-YYYYMMDD.log）
```

- 主页面提供「一键打开缓存目录」按钮；**直接删除 `cache/` 目录可清理空间，不影响下次运行**（历史消息中的结果图会显示为“图片已清理”占位）。
- 若可执行文件所在目录不可写（例如 deb 装到 `/opt`、Windows 装到 `Program Files`），会自动回退到系统用户数据目录（`~/.config/StabStab捅捅/` 或 `%APPDATA%/StabStab捅捅/`）。

---

## 功能清单

- **对话管理**：左侧标签（默认数字命名 1234…）、新建 / 重命名 / 删除 / 一键删除全部；标签「⋯」展开菜单。
- **无上下文**：每次请求只包含当前一条输入，上下文长度为 0。
- **消息操作**：原地编辑历史用户输入并重新发送（自动删除旧回复、原地覆盖）；删除单条消息；复制文字 / 图片；结果图片带分辨率显示。
- **图片输入**：粘贴（支持常见格式）、拖入输入框、点「+」多选；多图最多 3 张；允许纯图片、纯文字、文字+图片。
- **图片预览**：点击任意输入图 / 结果图放大预览，滚轮缩放、拖动查看细节、ESC 关闭、左右切换。
- **发送前图片压缩**：设置 → 基础设置 中开启，单图超过阈值（默认 10MB）自动压缩，多图分别检测。
- **size 参数**：`自动 / 2688*1536 / 2368*1728 / 2048*2048 / 1728*2368 / 1536*2688`（对应分辨率与比例）。
- **高级参数**：n（1–6 张）、反向提示词、水印、提示词改写、随机种子。
- **同步模式（默认）**：当前对话需等待 API 返回才能继续发送（发送按钮置灰、超时恢复），多标签各自独立等待；其它标签返回结果时显示黄点，点开即消。
- **异步模式**：`X-DashScope-Async` 提交 → 轮询 task（指数退避 3s→×1.5→上限 15s），状态卡片 + 取消按钮（仅 PENDING 可取消），应用重启后自动恢复轮询。
- **超时**：单次请求超时默认 300 秒，可在设置中调整。
- **日志**：关键信息记录到 `stabstab-data/log/`，便于排查。

---

## 模型设置与协议扩展

设置 → 模型设置：

- API Key、API 地址（Base URL，默认 `https://dashscope.aliyuncs.com/api/v1`）
- 模型列表：默认内置 `qwen-image-3.0-pro`（DashScope 协议），可添加 / 删除 / 设为默认

**新增另一套 API 请求与解析规则**（其它模型）的方法：

1. 在 `electron/src/api/` 新建适配器文件（参照 `dashscope.js` 的接口：`buildSubmitRequest / parseSubmit / buildTaskQuery / parseTask / buildTaskCancel` 等）；
2. 在 `electron/src/api/registry.js` 的 `adapters` 中注册；
3. 前端「设置 → 模型设置」的协议下拉会自动出现该选项。

`registry.js` 中的 `reserved` 列表用于在 UI 中展示「预留但未实现」的协议（占位、禁用）。详见 [AIDEV.md §7](./AIDEV.md)。

---

## API 规则要点（DashScope 千问图像）

参考工作区文档「图像编辑 - 千问AI平台.html」与「异步任务管理 - 千问AI平台.html」：

- 同步端点：`POST {base}/services/aigc/multimodal-generation/generation`
- 异步：同一端点 + 请求头 `X-DashScope-Async: enable`，返回 `output.task_id`；轮询 `GET {base}/tasks/{task_id}`；取消 `POST {base}/tasks/{task_id}/cancel`
- 输入 `messages[].content` 为 `[{image: url|base64}, ...{text}]`，图片 1–3 张，格式 JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF，单张 ≤ 10MB
- 图片 base64 格式：`data:<mime>;base64,<data>`
- 参数：`n`（1–6）、`negative_prompt`、`watermark`、`prompt_extend`、`seed`、`size`（宽*高）
- 响应：`output.choices[].message.content[].image`（旧版万相为 `output.results[].url`）

---

## 常见问题

**Linux 上窗口打不开 / GPU 报错？**
主进程已对 Linux 做兼容处理（禁用 GPU 进程沙箱，必要时整体禁用沙箱）。若仍异常，可手动追加参数：

```bash
./StabStab捅捅.sh --disable-gpu       # 彻底禁用 GPU 加速（软件渲染）
./StabStab捅捅.sh --no-sandbox        # 禁用沙箱（极少数受限环境）
```

**日志在哪？**
`stabstab-data/log/app-YYYYMMDD.log`（便携版位于可执行文件同级目录）。

---

## 许可证

MIT
