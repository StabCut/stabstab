# StabStab — AI 继续开发与调试文档（AIDEV.md）

> 本文档面向 **AI 编程助手 / 后续开发者**，用于在既有代码基础上继续开发、调试、扩展与维护。
> 阅读本文档前请先了解：这是一个 **Electron + React + Vite** 的 AI 图像生成工作台（文生图 / 图生图），
> 交互参考 Cherry Studio，已接入 **模型系列（Model Series）** 架构：
> **Qwen 图像系列**（DashScope 多模态）、**Doubao Seedream 系列**（官方火山方舟 / New API）、
> **GPT Image 系列**（Grsai / NewApi）；每个系列可挂多个来源，来源与协议适配器一一绑定。
> **请求模式只有「同步」一种**：提交后阻塞等待图片返回；同一个对话里可以同时等 2 个以上
> 互不干扰的请求（「伪异步」，见 §4.12）。**同步/异步开关已彻底删除**，不要再加回来。

---

## 0. 模型系列架构（先读这段）

三层关系：**模型系列 → API 来源 → 协议适配器**。

```
model-series.json（内置定义：有哪些系列、每个系列支持哪些来源、来源默认地址/尺寸）
        └── series[]          例如 qwen / doubao-seedream / gpt-image
                └── sources[] 例如 gpt-image 系列支持 grsai + newapi 两个来源
                        └── protocol  →  electron/src/api/registry.js 里的适配器 id
settings.json（用户数据：添加了哪些系列、系列里有哪些模型、每个「系列·来源」的密钥与地址）
        ├── modelGroups[]     [{ seriesId, models:[{ id, name, sourceId }] }]
        ├── sourceConfig{}    { '<seriesId>.<sourceId>': { apiKey, baseUrl } }   baseUrl 为空 = 用内置默认
        └── defaultModelId    全局默认模型（设置页模型行左侧单选框）
```

- 内置系列**不可真正删除**：设置页的删除 = 置 `hidden: true` 并从 `modelGroups` 移除（密钥保留在 `sourceConfig`，可随时重新添加）。
- **请求模式只有同步**：`model-series.json` 里没有 `requestMode`，来源也没有 `supportsAsync`
  （老版本数据里的这两个字段在 `modelSeries.mergeSeries` 里被丢弃）。所有系列一律「单次请求阻塞等待图片返回」。
- 发请求时**由主进程按 `modelId` 反查**协议 / 来源 / 密钥 / 地址（`electron/src/modelSeries.js#resolveModel`），渲染进程只传 `modelId`——渲染进程不持有权威凭据副本。
- 渲染进程侧的同一套解析在 `src/lib/models.js`（供下拉框、尺寸列表、参数面板、提示文案使用）。**改规则时两处都要改**。

---

## 1. 项目摘要

**StabStab** 是一个桌面端 AI 图像生成与编辑工具，核心能力：

- **文生图**（text-to-image）：纯文字提示词生成图片。
- **图生图 / 图像编辑**（image-to-image）：1–3 张输入图片 + 编辑指令，或纯图片输入。
- 对话式界面（类 Cherry Studio）：左侧标签管理会话（空对话按序号 1234…，出现首条文字后自动命名，可拖动改变顺序，见 §4.11），右侧聊天流，底部输入框。
- **逐标签草稿**：输入区的文字与待发送图片跟着标签独立保留 —— 切走再切回来内容还在，
  直到该会话被删除（或全部删除）才随之删除；草稿**只存内存**（不落盘，重启软件即消失），见 §4.6。
- 每个会话**不携带上下文**（上下文长度恒为 0）：每次请求只包含当前这一条输入。
- **标签自动命名（重命名模型）**：首条文字 → DeepSeek Responses API（默认 `deepseek-flash` 非思考模式）
  精简成 5~6 字中文标题；未配置 Key 或调用失败时截取首条文字。模板/温度/Top-P 在 `rename-model.json`。
- **模型系列 → API 来源 → 协议适配器**：内置 3 个系列（Qwen / Doubao Seedream / GPT Image），
  模型 id 由用户填写；每个「系列·来源」独立保存 API Key 与 API 地址。
- **只有同步模式 + 同对话并行等待（伪异步）**：请求提交后阻塞等待图片返回；**等待期间输入框不锁定**，
  同一个对话里可以连续发出多个请求，每个请求各占一个 jobId、各自等待、互不干扰（见 §4.12）。
  用户气泡上还有「新对话发送 / 当前对话发送」两个按钮，把这条内容原样再发一遍（见 §4.13）。
- 会话/设置/缓存/日志全部**本地持久化**在 `stabstab-data/`：打包后落在**用户数据目录**
  （Windows = `%APPDATA%\StabStab\stabstab-data`，Linux = `~/.config/StabStab/stabstab-data`），
  便携包落在 exe 同级，开发模式落在项目内 `dev-data/` —— **覆盖安装/卸载重装都不丢配置**，见 §5.6；
  内置模型系列配置同步落地一份到 `<dataRoot>/model-series.json`，可手工编辑。

**技术栈**：Electron 43（Node 22 内核）、React 19、Vite 8、electron-builder 26。
主进程为 **纯 CommonJS（无构建）**，渲染进程由 Vite 打包为静态资源。

---

## 2. 目录结构与文件职责

```
stabstab/
├── electron/                          # 主进程（Node 侧，CommonJS，不经过 Vite）
│   ├── main.js                        # 入口：窗口、IPC、协议注册、生命周期、启动规范化
│   ├── preload.js                     # contextBridge 桥接（window.stab）
│   ├── assets/
│   │   ├── icon.png                   # 运行时窗口图标（打包进 asar）
│   │   ├── model-series.json          # ★ 内置模型系列定义（系列 / 来源 / 默认地址 / 尺寸）
│   │   └── rename-model.json          # ★ 内置重命名模型配置（标题提示模板 / 温度 / Top-P / 默认地址）
│   └── src/
│       ├── paths.js                   # ★ 数据根目录解析（用户目录 / 便携 exe 同级 / dev-data）+ 旧数据迁移，见 §5.6
│       ├── logger.js                  # 文件日志 <data>/log/app-YYYYMMDD.log
│       ├── store.js                   # settings.json / conversations.json 原子读写 + 旧结构迁移
│       ├── modelSeries.js             # ★ 模型系列配置读写与解析（resolveModel = 发请求的权威口径）
│       ├── renameModel.js             # ★ 重命名模型：rename-model.json 读写 + DeepSeek Responses API 调用
│       ├── imageutil.js               # PNG/JPEG/GIF/WEBP 尺寸嗅探、缓存下载（含 data:base64 结果）
│       ├── promptmeta.js              # ★ 图片提示词元数据：PNG iTXt / JPEG XMP(APP1) / WebP XMP 分块 读写（含输入图文件名 picN）
│       ├── conversationMeta.js        # ★ 会话侧查询：结果图 ↔ 父用户消息的「提示词 + 输入图文件名」（保存兜底写 picN）
│       ├── clipboardPayload.js        # ★ 复制到剪贴板的载荷：HTML 内嵌原图字节 + data-filename/prompt/pics
│       ├── zip.js                     # ★ 最小 ZIP 打包 / 解包（零依赖：CRC32 + zlib，含 ZIP64 与 CRC 校验）
│       ├── dataTransfer.js            # ★ 配置 + 聊天记录 导出 / 导入：包名协议 + 包内目录协议 + 智能合并
│       └── exportImage.js             # ★ 结果图导出（result:download 的实现，带提示词 + picN 元数据）
│       └── api/
│           ├── registry.js            # 适配器注册表 + 预留协议列表 + listProtocols()
│           ├── util.js                # 适配器公共工具（端点拼接 / 结果图片收集 / 错误归一化）
│           ├── dashscope.js           # Qwen 系列·官方（DashScope 多模态，仅同步）
│           ├── seedream.js            # Doubao Seedream 系列·官方（火山方舟 images/generations）
│           ├── newapi-images.js       # Seedream / GPT Image 系列·New API（OpenAI 兼容图像生成）
│           ├── grsai.js               # GPT Image 系列·Grsai（SSE 同步 / 只给任务 id 时协议内部查询结果）
│           └── runner.js              # 请求执行器：提交/任务兜底查询/下载/事件/取消（协议无关）
├── src/                               # 渲染进程（React，经 Vite 构建）
│   ├── main.jsx                       # 入口 + 全局错误捕获上报
│   ├── App.jsx                        # 根组件：bootstrap、API 事件路由、主题
│   ├── components/
│   │   ├── Sidebar.jsx                # 左侧：Logo、新建、会话列表（含后台状态圆点，见 §4.8；拖动排序见 §4.11）、重命名/删除、底部操作
│   │   ├── ChatView.jsx               # 主区：头部（插入·复制临时按钮）、消息列表（进入标签贴底，见 §4.9）、空态、输入框
│   │   ├── UserMessage.jsx            # 用户气泡：文本/图片、底部「模型名 + 时间」（见 §4.14）、新对话发送·当前对话发送（见 §4.13）、编辑重发、编辑气泡补图（粘贴/拖入/＋，见 §4.7.1）、复制、删除
│   │   ├── AssistantMessage.jsx       # 助手气泡：结果图/错误/等待卡片（各自带「停止等待」，见 §4.12）
│   │   ├── Composer.jsx               # 输入框：粘贴/拖入/多选、size/高级参数、发送（等待中也能发）/停止等待、附加提示词解析、逐标签草稿搬运
│   │   ├── SizePicker.jsx             # ★ 尺寸选择器：候选尺寸（sizeOptions）+ 末尾「自定义…」（两个数字 + 固定 ×，见 §4.10）
│   │   ├── PromptDrop.jsx             # ★ 全窗口左右解析分区（曲线分隔）+ 「图片提示词」查看弹窗
│   │   ├── SettingsModal.jsx          # 设置：模型 / 重命名模型 / 基础 / 高级 / 数据管理 五页
│   │   ├── Lightbox.jsx               # 全屏图片预览：滚轮缩放/拖动/ESC
│   │   └── Toasts.jsx                 # 轻提示
│   └── lib/
│       ├── store.jsx                  # React Context + reducer 全局状态 + 防抖落盘（含逐标签草稿 drafts，仅内存）
│       ├── promptReuse.jsx            # ★ 解析分区显隐状态机（图片接收区域是一组元素：输入框 + 编辑气泡）+ 元数据解析 + 待复用提示词（临时状态）
│       ├── models.js                  # ★ 模型系列/模型解析（界面侧，与主进程同口径）
│       ├── title.js                   # ★ 会话标签自动命名（首条文字 → 重命名模型 → 回退截取）
│       ├── send.js                    # 发送/重发公共逻辑（无上下文、消息配对、压缩、参数过滤、重发取哪套设置）
│       ├── composerSelection.js        # ★ 输入区「当前模型 + 当前参数」的实时镜像（编辑重发据此发请求，见 §4.7）
│       ├── images.js                  # File→dataUrl、尺寸读取、按设置压缩
│       └── util.js                    # uid/时间/字节/尺寸解析/appfile URL 构造
├── build/                             # 打包资源：icon.svg / icon.png / icon.ico
│                                      #   + installer.nsh：NSIS 自定义片段，覆盖安装前抢救旧数据（见 §5.6）
├── public/icon.svg                    # 渲染进程内引用的 Logo（Vite 原样拷贝到 dist）
├── scripts/
│   ├── test-api.js                    # 后端端到端测试（mock HTTP 服务 + 真实 runner/适配器）
│   ├── gen-logo.js                    # 生成彭罗斯三角 Logo（需 ImageMagick）
│   ├── package.sh                     # Ubuntu 一键打包（deb + 便携 tar.gz；给便携包放 stabstab-portable.txt 标记）
│   └── package.cmd                    # Windows 一键打包（nsis + portable）
├── index.html                         # Vite 入口
├── vite.config.mjs                    # Vite 配置（base:'./' 必须保留）
├── electron-builder.yml               # 打包配置
└── package.json                       # 依赖/脚本/元信息（desktopName 字段勿删）
```

---

## 3. 快速命令

```bash
cd /home/lv/QWEN/stabstab

npm install          # 装依赖（.npmrc 已配国内镜像）
npm run dev          # 开发模式：Vite(127.0.0.1:5173) + Electron，F12 开 DevTools
npm run build        # 只构建渲染进程 → dist/
npm run logo         # 重新生成 Logo（需 ImageMagick：convert/magick）

./scripts/package.sh # Ubuntu 打包（deb + 便携 tar.gz）
scripts\package.cmd  # Windows 打包（setup.exe + portable.exe）

# 语法检查（主进程无构建，改完先跑这个）
node --check electron/main.js && node --check electron/preload.js
for f in electron/src/*.js electron/src/api/*.js; do node --check "$f"; done

# 本地回归（dev-data 已 gitignore，脚本头有各自跑法）
#   dev-data/qa/resend-target-test.js     编辑重发取哪套设置（含自定义尺寸）
#   dev-data/qa/size-picker-test/         尺寸选择器「自定义」的交互 + 排版截图（Electron 隐藏窗口）
#   dev-data/qa/edit-attach-test/         编辑气泡补图（粘贴 / 拖入 / ＋ / 上限 / 重发带图）
#   dev-data/qa/paths-test.js             数据目录解析与迁移
```

开发模式数据目录：项目内 `dev-data/`（已 gitignore）。
打包后数据目录：安装版在用户数据目录（Windows `%APPDATA%\StabStab\stabstab-data`），便携版在 exe 同级，详见 §5.6。

---

## 4. 架构与数据流

### 4.1 主进程 vs 渲染进程的边界（重要）

| 职责 | 所在进程 | 原因 |
|------|----------|------|
| 窗口/菜单/生命周期 | 主进程 main.js | Electron 框架要求 |
| 文件读写、日志 | 主进程 | Node fs |
| 所有 HTTP 请求（API、下载、轮询） | 主进程 runner.js | 规避 CORS + 统一超时/取消 |
| 剪贴板（图片） | 主进程 | Electron clipboard + nativeImage |
| 文件/目录选择器 | 主进程 | Electron dialog |
| 图片压缩（canvas） | 渲染进程 lib/images.js | 依赖 DOM canvas |
| UI 状态与会话编辑 | 渲染进程 lib/store.jsx | React |
| 会话/设置持久化 | 主进程写盘，渲染进程发起 | 渲染进程是数据编辑主体，防抖后 `state:save` |

**规则**：渲染进程**不得**直接 `fetch` 外部 API（DashScope 无 CORS 头）；图片字节一律在渲染进程压缩成 dataUrl 后经 IPC 传给主进程。

### 4.2 IPC 通道清单（完整）

`window.stab`（见 electron/preload.js）：

| 方法 | IPC 通道 | 方向 | 说明 |
|------|----------|------|------|
| `bootstrap()` | `app:bootstrap` | invoke | 一次返回 settings/modelSeries/renameConfig/conversations/paths/platform |
| `saveState({settings,conversations,modelSeries,renameConfig})` | `state:save` | invoke | 防抖整包落盘（四份数据一起写） |
| `listProtocols()` | `protocols:list` | invoke | 协议元信息：sizeOptions / paramSchema / supportsImageInput |
| `generate(opts)` | `api:generate` | invoke | 发起生成（立即返回 jobId）；`opts.imageNames` = 输入图文件名（顺序同 images），见 §4.5 |
| `cancelJob(jobId)` | `api:cancel` | invoke | 中止**这一个**请求的等待（同对话里的其它请求不受影响，见 §4.12） |
| `onApiEvent(cb)` | `api:event` | on | 结果/状态事件流 |
| `generateTitle(text)` | `title:generate` | invoke | 会话标签自动命名：把首条文字交给重命名模型，回 `{ok,name}` / `{ok:false,code,message}` |
| `saveAttachment({name,mime,dataUrl})` | `attachments:save` | invoke | 保存用户输入图 → 返回 file 名（真实文件名由渲染进程随 `generate` 的 `imageNames` 上行） |
| `readAttachment(file)` | `attachments:read` | invoke | 读回 dataUrl（编辑重发用） |
| `downloadResult(file)` | `result:download` | invoke | 结果图 → 默认保存路径 |
| `copyImage(file)` | `result:copy-image` | invoke | 结果图 → 剪贴板（html 格式带提示词 + picN，见 §4.5） |
| `copyUploadImage(file)` | `attachments:copy-image` | invoke | 输入图 → 剪贴板（同上） |
| `readImagePrompt(filePath)` | `prompt:read` | invoke | 读外部图片的提示词元数据（只读，不写回）→ `{ok,prompt,pics,format}` |
| `readImagePromptFromData(dataUrl)` | `prompt:read-data` | invoke | 拿不到真实路径时的 dataUrl 兜底解析 |
| `copyText(text)` | `prompt:copy` | invoke | 提示词 → 系统剪贴板（文本） |
| `pickImages()` | `dialog:pick-images` | invoke | 多选图片 → [{name,mime,size,dataUrl}] |
| `pickFolder(defaultPath)` | `dialog:pick-folder` | invoke | 目录选择器 |
| `openCacheDir()` | `cache:open` | invoke | 文件管理器打开缓存目录（左侧标签栏底部按钮） |
| `exportData()` | `data:export` | invoke | 「另存为」后把配置 + 聊天记录（含被引用的图片）打成 `ss-YYYYMMDD-HHmm.zip`，见 §5.7 |
| `importData()` | `data:import` | invoke | 选择导出包 → 包名 / 目录协议两道校验 → 解压到缓存目录 → 智能合并叠加，见 §5.7 |
| `openDownloadsDir()` | `downloads:open` | invoke | 文件管理器打开数据目录下的 downloads（对话区右上角文件夹按钮；开发模式 = dev-data/downloads） |
| `openSystemDownloadsDir()` | `system-downloads:open` | invoke | 文件管理器打开系统「下载」目录（右上角「下载」按钮；Windows = %USERPROFILE%\Downloads，Ubuntu 24.04 = ~/Downloads；取不到时回退数据目录 downloads） |
| `openPath(p)` / `showInFolder(p)` | `shell:*` | invoke | 打开路径/定位文件 |
| `openExternal(url)` | `shell:open-external` | invoke | 打开外部链接（仅 http/https，如 API Key 申请页） |
| `log(level,message,extra)` | `log:write` | send | 渲染进程日志 → 主进程日志文件 |

### 4.3 生成请求数据流

```
[渲染进程] Composer/UserMessage 收集 text + images(dataUrl) + srcName(输入图真实文件名) + params + modelId
   └─ lib/send.js: sendNew() / resendEdited() / sendBubbleAgain()（气泡重发，见 §4.13）
        │  resendEdited / 气泡重发的 modelId / params 由输入区**当前设置**给出（resolveResendTarget，见 §4.7）
        ├─ lib/models.js resolveModel(modelId) → 界面用信息（尺寸列表 / 参数 schema / 是否有 Key）
        ├─ 压缩每张图（compressIfNeeded，按 settings.compress*）
        ├─ dispatch MSG_ADD [userMsg, assistant占位(pending, meta.modelId)]
        ├─ dispatch BUSY_SET(convId, jobId=assistantMsg.id)      ← 一个对话可以同时登记多个 jobId
        └─ window.stab.generate({conversationId, messageId, modelId, prompt, images, imageNames, params})
             │  imageNames：与 images 顺序一一对应的输入图文件名（读不到就是空串），见 §4.5
[主进程] main.js api:generate：modelSeries.resolveModel(settings, modelSeries, modelId)
   ├─ 解析出 protocol / sourceId / apiKey / baseUrl
   ├─ 缺模型 → NO_MODEL；缺协议 → NO_PROTOCOL；缺 Key → NO_API_KEY（都在事件里点明「系列 → 来源」）
   └─ runner.start(opts, sendEvent)   ── opts.imageNames 随 job 独立传递（并发生成不串图名）
        ├─ adapter.buildSubmitRequest(ctx) → fetch（AbortController + 超时）
        ├─ parseSubmit → deliverResult（下载/解码每张图到 cache/，写入 {prompt, pics}）→ emit result
        └─ 仅当适配器返回 kind:'task'（Grsai 某些节点只回任务 id）→ emit status → pollTask 查询到结果为止
             （这是**协议内部**的兜底，不是用户可切换的异步模式，也没有重启恢复）
[渲染进程] App.jsx onApiEvent 路由（**按 messageId 定位**，所以同一对话里的多个请求各走各的）：
   ├─ status → MSG_UPDATE {status:'running', taskStatus, taskId}       （仅协议内部任务兜底会出现）
   ├─ result → MSG_UPDATE {status:'success', images, usage...} + BUSY_CLEAR(convId, jobId) + 非当前会话则 CONV_DOT_SET(success 绿点)
   ├─ error  → MSG_UPDATE {status:'error', error} + BUSY_CLEAR(convId, jobId) + 非当前会话则 CONV_DOT_SET(error 红点)
   └─ cancelled → MSG_UPDATE {status:'cancelled'} + BUSY_CLEAR(convId, jobId)  （取消不算失败，不给圆点）
   圆点动作由 store.jsx#dotActionForEvent(ev, activeId) 统一判定（见 §4.8）
```

**事件载荷统一结构**：`{conversationId, messageId, type, ok, images?, error?, taskId?, status?, usage?, durationMs?, ...}`。

### 4.5 图片提示词元数据（生成 → 写入 → 保存 → 拖入 → 解析 闭环）

生成提示词（以及**用户这次一起发送的输入图文件名**）会写进**图片文件本身**（不是水印、不是画字、不只是内部数据库），
因此用户保存 / 导出后的图片重新拖回软件仍能读回完整提示词。

```
记录格式（结构化 JSON，字段顺序 = pic1…picN → prompt → v）
   纯文生图      {"prompt":"…","v":1}
   图生图 / 编辑 {"pic1":"用户图.png","pic2":"","prompt":"…","v":1}
   · picN：本次请求用户一起发送的第 N 张输入图**文件名**（与发送顺序一一对应）。
   · 读不到名字的位置（系统剪贴板粘贴、从别的程序直接复制）保留空串，但 pic 项必须在 ——
     「这次带了几张输入图」于是也被记录下来；位置即图片，绝不压缩数组。
   · 只保留文件名本身（去掉目录），不把用户的完整路径写进图片。
   · 数量：用户发几张就记几项（输入框当前上限 3 张，见 `Composer.MAX_IMAGES`）；
     `promptmeta.MAX_PICS = 12` 只是解析不可信元数据时的边界。
   · v 仍为 1：picN 是**可选扩展**（老记录没有这些键，读取端按「没有 pic 项」处理）；
     键顺序固定为 pic1…picN → prompt → v，便于其它工具按行解析。

[生成] runner.start(opts)  ── opts.prompt + opts.imageNames 是本次请求的（每个 job 独立的对象）
   └─ runner.requestMeta(opts) → {prompt, pics:[…]}（两者都空 → null，纯文生图不带 pic 项）
   └─ deliverResult：downloadImage(url, cacheDir, 'result', 120000, {prompt, pics})
        └─ imageutil.withPromptMeta(buf, prompt, pics) → promptmeta.writePromptToBuffer
             · PNG  : iTXt keyword=prompt（原文/UTF-8） + iTXt keyword=stabstab（{"pic1":"…","prompt":"…","v":1}）
             · JPEG : APP1/XMP 包（xmp:CreatorTool=StabStab，内含同一份 JSON 记录）
             · WebP : RIFF "XMP " 分块（内容同上）
             · GIF/BMP/TIFF：不支持 → 记录日志，原图照常落盘（不静默转换、不丢图）
        └─ 只「插入元数据分块」，IDAT/扫描数据原样保留：分辨率与可见画面不变、不重新编码
        └─ 重写（改提示词 / 补 picN）会**替换**本软件写过的分块，不会越写越多
   └─ 用户点「下载保存 / 另存为」→ electron/src/exportImage.js#exportResultImage / #exportResultImageAs
        · 图片自带的提示词 / picN 优先透传；旧缓存图（旧版本生成、只有提示词没有 picN）用会话记录里的
          「输入图文件名」补写（main.js#metaFromConversations → requestMetaOfParent → parent.images[].srcName）
        · 写入失败 / 格式不支持 → 图片照常保存（元数据失败绝不影响图片）
        · 图片已带齐同一份元数据时原字节透传（不重复写）

[解析] 拖入外部图片（全窗口左右解析分区 / 底部输入框）
   └─ 渲染进程：window.stab.readImagePrompt(file.path)（拿不到路径时用 readImagePromptFromData）
        └─ promptmeta.extractPromptFromFile → extractPromptFromBuffer
             返回：{ok:true, prompt|null, pics:[…], format} | {ok:false, code, message}
             code = FORMAT_UNSUPPORTED / FORMAT_UNKNOWN / CORRUPT / TOO_LARGE / READ_FAILED
   └─ 主动解析（释放到左/右半区）：没有提示词 →「该图片未包含可识别的提示词元数据。」
      （格式不支持 / 损坏 / 读取失败 → 各自的提示，不混为一谈）
   └─ 底部接收：安静跳过，不打断原有附件流程
```

**输入图文件名的来源（渲染进程侧，`src/components/Composer.jsx`）**：

| 图片来源 | 有没有真实文件名 | pic 项 |
| --- | --- | --- |
| 资源管理器 / 访达拖入（`onDrop` → `addFiles(files, true)`） | 有（`File.name` 就是磁盘文件名） | `"pic1":"用户图.png"` |
| 输入框「+」多选（`pickFiles`，主进程对话框返回 `path.basename`） | 有 | `"pic1":"用户图.png"` |
| 系统剪贴板粘贴（`onPaste` → `addFiles(files, false)`） | 没有（浏览器给的是 `image.png` 这类占位名） | `"pic1":""` |

附件对象带 `srcName`（真实文件名，可能为空串），随用户消息落进 `conversations.json`；
发送时 `lib/send.js` 按图片顺序映射成 `imageNames:[…]` 上行（重发同样带上），主进程 `runner.requestMeta` 再写进结果图。

**元数据随图片走的三条出口**（生成时写进缓存图的字节，之后不再依赖会话文件）：

| 出口 | 是否带元数据 | 说明 |
| --- | --- | --- |
| 保存到下载 / 另存为 | 是（且会补写） | `exportImage.applyPromptToBuffer`：自带值优先，旧图缺 picN 用会话记录补写后落盘 |
| 复制到剪贴板 | HTML 格式带（位图格式不带） | 见下 |
| 聊天区展示 | — | 展示用 `appfile://` 读的是原文件，元数据一直在文件里 |

复制（`main.js#copyImageToClipboard` → `electron/src/clipboardPayload.js`）一次写三个剪贴板格式：

```
image（位图）  ← 任何程序都能粘；位图在系统剪贴板里没有元数据容器，**提示词 / picN 一定丢**
html           ← 内嵌「原图字节」的 data URI（不是重新编码的位图，所以元数据完整），
                 另加属性：data-filename / data-prompt / data-pics（JSON 数组，没有输入图时不出现）
text           ← 文件名 + 提示词（纯文本框粘贴用；不含 pic 项，避免污染纯文本粘贴）
```

- 复制**老图**（只有提示词、没有 picN）时，会在内存里用会话记录补写 pic 项**再嵌进 HTML**
  —— 只改剪贴板这一份，缓存 / 源文件不动（`exportImage.applyPromptToBuffer` 对 buffer 的复用）。
- 字节超过 12MB 时不带 HTML（避免剪贴板里塞过大的 base64），位图照常复制。
- 「粘贴到别的程序再另存为图片」能否留下元数据，取决于该宿主是否保存 HTML 里那份原始字节；
  只认位图的程序（画图等）仍会丢 —— 这是系统剪贴板本身的限制。


**两类临时 UI（全窗口解析分区 / 插入·复制按钮）与底部输入框的关系**（实现见 `src/lib/promptReuse.jsx` + `src/components/PromptDrop.jsx`）：

- 拖动图片期间，`dragover`（window，capture）按**鼠标当前坐标**判断是否落在任一「图片接收区域」内
  → 在应用非接收区域**把整个窗口一分为二**显示左右解析区
  （`topUiPhase()` 纯函数），进入接收区域立即恢复原界面；`drop`/`dragend`/窗口失焦/`dragover` 静默 800ms 都会收起。
- **接收区域是一组元素**（`promptReuse.jsx` 里的 `receiversRef`，`registerComposerEl` 与 `registerReceiver` 都往同一个集合里注册）：
  底部输入框 `.composer` + **正在编辑的用户气泡 `.edit-bubble`**（见 §4.7 的「编辑气泡补图」）。
  指针落在其中任意一个之内就隐藏解析区、松手时那份文件丢给该区域自己处理 —— 否则解析区会把拖到气泡上的图片吃掉。
- 左右解析区的视觉：一层**半透明蒙版**（`--drop-mask-bg` + `backdrop-filter`，原界面仍可见、只是压暗），
  蒙版边缘一圈 **圆角矩形虚线**，中间是同色同风格的 **S 形虚线**（`ZoneCurve`：同一条贝塞尔曲线的上下两段，
  SVG 拉伸铺满窗口高度，`vector-effect: non-scaling-stroke` 保证描边不随拉伸变粗）；左半区 = 解析并复制、右半区 = 解析并查看，
  只有指针所在半区点亮（`hover-active` 时关闭过渡，保证跟手）。
- 显示触发范围 ≠ 接收范围：只有释放到左/右半区之一才执行解析（左=复制，右=查看弹窗）。
- 底部实际接收图片后才做附加解析，写进 store 的 `temporary`，顶部出现「插入／复制」；
  临时状态与两个按钮同生命周期，由 reducer 的 `clearReuse` 在切换 / 新建 / 删除会话时统一清理。

### 4.4 会话标签自动命名数据流

标签名有两种来源，都由渲染进程发起、主进程执行 HTTP：

```
新会话 → CONV_NEW：name = String(++tabCounter)（空对话就一直是序号），nameAuto = true
   └─ 首条「带文字」的输入发出时（lib/send.js#sendNew → lib/title.js#maybeAutoTitle）
        ├─ 会话里已经有带文字的用户消息 → 不处理（只认首条文字）
        ├─ nameAuto === false（用户手动改过名）→ 不处理
        ├─ settings.renameModel.apiKey 已配置
        │     └─ window.stab.generateTitle(text) → main：renameModel.generateTitle(settings, text, renameConfig)
        │           POST {baseUrl|rename-model.json.baseUrl}/responses（Responses API，非 chat/completions）
        │           回 {ok:true,name} → dispatch CONV_RENAME_AUTO {id,name,expectName}
        └─ 未配置 / 失败 / 超时 → 本地截取首条文字（fallbackTitle，最长 18 字）
   └─ reducer：CONV_RENAME_AUTO 只在 nameAuto !== false 且 name === expectName 时写入，写后 nameAuto = false
        （手动 CONV_RENAME 也会把 nameAuto 置 false —— 用户的改名永远优先，迟到的模型结果不会覆盖）
```

**不变量**：命名请求与图片生成并行、不阻塞；`conversations.json` 只存 `name/nameAuto`，不含任何 Key；命名失败静默回退，不弹错误。

### 4.6 逐标签草稿（输入区文字 + 待发送图片，仅内存）

输入区的 `text` / `attachments` 仍然留在 Composer 本地 state（打字不触发全局重渲染），
但**跟着标签走**：切换标签时先把离开标签的草稿存进 `state.drafts`，再把目标标签的草稿取回来 ——
于是任何标签自己的草稿都留到它被删除为止，且不会被别的标签覆盖或清空。

```
[Composer] 本地输入区（text / attachments）
   ├─ 每次渲染：draftRef = {text, attachments}          ← 最新草稿快照（effect 里读到的是上一拍）
   ├─ 切换标签（convId 变化）：
   │     dispatch CONV_DRAFT_PARK {convId: 上一个标签, draft: draftRef}    ← 离开的先存回仓库
   │     从 state.drafts[新标签] 取回（没有 = 空输入区，绝不沿用上一个标签的内容）
   └─ 发送成功：dispatch CONV_DRAFT_DROP {convId}       ← 这条草稿被消费，切回来不复活
[reducer] state.drafts : conversationId -> {text, attachments}
   ├─ CONV_DRAFT_PARK ：会话已不存在 → 丢弃请求；空草稿 → 删除条目（不留空壳）
   ├─ CONV_DELETE     ：只删被删标签自己那一份（其它标签的草稿原样保留）
   └─ CONV_DELETE_ALL ：drafts = {}
```

- **只存内存**：`flushSave` 只取 `settings / conversations / modelSeries / renameConfig`，`state.drafts` 不在其中 ——
  所以草稿不落盘、**重启软件即消失**；反过来，草稿也**绝不能塞进 `conversations`**（那一份会被整包写盘，草稿里可能有 base64 图片）。
- **切换即搬运，不是重置**：`CONV_DRAFT_PARK` 交给 reducer 时，若该会话已被删除则直接丢弃 ——
  否则「删除标签」之后迟到的那一拍会把草稿重新塞回仓库，草稿就永远不会释放。
- **发送期间切标签安全**：`doSend` 记下发起时的 `sentConvId`，收尾（清空输入区 / 清待复用提示词 / 焦点）只在该标签仍是当前标签时执行。
- 与 **待复用提示词**（`state.temporary`，见 §4.5）的区别：后者是解析图片元数据出来的临时按钮态，切标签即失效（`clearReuse`）；
  输入区草稿跟着标签走。两者生命周期不同，不要混在一起改。

### 4.7 编辑重发用「输入区当前设置」（不是消息当时的设置）

用户消息上的「编辑并重新发送」**不是照原样再发一次**：这次请求的**模型 / 尺寸 / 高级参数**
一律取底部输入框的**当前**选择 —— 当时用模型 A 发的，现在下方换成了模型 B、分辨率也改了，
重发就按 B 与当前分辨率发（`src/lib/send.js#resolveResendTarget` 是这条规则的唯一实现）。

```
[Composer] 模型下拉 / 尺寸下拉 / 参数面板变化
   └─ setComposerSelection(modelId, params)        ← src/lib/composerSelection.js（模块级外部状态）
[UserMessage] 编辑气泡（打开时才订阅）
   ├─ 渲染：resolveResendTarget({selection}) → 尺寸下拉的候选与默认值、即将使用的模型名
   ├─ 尺寸下拉：默认跟随输入区当前尺寸；手选 = 只覆盖这一次重发的 size（sizeOverride，候选值或自定义像素值都行）
   └─ 点「确定并重新发送」：再调一次 getComposerSelection() 取最新一拍
        └─ resendEdited({modelId: 当前模型, params: buildParams({...当前参数, size}, 当前模型 schema)})
             └─ 用户消息的 params / model 一并改写成本次真正发出去的那套（消息记录 = 实际请求）
```

- **为什么不用全局 store**：参数面板的数字 / 文本框每敲一个字符都会变，走 reducer 会让整条消息列表重渲染；
  这里用模块级外部状态 + `useSyncExternalStore`，且 `useComposerSelection(enabled)` 只在编辑气泡打开时订阅。
- **模型能力不同**：尺寸候选来自**当前模型**的 `sizeOptions`；候选之外的值，**能解析成像素尺寸（`宽×高`）的算合法的自定义尺寸、保留**
  （符号按当前协议规范化），既不是候选也不是像素尺寸的遗留值才校正到该模型的第一个候选；
  参数按**当前模型**的 `paramSchema` 过滤（`buildParams`），于是 A 协议的 `n` / `watermark` 不会漏给 B 协议。
- **兜底**：输入区还没写出任何设置（Composer 尚未发布，属极端时序）时，退回该消息记录里的模型与参数（= 旧行为）。
- **等待中也能编辑重发**：同步等待不再锁输入区（见 §4.12），所以编辑气泡里没有 busy 拦截；
  这条消息名下**正在等待的旧回复会先被 `cancelJob` 中止**（它们马上要被删掉，没必要白跑）。
- **消息记录跟着改写**：`MSG_EDIT_PREPARE` 把用户消息的 `params` / `model` 更新为本次实际使用的值，
  所以会话里留下的永远是「实际发出去了什么」，不是「打算发什么」。
- 回归脚本：`dev-data/qa/resend-target-test.js`（本地脚本，dev-data 已 gitignore，跑法见文件头）。

### 4.7.1 编辑气泡补图（粘贴 / 拖入 / 「＋」多选）

编辑气泡里除了原来的**移除**图片，还能**增加**图片 —— 三条入口与底部输入区完全同源，
只改这一条消息**本地**的 `kept` 列表，点「确定并重新发送」时才真正落盘（`resendEdited` → `attachmentsOfMessage` 读回 dataUrl）。

```
[UserMessage] 编辑态（.edit-bubble）
   ├─ 粘贴：onPaste 只挂在编辑 textarea 上 → **光标必须在编辑框里**才会触发（纯文字粘贴走默认行为）
   ├─ 拖入：接收区域 = 这条**用户气泡**（.edit-bubble 自己 onDragEnter/Over/Leave/Drop）
   │     └─ 同时把该元素注册进 promptReuse 的「接收区域」集合（registerReceiver）
   │           → 指针在气泡上时不显示左右解析区，松手的那份文件交给气泡（见 §4.5）
   └─ 「＋」：window.stab.pickImages() 多选（与输入区同一个主进程对话框）
        └─ 三条入口最终都走 addKeptFiles(files, named) → window.stab.saveAttachment → kept
```

- **上限共用**：`Composer.MAX_IMAGES`（= 3）—— 与输入区同一个常量，凑满 3 张后「＋」自动隐藏、再拖入/粘贴会被拒绝；
  本地 `setKept` 里再 `slice(0, MAX_IMAGES)` 兜一次（连续两次拖入时 `room` 是按上一拍算的）。
- **picN 的真实名规则不变**（见 §4.5）：拖入 / 「＋」多选拿得到磁盘文件名 → 记真名；系统剪贴板粘贴 → 记空串但位置保留。
- **只改本地**：删除 / 新增都只动 `kept`，取消编辑即全部丢弃，不会写进 `conversations.json`。
- **拖文字不误触**：`isFileDrag(e)` 只认 `dataTransfer.types` 含 `Files`，在气泡里拖选中的文字不会弹出补图蒙版。
- 回归脚本：`dev-data/qa/edit-attach-test/`（真实 `<App/>` + 真实 DOM 事件：粘贴 / 拖入 / 上限 / 移除 / ＋，
  并断言拖到气泡上时解析区不弹出、重发请求里的 `images` 与 `imageNames`；跑法见 `main.js` 文件头）。

### 4.8 侧栏圆点：后台生成状态（黄 / 绿 / 红，点开即消费）

一个会话在**别的标签上跑着**的时候，左侧标签用**同一个圆点组件**（`Sidebar.jsx#ConvDot` + `.conv-dot`，
只是颜色修饰类不同）表示三种后台状态：

| 圆点 | class | 含义 | 什么时候亮 |
|------|-------|------|-----------|
| 黄 | `.conv-dot.running` | 后台仍在等这个标签的结果 | 该会话**正在生成**且**不是当前标签** |
| 绿 | `.conv-dot.success` | 后台生成成功 | 结果事件到达时会话不是当前标签（`CONV_DOT_SET`） |
| 红 | `.conv-dot.error` | 后台生成失败 | 失败事件到达时会话不是当前标签（`CONV_DOT_SET`） |

```
[store.jsx] conversationDot(state, conv)       ← 侧栏渲染时调用（纯函数）
   ├─ 是当前标签 → null（正看着的会话不打扰；点开标签 = 圆点被消费）
   ├─ isGenerating(state, conv) → 'running'    ← 黄点是**推导**出来的，不额外记「谁在跑」
   └─ conv.dot || null                         ← 终态点（绿/红）由事件写入并落盘
isGenerating = waitingJobs(state, convId) 非空（busy 里有任意 jobId）
             ∨ 助手消息 status ∈ {pending, running}（兜底：事件与状态短暂不同步时）
[App.jsx] dotActionForEvent(ev, activeId)      ← 事件 → 圆点动作的唯一实现
   · 只有 result（→success）/ error（→error）给点，且事件到达时会话不是当前标签
   · status（还在跑）、cancelled（用户主动停止）都不给点
[reducer] CONV_ACTIVATE → 把该会话 dot 清空（消费）；CONV_DOT_SET → 写终态
```

- **黄点为什么是推导的**：切换标签、同一对话里的多个并行请求都不需要「谁在跑」的
  额外账本 —— 只要还在生成就自然亮黄点；`busy[convId]` 里只要还有任意一个 jobId 就算生成中。
- **消费语义**：点开标签即 `dot = null`（绿/红终态从此不再出现，切走再切回来也不复活）；
  黄点属于「当前状态」，切走时该黄还会再亮 —— 这是「还在等结果」的正确表达。
- **优先级**：正在生成优先于上一次的终态 —— 同一标签又发了一条，圆点从绿/红回到黄。
- **多个并行请求共用一个圆点**：一个对话等 2 个结果时也只是一个黄点；哪一个先落终态就按它给
  绿/红点（后到的终态会覆盖前一个）—— 圆点表达的是「这个标签有没有需要你看的动静」。
- **持久化**：`conversations[].dot` 只有 `null | 'success' | 'error'`（`'running'` 不落盘）；
  主进程启动时 `normalizeConversationsOnStartup` 把 `dot` 清空（结果已在会话里可见），
  并删除旧版本遗留的布尔字段 `unread`。
- 与「输入区草稿」「待复用提示词」互不相干：圆点只描述后台的生成状态。

### 4.9 聊天区滚动：进入标签页默认停在最后一条消息

`ChatView.jsx` 的 `.chat-scroll`（唯一滚动容器，`.message-list` 是内容）自带跟随策略 ——
点进一个历史较长的标签时直接落在**最后一条消息**上，不用自己往下翻：

```
[ChatView] useLayoutEffect [convId, msgCount, tailId]
   ├─ entered  = 上一次的 activeId ≠ 当前 convId（切换 / 新建标签）
   ├─ appended = msgCount 变多（自己刚发出）
   ├─ tailIsNew = 末尾换成了一条**更新的**消息（编辑重发「删旧回复 + 加新回复」在同一拍完成，条数常常不变；
   │              删掉末尾消息时新末尾更旧 → 不算，不会莫名把人拉到下面）
   └─ 满足任一条 → pinned = true，scrollTop = scrollHeight（**瞬时**，layout 阶段，切换不闪一下顶部）
[ChatView] ResizeObserver(.message-list)
   └─ 内容变高（结果图加载完成、文字换行）时：pinned 为真才再贴底
[ChatView] onScroll
   └─ pinned = 距底部 ≤ 48px（用户往回滚 → false，读历史时新结果不会把视线拽走；滚回底部自动恢复跟随）
```

- **为什么不能只写一次 `scrollTop = scrollHeight`**：结果图是 `max-width/height: 340px` 的自适应 `<img>`，
  进入标签那一刻图片还没解码，内容比最终高度矮 → 一次性的贴底会被后面的图片撑开而失效，
  所以要有 `ResizeObserver` 持续贴底（只对「本来就在底部」的用户生效）。
- 结果**只**在「进入标签」「消息条数变多」「末尾换成更新的消息（编辑重发）」三种时点强制贴底；
  同一标签里结果消息从 running 变 success 不改条数也不改末尾 id，因此正在读历史时不会被拉下去（这正是 pinned 的用途）。
- 瞬时滚动（不用 `scroll-behavior: smooth`）：切标签是「定位」而不是「播放动画」。
- 与 `.chat-scroll` 无关的滚动（输入框 `textarea` 自己的贴底、灯箱、解析弹窗）各管各的，不要混用。

### 4.10 尺寸选择器的「自定义」（输入区工具条与编辑气泡共用）

候选尺寸来自来源配置（`model-series.json` 的 `sources[].sizeOptions`）。两个尺寸选择器（输入区、编辑气泡）
**末尾都多一项「尺寸：自定义…」**：选中后右边出现两个数字输入框，**中间的乘号是固定的**，用户只填两个数字。
实现只有一处：`src/components/SizePicker.jsx`（Composer / UserMessage 都复用它）。

```
[SizePicker] 受控组件：value = 真正发出去的尺寸字符串，onChange(next)
   ├─ 自定义态记在**本地 state**，不能只看「value 在不在候选列表里」——
   │    用户填的数字正好等于某个候选值（例如 2048×2048）时，两个输入框必须继续留着
   ├─ 选中「自定义」：沿用上次填过的数字（第一次 1024×1024 打底）并**立即生效**，不必再点别处
   ├─ 每敲一个数字就回调，但**两个数字都有效才拼值**（清空输入框不会把尺寸发成空）
   ├─ 符号由协议决定（models.js#sizeSeparator）：DashScope(Qwen) = `宽*高`，Seedream / New API / Grsai = `宽x高`
   └─ 界面上一律显示 `×`（与 sizeLabel 一致），用户看不到协议差异
[models.js] CUSTOM_SIZE / parseSizeDims / sizeSeparator / normalizeSize / isValidSize（纯函数，UI 与 send.js 共用）
[Composer] 尺寸校正 effect：候选值原样保留；像素值只规范化符号；其余回落第一个候选（收敛后返回同一对象，不震荡）
[send.js] resolveResendTarget：sizeOverride 与输入区尺寸都按同一套「候选 ∨ 像素值」判定，再按当前模型协议规范化
```

- **为什么符号要按协议**：`size` 是原样透传给适配器的（`runner.js` → `body.size` / `parameters.size`），
  DashScope 要 `2688*1536`，Seedream / New API / Grsai 按文档写 `2048x2048`；界面显示统一用 `×`。
- 主进程**不校验**尺寸是否在候选列表里，所以自定义尺寸不需要改任何适配器。
- 回归脚本：`dev-data/qa/size-picker-test/`（Electron 隐藏窗口 + 真实 DOM 跑交互断言，并按排版截图；跑法见文件头）。

### 4.11 侧栏会话拖动排序（顺序 = 数组顺序）

左侧标签的顺序**就是** `state.conversations.conversations` 的数组顺序（`conversations.json` 里也是这个顺序）：

```
[Sidebar] 渲染顺序 = conversations 数组顺序（**不再**按 createdAt 排序）
   └─ 新建会话 CONV_NEW：新会话 unshift 到数组**头部** → 出现在最上面（与旧行为一致）
[拖动] 整条 .conv-item 都是把手（HTML5 DnD，draggable={!renaming}）
   ├─ dragstart：记下被拖的会话 id（dragIdRef 供 dragover/drop 读最新值，避免闭包拿到旧 state）
   ├─ dragover：指针在目标条目**上半 → 插到它之前**，下半 → 插到它之后（.drop-before / .drop-after 画指示线）；
   │           拖到自己身上不 preventDefault（不允许落在自己身上）
   ├─ dragover（列表末尾空白处，指针在最后一条下沿之下）→ 提示落到最后（.drop-after 画在最后一条上）
   └─ drop → dropIndexFor(list, id, overId, pos) → dispatch CONV_REORDER { id, toIndex }
[reducer] CONV_REORDER → moveConversation(list, id, toIndex)（越界夹紧；找不到 / 原地不动 → 返回 null 保持同一引用）
   ├─ 只改数组顺序：activeId / drafts / temporary / 消息一律不动（排序不是切换会话）
   └─ 顺序随既有的 conversations 防抖落盘写进 conversations.json（重启后保持）
```

- **两个纯函数在 `store.jsx`**（`dropIndexFor` / `moveConversation`，导出便于 QA 断言）：下标必须按
  「先摘掉自己、再插入」换算（`from < to` 时目标 -1），否则向下拖会永远差一位。
- **为什么改成数组顺序**：`createdAt` 只表示「什么时候建的」，用户拖动之后就不再等于显示顺序了；
  数组顺序本来就被整包写盘，直接用它当权威顺序即可（老数据的数组顺序就是原来的 createdAt 倒序，升级后外观不变）。
- **不影响别处**：`createdAt` 仍用于消息/时间显示，会话删除后的落点仍是 `rest[0]`（数组首条）。
- **不会误触图片解析分区**：本拖动只写 `text/plain`，`promptReuse.jsx#useAppFileDrag` 只认
  `dataTransfer.types` 含 `Files` 的拖动，因此拖标签期间不会弹出左右解析区（见 §4.5）。
- **重命名中不可拖**：`draggable={!renaming}`，否则输入框里选不中文字（`.conv-item` 整体 `user-select: none`，
  `.conv-rename-input` 单独特判回 `user-select: text`）。
- 回归脚本：`dev-data/qa/conv-reorder-test/`（真实 `<App/>` + 真实 DragEvent 序列：纯函数换算、DOM 顺序、
  当前标签不变、不误开解析区、防抖落盘顺序；跑法见 `main.js` 文件头）。

### 4.12 只有同步模式 + 「伪异步」：同一对话里的多个并行请求

**同步/异步开关已经彻底删除**（老版本里的 `requestMode` / `supportsAsync` / `X-DashScope-Async` /
`/tasks/{id}` 轮询与取消、重启后恢复异步任务、界面上的「同步模式／异步模式」徽标与高级设置里的单选卡片
全部不存在了）。现在**所有协议一律同步**：提交请求 → 阻塞等待响应 → 下载图片。

但「同步」只表示**一次请求要等结果**，不表示**一个对话只能等一个请求**。等上一个请求返回的时候，
输入框不锁定，可以继续发送 —— 每个请求完全独立，跟「另开一个对话来请求并等待结果」没有区别：

```
[发一次] lib/send.js 的 sendNew / resendEdited / sendBubbleAgain
   ├─ dispatch MSG_ADD [userMsg, assistant占位]                 ← 这个请求自己的配对与位置
   ├─ dispatch BUSY_SET {convId, jobId: assistantMsg.id}        ← 只登记自己
   └─ window.stab.generate({conversationId, messageId, ...})    ← jobId === messageId（不变量 2）
[状态] state.busy : conversationId -> { [jobId]: true }          ← **集合**，不是一个槽位
   ├─ BUSY_SET   {convId, jobId}    → 加一项
   ├─ BUSY_CLEAR {convId, jobId}    → 只删这一项（结果/失败/中止事件都只带自己的 messageId）
   └─ BUSY_CLEAR {convId}（不带 jobId）→ 清掉这个对话的全部等待标记（输入区「停止等待」用）
[主进程] runner 里每个 jobId 各有自己的 AbortController / 超时 / taskId：
   ├─ Fetch 完全并发，一个失败/超时/取消都不影响其它 job
   └─ cancel(jobId) 只中止这一个（见 §4.2 的 cancelJob）
[渲染进程] App.jsx 的事件路由全部按 messageId 定位 → 结果只会落进它自己那条助手消息
```

- **隔离的含义**：不共享任何等待状态、不共享超时、不共享错误 —— 事件、busy 项、助手消息三者都以
  `messageId` 为键；`MSG_EDIT_PREPARE` 也只删「自己 parentId 名下」的回复。
- **输入区**：`canSend` 不再看 busy（只有「本地正在提交」的 `sending` 会短暂禁用按钮）；
  工具栏右侧显示「等待中 ×N」与一个「停止等待」按钮，后者对**本对话全部**等待中的 jobId 调 `cancelJob`。
- **结果卡**：`pending` / `running` 的助手气泡自带一个「停止等待」，只中止**它自己**那一次请求。
- **超时**：每个请求各自按 `settings.requestTimeoutSec` 计时（互不累加）。
- **重启**：应用退出时所有在等待的请求都随之中断；`normalizeConversationsOnStartup` 把
  `pending/running` 的助手消息一律标成 `INTERRUPTED` 失败（不再有「恢复轮询」这回事）。
- **唯一的 kind:'task' 是谁**：Grsai 某些节点只回一个任务 id，`grsai.js` 会返回 `kind:'task'`，
  `runner.pollTask` 按适配器给的查询端点取回结果。它是**协议内部**的兜底（没有开关、没有模式徽标、
  不写 `meta.mode`、也不参与重启恢复），**不是**被删掉的「异步模式」，不要在 UI 上为它加任何模式提示。

### 4.13 用户气泡上的「新对话发送 / 当前对话发送」（把这条内容再发一遍）

用户气泡悬停时那一排按钮从原来的「复制 / 编辑 / 删除」变成
**「新对话发送 / 当前对话发送 / 复制 / 编辑 / 删除」**（前两个在最前面，`title` 就是这两个词）：

```
[UserMessage] 两个按钮 → resendBubble('new' | 'current')
   ├─ 取设置：resolveResendTarget({selection: getComposerSelection(), fallback…})
   │     —— 与「编辑重发」同一口径：模型 / 尺寸 / 参数用**输入区当前设置**（见 §4.7）
   ├─ 取内容：这条消息的 text + 全部输入图（msg.images 只存文件名，用 window.stab.readAttachment 读回 dataUrl；
   │     文件已被清理的图跳过；文字与图都拿不到时抛错提示，不发空请求）
   ├─ 'current' → sendBubbleAgain()：**在当前对话**里新增一条用户消息 + 它自己的助手结果
   └─ 'new'     → sendBubbleToNewConversation()：先 makeConversation() 造会话 → dispatch CONV_ADD
                  （新会话立刻成为当前标签）→ 再 sendBubbleAgain() 发进去
```

- **与「编辑重发」的区别**：编辑重发是**原地覆盖**（改写用户消息 + 删掉配对旧回复）；
  这两个按钮**什么都不改**，只是新增一份请求，所以原来那条消息与它的结果原样保留。
- **与 §4.12 的关系**：「当前对话发送」就是一个新的独立同步请求 —— 上个请求还在等也照发不误，
  两个（或多个）请求各等各的、互不干扰；「新对话发送」只是把目标会话换成一个新建的会话。
- **为什么要 `CONV_ADD` 而不是 `CONV_NEW`**：调用方必须**先拿到新会话对象**才能把请求发进去
  （`window.stab.generate` 要 `conversationId`），而 `CONV_NEW` 的 id 在 reducer 里现场生成。
  于是 `store.jsx#makeConversation(tabCounter)` 负责造对象与序号，`CONV_ADD` 只负责插到头部并激活。
- **按钮顺序即需求**：`新对话发送 - 当前对话发送 - 复制 - 编辑 - 删除`；图标 `chatPlus` / `send`
  （`assets/icons/chat-plus.svg` / `send.svg`，新增图标要走 `npm run check:icons`）。
- **防连点**：提交期间两个按钮 `disabled`（`.icon-btn:disabled` 置灰），避免同一次点击发出两遍。

### 4.14 用户气泡底部的「模型 + 时间」

`UserMessage.jsx` 的气泡底部信息行（`.msg-meta`）里，**时间左侧**显示这条输入**本次发送使用的模型**：

```
<div class="msg-meta has-model">
  <span class="msg-model" title="本次发送使用的模型：…（系列：qwen · 来源：official）">qwen-image-3.0-pro</span>
  <span class="msg-time">15:30</span>
</div>
```

- 数据来源就是消息自带的 `msg.model.name`（`send.js#modelRef` 写入，**不发请求、不做反查**）——
  这样模型后来在设置里被改名 / 删掉，历史气泡显示的仍是当时真正用的那个名字。
- 没有 `msg.model` 的老数据（早期版本 / 手工改过的会话）只渲染时间，不会留空位；
  助手气泡的 `.msg-meta` 不变（只有时间，没有 `has-model`），所以 `.msg-meta.has-model` 的 flex 规则不影响它。
- 样式（`app.css`）：`.msg-model` 单行 + 省略号（`max-width: 260px`），靠 `.msg-meta.has-model` 变成
  `flex` + `align-items: baseline` 右对齐贴住时间；`title` 里带系列 / 来源，长模型名悬停可看全。

---

## 5. 持久化数据结构（Schema）

### 5.1 `settings.json`

```jsonc
{
  "theme": "system",            // system | light | dark
  "defaultSavePath": "",        // 空 = 用 <data>/downloads
  "requestTimeoutSec": 300,     // 单次请求超时（秒）
  "compressEnabled": true,      // 图片自动压缩开关
  "compressMaxMB": 10,          // 超过该大小自动压缩
  "modelGroups": [              // 已添加的模型系列（隐藏的系列不在这里）
    {
      "seriesId": "qwen",       // 对应 model-series.json 里的 series[].id
      "models": [
        { "id": "m_xxx", "name": "qwen-image-3.0-pro", "sourceId": "official" }
      ]
    }
  ],
  "sourceConfig": {             // 按「系列·来源」保存密钥与地址覆盖
    "qwen.official": { "apiKey": "", "baseUrl": "" }   // baseUrl 为空 = 用 json 里的默认地址
  },
  "defaultModelId": "m_xxx",    // 全局默认模型；没有模型时为字符串
  "renameModel": {              // 「重命名模型」：会话标签自动命名的凭据（其余参数见 5.5 rename-model.json）
    "apiKey": "",               // DeepSeek 开放平台的 Key；为空 = 不做模型命名，直接截取首条文字
    "baseUrl": "",              // 空 = 用 rename-model.json 里的默认地址（https://api.deepseek.com）
    "modelId": ""               // 空 = 用 rename-model.json 里的默认模型（deepseek-flash）
  }
}
```

> **默认不预置任何模型系列**：全新安装时 `modelGroups` 为空；v1 旧结构（`api` / `models` / `requestMode`）由
> `store.migrateLegacySettings` 迁移时**也不会自动带出系列或模型**——只把旧 API Key / 自定义地址归位到
> `sourceConfig['<系列>.<来源>']`，用户自己添加该系列后即可直接生效（迁移后 `modelGroups` 仍为 `[]`、`defaultModelId` 为 `''`）。

### 5.2 `model-series.json`（内置模型系列定义）

`electron/assets/model-series.json` 随包发布（只读）；首次启动复制一份到 `<dataRoot>/model-series.json`（可写）。
合并规则：**系列/来源的成员与协议以程序内置为准**；本地副本可覆盖文案与默认值（label / description / hint / baseUrl / sizeOptions / apiKeyUrl），
并保存用户的 `hidden`（移除系列）；本地副本里的非内置系列原样保留。
**老版本数据里的 `requestMode` 与 `sources[].supportsAsync` 会被 `mergeSeries` 丢弃**（同步/异步开关已删除）。

```jsonc
{
  "version": 1,
  "series": [
    {
      "id": "qwen",
      "label": "Qwen 图像系列",
      "description": "……",
      "builtin": true,
      "hidden": false,                       // true = 已从设置列表移除（可重新添加）
      "protocol": "dashscope-multimodal",    // 系列默认协议（来源未指定时兜底）
      "modelPlaceholder": "例如：qwen-image-3.0-pro",
      "sources": [
        {
          "id": "official",
          "label": "官方（DashScope / 阿里云百炼）",
          "protocol": "dashscope-multimodal", // 绑定 registry 里的适配器 id
          "baseUrl": "https://dashscope.aliyuncs.com/api/v1",  // 默认地址：设置页自动填充 / 恢复默认
          "apiKeyUrl": "https://bailian.console.aliyun.com/",
          "hint": "……（设置页显示的协议要点）",
          "sizeOptions": ["auto", "2688*1536", "…"]
        }
      ]
    }
  ]
}
```

内置的三个系列：`qwen`（官方 DashScope 一个来源）、`doubao-seedream`（官方 Ark / New API）、`gpt-image`（Grsai / New API）。
三个系列都**只有同步**，配置里没有 `requestMode` / `supportsAsync` 这样的字段。

### 5.3 `rename-model.json`（重命名模型配置：标题提示模板 / 温度 / Top-P / 默认地址）

与 `model-series.json` 同一套做法：`electron/assets/rename-model.json` 随包发布（内置默认值），首次启动复制到
`<dataRoot>/rename-model.json`（唯一可写，可手工编辑，重启生效）；UI 里的两个滑动条与模板框写的就是它。

```jsonc
{
  "version": 1,
  "baseUrl": "https://api.deepseek.com",   // 默认 API 地址（设置页「API 地址」留空时用它）
  "modelId": "deepseek-flash",             // 默认模型 id（设置页「模型 id」留空时用它）
  "temperature": 0.5,                      // ★ 滑动条可改（0~2）
  "topP": 0.5,                             // ★ 滑动条可改（0~1；DeepSeek 非思考模式下该值不生效，恒为 1.0）
  "promptTemplate": "你是一个标题生成助手……以下为实际输入 JSON：\n{$$}"   // ★ 模板框可改，$$ = 实际输入片段
}
```

- 合并规则（`renameModel.mergeConfig(seed, local)`）：本地值非空 / 数值在区间内即生效，否则回退内置默认值；
  模板为空时回退内置模板，`temperature` 会被夹到 `0~2`、`topP` 夹到 `0~1`。
- **请求格式**（`renameModel.generateTitle`，见工作区 `deepseek系列.md`）：
  `POST {baseUrl}/responses`，body = `{model, instructions: <渲染后的模板>, input: '{"text":"…"}',
  temperature, top_p, reasoning:{effort:'none'}, text:{format:{type:'json_object'}}, stream:false}`
  —— 是 **Responses**，不是 chat/completions（`input`/`instructions` 两个字段都是必给的其中一种，这里都给）。
- **解析**：优先取 `output[]` 里 `type=message` 的 `content[].output_text`（跳过 reasoning item），
  再按 `{"title":"…"}` 解析 JSON，失败就按纯文本用；最后 `sanitizeTitle` 去引号 / 括号 / 句末标点并截到 18 字。
- 失败（无 Key / HTTP 错误 / 超时 20s / 没有可用标题）一律回 `{ok:false, code, message}`，**不抛异常**，
  由渲染进程回退到「截取首条文字」。

### 5.4 `conversations.json`

```jsonc
{
  "version": 1,
  "tabCounter": 0,       // 数字标签命名，只增不减
  "activeId": null,      // 当前激活会话
  "conversations": [     // ★ 数组顺序 = 侧栏显示顺序（拖动排序改的就是它，见 §4.11）；新会话插在数组头部
    {
      "id": "c_xxx", "name": "1", "nameAuto": true,
      // name  = 空对话是序号（"1"）；出现首条文字后自动命名（见 §4.4）
      // nameAuto = true 表示名字还可被自动命名替换；用户手动改名后为 false（自动命名不再覆盖）
      "createdAt": 0, "updatedAt": 0, "dot": null,
      // dot = 侧栏圆点的终态：null | 'success'（绿）| 'error'（红）；黄点 'running' 由渲染进程推导、不落盘（见 §4.8）
      //       启动时由主进程清空，旧版本遗留的布尔字段 unread 会被删掉
      "messages": [
        { // 用户消息
          "id": "m_u", "role": "user",
          "text": "提示词",
          "images": [ { "file": "up_xxx.png", "name": "a.png", "srcName": "用户磁盘上的文件名.png", "mime": "image/png", "width": 1024, "height": 1536 } ],
          // name    = 附件记录用的名字（粘贴的图是浏览器给的占位名）
          // srcName = 用户文件的**真实文件名**（拖入 / 多选时有，剪贴板粘贴时是空串）→ 写进结果图 picN、保存时兜底
          "params": { "size": "2048*2048", "n": 1, "negative_prompt": "", "watermark": false, "prompt_extend": true, "seed": "" },
          "model": { "id": "m_xxx", "name": "qwen-image-3.0-pro", "seriesId": "qwen", "sourceId": "official", "protocol": "dashscope-multimodal" },
          "createdAt": 0
        },
        { // 助手消息（parentId 指向配对用户消息）
          "id": "m_a", "role": "assistant", "parentId": "m_u",
          "status": "success",          // pending|running|success|error|cancelled
          "taskStatus": null,           // 仅协议内部任务兜底（Grsai 只回任务 id）时才有值
          "images": [ { "file": "result_xxx.png", "width": 2048, "height": 2048, "url": "https://...", "bytes": 123 } ],
          "texts": [], "error": null, "usage": { "output_width": 2048, "output_height": 2048, "output_image_count": 1 },
          "requestId": null, "taskId": null, "finishedAt": 0, "durationMs": 1234,
          "meta": { "protocol": "dashscope-multimodal", "model": "qwen-image-3.0-pro",
                    "modelId": "m_xxx", "seriesId": "qwen", "sourceId": "official" },
          "createdAt": 0
        }
      ]
    }
  ]
}
```

> 助手消息的 `meta.modelId` 是「重启后按模型反查配置」的定位依据（密钥不进会话文件）；
> **没有 `meta.mode`**（请求模式只有同步）。同一个对话里的多个请求各占一条助手消息，
> `messageId` 就是 `jobId`，所以「哪个结果属于哪个请求」永远明确（见 §4.12）。
> **`conversations[]` 的数组顺序 = 侧栏显示顺序**（拖动排序直接改数组顺序，见 §4.11）：`createdAt` 只用于时间显示，
> 渲染进程**不得**再按它排序；主进程启动规范化（`normalizeConversationsOnStartup`）也不得重排数组。
> 逐标签草稿（输入区的文字与待发送图片）**不在这个文件里**：它只活在渲染进程内存（`state.drafts`），重启软件即消失，见 §4.6。

### 5.5 图片存储位置

- 用户输入图 → `<data>/uploads/<file>`，渲染进程经 `appfile://uploads/<file>` 显示。
- 结果图 → `<data>/cache/<file>`，经 `appfile://cache/<file>` 显示。
- 下载结果 → `<defaultSavePath>/`（默认 `<data>/downloads`）。
- 删除 cache/ 目录**不影响程序运行**；历史消息中的结果图会显示「图片已清理」占位。
- `<data>` = 数据根目录，覆盖安装后必须还在原处（见 §5.6）。

### 5.6 数据目录与「覆盖安装保留配置」

`electron/src/paths.js` 是数据根目录的**唯一入口**（`getPaths(app)`）。规则：

| 运行形态 | 数据根目录 | 理由 |
|---|---|---|
| 未打包（`npm run dev`） | `<项目>/dev-data` | 不污染 node_modules，也不写用户目录 |
| 便携版（electron-builder `portable` 目标，`PORTABLE_EXECUTABLE_DIR` 已设置） | `<便携 exe 同级>/stabstab-data` | 便携包每次运行都解压到临时目录再跑（`portable.nsi` 跑完还 `RMDir /r`），写 `process.execPath` 同级 = 每次全新数据 |
| exe 同级放了 `stabstab-portable.txt`（Linux 便携 tar.gz 由 `package.sh` 放置） | `<exe 同级>/stabstab-data` | 保持「解压即用、拷走即带走配置」的便携语义 |
| 其余打包形态（Windows NSIS、Linux deb、macOS） | `<userData>/stabstab-data`（Windows = `%APPDATA%\StabStab\stabstab-data`，Linux = `~/.config/StabStab/stabstab-data`） | **卸载 / 覆盖安装都不会碰它** |

- **为什么安装版绝不能放 exe 同级**：NSIS 覆盖安装会先跑旧版卸载器（`installSection.nsh` 的 `uninstallOldVersion`），
  而卸载器里有 `RMDir /r $INSTDIR`（`uninstaller.nsh`）—— 安装目录里的东西全会被删。卸载器只删安装目录，
  除非显式 `--delete-app-data` 或配置 `deleteAppDataOnUninstall`，否则不碰 `%APPDATA%`。
- **旧数据迁移**（`migrateLegacyData`，只**拷**不删源）：新位置还没有配置时，从
  `exe 同级/stabstab-data`（旧版位置）→ `PORTABLE_EXECUTABLE_DIR` 同级 → `<userData>/stabstab-data`
  → `%LOCALAPPDATA%\Programs\{StabStab,stabstab}\stabstab-data` 依次找第一个「像数据根」（含任一配置文件）的来源。
  小配置（4 个 json）**同步**拷（本次启动就生效），`cache/ uploads/ downloads/ log/` **后台异步**拷（可能几个 G，不阻塞窗口）。
  搬运进度写在 `<data>/.migration.json`（来源 + 是否搬完），中途退出下次启动**续搬**；源目录消失则收尾标记完成。
- **安装器侧的抢救**（`build/installer.nsh` 的 `customInit`，经 `electron-builder.yml` 的 `nsis.include` 注入）：
  它在 `.onInit` 里、`initMultiUser` 之后、安装段之前执行 —— 此时 `$INSTDIR` 还是上一次的安装目录、数据还在，
  于是先用 `xcopy` 把 `$INSTDIR\stabstab-data` 拷到 `$APPDATA\<productName>\stabstab-data`（= 新版要读的位置），
  再由安装器照常删旧目录。目标位置已有配置就跳过（绝不拿旧数据盖新数据）；失败也不影响安装（应用启动还会再迁一次）。
- **排查入口**：启动日志里记 `dataRoot` / `dataRootKind` / `usedFallback` 与迁移结果（`logDataRootInfo`）；
  `app:bootstrap` 的 `paths.kind` / `paths.migratedFrom` 也一并下发。
- 回归脚本：`dev-data/qa/paths-test.js`（`node dev-data/qa/paths-test.js`，覆盖三种形态 + 迁移/续搬/不再重复迁移）。

### 5.7 「配置 + 聊天记录」导出包协议与合并规则

实现：`electron/src/dataTransfer.js`（业务）+ `electron/src/zip.js`（打包/解包，**零第三方依赖**）；
界面在**设置 → 数据管理**（`SettingsModal.jsx` 的 `data` 页），IPC 是 `data:export` / `data:import`（见 §4.2）。

**包名协议（导入的第一道校验，先于解压）**

```
ss-YYYYMMDD-HHmm.zip      例如 ss-20260213-1530.zip（本地时间，精确到分钟）
```

- 不匹配 / 日期时间不合法 → `{ok:false, code:'BAD_NAME'}`，界面提示「包名不符合格式」。
- **导出时强制回到协议名**：用户在「另存为」里改名（如 `我的备份.zip`）也会在目标目录里写出 `ss-<当前时间>.zip`，
  避免导出的包之后导不回来；结果里带 `renamedFrom` 供提示文案使用。

**包内目录协议（第二道校验，解压之后）**

```
ss-export/
├── manifest.json        {format:'stabstab-export', version:1, appVersion, exportedAt, counts{conversations,messages,images,missing}}
├── settings.json        settings.json 原样（含各「系列·来源」的 API Key —— 导出包要保管好）
├── conversations.json   会话 + 消息（标签名 / 模型引用 / 参数都在）
├── model-series.json    模型系列定义（用户自定义系列会一起带走）
├── rename-model.json    重命名模型（提示模板 / 温度 / Top-P / 默认地址）
├── cache/<file>         只含「聊天记录里引用到」的结果图
└── uploads/<file>       只含「聊天记录里引用到」的输入图
```

- 顶层只允许上面这些条目；`manifest.json` 必须存在且 `format === 'stabstab-export'`；
  `settings.json` 与 `conversations.json` 至少要有一个；媒体目录只允许平铺的图片文件（`.png/.jpg/.jpeg/.webp/.gif/.bmp/.tiff`）。
  任一条不满足 → `{ok:false, code:'BAD_STRUCTURE'}`；`version` 比程序新 → `BAD_VERSION`；包体损坏 → `BAD_ZIP`。
  这套严格校验同时挡住了目录穿越（条目名经 `zip.normalizeEntryName` 校验，绝对路径 / `..` / 盘符一律拒绝）。
- 解压目标是**程序缓存目录** `<dataRoot>/cache/ss-import-<随机>/`，无论导入成败都会清理。

**合并规则（叠加，绝不先清空）**

| 对象 | 规则 |
|------|------|
| 图片（独立文件） | 直接叠加到 `<data>/cache`、`<data>/uploads`（目录/文件不存在则创建）；**同名已存在则忽略**（查重） |
| 选项类设置 | `theme` / `requestTimeoutSec` / `compressEnabled` / `compressMaxMB` / `saveNamePromptChars` / `defaultModelId` 按导入值改动 |
| `defaultSavePath` | 机器相关的绝对路径：**本机确实存在该目录才采用**，否则保留当前值（并记一条 notes） |
| `renameModel`（凭据） | 导入的非空字段覆盖，留空的保留当前 |
| `modelGroups` | 同 id = 忽略；**同系列 + 同来源 + 同名**（不同机器上 id 不同）= 认作同一个模型 → 忽略并记 id 映射；其余**追加** |
| 系列 | 当前配置没有的自定义系列定义直接新增；导入的模型让某个已隐藏系列重新有模型时，把它从 `hidden` 里放出来（没有模型的系列保持隐藏） |
| `sourceConfig` | **只补空缺**：本机已有 Key / 地址的不被导入覆盖（避免误换账号） |
| `rename-model.json` | 非空字符串与合法数值按导入覆盖（`temperature` / `topP` 仍由 `renameModel.save` 夹到区间内） |
| 聊天记录 | 按 id 查重，新增的**追加在当前列表最新位置（最上面）**，顺序保持包内顺序；`tabCounter` 取两者最大值；`activeId` 保持当前有效标签 —— 见 §6 不变量 28 |
| 导入消息 | `dot` 清空；`pending/running/polling` 的助手消息按「被中断」标记为 `error`（与启动规范化同口径）；`meta.mode` / 旧 `taskId` 清掉 |
| 模型引用改指 | 被查重忽略的导入模型 id（`msg.model.id` / `msg.meta.modelId`）改成**本机那个同款模型的 id**，导入的历史对话于是能直接继续重发 |

- 落盘顺序：先叠加图片，再写 `model-series.json` → `rename-model.json` → `settings.json` → `conversations.json`，
  全部成功后更新主进程内存；任一步失败 → `SAVE_FAILED` / `COPY_FAILED`，内存与已写文件不半途改指向。
- 渲染进程收到成功结果后 `dispatch({type:'DATA_IMPORT', state})` 整体替换四份数据（`store.jsx`），
  并把设置弹窗里的草稿同步成导入后的值（避免之后点「保存」把导入的设置盖回去）。
- 导出前渲染进程先 `flushSave()`：主进程内存里的 `settings/conversations` 才是最新的（§4.1 的防抖落盘）。
- 合并逻辑是**纯函数**（`mergeImport` / `mergeModelGroups` / `mergeConversations` / `mergeSourceConfig` …），
  回归脚本见 §9.1 `[23]` `[24]`。

---

## 6. 关键不变量（改代码时严禁破坏）

1. **无上下文**：每次请求 `input.messages` 只含当前一条用户输入，绝不拼接历史消息。
2. **jobId === assistant 消息 id**：`runner` 的 `activeJobs` 以 `messageId` 为键；取消、停止等待都依赖此约定。
3. **user↔assistant 配对**：assistant 消息的 `parentId` 指向其用户消息；「编辑重发」通过 `MSG_EDIT_PREPARE` 删除 `parentId===userMsgId` 的旧回复。
4. **图片 base64 格式**：`data:<mime>;base64,<data>`（各协议统一用这个格式接收输入图）。
5. **size 参数**：`'auto'` 表示**不发送** size 字段（交给模型推荐）；qwen 用 `宽*高`（如 `2688*1536`），Seedream 官方支持 `1K/2K/4K` 或 `2048x2048`，Grsai 支持比例（如 `16:9`）。候选列表来自来源配置（`model-series.json` 的 `sources[].sizeOptions`）；
   候选之外**允许用户自定义像素尺寸**（尺寸选择器末尾的「自定义」，见 §4.10）——分隔符按协议：DashScope `*`，其余 `x`（`models.js#sizeSeparator` / `normalizeSize`），主进程原样透传、不校验。
6. **协议适配器接口**：新增协议必须实现 registry 中约定的方法（见 §7），否则 `runner.start` 直接报 `NO_ADAPTER`。
7. **appfile 协议**：URL 结构 `appfile://<cache|uploads>/<文件名>`；主进程 handler 用 `path.basename` 防目录穿越。
8. **Vite `base:'./'`**：打包后经 `file://` 加载，资源必须相对路径，否则白屏。
9. **数据目录解析**：`paths.js` 是唯一入口；打包后**安装版必须落用户数据目录**（便携版才允许 exe 同级），
   绝不写安装目录 —— 覆盖安装时旧卸载器会 `RMDir /r $INSTDIR`，详见 §5.6 与不变量 25。
10. **防抖落盘**：渲染进程是数据编辑主体，`store.jsx` 中 `state.settings/modelSeries/renameConfig/conversations` 变化后 400ms 防抖 `state:save`；`beforeunload` 立即 flush。
11. **模型必须经由系列解析**：发请求时 `protocol/baseUrl/apiKey` **只能**由 `modelSeries.resolveModel()` 得出（渲染进程的解析只服务界面）；`modelId` 是唯一的跨进程定位键。
12. **没有同步/异步开关**：请求模式恒为「同步」；`model-series.json` / `resolveModel` / 适配器元信息里都**不得**再出现
    `requestMode` / `supportsAsync` / `mode` 字段；DashScope 不得发送 `X-DashScope-Async`，也不得轮询 `/tasks/{id}`。
    界面不得再显示任何「同步模式／异步模式」徽标或选项（见 §4.12）。唯一保留的 `kind:'task'` 是 Grsai 协议内部的
    结果查询兜底（服务端只回任务 id 时），它不是可切换的模式，也不参与重启恢复。
13. **钥匙不进会话**：`conversations.json` 只记 `meta.modelId/seriesId/sourceId`，绝不写入 API Key。
14. **标签命名只认首条文字**：自动命名只在「会话里还没有带文字的用户消息」时触发一次；`nameAuto === false`（用户手动改过名）时永不覆盖，见 §4.4。
15. **重命名模型走 Responses API**：`POST {baseUrl}/responses`（`input` + `instructions` + `reasoning.effort='none'` + `text.format=json_object`），**不是** chat/completions；默认地址 / 默认模型 / 提示模板 / 温度 / Top-P 一律来自 `rename-model.json`（主进程解析，渲染进程只传首条文字）。
16. **提示词元数据只「插入分块」**：写元数据不得解码 / 重新编码像素，不得改变分辨率与可见画面，不得覆盖已有元数据；GIF/BMP/TIFF 明确返回 `FORMAT_UNSUPPORTED`（不静默转换）。重写本软件自己的记录（改提示词 / 补 picN）时**替换**旧分块，不允许同一份记录叠积，但判据必须保守（`isManagedPngText` 只认 `iTXt keyword=stabstab` 与「纯文本 iTXt prompt」，`tEXt` / `zTXt` 与别家 JSON 一律保留；`isOwnXmpSegment` / `isOwnXmpChunk` 要求 XMP 里出现 `stabstab:Prompt` 或 `StabStab`），绝不能把别的工具（如 ComfyUI）写的元数据删掉。
17. **元数据失败不许丢图**：`imageutil.withPromptMeta` / `exportImage.applyPromptToBuffer` 失败时都必须返回原字节并继续写盘；生成结果图与用户导出的图片永远优先保证存在。
18. **提示词与结果图一一对应**：`opts.prompt` 随每个 job 独立传递（`runner.deliverResult` → `downloadImage(..., {prompt, pics})`），并发生成时不得把别的 job 的提示词写进本批图片。
19. **输入图文件名（picN）随请求走、按位置对齐**：`picN` = 用户本次发送的第 N 张输入图文件名，顺序与 `images` 严格一一对应；读不到名字（系统剪贴板粘贴 / 直接复制）**保留空串但必须保留 pic 项**（`pic1`…`picN` 都在），这样「带了几张输入图」也被记录；纯文生图不得出现任何 pic 项。名字只写文件名本身（`promptmeta.sanitizePicName` 去掉目录），不得把用户路径写进图片。保存 / 另存为时，图片自带值优先，旧图缺 picN 才用会话记录（`conversations.json` 里用户消息的 `images[].srcName`）补写。
20. **解析区显隐 = 鼠标当前位置**：判定必须每次 `dragover` 重算（`topUiPhase`），不能只在图片进入窗口时设置一次；底部输入框区域判定优先于应用全局判定，且 `drop` 事件只能被处理一次（半区侧 `stopPropagation` + 全局侧 `defaultPrevented` 兜底）。
21. **解析区覆盖整个窗口且不遮挡原界面**：`position: fixed; inset: 0` 盖住 `.app-shell` 全部内容（含侧栏/标题栏/消息区），
    底色必须是**半透明**蒙版（禁止用不透明背景把界面盖白），边缘圆角矩形虚线与中间曲线分隔线**同色同风格**（都走
    `--drop-line` / `--drop-line-strong`），曲线只作装饰（`pointer-events: none`），实际接收者是左右两个半区。
22. **待复用提示词与「插入／复制」同生命周期**：存在 `state.temporary`，点击按钮 / 发送 / 切换 / 新建 / 删除任意会话（含非当前）/ 全部删除 / 主动改文字都必须一起清空；聚焦、移动光标、附件变化、拖放区显隐不得清理；异步解析必须用版本号 + 会话标识 + 文字快照三重校验，过期结果不得重新显示按钮。
23. **逐标签草稿只存内存、随标签存亡**：输入区的文字与待发送图片按 `conversationId` 存在 `state.drafts`（仅内存，**不得**进 `state:save`，也**不得**塞进 `conversations`）；切换标签只搬运不清空（别人的草稿不许丢、也不许被上一个标签的内容覆盖），会话 `CONV_DELETE` / `CONV_DELETE_ALL` 时对应草稿随之删除；`CONV_DRAFT_PARK` 必须拒绝已不存在的会话（否则删除后迟到的一拍会把草稿塞回仓库、永不释放），发送成功必须 `CONV_DRAFT_DROP`（切回来不复活已发送的内容），见 §4.6。
24. **编辑重发用输入区当前设置**：`resolveResendTarget`（`lib/send.js`）是唯一实现 —— 模型 / 尺寸 / 高级参数取**输入区当前值**（`lib/composerSelection.js` 的实时镜像），**不得**改回「用该消息记录里的 `msg.model` / `msg.params` 发」；尺寸候选与参数过滤都要按**当前模型**（`sizeOptions` / `paramSchema`）算，输入区遗留的不兼容尺寸校正到该模型第一个候选；输入区尚未发布设置时才退回消息记录那套；重发后用户消息的 `params` / `model` 改写为本**实际发送**的那套，见 §4.7。用户气泡的「新对话发送 / 当前对话发送」也用同一套设置口径（见 §4.13）。
25. **数据必须活在安装目录之外**：打包后（非便携）数据根一律 `<userData>/stabstab-data`，**严禁**改回 exe 同级 ——
    NSIS 覆盖安装会先跑旧卸载器，`RMDir /r $INSTDIR` 会把安装目录连数据一起删掉；便携形态只认
    `PORTABLE_EXECUTABLE_DIR` 或 exe 同级的 `stabstab-portable.txt` 标记。旧数据迁移（`migrateLegacyData`）**只拷不删**源目录，
    已有配置时不得再迁（不能覆盖新数据），中断要能靠 `.migration.json` 续搬；安装器侧的抢救只准放在 `customInit`
    （`customInstall` 太晚，旧卸载器已经删过目录了），目标目录必须与 `paths.js` 算出来的一致，见 §5.6。
26. **侧栏圆点三态只有一个实现**：黄/绿/红都走 `Sidebar.jsx#ConvDot` + `.conv-dot` 的三个修饰类；
    显示与否由 `store.jsx#conversationDot` 判定（**只有非当前标签**才显示；`'running'` 由 `isGenerating`
    推导，**不得**另立一份「谁在跑」的账本），终态点只由 `dotActionForEvent` 写入（result → 绿、error → 红；
    `status` / `cancelled` 不给点）；点开标签即消费（`CONV_ACTIVATE` 清 `dot`，切走再切回来不复活）；
    正在生成优先于上一次的终态。`conversations[].dot` 只存 `'success' | 'error' | null`，`'running'` 不落盘，见 §4.8。
27. **聊天区进标签即贴底**：进入标签 / 该标签新增消息（条数变多，或末尾换成更新的消息 = 编辑重发）时，
    必须在 layout 阶段把 `.chat-scroll` **瞬时**滚到最后一条消息（禁止平滑动画，否则切标签会先闪一下顶部）；
    结果图是自适应尺寸、进入那一刻还没解码，所以**不得**只在挂载时贴一次 —— 内容变高要用 `ResizeObserver` 续贴；
    但用户**往回滚过**（距底 > 48px）就不得再自动贴底（读历史时来的新结果不能把视线拽走），滚回底部自动恢复跟随，见 §4.9。
28. **侧栏顺序 = `conversations` 数组顺序**：渲染进程**不得**再按 `createdAt` 排序（拖动排序会让两者不再一致）；
    拖动只走 `store.jsx#dropIndexFor`（落点 → 目标下标）→ `CONV_REORDER` → `moveConversation`，
    只改数组顺序（`activeId` / `drafts` / `temporary` / 消息都不动），顺序随既有防抖落盘持久化；
    拖动只写 `text/plain`，**不得**让侧栏拖动触发图片解析分区（解析区只认 `Files` 类型，见 §4.5）；见 §4.11。
29. **同一对话的多个请求必须完全隔离（伪异步）**：`state.busy` 是 `conversationId -> { [jobId]: true }` 的**集合**，
    **不得**退回「一个对话一个槽位」；每次发送只 `BUSY_SET` 自己的 `jobId`，结果 / 失败 / 中止只 `BUSY_CLEAR`
    自己的那一项（不带 `jobId` 的 `BUSY_CLEAR` 只给输入区「停止等待」用，清掉该对话全部标记）；
    `jobId === messageId` 且所有 API 事件都按 `messageId` 定位，于是一个对话里等 2 个以上结果时事件不会串；
    等待期间**不得**再禁用发送按钮（`canSend` 不看 busy）、**不得**再在编辑重发里用 busy 拦截；
    单个请求的中止只能走 `window.stab.cancelJob(那个 messageId)`。见 §4.12。
30. **用户气泡的两个重发按钮不得改动原消息**：「新对话发送 / 当前对话发送」只新增一条用户消息 + 它自己的
    助手结果（`sendBubbleAgain`），**不得**走 `MSG_EDIT_PREPARE`（那是编辑重发的原地覆盖）；
    内容只取该气泡的 `text` + 全部输入图（`readAttachment` 读回，缺文件跳过，内容全空则报错不发）；
    新对话必须先 `makeConversation()` + `CONV_ADD`（拿到 conv 对象才能发请求），**不得**用 `CONV_NEW`。见 §4.13。
31. **导出包名 + 包内目录协议是导入的两道硬校验**：包名必须 `ss-YYYYMMDD-HHmm.zip`（`BAD_NAME`），
    解压后 `ss-export/` 里必须齐备 manifest 与允许的条目（`BAD_STRUCTURE`），**分别报错、不得合并成一类**；
    导出时若用户在「另存为」里改了名，必须写回协议名（否则这个包以后导不回来）。解压只能落在
    `<dataRoot>/cache/ss-import-*` 临时目录并在结束时清理；条目名一律过 `zip.normalizeEntryName`（挡目录穿越），
    `zip.js` 保持**零第三方依赖**（生产依赖为空是打包前提，见 §8.1）。见 §5.7。
32. **导入是「叠加 + 智能合并」，绝不清空 / 绝不覆盖本机凭据**：图片按文件名查重直接落盘，模型按
    「同 id / 同系列同来源同名」查重后追加（当前没有的系列自动新增并从 `hidden` 放出），聊天记录按 id 查重后
    **追加在列表最上面**，选项类设置按导入值更新而 `sourceConfig` 的 Key/地址**只补空缺**；
    被查重忽略的导入模型必须在会话里**改指本机同款模型 id**（否则导入的历史对话重发会找不到模型）；
    合并逻辑只许走 `dataTransfer.js` 的纯函数（`mergeImport` 一族），落盘失败要整体报错、不更新内存。见 §5.7。
33. **用户气泡的模型标签只读 `msg.model`**：显示的是**这条消息当时真正用的模型名**（`send.js#modelRef` 写入），
    不得在渲染时按当前设置反查 / 回填 —— 模型被改名或删掉后，历史气泡仍要显示当时的名字；
    老数据没有 `msg.model` 时只显示时间，不留空位。见 §4.14。

---

## 7. 协议适配器接口（如何接入另一套 API 规则）

适配器是一个 CommonJS 模块，导出以下字段/函数（参考 `electron/src/api/dashscope.js`）：

```js
module.exports = {
  id: 'xxx',                     // 唯一协议 id，registry 键名
  label: '展示名',
  defaultBaseUrl: 'https://...',
  defaultModel: '模型默认名',
  supportsImageInput: true,      // 是否支持输入图（图生图）；false 时界面可据此提示
  modelPlaceholder: '例如：xxx',  // 模型 id 输入框的灰色提示
  sizeOptions: ['auto', '2688*1536', ...],   // 前端 size 下拉的兜底候选（来源 json 里的 sizeOptions 优先）
  paramSchema: { n: {...}, negative_prompt: {...}, ... }, // 前端参数面板元信息（决定发什么参数）
  buildSubmitRequest(ctx) -> {url, method, headers, body},
  parseSubmit(json, httpStatus) -> {kind:'result',images,texts,usage,requestId} | {kind:'task',taskId,taskStatus} | {kind:'error',error:{code,message,requestId}},
  // ↓ 可选：只有「服务端没法一次返回结果、必须先给任务 id」的协议才需要（目前只有 Grsai）。
  //   这不是可切换的「异步模式」，只是该协议自己的取结果方式。
  buildTaskQuery(ctx) -> {url, method, headers},
  parseTask(json, httpStatus) -> {status:'SUCCEEDED'|'FAILED'|'RUNNING'|'PENDING'|'UNKNOWN'|'CANCELED', images?, texts?, usage?, error?},
  buildTaskCancel(ctx) -> {url, method, headers} | null      // 返回 null = 无服务端取消接口
};
```

`ctx` 结构：`{apiKey, baseUrl, model, prompt, images:[dataUrl], params, taskId?}`（**没有 `mode`**）。

`paramSchema` 字段类型（`Composer.jsx#ParamsPanel` 按类型渲染，`lib/send.js#buildParams` 按 schema 过滤参数）：

| type | 渲染 | 说明 |
|------|------|------|
| `bool` | 复选框（连续多个会并成一行） | 恒发送 true/false |
| `int` | 数字输入 | 留空 = 不发送；`min`/`max` 生效 |
| `string` | 文本输入 | 留空 = 不发送 |
| `enum` | 下拉框（`options: ['', 'a', 'b']`） | `''` 显示为「默认（不发送）」 |

结果图片可以用 **http(s) URL** 或 **`data:image/...;base64,...`** 返回，`runner.deliverResult` 两种都会落盘到 `cache/`（见 `imageutil.downloadImage`）。

**接入一套新 API 规则**：
1. 在 `electron/src/api/` 新建适配器文件（可复用 `api/util.js` 的 `endpoint / collectImages / normalizeError…`）；
2. 在 `electron/src/api/registry.js` 的 `adapters` 对象中注册（键 = id）；
3. **在 `electron/assets/model-series.json` 里挂到某个系列**（新建系列，或给现有系列加一个 `sources[]` 条目，`protocol` 填适配器 id）——这一步才让它在「设置 → 模型设置」中可选；
4. （可选）把未实现的协议放入 `reserved` 数组，会显示为「预留/禁用」。
5. 跑 `npm run test:api`，在 `scripts/test-api.js` 里补一个 mock 端点 + 场景。

`runner.js` 的 `start/cancel/cancelAll/deliverResult/pollTask` 是**协议无关**的，新增协议无需改动执行器
（`pollTask` 只在适配器返回 `kind:'task'` 时被用到）。

### 7.1 四个内置协议要点（对接新来源时照抄这份对照表）

| 系列 · 来源 | 适配器 id | 端点 | 请求要点 | 结果解析 |
|-------------|-----------|------|----------|----------|
| Qwen · 官方 | `dashscope-multimodal` | `POST {base}/services/aigc/multimodal-generation/generation` | `input.messages[].content=[{image},{text}]`，参数 n/negative_prompt/watermark/prompt_extend/seed/size；**纯同步，不发任何异步请求头** | `output.choices[].message.content[].image`（旧版 `output.results[].url`） |
| Doubao Seedream · 官方（火山方舟 Ark） | `seedream-official` | `POST {base}/images/generations`（base 默认 `https://ark.cn-beijing.volces.com/api/v3`） | `{model,prompt,size,image,response_format:'url',watermark?,output_format?}`；`image` 单图=字符串、多图=数组；Ark 文档要求**不要传不支持的字段**，因此可选参数只在用户显式选择后才发送 | `data[].url`（或 `b64_json`），`usage.generated_images` 归一化为 `output_image_count` |
| Seedream / GPT Image · New API | `newapi-images` | `POST {base}/images/generations`（base 形如 `https://host/v1`） | `{model,prompt,size,n,quality?,style?,response_format:'url',image?}`；令牌页面生成 Bearer | `data[].url \| data[].b64_json`（两者都会落盘） |
| GPT Image · Grsai | `grsai-image` | `POST {base}`（完整地址 `…/v1/api/generate`） | `{model,prompt,images?,aspectRatio?}`；`aspectRatio` 支持 `16:9` 这类比例或 `1024x1024` 像素值；`images` 为 dataUrl / URL 数组 | SSE `data:` 行里的 `results[].url`，或 JSON `{code:0,data:{results:[{url}]}}`；**若服务端只回任务 id**，协议内部按 `POST {host}/v1/draw/result {id}` 取回结果（不是可切换的异步模式） |

> 文档来源：工作区 `seedream系列api.md`、`gpt-image系列.md`、`api-url.txt` 与千问平台静态 HTML。
> 注意 `seedream系列api.md` 里的「官方版本 api 示例」给的是 `/api/v3/responses`（文本对话示例），**生图实际用 `/api/v3/images/generations`**。
> Grsai 文档未写明响应结构，故 `grsai.js` 同时兼容 SSE / JSON / 任务 id 三种形态。

---

## 8. 打包流程与已知坑

### 8.1 打包

- electron-builder 配置见 `electron-builder.yml`；`files` 只含 `dist/**`、`electron/**`、`package.json`（生产依赖为空，React 被 Vite 打进 bundle）。
  ZIP 打包 / 解包是自研的 `electron/src/zip.js`（只用 Node 自带 zlib），**能不加运行时依赖就不加** ——
  一旦加了依赖，`files` / `asar` 与安装包体积都会跟着变，先确认真的必要。
- `build/` 是 buildResources（图标源），**运行时窗口图标**在 `electron/assets/icon.png`（打进 asar）。
- deb 需要 `package.json` 里的 `homepage` 字段（缺了 fpm 报错）；`desktopName` + `linux.syncDesktopName` 保证窗口与 .desktop 关联。
- 二进制名会被 electron-builder 规范化为 `stabstab`（productName 含中文时），启动脚本已做 `stabstab`/`StabStab` 双名探测。

### 8.2 已知坑（务必了解）

1. **Chromium 进程沙箱在受限环境崩溃**（`main.js` 顶部，**不要删除这段降级逻辑**）：
   - **Linux**（`GPU process isn't usable. Goodbye.`，error_code=1002）：追加 `--disable-gpu-sandbox`；必要时（无用户命名空间且 chrome-sandbox 非 SUID）再追加 `--no-sandbox`。
   - **Windows**（企业 EDR / 安全软件挂钩进程创建，实测深信服 aES）：沙箱无法建立受限令牌 / AppContainer，日志表现为
     `渲染进程异常退出 {"reason":"launch-failed","exitCode":57}`（窗口空白）或 GPU 进程 `error_code=57` → 主进程 FATAL 直接退出。
     已对 Windows 默认追加 `--no-sandbox`（主/渲染/GPU 沙箱同时失效，属已知取舍）；设置 `STABSTAB_KEEP_SANDBOX=1` 可恢复沙箱。
2. **DashScope 无 CORS**：必须在主进程 fetch（渲染进程直连会失败）。
3. **asar 内读文件**：用 `path.join(__dirname, ...)` + Electron 的 fs 补丁即可读；写文件必须写到 asar 之外（数据目录）。
4. **图片尺寸嗅探**：结果图用 `usage.output_width/height` 优先，缺失时 `imageutil.sniffDimensions` 解析 PNG/JPEG/GIF/WEBP 头。
5. **GIF**：canvas 压缩只取第一帧，与 API「动态 GIF 仅处理第一帧」一致。
6. **HTTP 超时**：`runner` 用「AbortController + setTimeout(deadline)」实现总超时；轮询单次 fetch 另有 30s 上限。
7. **`base:'./'`**：改成绝对路径会导致打包后白屏。
8. **中文路径/文件名**：数据目录用 ASCII `stabstab-data` 规避潜在问题；可执行文件同级目录的写入权限检测用「探测文件」实现。

---

## 9. 测试方法

### 9.1 后端逻辑单测（mock HTTP 服务，覆盖全部 4 个协议）

无需 GUI，用本地 HTTP 服务模拟各家接口即可验证 runner 的同步 / 错误 / 取消 / **并发隔离** 全链路 + 各协议解析：

```bash
npm run test:api      # 即 node scripts/test-api.js（当前 297 项断言，含模型系列 / 设置迁移 / 重命名模型 / 图片提示词元数据 + 输入图文件名 picN / ZIP 打包解包 / 导出导入合并）
```

该脚本自包含：内置一张 16x16 PNG（校验尺寸嗅探 / b64 结果落盘）、临时目录自动清理。可直接参考或扩展。

mock 端点覆盖：
- `POST {base}/services/aigc/multimodal-generation/generation`（返回 choices；另有 `err-model` 报错、`hang-model` 永不响应）
- `POST {base}/api/v3/images/generations`（Seedream 官方：`data[].url` + `usage.generated_images`）
- `POST {base}/v1/images/generations`（New API：返回 `data[].b64_json`，验证 base64 结果落盘）
- `POST {base}/v1/api/generate`（Grsai：SSE 流 / 只返回任务 id）+ `POST {base}/v1/draw/result`（协议内部取结果）
- `POST {base}/responses`（重命名模型：`output[].content[].output_text` 给 `{"title":"…"}`，另有 401 / 只有思维链 item 两种异常）
- `GET /img.png`（供结果图下载）

其中 §3 断言「**同步请求不带 `X-DashScope-Async` 请求头**、适配器没有 `supportsAsync` / 任务端点、协议元信息里也没有」，
§4 断言**同一个 `conversationId` 下的多个请求互不干扰**（一个成功、一个业务错误、一个永不返回，事件各按 `messageId` 命中，
且能只中止其中一个），§5 断言单个同步请求的取消。

此外还直接单测 `modelSeries.load/save/applyPatch/resolveModel`（内置 json 落地、hidden 持久化、协议不可被本地 json 篡改、
**老数据的 `requestMode` 被丢弃且 `resolveModel` 不再返回 `mode`/`supportsAsync`**）、
`store.loadSettings` 的旧结构迁移，§17/§18 的 `renameModel.load/save/mergeConfig/renderTemplate/pickTitle/sanitizeTitle/generateTitle`
（含 `temperature/top_p` 透传、`$$` 模板渲染、Responses 响应解析、错误码与回退路径），
以及 §19/§20 的**图片提示词元数据**：PNG iTXt / JPEG XMP / WebP XMP 三格式的中文·换行·引号·反斜杠·emoji 往返、
**输入图文件名 `pic1`…`picN`**（按位置往返、读不到名字的位置是空串、重写记录时替换而非叠积分块、
别家工具写的元数据如 ComfyUI 的 `tEXt keyword=prompt` 不被误删）、
分辨率与 IDAT 不变、`CRC32` 正确、GIF 明确 `FORMAT_UNSUPPORTED`、截断文件返回 `CORRUPT`、4 万字不截断，
并在真实 runner 上验证「并发生成不串词 → 落盘即带元数据（含 picN）→ 保存 / 另存为补写缺失的 picN → 可被读回」；
§21 还直接断言 `conversationMeta.metaOfParent/metaFromConversations`（图生图 / 纯文生图 / 老会话缺 `srcName` / 会话数据缺失四种情况）
与「老图 + 会话兜底 → 导出文件里出现 picN」的完整链路；§22 断言复制到剪贴板的载荷（`clipboardPayload`：data-pics 的 JSON 与转义、
大小上限、以及「HTML 内嵌的字节本身带着提示词 + pic 项」，含复制老图时的内存补写）。

§23/§24 覆盖本次新增的「配置 + 聊天记录导出 / 导入」：

- `zip.js`：写 / 读往返（UTF-8 中文名、DEFLATE 文本 + STORE 大文件、空条目）、ZIP64 强制分支、
  条目名安全（反斜杠归一、拒绝 `..` 与盘符）、**改坏一个字节必须报 CRC_MISMATCH**、非 zip 报 BAD_ZIP；
- `dataTransfer.js`：包名协议（合法 / 大小写 / 五种非法名）、导出内容与 manifest 计数（未被引用的缓存图不进包）、
  两道校验各自的错误码（BAD_NAME / BAD_STRUCTURE / BAD_VERSION / BAD_ZIP）、
  合并全链路（选项类设置按导入改动、保存路径本机不存在则保留、模型查重与追加、系列自动新增与 hidden、
  密钥只补空缺、rename-model 覆盖、聊天记录追加在最上面 + id 映射 + 中断标记 + tabCounter 最大值、
  图片叠加与重复导入的幂等），以及 `mergeModelGroups` / `mergeSourceConfig` / `mergeConversations` 的纯函数断言。

### 9.2 冒烟测试（无 GUI 环境）

```bash
npm run build && timeout 15 npx electron . 2>&1
# 观察 dev-data/log/app-*.log 出现「渲染进程启动完成」即渲染进程正常
# 打包后：
timeout 15 release/linux-unpacked/stabstab 2>&1
```

判定：`exit:124`（被 timeout 正常终止）= 稳定运行；`FATAL` 出现 = 崩溃。
Windows 上可用后台作业启动、日志出现「渲染进程启动完成」后结束进程：

```powershell
npm run build
$job = Start-Job { Set-Location <项目路径>; & '.\node_modules\.bin\electron.cmd' '.' }
Start-Sleep 14; Stop-Job $job; Remove-Job $job -Force
Get-Process electron | Stop-Process -Force      # 子进程可能残留
Get-Content dev-data\log\app-<日期>.log -Tail 20 # 应能看到「渲染进程启动完成」
```

启动时可在 `dev-data/` 里确认：`model-series.json` / `rename-model.json` 是否已生成、`settings.json` 是否已迁移成 `modelGroups/sourceConfig`。

> 若本机已有实例在运行（`requestSingleInstanceLock`），第二个实例会直接退出并聚焦已有窗口。
> 要隔离验证启动路径：把 `electron/` + `dist/` + `package.json` 复制到临时目录，用
> `node_modules\electron\dist\electron.exe <临时目录> --user-data-dir=<临时目录>\userdata` 启动，
> 数据目录会落在 `<临时目录>\dev-data`，不会碰真实数据。

### 9.3 界面预览与渲染进程断言（无 GUI 环境，可选）

`dev-data/qa/`（gitignore，不进仓库）里有几个 esbuild + 无头 Chrome 的脚本，用**真实组件 / 真实代码 + 真实 app.css** 出图或断言：

```bash
node dev-data/qa/settings-preview.mjs   # 设置弹窗：空态 / 多系列 / 高级设置 / 重命名模型，亮暗两套
node dev-data/qa/composer-preview.mjs   # 输入区 + 各协议参数面板
node dev-data/qa/title-test.mjs         # 标签自动命名：触发时机 / 回退 / reducer 守卫（22 项断言）
node dev-data/qa/promptdrop-preview.mjs # 全窗口解析分区 / 插入·复制 / 图片提示词弹窗，亮暗两套（分 base/overlay/modal 三层出图）
node dev-data/qa/promptdrop-test.mjs    # 提示词复用纯逻辑断言（append / topUiPhase / reducer 清理规则 / 错误文案，32 项）
node dev-data/qa/dom-behavior-test.js   # 在真实应用窗口里跑 DOM 行为断言（48 项），electron 跑
node dev-data/qa/picname-flow-test.js   # 输入图文件名链路（拖入/粘贴 → generate.imageNames，10 项），electron 跑
node dev-data/qa/meta-decode-check.js   # 元数据写入后仍可被真实解码器解码（electron 跑，PNG/JPEG/WebP）
node dev-data/qa/conv-reorder-test/build.mjs   # 侧栏拖动排序：先构建 bundle
node_modules\.bin\electron dev-data\qa\conv-reorder-test\main.js  # …再用真实 DragEvent 序列跑断言 + 截图（含「拖起淡出 + 落点线」）
```

`picname-flow-test.js` 用真实 `dist/index.html` + 真实 `lib/send.js`，只把 `api:generate` 换成捕获桩：
模拟「拖入 `图片.png` + `参考图.jpg` → 输入「改为黑白」→ 发送」，断言前端发出的 `imageNames` 就是
`["图片.png","参考图.jpg"]`（顺序一致）；再模拟系统剪贴板粘贴（浏览器给的占位名 `image.png`），
断言 `imageNames` 是 `[""]`（pic 项位置保留、值为空串）。

`dom-behavior-test.js` 用 electron 加载真实的 `dist/index.html`，再注入 `promptdrop-dom-test-inject.js`：
它按真实 DOM 事件序列模拟「拖动图片 → 鼠标在顶栏/输入框之间移动 → 松手 → 改文字」，
断言解析分区随指针实时切换（含覆盖整个窗口 / 左右均分 / 曲线虚线 / 半透明蒙版）、「插入／复制」的出现/清理/异步竞态、插入的追加语义与光标位置。
两点坑：**无头窗口的 `requestAnimationFrame` 会被节流到 ~2 秒**（用它等 React 刷新会误判，脚本里改用固定短等待）；
`window.stab.*` 是 contextBridge 冻结对象，**改不了** —— 解析结果由测试 preload（`qa-test-preload.js`）+ 主进程
`qa:configure-prompt` / `qa:prompt-calls` 控制。

要点：用 esbuild 的 `onResolve` 把 `lib/store.jsx` 换成桩（返回构造好的 state，但 `reducer` / `initialState` 仍是真实实现），
用 `define` 注入 `model-series.json` / `rename-model.json` / `listProtocols()` 的真实内容，
再用 `--headless=new --screenshot=…` 出 PNG；`title-test.mjs` / `promptdrop-test.mjs` 则直接跑真实
`lib/title.js`、`lib/promptReuse.jsx`、`store.jsx` 的 reducer 与 `Composer.appendPromptText`（`window.stab` 用桩）。
注意：`promptdrop-preview.mjs` 里两个桩必须用**不同的 namespace**（esbuild 的 `onLoad` 结果按 `(namespace, path)` 缓存）。

---

## 10. 常见修改指南

| 想做什么 | 改哪里 |
|----------|--------|
| 接入新模型/协议 | `electron/src/api/` 新建适配器 + `registry.js` 注册 + **`electron/assets/model-series.json` 挂到某个系列的 sources** |
| 调整某个系列/来源 | `electron/assets/model-series.json`（label / 来源 / baseUrl / sizeOptions / hint）；用户级覆盖在 `settings.json` 与数据目录的 `model-series.json` |
| 加一个 API 参数到输入区 | 对应适配器的 `paramSchema` + `buildBody`；参数面板与 `buildParams` 都是 schema 驱动，无需改 UI |
| 改 size 列表 | `electron/assets/model-series.json` 的 `sources[].sizeOptions`（或适配器的 `sizeOptions` 兜底） |
| 改「模型设置」页结构 | `src/components/SettingsModal.jsx`（系列卡片 / 模型行 / 来源级 API Key 与地址） |
| 改标题生成提示模板 / 温度 / Top-P / 默认地址 | `electron/assets/rename-model.json`（随包默认）或数据目录的 `rename-model.json`（可手工编辑，重启生效；设置页滑动条也写它） |
| 改标签命名时机与回退 | `src/lib/title.js#maybeAutoTitle/fallbackTitle` + `src/lib/send.js`（触发点）+ `src/lib/store.jsx` 的 `CONV_RENAME_AUTO` 守卫 |
| 改「同对话多个请求并行等待」（伪异步） | `src/lib/store.jsx` 的 `busy`（`convId -> {[jobId]}`）+ `BUSY_SET/BUSY_CLEAR` + `waitingJobs` + `src/lib/send.js`（每次发送只登记自己的 jobId）+ `src/components/Composer.jsx`（`waiting` / `stopAllWaiting` / `canSend`）+ `src/components/AssistantMessage.jsx#stopWaiting`（见 §4.12） |
| 加/改用户气泡上的重发按钮 | `src/components/UserMessage.jsx#resendBubble` + `src/lib/send.js#sendBubbleAgain/sendBubbleToNewConversation` + `src/lib/store.jsx#makeConversation`/`CONV_ADD` + 图标 `assets/icons/{chat-plus,send}.svg`（见 §4.13） |
| 改侧栏圆点（黄/绿/红、点开消费） | `src/lib/store.jsx#conversationDot/isGenerating/dotActionForEvent`（判定口径）+ `src/components/Sidebar.jsx#ConvDot` + `src/styles/app.css` 的 `.conv-dot` 修饰类 + `src/App.jsx` 的事件路由（见 §4.8） |
| 改侧栏拖动排序（落点规则 / 视觉） | `src/lib/store.jsx#dropIndexFor/moveConversation` + `CONV_REORDER`（纯逻辑）+ `src/components/Sidebar.jsx` 的拖动状态机 + `src/styles/app.css` 的 `.dragging` / `.drop-before` / `.drop-after`（见 §4.11） |
| 改重命名模型的协议/解析 | `electron/src/renameModel.js#generateTitle/sanitizeTitle/extractText/pickTitle`（Responses API，非 chat/completions） |
| 改模型解析规则 | `electron/src/modelSeries.js#resolveModel` **与** `src/lib/models.js#resolveModel`（两处同口径） |
| 改会话/消息数据结构 | `lib/store.jsx` 的 reducer + `lib/send.js` 构造器 + 主进程 `normalizeConversationsOnStartup` |
| 改提示词元数据的存储约定 / 支持的格式 | `electron/src/promptmeta.js`（`PROMPT_KEY` / `PIC_KEY` / `buildRecord` / `parseRecord` / `pngInsert` / `jpegInsert` / `webpInsert` / `mergeMeta`）；**写入端与读取端同处一文件，改一处即可保持一致** |
| 改输入图文件名（picN）的收集方式 | 渲染进程 `src/components/Composer.jsx#addFiles(named)` + `src/lib/images.js#sourceFileName`（拖入/多选有名字，粘贴留空）→ `src/lib/send.js#imageNamesOf` → 主进程 `runner.js#requestMeta`；兜底查询在 `electron/src/conversationMeta.js` |
| 改结果图导出行为（保存路径 / 元数据透传 / 补写 picN） | `electron/src/exportImage.js`（`applyPromptToBuffer` → `promptmeta.mergeMeta`）+ `main.js` 的 `image:save` / `image:save-as` / `result:download`（同级目录兜底在 `conversationMeta.metaFromConversations`） |
| 改顶部解析区显隐规则 | `src/lib/promptReuse.jsx#topUiPhase/useAppFileDrag`（纯函数可直接被 QA 断言） |
| 改「插入／复制」的清理时机 | `src/lib/store.jsx` 的 `clearReuse` + `CONV_REUSE_SET/CLEAR` + `src/components/Composer.jsx#onTextInput/doSend` |
| 改「切换标签时草稿怎么留」 | `src/components/Composer.jsx` 的搬运 effect（`draftOwnerRef` / `draftRef`）+ `src/lib/store.jsx` 的 `CONV_DRAFT_PARK/DROP`（仓库只在内存，删除会话时随之删除，见 §4.6） |
| 改插入的拼接规则 | `src/components/Composer.jsx#appendPromptText`（append，不覆盖、不按光标插入） |
| 改聊天区滚动 / 「进入标签停在最后一条消息」 | `src/components/ChatView.jsx` 的 `useLayoutEffect [convId,msgCount,tailId]` + `ResizeObserver(.message-list)` + `onScroll`（见 §4.9；不要改成只在挂载时贴一次底） |
| 改解析失败文案 | `src/lib/promptReuse.jsx` 的 `PROMPT_MESSAGES` / `promptErrorText`（区分不支持 / 未找到 / 损坏 / 读取失败） |
| 改持久化字段默认值 | `electron/src/store.js` 的 `DEFAULT_SETTINGS` / `DEFAULT_CONVERSATIONS` |
| 改导出 / 导入的包名或包内协议 | `electron/src/dataTransfer.js` 顶部常量（`EXPORT_PREFIX` / `ROOT_DIR` / `FORMAT` / `FORMAT_VERSION` / `MEDIA_DIRS`）+ `zipNameFor` / `parseZipName` / `inspectDir`（见 §5.7） |
| 改导入的合并规则 | `electron/src/dataTransfer.js` 的 `mergeImport` / `mergeModelGroups` / `mergeConversations` / `mergeSourceConfig` / `mergeRenameConfig`（纯函数，改完在 `scripts/test-api.js` §24 补断言） |
| 改 ZIP 打包 / 解包实现 | `electron/src/zip.js`（唯一实现：`writeZip` / `listZip` / `extractAll`；保持零第三方依赖） |
| 改「数据管理」页界面 / 文案 | `src/components/SettingsModal.jsx` 的 `data` 页 + `doExport` / `doImport`；样式 `.import-result*` 在 `src/styles/app.css` |
| 改用户气泡底部的模型显示 | `src/components/UserMessage.jsx` 的 `.msg-meta`（`.msg-model` + `.msg-time`）+ `app.css` 的 `.msg-meta.has-model` / `.msg-model`（见 §4.14） |
| 改主题配色 | `src/styles/app.css` 顶部 CSS 变量 |
| 加 IPC | `preload.js` 暴露 + `main.js` `ipcMain.handle` + 渲染进程 `window.stab.*` |
| 改打包产物 | `electron-builder.yml` + `scripts/package.{sh,cmd}` |

---

## 11. 安全与凭据注意事项

- API Key 只存于本机 `settings.json`（图片模型在 `sourceConfig['<系列>.<来源>']`，重命名模型在 `renameModel.apiKey`），
  日志**不打印** Key，也不打印完整 base64（只记字节数）；重命名请求的日志只记模型 / 字数 / 耗时 / 生成的标题。
- `runner` 日志会记录模型名、协议、图片数量、size、耗时、错误码/信息，便于排查但脱敏。
- 提交代码时不要把 `dev-data/`、`stabstab-data/`、`release/`、`node_modules/` 纳入版本控制（已在 `.gitignore`）。
- **不要**把任何 Personal Access Token / API Key 提交进仓库或写入脚本。

