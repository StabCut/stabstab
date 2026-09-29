# StabStab — AI 继续开发与调试文档（AIDEV.md）

> 本文档面向 **AI 编程助手 / 后续开发者**，用于在既有代码基础上继续开发、调试、扩展与维护。
> 阅读本文档前请先了解：这是一个 **Electron + React + Vite** 的 AI 图像生成工作台（文生图 / 图生图），
> 交互参考 Cherry Studio，已接入 **模型系列（Model Series）** 架构：
> **Qwen 图像系列**（DashScope 多模态，同步 + 异步）、**Doubao Seedream 系列**（官方火山方舟 / New API）、
> **GPT Image 系列**（Grsai / NewApi）；每个系列可挂多个来源，来源与协议适配器一一绑定。

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
- **同步/异步只对声明 `requestMode.supported = true` 的系列生效**（当前仅 qwen）：开关值存在 `model-series.json` 的 `series[].requestMode.value`；其它系列一律同步（单次请求阻塞等待）。
- 发请求时**由主进程按 `modelId` 反查**协议 / 来源 / 密钥 / 地址 / 模式（`electron/src/modelSeries.js#resolveModel`），渲染进程只传 `modelId`——渲染进程不持有权威凭据副本。
- 渲染进程侧的同一套解析在 `src/lib/models.js`（供下拉框、尺寸列表、参数面板、提示文案使用）。**改规则时两处都要改**。

---

## 1. 项目摘要

**StabStab** 是一个桌面端 AI 图像生成与编辑工具，核心能力：

- **文生图**（text-to-image）：纯文字提示词生成图片。
- **图生图 / 图像编辑**（image-to-image）：1–3 张输入图片 + 编辑指令，或纯图片输入。
- 对话式界面（类 Cherry Studio）：左侧标签管理会话（空对话按序号 1234…，出现首条文字后自动命名），右侧聊天流，底部输入框。
- 每个会话**不携带上下文**（上下文长度恒为 0）：每次请求只包含当前这一条输入。
- **标签自动命名（重命名模型）**：首条文字 → DeepSeek Responses API（默认 `deepseek-flash` 非思考模式）
  精简成 5~6 字中文标题；未配置 Key 或调用失败时截取首条文字。模板/温度/Top-P 在 `rename-model.json`。
- **模型系列 → API 来源 → 协议适配器**：内置 3 个系列（Qwen / Doubao Seedream / GPT Image），
  模型 id 由用户填写；每个「系列·来源」独立保存 API Key 与 API 地址。
- 支持 **同步**（默认，当前会话阻塞等待）与 **异步 Task API**（后台轮询）两种请求模式；
  异步仅对支持该能力的系列生效（当前只有 qwen 系列）。
- 会话/设置/缓存/日志全部**本地持久化**在「可执行文件同级目录」的 `stabstab-data/`（不可写时回退系统用户目录）；
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
│       ├── paths.js                   # 数据根目录解析（可执行文件同级 + 回退）
│       ├── logger.js                  # 文件日志 <data>/log/app-YYYYMMDD.log
│       ├── store.js                   # settings.json / conversations.json 原子读写 + 旧结构迁移
│       ├── modelSeries.js             # ★ 模型系列配置读写与解析（resolveModel = 发请求的权威口径）
│       ├── renameModel.js             # ★ 重命名模型：rename-model.json 读写 + DeepSeek Responses API 调用
│       ├── imageutil.js               # PNG/JPEG/GIF/WEBP 尺寸嗅探、缓存下载（含 data:base64 结果）
│       └── api/
│           ├── registry.js            # 适配器注册表 + 预留协议列表 + listProtocols()
│           ├── util.js                # 适配器公共工具（端点拼接 / 结果图片收集 / 错误归一化）
│           ├── dashscope.js           # Qwen 系列·官方（DashScope 多模态，同步 + 异步 + 取消）
│           ├── seedream.js            # Doubao Seedream 系列·官方（火山方舟 images/generations）
│           ├── newapi-images.js       # Seedream / GPT Image 系列·New API（OpenAI 兼容图像生成）
│           ├── grsai.js               # GPT Image 系列·Grsai（SSE 同步 / 只给任务 id 时自动退化轮询）
│           └── runner.js              # 请求执行器：提交/轮询/下载/事件/取消/恢复（协议无关）
├── src/                               # 渲染进程（React，经 Vite 构建）
│   ├── main.jsx                       # 入口 + 全局错误捕获上报
│   ├── App.jsx                        # 根组件：bootstrap、API 事件路由、主题
│   ├── components/
│   │   ├── Sidebar.jsx                # 左侧：Logo、新建、会话列表、重命名/删除、底部操作
│   │   ├── ChatView.jsx               # 主区：头部、消息列表、空态、输入框
│   │   ├── UserMessage.jsx            # 用户气泡：文本/图片、编辑重发、复制、删除
│   │   ├── AssistantMessage.jsx       # 助手气泡：结果图/错误/异步状态卡片/取消
│   │   ├── Composer.jsx               # 输入框：粘贴/拖入/多选、size/高级参数、发送/停止
│   │   ├── SettingsModal.jsx          # 设置：模型 / 重命名模型 / 基础 / 高级 四页
│   │   ├── Lightbox.jsx               # 全屏图片预览：滚轮缩放/拖动/ESC
│   │   └── Toasts.jsx                 # 轻提示
│   └── lib/
│       ├── store.jsx                  # React Context + reducer 全局状态 + 防抖落盘
│       ├── models.js                  # ★ 模型系列/模型解析（界面侧，与主进程同口径）
│       ├── title.js                   # ★ 会话标签自动命名（首条文字 → 重命名模型 → 回退截取）
│       ├── send.js                    # 发送/重发公共逻辑（无上下文、消息配对、压缩、参数过滤）
│       ├── images.js                  # File→dataUrl、尺寸读取、按设置压缩
│       └── util.js                    # uid/时间/字节/尺寸解析/appfile URL 构造
├── build/                             # 打包资源：icon.svg / icon.png / icon.ico
├── public/icon.svg                    # 渲染进程内引用的 Logo（Vite 原样拷贝到 dist）
├── scripts/
│   ├── test-api.js                    # 后端端到端测试（mock HTTP 服务 + 真实 runner/适配器）
│   ├── gen-logo.js                    # 生成彭罗斯三角 Logo（需 ImageMagick）
│   ├── package.sh                     # Ubuntu 一键打包（deb + 便携 tar.gz）
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
```

开发模式数据目录：项目内 `dev-data/`（已 gitignore）。
打包后数据目录：可执行文件同级 `stabstab-data/`。

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
| `bootstrap()` | `app:bootstrap` | invoke | 一次返回 settings/modelSeries/renameConfig/conversations/paths/platform/resumeCount |
| `saveState({settings,conversations,modelSeries,renameConfig})` | `state:save` | invoke | 防抖整包落盘（四份数据一起写） |
| `listProtocols()` | `protocols:list` | invoke | 协议元信息：sizeOptions / paramSchema / supportsAsync… |
| `generate(opts)` | `api:generate` | invoke | 发起生成（立即返回 jobId） |
| `cancelJob(jobId)` | `api:cancel` | invoke | 取消/停止等待 |
| `resumeJobs()` | `api:resume` | invoke | 重启后恢复异步轮询 |
| `onApiEvent(cb)` | `api:event` | on | 结果/状态事件流 |
| `generateTitle(text)` | `title:generate` | invoke | 会话标签自动命名：把首条文字交给重命名模型，回 `{ok,name}` / `{ok:false,code,message}` |
| `saveAttachment({name,mime,dataUrl})` | `attachments:save` | invoke | 保存用户输入图 → 返回 file 名 |
| `readAttachment(file)` | `attachments:read` | invoke | 读回 dataUrl（编辑重发用） |
| `downloadResult(file)` | `result:download` | invoke | 结果图 → 默认保存路径 |
| `copyImage(file)` | `result:copy-image` | invoke | 结果图 → 剪贴板 |
| `copyUploadImage(file)` | `attachments:copy-image` | invoke | 输入图 → 剪贴板 |
| `pickImages()` | `dialog:pick-images` | invoke | 多选图片 → [{name,mime,size,dataUrl}] |
| `pickFolder(defaultPath)` | `dialog:pick-folder` | invoke | 目录选择器 |
| `openCacheDir()` | `cache:open` | invoke | 文件管理器打开缓存目录 |
| `openPath(p)` / `showInFolder(p)` | `shell:*` | invoke | 打开路径/定位文件 |
| `openExternal(url)` | `shell:open-external` | invoke | 打开外部链接（仅 http/https，如 API Key 申请页） |
| `log(level,message,extra)` | `log:write` | send | 渲染进程日志 → 主进程日志文件 |

### 4.3 生成请求数据流

```
[渲染进程] Composer/UserMessage 收集 text + images(dataUrl) + params + modelId
   └─ lib/send.js: sendNew() / resendEdited()
        ├─ lib/models.js resolveModel(modelId) → 界面用信息（尺寸列表 / 参数 schema / 模式提示 / 是否有 Key）
        ├─ 压缩每张图（compressIfNeeded，按 settings.compress*）
        ├─ dispatch MSG_ADD [userMsg, assistant占位(pending, meta.modelId)]
        ├─ 同步模式 → BUSY_SET(convId, jobId=assistantMsg.id)
        └─ window.stab.generate({conversationId, messageId, modelId, prompt, images, params})
             │
[主进程] main.js api:generate：modelSeries.resolveModel(settings, modelSeries, modelId)
   ├─ 解析出 protocol / sourceId / apiKey / baseUrl / mode（同步异步）
   ├─ 缺模型 → NO_MODEL；缺协议 → NO_PROTOCOL；缺 Key → NO_API_KEY（都在事件里点明「系列 → 来源」）
   └─ runner.start(opts, sendEvent)
        ├─ adapter.buildSubmitRequest(ctx) → fetch（AbortController + 超时）
        ├─ 同步：parseSubmit → deliverResult（下载/解码每张图到 cache/）→ emit result
        └─ 异步：parseSubmit 得 taskId → emit status → pollTask(指数退避) → deliverResult
             │
[渲染进程] App.jsx onApiEvent 路由：
   ├─ status → MSG_UPDATE {status:'running', taskStatus, taskId}
   ├─ result → MSG_UPDATE {status:'success', images, usage...} + BUSY_CLEAR + 非当前会话则 CONV_MARK_UNREAD(黄点)
   ├─ error  → MSG_UPDATE {status:'error', error} + BUSY_CLEAR
   └─ cancelled → MSG_UPDATE {status:'cancelled'} + BUSY_CLEAR
```

**事件载荷统一结构**：`{conversationId, messageId, type, ok, images?, error?, taskId?, status?, usage?, durationMs?, ...}`。

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
并保存用户的 `hidden`（移除系列）与 `requestMode.value`（同步/异步）开关；本地副本里的非内置系列原样保留。

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
      "requestMode": {                       // ★ 「高级设置」的同步/异步开关（只对 supported=true 的系列显示）
        "supported": true, "default": "sync", "value": "sync"
      },
      "sources": [
        {
          "id": "official",
          "label": "官方（DashScope / 阿里云百炼）",
          "protocol": "dashscope-multimodal", // 绑定 registry 里的适配器 id
          "baseUrl": "https://dashscope.aliyuncs.com/api/v1",  // 默认地址：设置页自动填充 / 恢复默认
          "supportsAsync": true,
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
  "conversations": [
    {
      "id": "c_xxx", "name": "1", "nameAuto": true,
      // name  = 空对话是序号（"1"）；出现首条文字后自动命名（见 §4.4）
      // nameAuto = true 表示名字还可被自动命名替换；用户手动改名后为 false（自动命名不再覆盖）
      "createdAt": 0, "updatedAt": 0, "unread": false,
      "messages": [
        { // 用户消息
          "id": "m_u", "role": "user",
          "text": "提示词",
          "images": [ { "file": "up_xxx.png", "name": "a.png", "mime": "image/png", "width": 1024, "height": 1536 } ],
          "params": { "size": "2048*2048", "n": 1, "negative_prompt": "", "watermark": false, "prompt_extend": true, "seed": "" },
          "model": { "id": "m_xxx", "name": "qwen-image-3.0-pro", "seriesId": "qwen", "sourceId": "official", "protocol": "dashscope-multimodal" },
          "createdAt": 0
        },
        { // 助手消息（parentId 指向配对用户消息）
          "id": "m_a", "role": "assistant", "parentId": "m_u",
          "status": "success",          // pending|running|success|error|cancelled
          "taskStatus": null,           // 异步: PENDING|RUNNING|...
          "images": [ { "file": "result_xxx.png", "width": 2048, "height": 2048, "url": "https://...", "bytes": 123 } ],
          "texts": [], "error": null, "usage": { "output_width": 2048, "output_height": 2048, "output_image_count": 1 },
          "requestId": null, "taskId": null, "finishedAt": 0, "durationMs": 1234,
          "meta": { "protocol": "dashscope-multimodal", "model": "qwen-image-3.0-pro",
                    "modelId": "m_xxx", "seriesId": "qwen", "sourceId": "official", "mode": "sync" },
          "createdAt": 0
        }
      ]
    }
  ]
}
```

> 助手消息的 `meta.modelId` 是「重启后恢复异步轮询」与「编辑重发」的定位依据：主进程用它反查系列/来源/密钥（密钥不进会话文件）。

### 5.5 图片存储位置

- 用户输入图 → `<data>/uploads/<file>`，渲染进程经 `appfile://uploads/<file>` 显示。
- 结果图 → `<data>/cache/<file>`，经 `appfile://cache/<file>` 显示。
- 下载结果 → `<defaultSavePath>/`（默认 `<data>/downloads`）。
- 删除 cache/ 目录**不影响程序运行**；历史消息中的结果图会显示「图片已清理」占位。

---

## 6. 关键不变量（改代码时严禁破坏）

1. **无上下文**：每次请求 `input.messages` 只含当前一条用户输入，绝不拼接历史消息。
2. **jobId === assistant 消息 id**：`runner` 的 `activeJobs` 以 `messageId` 为键；取消、停止等待都依赖此约定。
3. **user↔assistant 配对**：assistant 消息的 `parentId` 指向其用户消息；「编辑重发」通过 `MSG_EDIT_PREPARE` 删除 `parentId===userMsgId` 的旧回复。
4. **图片 base64 格式**：`data:<mime>;base64,<data>`（各协议统一用这个格式接收输入图）。
5. **size 参数**：`'auto'` 表示**不发送** size 字段（交给模型推荐）；qwen 用 `宽*高`（如 `2688*1536`），Seedream 官方支持 `1K/2K/4K` 或 `2048x2048`，Grsai 支持比例（如 `16:9`）。候选列表来自来源配置（`model-series.json` 的 `sources[].sizeOptions`）。
6. **协议适配器接口**：新增协议必须实现 registry 中约定的方法（见 §7），否则 `runner.start` 直接报 `NO_ADAPTER`。
7. **appfile 协议**：URL 结构 `appfile://<cache|uploads>/<文件名>`；主进程 handler 用 `path.basename` 防目录穿越。
8. **Vite `base:'./'`**：打包后经 `file://` 加载，资源必须相对路径，否则白屏。
9. **数据目录解析**：`app.isPackaged` 决定「可执行文件同级」还是「项目内 dev-data」；`paths.js` 是唯一入口。
10. **防抖落盘**：渲染进程是数据编辑主体，`store.jsx` 中 `state.settings/modelSeries/renameConfig/conversations` 变化后 400ms 防抖 `state:save`；`beforeunload` 立即 flush。
11. **模型必须经由系列解析**：发请求时 `protocol/baseUrl/apiKey/mode` **只能**由 `modelSeries.resolveModel()` 得出（渲染进程的解析只服务界面）；`modelId` 是唯一的跨进程定位键。
12. **同步/异步按系列**：只有 `series.requestMode.supported === true`（当前仅 qwen）才允许 `mode='async'`；其它系列即使本地 json 被改成 `async` 也会被强制回 `sync`。
13. **钥匙不进会话**：`conversations.json` 只记 `meta.modelId/seriesId/sourceId`，绝不写入 API Key。
14. **标签命名只认首条文字**：自动命名只在「会话里还没有带文字的用户消息」时触发一次；`nameAuto === false`（用户手动改过名）时永不覆盖，见 §4.4。
15. **重命名模型走 Responses API**：`POST {baseUrl}/responses`（`input` + `instructions` + `reasoning.effort='none'` + `text.format=json_object`），**不是** chat/completions；默认地址 / 默认模型 / 提示模板 / 温度 / Top-P 一律来自 `rename-model.json`（主进程解析，渲染进程只传首条文字）。

---

## 7. 协议适配器接口（如何接入另一套 API 规则）

适配器是一个 CommonJS 模块，导出以下字段/函数（参考 `electron/src/api/dashscope.js`）：

```js
module.exports = {
  id: 'xxx',                     // 唯一协议 id，registry 键名
  label: '展示名',
  defaultBaseUrl: 'https://...',
  defaultModel: '模型默认名',
  supportsAsync: true|false,     // 是否支持异步 Task API（还要系列声明 requestMode.supported 才会启用）
  supportsImageInput: true,      // 是否支持输入图（图生图）；false 时界面可据此提示
  modelPlaceholder: '例如：xxx',  // 模型 id 输入框的灰色提示
  sizeOptions: ['auto', '2688*1536', ...],   // 前端 size 下拉的兜底候选（来源 json 里的 sizeOptions 优先）
  paramSchema: { n: {...}, negative_prompt: {...}, ... }, // 前端参数面板元信息（决定发什么参数）
  buildSubmitRequest(ctx) -> {url, method, headers, body},
  parseSubmit(json, httpStatus, mode) -> {kind:'result',images,texts,usage,requestId} | {kind:'task',taskId,taskStatus} | {kind:'error',error:{code,message,requestId}},
  buildTaskQuery(ctx) -> {url, method, headers},            // 仅异步协议需要
  parseTask(json, httpStatus) -> {status:'SUCCEEDED'|'FAILED'|'RUNNING'|'PENDING'|'UNKNOWN'|'CANCELED', images?, texts?, usage?, error?},
  buildTaskCancel(ctx) -> {url, method, headers} | null      // 仅异步协议需要；返回 null = 无服务端取消接口
};
```

`ctx` 结构：`{apiKey, baseUrl, model, prompt, images:[dataUrl], params, mode, taskId?}`。

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

`runner.js` 的 `start/resume/cancel/pollTask/deliverResult` 是**协议无关**的，新增协议无需改动执行器。

### 7.1 四个内置协议要点（对接新来源时照抄这份对照表）

| 系列 · 来源 | 适配器 id | 端点 | 模式 | 请求要点 | 结果解析 |
|-------------|-----------|------|------|----------|----------|
| Qwen · 官方 | `dashscope-multimodal` | `POST {base}/services/aigc/multimodal-generation/generation` | 同步 + 异步（`X-DashScope-Async: enable`） | `input.messages[].content=[{image},{text}]`，参数 n/negative_prompt/watermark/prompt_extend/seed/size | `output.choices[].message.content[].image`（旧版 `output.results[].url`） |
| Doubao Seedream · 官方（火山方舟 Ark） | `seedream-official` | `POST {base}/images/generations`（base 默认 `https://ark.cn-beijing.volces.com/api/v3`） | 仅同步 | `{model,prompt,size,image,response_format:'url',watermark?,output_format?}`；`image` 单图=字符串、多图=数组；Ark 文档要求**不要传不支持的字段**，因此可选参数只在用户显式选择后才发送 | `data[].url`（或 `b64_json`），`usage.generated_images` 归一化为 `output_image_count` |
| Seedream / GPT Image · New API | `newapi-images` | `POST {base}/images/generations`（base 形如 `https://host/v1`） | 仅同步 | `{model,prompt,size,n,quality?,style?,response_format:'url',image?}`；令牌页面生成 Bearer | `data[].url \| data[].b64_json`（两者都会落盘） |
| GPT Image · Grsai | `grsai-image` | `POST {base}`（完整地址 `…/v1/api/generate`） | 仅同步（若服务端只回任务 id，自动退化为 `POST {host}/v1/draw/result {id}` 轮询） | `{model,prompt,images?,aspectRatio?}`；`aspectRatio` 支持 `16:9` 这类比例或 `1024x1024` 像素值；`images` 为 dataUrl / URL 数组 | SSE `data:` 行里的 `results[].url`，或 JSON `{code:0,data:{results:[{url}]}}` |

> 文档来源：工作区 `seedream系列api.md`、`gpt-image系列.md`、`api-url.txt` 与千问平台静态 HTML。
> 注意 `seedream系列api.md` 里的「官方版本 api 示例」给的是 `/api/v3/responses`（文本对话示例），**生图实际用 `/api/v3/images/generations`**。
> Grsai 文档未写明响应结构，故 `grsai.js` 同时兼容 SSE / JSON / 任务 id 三种形态。

---

## 8. 打包流程与已知坑

### 8.1 打包

- electron-builder 配置见 `electron-builder.yml`；`files` 只含 `dist/**`、`electron/**`、`package.json`（生产依赖为空，React 被 Vite 打进 bundle）。
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

无需 GUI，用本地 HTTP 服务模拟各家接口即可验证 runner 的同步/异步/错误/取消全链路 + 各协议解析：

```bash
npm run test:api      # 即 node scripts/test-api.js（当前 106 项断言，含模型系列 / 设置迁移 / 重命名模型）
```

该脚本自包含：内置一张 16x16 PNG（校验尺寸嗅探 / b64 结果落盘）、临时目录自动清理。可直接参考或扩展。

mock 端点覆盖：
- `POST {base}/services/aigc/multimodal-generation/generation`（sync 返回 choices，async 返回 task_id）
- `GET {base}/tasks/{id}`（PENDING→SUCCEEDED/FAILED）、`POST {base}/tasks/{id}/cancel`
- `POST {base}/api/v3/images/generations`（Seedream 官方：`data[].url` + `usage.generated_images`）
- `POST {base}/v1/images/generations`（New API：返回 `data[].b64_json`，验证 base64 结果落盘）
- `POST {base}/v1/api/generate`（Grsai：SSE 流 / 只返回任务 id）+ `POST {base}/v1/draw/result`（轮询兜底）
- `POST {base}/responses`（重命名模型：`output[].content[].output_text` 给 `{"title":"…"}`，另有 401 / 只有思维链 item 两种异常）
- `GET /img.png`（供结果图下载）

此外还直接单测 `modelSeries.load/save/resolveModel`（内置 json 落地、hidden 与同步异步开关持久化、协议不可被本地 json 篡改）、
`store.loadSettings` 的旧结构迁移，以及 §17/§18 的 `renameModel.load/save/mergeConfig/renderTemplate/pickTitle/sanitizeTitle/generateTitle`
（含 `temperature/top_p` 透传、`$$` 模板渲染、Responses 响应解析、错误码与回退路径）。

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
```

要点：用 esbuild 的 `onResolve` 把 `lib/store.jsx` 换成桩（返回构造好的 state），
用 `define` 注入 `model-series.json` / `rename-model.json` / `listProtocols()` 的真实内容，
再用 `--headless=new --screenshot=…` 出 PNG；`title-test.mjs` 则直接跑真实 `lib/title.js` 与 `store.jsx` 的 reducer（`window.stab` 用桩）。

---

## 10. 常见修改指南

| 想做什么 | 改哪里 |
|----------|--------|
| 接入新模型/协议 | `electron/src/api/` 新建适配器 + `registry.js` 注册 + **`electron/assets/model-series.json` 挂到某个系列的 sources** |
| 调整某个系列/来源 | `electron/assets/model-series.json`（label / 来源 / baseUrl / sizeOptions / hint / 是否支持异步）；用户级开关与覆盖在 `settings.json` 与数据目录的 `model-series.json` |
| 加一个 API 参数到输入区 | 对应适配器的 `paramSchema` + `buildBody`；参数面板与 `buildParams` 都是 schema 驱动，无需改 UI |
| 改 size 列表 | `electron/assets/model-series.json` 的 `sources[].sizeOptions`（或适配器的 `sizeOptions` 兜底） |
| 改「模型设置」页结构 | `src/components/SettingsModal.jsx`（系列卡片 / 模型行 / 来源级 API Key 与地址） |
| 改标题生成提示模板 / 温度 / Top-P / 默认地址 | `electron/assets/rename-model.json`（随包默认）或数据目录的 `rename-model.json`（可手工编辑，重启生效；设置页滑动条也写它） |
| 改标签命名时机与回退 | `src/lib/title.js#maybeAutoTitle/fallbackTitle` + `src/lib/send.js`（触发点）+ `src/lib/store.jsx` 的 `CONV_RENAME_AUTO` 守卫 |
| 改重命名模型的协议/解析 | `electron/src/renameModel.js#generateTitle/sanitizeTitle/extractText/pickTitle`（Responses API，非 chat/completions） |
| 改模型解析规则 | `electron/src/modelSeries.js#resolveModel` **与** `src/lib/models.js#resolveModel`（两处同口径） |
| 改会话/消息数据结构 | `lib/store.jsx` 的 reducer + `lib/send.js` 构造器 + 主进程 `normalizeConversationsOnStartup` |
| 改持久化字段默认值 | `electron/src/store.js` 的 `DEFAULT_SETTINGS` / `DEFAULT_CONVERSATIONS` |
| 改主题配色 | `src/styles/app.css` 顶部 CSS 变量 |
| 加 IPC | `preload.js` 暴露 + `main.js` `ipcMain.handle` + 渲染进程 `window.stab.*` |
| 改打包产物 | `electron-builder.yml` + `scripts/package.{sh,cmd}` |

---

## 11. 安全与凭据注意事项

- API Key 只存于本机 `settings.json`（图片模型在 `sourceConfig['<系列>.<来源>']`，重命名模型在 `renameModel.apiKey`），
  日志**不打印** Key，也不打印完整 base64（只记字节数）；重命名请求的日志只记模型 / 字数 / 耗时 / 生成的标题。
- `runner` 日志会记录模型名、协议、模式、图片数量、size、耗时、错误码/信息，便于排查但脱敏。
- 提交代码时不要把 `dev-data/`、`stabstab-data/`、`release/`、`node_modules/` 纳入版本控制（已在 `.gitignore`）。
- **不要**把任何 Personal Access Token / API Key 提交进仓库或写入脚本。
