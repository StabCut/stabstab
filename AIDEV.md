# StabStab — AI 继续开发与调试文档（AIDEV.md）

> 本文档面向 **AI 编程助手 / 后续开发者**，用于在既有代码基础上继续开发、调试、扩展与维护。
> 阅读本文档前请先了解：这是一个 **Electron + React + Vite** 的 AI 图像生成工作台（文生图 / 图生图），
> 交互参考 Cherry Studio，首版接入 **Qwen-Image-3.0-Pro**（DashScope 多模态协议，同步 + 异步）。

---

## 1. 项目摘要

**StabStab** 是一个桌面端 AI 图像生成与编辑工具，核心能力：

- **文生图**（text-to-image）：纯文字提示词生成图片。
- **图生图 / 图像编辑**（image-to-image）：1–3 张输入图片 + 编辑指令，或纯图片输入。
- 对话式界面（类 Cherry Studio）：左侧数字标签管理会话，右侧聊天流，底部输入框。
- 每个会话**不携带上下文**（上下文长度恒为 0）：每次请求只包含当前这一条输入。
- 支持 **同步**（默认，当前会话阻塞等待）与 **异步 Task API**（后台轮询）两种请求模式。
- 会话/设置/缓存/日志全部**本地持久化**在「可执行文件同级目录」的 `stabstab-data/`（不可写时回退系统用户目录）。
- 通过 **协议适配器** 架构预留了其它模型 / 另一套 API 请求解析规则的扩展位。

**技术栈**：Electron 43（Node 22 内核）、React 19、Vite 8、electron-builder 26。
主进程为 **纯 CommonJS（无构建）**，渲染进程由 Vite 打包为静态资源。

---

## 2. 目录结构与文件职责

```
stabstab/
├── electron/                          # 主进程（Node 侧，CommonJS，不经过 Vite）
│   ├── main.js                        # 入口：窗口、IPC、协议注册、生命周期、启动规范化
│   ├── preload.js                     # contextBridge 桥接（window.stab）
│   ├── assets/icon.png                # 运行时窗口图标（打包进 asar）
│   └── src/
│       ├── paths.js                   # 数据根目录解析（可执行文件同级 + 回退）
│       ├── logger.js                  # 文件日志 <data>/log/app-YYYYMMDD.log
│       ├── store.js                   # settings.json / conversations.json 原子读写
│       ├── imageutil.js               # PNG/JPEG/GIF/WEBP 尺寸嗅探、缓存下载、唯一文件名
│       └── api/
│           ├── dashscope.js           # DashScope 协议适配器（同步 + 异步 + 取消）
│           ├── registry.js            # 适配器注册表 + 预留协议列表
│           └── runner.js              # 请求执行器：提交/轮询/下载/事件/取消/恢复
├── src/                               # 渲染进程（React，经 Vite 构建）
│   ├── main.jsx                       # 入口 + 全局错误捕获上报
│   ├── App.jsx                        # 根组件：bootstrap、API 事件路由、主题
│   ├── components/
│   │   ├── Sidebar.jsx                # 左侧：Logo、新建、会话列表、重命名/删除、底部操作
│   │   ├── ChatView.jsx               # 主区：头部、消息列表、空态、输入框
│   │   ├── UserMessage.jsx            # 用户气泡：文本/图片、编辑重发、复制、删除
│   │   ├── AssistantMessage.jsx       # 助手气泡：结果图/错误/异步状态卡片/取消
│   │   ├── Composer.jsx               # 输入框：粘贴/拖入/多选、size/高级参数、发送/停止
│   │   ├── SettingsModal.jsx          # 设置：模型/基础/高级三页
│   │   ├── Lightbox.jsx               # 全屏图片预览：滚轮缩放/拖动/ESC
│   │   └── Toasts.jsx                 # 轻提示
│   └── lib/
│       ├── store.jsx                  # React Context + reducer 全局状态 + 防抖落盘
│       ├── send.js                    # 发送/重发公共逻辑（无上下文、消息配对、压缩）
│       ├── images.js                  # File→dataUrl、尺寸读取、按设置压缩
│       └── util.js                    # uid/时间/字节/尺寸解析/appfile URL 构造
├── build/                             # 打包资源：icon.svg / icon.png / icon.ico
├── public/icon.svg                    # 渲染进程内引用的 Logo（Vite 原样拷贝到 dist）
├── scripts/
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
| `bootstrap()` | `app:bootstrap` | invoke | 一次返回 settings/conversations/paths/platform/resumeCount |
| `saveState({settings,conversations})` | `state:save` | invoke | 防抖整包落盘 |
| `listProtocols()` | `protocols:list` | invoke | 协议下拉选项 |
| `generate(opts)` | `api:generate` | invoke | 发起生成（立即返回 jobId） |
| `cancelJob(jobId)` | `api:cancel` | invoke | 取消/停止等待 |
| `resumeJobs()` | `api:resume` | invoke | 重启后恢复异步轮询 |
| `onApiEvent(cb)` | `api:event` | on | 结果/状态事件流 |
| `saveAttachment({name,mime,dataUrl})` | `attachments:save` | invoke | 保存用户输入图 → 返回 file 名 |
| `readAttachment(file)` | `attachments:read` | invoke | 读回 dataUrl（编辑重发用） |
| `downloadResult(file)` | `result:download` | invoke | 结果图 → 默认保存路径 |
| `copyImage(file)` | `result:copy-image` | invoke | 结果图 → 剪贴板 |
| `copyUploadImage(file)` | `attachments:copy-image` | invoke | 输入图 → 剪贴板 |
| `pickImages()` | `dialog:pick-images` | invoke | 多选图片 → [{name,mime,size,dataUrl}] |
| `pickFolder(defaultPath)` | `dialog:pick-folder` | invoke | 目录选择器 |
| `openCacheDir()` | `cache:open` | invoke | 文件管理器打开缓存目录 |
| `openPath(p)` / `showInFolder(p)` | `shell:*` | invoke | 打开路径/定位文件 |
| `log(level,message,extra)` | `log:write` | send | 渲染进程日志 → 主进程日志文件 |

### 4.3 生成请求数据流

```
[渲染进程] Composer/UserMessage 收集 text + images(dataUrl) + params + model
   └─ lib/send.js: sendNew() / resendEdited()
        ├─ 压缩每张图（compressIfNeeded，按 settings.compress*）
        ├─ dispatch MSG_ADD [userMsg, assistant占位(pending)]
        ├─ 同步模式 → BUSY_SET(convId, jobId=assistantMsg.id)
        └─ window.stab.generate({conversationId, messageId=assistantMsg.id, ...})
             │
[主进程] runner.start(opts, sendEvent)
   ├─ 校验协议/adapter/apiKey
   ├─ adapter.buildSubmitRequest(ctx) → fetch（AbortController + 超时）
   ├─ 同步：parseSubmit → deliverResult(下载每张图到 cache/) → emit result
   └─ 异步：parseSubmit 得 taskId → emit status → pollTask(指数退避) → deliverResult
             │
[渲染进程] App.jsx onApiEvent 路由：
   ├─ status → MSG_UPDATE {status:'running', taskStatus, taskId}
   ├─ result → MSG_UPDATE {status:'success', images, usage...} + BUSY_CLEAR + 非当前会话则 CONV_MARK_UNREAD(黄点)
   ├─ error  → MSG_UPDATE {status:'error', error} + BUSY_CLEAR
   └─ cancelled → MSG_UPDATE {status:'cancelled'} + BUSY_CLEAR
```

**事件载荷统一结构**：`{conversationId, messageId, type, ok, images?, error?, taskId?, status?, usage?, durationMs?, ...}`。

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
  "requestMode": "sync",        // sync | async（高级设置切换）
  "api": { "apiKey": "", "baseUrl": "https://dashscope.aliyuncs.com/api/v1" },
  "models": [ { "id": "m_builtin_qwen", "name": "qwen-image-3.0-pro", "protocol": "dashscope-multimodal", "builtin": true } ],
  "defaultModelId": "m_builtin_qwen"
}
```

### 5.2 `conversations.json`

```jsonc
{
  "version": 1,
  "tabCounter": 0,       // 数字标签命名，只增不减
  "activeId": null,      // 当前激活会话
  "conversations": [
    {
      "id": "c_xxx", "name": "1", "createdAt": 0, "updatedAt": 0, "unread": false,
      "messages": [
        { // 用户消息
          "id": "m_u", "role": "user",
          "text": "提示词",
          "images": [ { "file": "up_xxx.png", "name": "a.png", "mime": "image/png", "width": 1024, "height": 1536 } ],
          "params": { "size": "2048*2048", "n": 1, "negative_prompt": "", "watermark": false, "prompt_extend": true, "seed": "" },
          "model": { "id": "m_builtin_qwen", "name": "qwen-image-3.0-pro", "protocol": "dashscope-multimodal" },
          "createdAt": 0
        },
        { // 助手消息（parentId 指向配对用户消息）
          "id": "m_a", "role": "assistant", "parentId": "m_u",
          "status": "success",          // pending|running|success|error|cancelled
          "taskStatus": null,           // 异步: PENDING|RUNNING|...
          "images": [ { "file": "result_xxx.png", "width": 2048, "height": 2048, "url": "https://...", "bytes": 123 } ],
          "texts": [], "error": null, "usage": { "output_width": 2048, "output_height": 2048, "output_image_count": 1 },
          "requestId": null, "taskId": null, "finishedAt": 0, "durationMs": 1234,
          "meta": { "protocol": "dashscope-multimodal", "model": "qwen-image-3.0-pro", "mode": "sync" },
          "createdAt": 0
        }
      ]
    }
  ]
}
```

### 5.3 图片存储位置

- 用户输入图 → `<data>/uploads/<file>`，渲染进程经 `appfile://uploads/<file>` 显示。
- 结果图 → `<data>/cache/<file>`，经 `appfile://cache/<file>` 显示。
- 下载结果 → `<defaultSavePath>/`（默认 `<data>/downloads`）。
- 删除 cache/ 目录**不影响程序运行**；历史消息中的结果图会显示「图片已清理」占位。

---

## 6. 关键不变量（改代码时严禁破坏）

1. **无上下文**：每次请求 `input.messages` 只含当前一条用户输入，绝不拼接历史消息。
2. **jobId === assistant 消息 id**：`runner` 的 `activeJobs` 以 `messageId` 为键；取消、停止等待都依赖此约定。
3. **user↔assistant 配对**：assistant 消息的 `parentId` 指向其用户消息；「编辑重发」通过 `MSG_EDIT_PREPARE` 删除 `parentId===userMsgId` 的旧回复。
4. **图片 base64 格式**：`data:<mime>;base64,<data>`（DashScope 要求的格式）。
5. **size 参数**：`'auto'` 表示**不发送** size 字段（交给模型推荐）；5 个固定尺寸格式为 `宽*高`（如 `2688*1536`）。
6. **协议适配器接口**：新增协议必须实现 registry 中约定的方法（见 §7），否则 `runner.start` 直接报 `NO_ADAPTER`。
7. **appfile 协议**：URL 结构 `appfile://<cache|uploads>/<文件名>`；主进程 handler 用 `path.basename` 防目录穿越。
8. **Vite `base:'./'`**：打包后经 `file://` 加载，资源必须相对路径，否则白屏。
9. **数据目录解析**：`app.isPackaged` 决定「可执行文件同级」还是「项目内 dev-data」；`paths.js` 是唯一入口。
10. **防抖落盘**：渲染进程是数据编辑主体，`store.jsx` 中 `state.settings/conversations` 变化后 400ms 防抖 `state:save`；`beforeunload` 立即 flush。

---

## 7. 协议适配器接口（如何接入另一套 API 规则）

适配器是一个 CommonJS 模块，导出以下字段/函数（参考 `electron/src/api/dashscope.js`）：

```js
module.exports = {
  id: 'xxx',                     // 唯一协议 id，registry 键名
  label: '展示名',
  defaultBaseUrl: 'https://...',
  defaultModel: '模型默认名',
  supportsAsync: true|false,
  sizeOptions: ['auto', '2688*1536', ...],   // 前端 size 下拉
  paramSchema: { n: {...}, negative_prompt: {...}, ... }, // 前端参数面板元信息
  buildSubmitRequest(ctx) -> {url, method, headers, body},
  parseSubmit(json, httpStatus, mode) -> {kind:'result',images,texts,usage,requestId} | {kind:'task',taskId,taskStatus} | {kind:'error',error:{code,message,requestId}},
  buildTaskQuery(ctx) -> {url, method, headers},
  parseTask(json, httpStatus) -> {status:'SUCCEEDED'|'FAILED'|'RUNNING'|'PENDING'|'UNKNOWN'|'CANCELED', images?, texts?, usage?, error?},
  buildTaskCancel(ctx) -> {url, method, headers}   // 仅异步协议需要
};
```

`ctx` 结构：`{apiKey, baseUrl, model, prompt, images:[dataUrl], params, mode, taskId?}`。

**接入步骤**：
1. 在 `electron/src/api/` 新建适配器文件；
2. 在 `electron/src/api/registry.js` 的 `adapters` 对象中注册（键 = id）；
3. （可选）把未实现的协议放入 `reserved` 数组，前端协议下拉会显示为「预留/禁用」；
4. 前端 `SettingsModal` 会自动读取 `listProtocols()` 的结果，无需改 UI。

`runner.js` 的 `start/resume/cancel/pollTask/deliverResult` 是**协议无关**的，新增协议无需改动执行器。

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

### 9.1 后端逻辑单测（mock DashScope）

无需 GUI，用本地 HTTP 服务模拟 DashScope 即可验证 runner 的同步/异步/错误/取消全链路：

```bash
npm run test:api      # 即 node scripts/test-api.js（已验证通过 15 项断言）
```

该脚本自包含：内置一张 16x16 PNG（校验尺寸嗅探）、临时目录自动清理。可直接参考或扩展。

mock 端点需覆盖：
- `POST {base}/services/aigc/multimodal-generation/generation`（sync 返回 choices，async 返回 task_id）
- `GET {base}/tasks/{id}`（PENDING→SUCCEEDED/FAILED）
- `POST {base}/tasks/{id}/cancel`
- `GET /img.png`（供结果图下载）

### 9.2 冒烟测试（无 GUI 环境）

```bash
npm run build && timeout 15 npx electron . 2>&1
# 观察 dev-data/log/app-*.log 出现「渲染进程启动完成」即渲染进程正常
# 打包后：
timeout 15 release/linux-unpacked/stabstab 2>&1
```

判定：`exit:124`（被 timeout 正常终止）= 稳定运行；`FATAL` 出现 = 崩溃。

---

## 10. 常见修改指南

| 想做什么 | 改哪里 |
|----------|--------|
| 接入新模型/协议 | `electron/src/api/` 新建适配器 + `registry.js` 注册 |
| 加一个 API 参数到输入区 | `dashscope.js` 的 `paramSchema` + `buildBody` + `Composer.jsx` 的 `ParamsPanel` + `lib/send.js` 的 `buildParams` |
| 改 size 列表 | `dashscope.js` 的 `sizeOptions`（注意 UserMessage 编辑态里也有一份硬编码，需同步） |
| 改会话/消息数据结构 | `lib/store.jsx` 的 reducer + `lib/send.js` 构造器 + 主进程 `normalizeConversationsOnStartup` |
| 改持久化字段默认值 | `electron/src/store.js` 的 `DEFAULT_SETTINGS` / `DEFAULT_CONVERSATIONS` |
| 改主题配色 | `src/styles/app.css` 顶部 CSS 变量 |
| 加 IPC | `preload.js` 暴露 + `main.js` `ipcMain.handle` + 渲染进程 `window.stab.*` |
| 改打包产物 | `electron-builder.yml` + `scripts/package.{sh,cmd}` |

---

## 11. 安全与凭据注意事项

- API Key 只存于本机 `settings.json`，日志**不打印** Key，也不打印完整 base64（只记字节数）。
- `runner` 日志会记录模型名、协议、模式、图片数量、size、耗时、错误码/信息，便于排查但脱敏。
- 提交代码时不要把 `dev-data/`、`stabstab-data/`、`release/`、`node_modules/` 纳入版本控制（已在 `.gitignore`）。
- **不要**把任何 Personal Access Token / API Key 提交进仓库或写入脚本。
