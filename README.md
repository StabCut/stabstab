# StabStab

<div align="center">

[**中文**](./README.md) &nbsp;·&nbsp; [English](./README.en.md)

</div>

基于 **Electron + React + Vite** 的 AI 图像生成与编辑工作台，界面交互参考 Cherry Studio。

- **文生图**：输入文字生成图片
- **图生图**：输入图片（1–3 张）+ 编辑指令，或纯图片输入
- **模型系列化接入**（模型 id 自己填，每个系列可配多个 API 来源）：

  | 模型系列 | 可用的 API 来源 |
  |----------|----------------|
  | **Qwen 图像系列**（qwen-image-3.0-pro 等） | 官方（DashScope / 阿里云百炼）· 同步 + 异步 Task API |
  | **Doubao Seedream 系列**（doubao-seedream-* ） | 官方（火山方舟 Ark）· New API |
  | **GPT Image 系列**（gpt-image-2 / 2.5 等） | Grsai · NewApi |

- 除 Qwen 系列可切异步外，其余来源均为**同步模式**：单次请求阻塞等待图片返回
- 通过「协议适配器」架构可继续扩展其它系列 / 其它 API 请求解析规则

> 面向 AI / 开发者的继续开发与调试指南见 **[AIDEV.md](./AIDEV.md)**。

---

## 目录结构

```
stabstab/
├── electron/               # Electron 主进程（入口 main.js + preload.js）
│   ├── assets/             # 窗口图标 + 内置模型系列配置 model-series.json
│   └── src/
│       ├── api/            # 协议适配器（dashscope / seedream / newapi-images / grsai）+ 注册表 + 执行器(runner.js)
│       ├── paths.js        # 数据根目录解析（可执行文件同级，不可写则回退用户目录）
│       ├── logger.js       # 日志（<data>/log/app-YYYYMMDD.log）
│       ├── store.js        # 设置 / 会话 JSON 持久化（原子写入 + 旧结构迁移）
│       ├── modelSeries.js  # 模型系列配置读写与解析（发请求的权威口径）
│       └── imageutil.js    # 图片尺寸嗅探 / 缓存下载
├── src/                    # React 渲染进程（Vite）
│   ├── components/         # 侧边栏、聊天、消息、输入框、设置、灯箱预览、Toast
│   ├── lib/                # 状态 store、模型解析、图片压缩、发送逻辑
│   └── styles/app.css      # 白天 / 黑暗主题样式
├── build/                  # Logo（icon.svg / icon.png / icon.ico）
├── scripts/
│   ├── test-api.js         # 后端端到端测试（mock 各协议 HTTP 服务）
│   ├── gen-logo.js         # 生成 Logo（彭罗斯三角 / 纪念碑谷风）
│   ├── package.sh          # Ubuntu 一键打包
│   └── package.cmd         # Windows 一键打包
├── AIDEV.md                # AI / 开发者继续开发与调试文档
└── electron-builder.yml    # 打包配置
```

---

## 快速开始（开发）

前置：Node.js ≥ 18（推荐 20+）、npm、Git。

```bash
# 1. 克隆仓库
git clone https://github.com/ExploringBB/stabstab.git
cd stabstab

# 2. 安装依赖（自动配置，见下方说明）
npm install

# 3. 开发模式：启动 Vite + Electron（F12 打开 DevTools）
npm run dev
```

> **依赖自动配置**：项目根目录的 `.npmrc` 已内置国内镜像
> （`electron_mirror` / `electron_builder_binaries_mirror` 指向 npmmirror），
> 执行 `npm install` 时会自动走镜像加速 Electron 与 electron-builder 的二进制下载，
> 无需手动设置任何环境变量。

### 构建生产产物（可选）

打包脚本内部会自动构建，通常无需手动执行；如需单独构建渲染进程：

```bash
npm run build      # Vite 构建渲染进程到 dist/
```

> **命令名注意**：请使用 `npm run dev` 与 `npm run build`。
> `npm dev` 不是合法命令会报错；`npm build` 虽为历史别名，但建议统一使用 `npm run build`。

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
| `StabStab-linux-x64.tar.gz` | 便携目录（解压后内含 `StabStab.sh`，终端执行即可启动） |

安装 / 运行：

```bash
# deb 安装
sudo dpkg -i release/stabstab-<版本>-amd64.deb

# 便携运行
tar -xzf release/StabStab-linux-x64.tar.gz
cd linux-unpacked
./StabStab.sh
```

> 说明：打包需要 ImageMagick（`convert` / `magick`）用于把 SVG Logo 光栅化成 png/ico。
> 未安装时脚本会自动跳过 Logo 生成、沿用已提交的 `build/` 图标。

### Windows（在 Windows 上执行；已验证）

```bat
cd stabstab
scripts\package.cmd
```

产物在 `release\`：

| 文件 | 说明 |
|------|------|
| `StabStab-<版本>-x64-setup.exe` | NSIS 安装包 |
| `StabStab-<版本>-x64-portable.exe` | 便携可执行文件 |

> 说明：Windows 上脚本仅自动检测 `magick`（ImageMagick 7），`convert` 与系统自带的
> `C:\Windows\System32\convert.exe` 重名已不再使用。未安装时脚本会跳过 Logo 生成、沿用已提交的 `build/` 图标。

---

## 数据与缓存（重要）

应用数据保存在「可执行文件同级目录」下的 `stabstab-data/`：

```
stabstab-data/
├── conversations.json   # 会话与历史（文字 + 图片引用）
├── settings.json        # 设置（模型系列与模型、API Key、主题、超时等）
├── model-series.json    # 内置模型系列配置（系列 / API 来源 / 默认地址 / 同步异步开关）
├── cache/               # 生成结果的图片缓存（API 返回 URL 后立即下载到这里）
├── uploads/             # 用户输入图片（粘贴/拖入/选择）
├── downloads/           # 默认保存路径（下载结果图片）
└── log/                 # 日志（app-YYYYMMDD.log）
```

- 主页面提供「一键打开缓存目录」按钮；**直接删除 `cache/` 目录可清理空间，不影响下次运行**（历史消息中的结果图会显示为“图片已清理”占位）。
- `model-series.json` 可手工编辑（例如把某系列的默认 API 地址换成你自己的中转地址），重启后生效；删除该文件会从程序内置配置重新生成一份。
- 若可执行文件所在目录不可写（例如 deb 装到 `/opt`、Windows 装到 `Program Files`），会自动回退到系统用户数据目录（`~/.config/StabStab/` 或 `%APPDATA%/StabStab/`）。

---

## 功能清单

- **对话管理**：左侧标签（默认数字命名 1234…）、新建 / 重命名 / 删除 / 一键删除全部；标签「⋯」展开菜单。
- **无上下文**：每次请求只包含当前一条输入，上下文长度为 0。
- **消息操作**：原地编辑历史用户输入并重新发送（自动删除旧回复、原地覆盖）；删除单条消息；复制文字 / 图片；结果图片带分辨率显示。
- **图片输入**：粘贴（支持常见格式）、拖入输入框、点「+」多选；多图最多 3 张；允许纯图片、纯文字、文字+图片。
- **图片预览**：点击任意输入图 / 结果图放大预览，滚轮缩放、拖动查看细节、ESC 关闭、左右切换。
- **发送前图片压缩**：设置 → 基础设置 中开启，单图超过阈值（默认 10MB）自动压缩，多图分别检测。
- **size 参数**：按模型自动给出候选 —— Qwen：`自动 / 2688*1536 / 2368*1728 / 2048*2048 / 1728*2368 / 1536*2688`；Seedream 官方：`1K / 2K / 4K / 2048x2048` 等；Grsai：`16:9 / 9:16 / 1:1` 等比例或像素值；New API：`1024x1024` 等。
- **高级参数**：随协议自动变化（Qwen：n、反向提示词、水印、提示词改写、随机种子；Seedream 官方：水印、输出格式；New API：n、quality、style；Grsai：无额外参数）。
- **同步模式（默认）**：当前对话需等待 API 返回才能继续发送（发送按钮置灰、超时恢复），多标签各自独立等待；其它标签返回结果时显示黄点，点开即消。
- **异步模式**：**只有 Qwen 系列支持**（`X-DashScope-Async` 提交 → 轮询 task，指数退避 3s→×1.5→上限 15s），状态卡片 + 取消按钮（仅 PENDING 可取消），应用重启后自动恢复轮询；其它系列固定同步。
- **超时**：单次请求超时默认 300 秒，可在设置中调整。
- **日志**：关键信息记录到 `stabstab-data/log/`，便于排查。

---

## 模型设置、模型系列与协议扩展

「设置 → 模型设置」按**模型系列**组织，初始为空，需要自己添加：

1. 在「添加模型系列」下拉框中选择一个**内置系列**（系列与其可用 API 来源由系统内置，配置存放在数据目录的 `model-series.json`），点「添加」；
2. 在系列卡片内点「添加模型」，填写**模型 id**（灰色提示给出示例，例如 `gpt-image-2`、`doubao-seedream-5-0-pro-260628`），并选择该模型使用的 **API 来源**；
3. 在系列卡片下方的**来源级配置**里填写 **API Key** 与 **API 地址**（地址默认自动填充内置地址，可改，点「恢复默认」还原）；
4. 模型行左侧的单选框 = **全局默认模型**（输入区默认选中的那个）。

其它说明：

- 每个模型可以有自己的 API Key / 地址（按「系列·来源」保存），互不干扰；
- 删除按钮分两级：删除模型、移除模型系列（内置系列只是从列表移除，密钥会保留，随时可以重新添加）；
- 「高级设置」里的**同步 / 异步**只对支持该能力的系列显示（当前仅 Qwen 系列），并保存在 `model-series.json`；
- **初始没有任何模型系列**（全新安装和从旧版本升级都一样）：需要自己从下拉框添加系列、再往系列里添加模型；
  旧版本的 API Key / 自定义 API 地址会在升级时自动归位（添加对应系列后即可直接使用），但**不会自动带出系列或模型**。

**新增一套 API 请求与解析规则**（其它系列 / 其它中转）：

1. 在 `electron/src/api/` 新建适配器文件（参照 `dashscope.js` 的接口：`buildSubmitRequest / parseSubmit / buildTaskQuery / parseTask / buildTaskCancel`，以及 `sizeOptions / paramSchema` 元信息）；
2. 在 `electron/src/api/registry.js` 的 `adapters` 中注册；
3. 在 `electron/assets/model-series.json` 里新建一个系列（或给现有系列加一个 `sources[]` 条目），`protocol` 填适配器 id——设置页的系列下拉与来源下拉就会自动出现。

`registry.js` 中的 `reserved` 列表用于在 UI 中展示「预留但未实现」的协议（占位、禁用）。详见 [AIDEV.md §0 与 §7](./AIDEV.md)。

---

## API 规则要点

**Qwen 图像系列 · 官方（DashScope）** —— 参考工作区文档「图像编辑 - 千问AI平台.html」与「异步任务管理 - 千问AI平台.html」：

- 同步端点：`POST {base}/services/aigc/multimodal-generation/generation`
- 异步：同一端点 + 请求头 `X-DashScope-Async: enable`，返回 `output.task_id`；轮询 `GET {base}/tasks/{task_id}`；取消 `POST {base}/tasks/{task_id}/cancel`
- 输入 `messages[].content` 为 `[{image: url|base64}, ...{text}]`，图片 1–3 张，格式 JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF，单张 ≤ 10MB
- 图片 base64 格式：`data:<mime>;base64,<data>`
- 参数：`n`（1–6）、`negative_prompt`、`watermark`、`prompt_extend`、`seed`、`size`（宽*高）
- 响应：`output.choices[].message.content[].image`（旧版万相为 `output.results[].url`）

**Doubao Seedream 系列 · 官方（火山方舟 Ark）** —— 参考「seedream系列api.md」（该文档给的是文本对话示例 `/responses`，生图实际用 `/images/generations`）：

- `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`，请求头 `Authorization: Bearer <ARK_API_KEY>`
- 请求体：`{model, prompt, size, image, response_format:"url", watermark, output_format}`
- `size` 支持 `1K/2K/4K` 或 `2048x2048` 像素值（两种模式不可混用）；有输入图时用 `image`（URL 或 `data:base64`，多图传数组）
- 响应：`data[].url`，`usage.generated_images`；同一来源**仅同步**（单次请求阻塞等待返回）

**Doubao Seedream 系列 · New API / GPT Image 系列 · NewApi** —— 参考「gpt-image系列.md」的 New Api 部分：

- `POST {base}/images/generations`（`{base}` 形如 `https://toprouter.sealoshzh.site/v1`），请求头 `Authorization: Bearer <TOKEN>`
- 参数：`prompt`（必填）、`size`（默认 `1024x1024`）、`quality`（默认 `standard`）、`style`（默认 `vivid`）、`n`（1–10）、`response_format`（默认 `url`）
- 响应：`data[].url` 或 `data[].b64_json`（两种都会自动落盘到缓存目录）

**GPT Image 系列 · Grsai** —— 参考「gpt-image系列.md」的 Grsai API 部分：

- `POST https://grsaiapi.com/v1/api/generate`（国内节点 `https://grsai.dakka.com.cn/v1/api/generate`），请求头 `Authorization: Bearer sk-xxx`
- 请求体：`{model, prompt, images?, aspectRatio?}`；`images` 支持 base64（dataUrl）与 URL 链接，`aspectRatio` 支持 `16:9` 这类比例或 `1024x1024` 像素值
- 支持的模型：`gpt-image-2`、`gpt-image-2-vip`、`gpt-image-2.5`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`（模型 id 自行填写）
- 响应：SSE 流中的 `results[].url`，或 JSON `{code:0,data:{results:[{url}]}}`；若服务端只返回任务 id，程序会自动转为轮询结果接口

---

## 常见问题

**Linux 上窗口打不开 / GPU 报错？**
主进程已对 Linux 做兼容处理（禁用 GPU 进程沙箱，必要时整体禁用沙箱）。若仍异常，可手动追加参数：

```bash
./StabStab.sh --disable-gpu       # 彻底禁用 GPU 加速（软件渲染）
./StabStab.sh --no-sandbox        # 禁用沙箱（极少数受限环境）
```

**Windows 上窗口不出现 / 启动后直接退出？**
企业 EDR / 安全软件（实测：深信服 aES）会拦截 Chromium 的沙箱子进程创建，日志表现为
`渲染进程异常退出 {"reason":"launch-failed","exitCode":57}`（窗口一片空白），或 GPU 进程报 `error_code=57`
后主进程直接 `GPU process isn't usable. Goodbye.` 退出。
主进程已对 Windows 默认追加 `--no-sandbox` 以保证开箱即用；如需恢复沙箱，设置环境变量后启动：

```powershell
$env:STABSTAB_KEEP_SANDBOX='1'; npm run dev
```

**日志在哪？**
`stabstab-data/log/app-YYYYMMDD.log`（便携版位于可执行文件同级目录）。

---

## 许可证

MIT
