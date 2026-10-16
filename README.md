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
- **两种生成模式**：**图片生成**（默认，即上面这套文生图 / 图生图）与 **对话生成**（接文本模型：流式回答、
  支持多图提问、整段对话作为上下文；配置在「设置 → 文本模型」，开关在「设置 → 基础设置 → 生成模式」）
- 通过「协议适配器」架构可继续扩展其它系列 / 其它 API 请求解析规则

> 面向 AI / 开发者的继续开发与调试指南见 **[AIDEV.md](./AIDEV.md)**。

---

## 目录结构

```
stabstab/
├── electron/               # Electron 主进程（入口 main.js + preload.js）
│   ├── assets/             # 窗口图标 + 内置配置：model-series.json（图像系列）/ text-model-series.json（文本系列）
│   └── src/
│       ├── api/            # 协议适配器（dashscope / seedream / newapi-images / grsai / grsai-chat）+ 注册表 + 执行器(runner.js)
│       ├── paths.js        # 数据根目录解析（安装版→用户目录，便携版→exe 同级）+ 旧数据迁移
│       ├── logger.js       # 日志（<data>/log/app-YYYYMMDD.log）
│       ├── store.js        # 设置 / 会话 JSON 持久化（原子写入 + 旧结构迁移）
│       ├── modelSeries.js  # 模型系列配置读写与解析（发请求的权威口径）
│       ├── textModelSeries.js # 文本模型系列配置读写与解析（「对话生成」模式的权威口径）
│       └── imageutil.js    # 图片尺寸嗅探 / 缓存下载
├── src/                    # React 渲染进程（Vite）
│   ├── components/         # 侧边栏、聊天、消息、输入框、设置、灯箱预览、Toast
│   ├── lib/                # 状态 store、模型解析（models.js / textModels.js）、图片压缩、发送逻辑
│   └── styles/app.css      # 白天 / 黑暗主题样式
├── build/                  # Logo（icon.svg / icon.png / icon.ico）
├── scripts/
│   ├── test-api.js         # 后端端到端测试（mock 各协议 HTTP 服务）
│   ├── gen-logo.js         # 生成 Logo（彭罗斯三角 / 纪念碑谷风）
│   ├── package.sh          # Ubuntu 一键打包
│   ├── package.cmd         # Windows 一键打包（打包前先清理 release 残留并检查占用）
│   └── clean-release.ps1   # 打包前置清理 + 持锁进程诊断（辅助：lib/RmFileLock.cs）
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

应用数据保存在一个 `stabstab-data/` 目录里，**位置随运行形态而定**（卸载、覆盖安装都不会丢）：

| 运行形态 | 数据目录位置 |
|---|---|
| 安装版（Windows 安装包 / Linux deb） | Windows：`%APPDATA%\StabStab\stabstab-data`；Linux：`~/.config/StabStab/stabstab-data` |
| 便携版（Windows portable / Linux 便携 tar.gz） | 可执行文件同级的 `stabstab-data/`（整个目录拷走即带走全部配置） |
| 开发模式（`npm run dev`） | 项目内 `dev-data/` |

```
stabstab-data/
├── conversations.json   # 会话与历史（文字 + 图片引用）
├── settings.json        # 设置（模型系列与模型、API Key、主题、超时、生成模式等）
├── model-series.json    # 内置模型系列配置（系列 / API 来源 / 默认地址 / 尺寸候选）
├── text-model-series.json # 文本模型系列配置（「对话生成」：系列 / 来源 / 内置模型清单 / 默认模型）
├── rename-model.json    # 重命名模型配置（标题提示模板 / 温度 / Top-P / 默认地址与默认模型）
├── .migration.json      # 旧数据迁移记录（从哪个旧目录搬来的、是否搬完；没有迁移过则不存在）
├── cache/               # 生成结果的图片缓存（API 返回 URL 后立即下载到这里）
├── uploads/             # 用户输入图片（粘贴/拖入/选择）
├── downloads/           # 默认保存路径（下载结果图片）
└── log/                 # 日志（app-YYYYMMDD.log）
```

- **覆盖安装 / 卸载重装后配置都在**：数据放在系统用户目录（便携版放 exe 同级），安装器只删安装目录。
  旧版本曾把数据放在 exe 同级，首次升级时会**自动迁移**过去（含历史图片，只拷不删原目录）；
  Windows 安装包还会在删旧目录之前先抢一份（迁移过程打印在安装界面的「详细信息」里）。
- 左侧标签栏底部提供「一键打开缓存目录」按钮；**直接删除 `cache/` 目录可清理空间，不影响下次运行**（历史消息中的结果图会显示为“图片已清理”占位）。
- 对话区右上角「同步模式」右侧有两个目录按钮：文件夹图标打开数据目录下的 `downloads/`（开发模式即项目内 `dev-data/downloads/`）；其右侧「下载」图标打开**系统「下载」目录**（Windows = 用户目录 `Downloads`，Ubuntu 24.04 = `~/Downloads`）。
- `model-series.json` 可手工编辑（例如把某系列的默认 API 地址换成你自己的中转地址），重启后生效；删除该文件会从程序内置配置重新生成一份。其中 `sources[].sizeOptions`（尺寸候选）取「程序内置 ∪ 你手工追加」的**并集**：升级后新增的常用尺寸会立刻出现，你自己加的尺寸也不会丢；反过来，**在副本里删掉某个内置尺寸不生效**（只能增不能删）。
- `rename-model.json` 同样可手工编辑（标题生成提示模板 / 温度 / Top-P / 默认 API 地址 / 默认模型 id），重启后生效；设置页「重命名模型」里的滑动条与模板框写的就是这个文件。
- `text-model-series.json` 是**「对话生成」模式**专用的一份配置（与 `model-series.json` 互不共用）：里面是文本模型系列、
  它的 API 来源与**内置模型清单**，同样可手工编辑、重启生效；设置页「文本模型」里能改的只有「来源的 API Key / API 地址」与
  「用哪个内置模型」两件事，要增删模型就改这份 json。
- **配置 + 聊天记录导出 / 导入**（设置 → 数据管理）：导出把设置、模型系列、重命名模型配置与全部聊天记录（含聊天记录里引用到的图片）打成一个 zip，
  包名固定为 `ss-YYYYMMDD-HHmm.zip`（精确到分钟，如 `ss-20260213-1530.zip`）；导入时先校验包名、解压到程序缓存目录后再校验包内目录协议，
  然后叠加合并到当前数据 —— 图片按文件名查重直接落盘、模型按「同 id / 同系列同来源同名」查重后追加（当前没有的系列自动新增）、
  聊天记录按 id 查重后追加在列表最上面，选项类设置（主题 / 超时 / 压缩 / 命名 / 默认模型）按导入的值更新，
  本机已填的 API Key / 地址不被导入覆盖（只补空缺）。两条校验各自有明确报错，失败时原样保留当前数据。
- 想手动指定或找回数据目录：启动日志会写明本次使用的数据目录（`dataRoot`）以及是否发生过迁移（`migratedFrom`）。

---

## 功能清单

- **对话管理**：左侧标签（空对话按序号命名 1234…）、新建 / 重命名 / 删除 / 一键删除全部；标签「⋯」展开菜单（重命名 / 生成重命名 / 删除）。
- **标签自动命名**：发出首条文字后，用「重命名模型」（DeepSeek 大模型，Responses API，提示使用 `deepseek-flash` 非思考模式）把文字精简成 5~6 个汉字的中文标题作为标签名；未配置 API Key 或调用失败时，直接截取首条文字。提示模板 / 温度 / Top-P 存在数据目录的 `rename-model.json`，设置 → 重命名模型 里提供 API Key、API 地址、模型 id 与两个滑动条。
- **手动「生成重命名」**：标签「⋯」菜单 →**生成重命名**（在「重命名」与「删除」之间）立刻再调一次重命名模型重算标签名 —— 它把这个会话里**全部**用户输入交给模型（不只是首条），适合不满意自动命名或自动命名当时失效（没填 Key / 超时 / 首条只有图片）的情况；成功弹提示并直接改名，失败保留原名并提示原因（例如「尚未配置重命名模型的 API Key」）。
- **无上下文**：每次请求只包含当前一条输入，上下文长度为 0。
- **消息操作**：原地编辑历史用户输入并重新发送（自动删除旧回复、原地覆盖）。重发一律使用**输入框当前的模型与参数**（下方换了模型 / 改了尺寸，重发就按新的发；编辑气泡里也能单独改这一次的尺寸）；编辑时既能**移除**图片，也能**增加**图片（在编辑框里粘贴、把图片拖到这条气泡上、或点「＋」多选，最多 3 张）；删除单条消息；复制文字 / 图片；结果图片带分辨率显示。
- **发送气泡显示模型**：用户消息气泡底部、时间左侧显示这条输入**本次发送使用的模型名**（名字过长省略号截断，悬停可看模型所属系列与来源）。
- **对话生成模式**（设置 → 基础设置 →「生成模式」选「对话生成」）：聊天页换成跟**文本模型**对话 —— 只列文本模型、
  隐藏尺寸与参数，回答**流式**逐字显示；支持多图提问（粘贴 / 拖入 / 多选，与图片模式同一条输入框），
  并且**带上整段对话作为上下文**（本对话里对话生成模式的消息按顺序发出，不截断、不摘要）。
  同一个对话是**严格串行**的：上一条回答结束前发不出下一条（避免两个回答基于同一段还不完整的历史各说各话）。
  为避免上下文错位，对话生成模式下对历史气泡的「当前对话发送」与「编辑并重新发送」**不可用**（按钮置灰，悬停有说明），
  要把某条内容再发一遍请用「新对话发送」分叉到新对话。模型与 Key 在「设置 → 文本模型」里配，见下方「对话生成模式（文本模型）」。
- **配置 + 聊天记录导出 / 导入**：设置 → 数据管理 一键导出 / 导入（`ss-日期-时间.zip`，含结果提示与合并明细），见上方「数据与缓存」。
- **图片输入**：粘贴（支持常见格式）、拖入输入框、点「+」多选；多图最多 3 张；允许纯图片、纯文字、文字+图片。编辑历史消息时同样可以粘贴 / 拖入 / 「+」补图（拖放接收区域就是那条用户气泡）。
- **图片预览**：点击任意输入图 / 结果图放大预览，滚轮缩放、拖动查看细节、ESC 关闭、左右切换。
- **发送前图片压缩**：设置 → 基础设置 中开启，单图超过阈值（默认 10MB）自动压缩，多图分别检测。
- **关闭窗口行为**：设置 → 基础设置 →「关闭窗口时」可选 **最小化到托盘** 或 **直接退出程序**。
  **没设置过**时按运行方式决定：`npm run dev`（开发模式）点 × 直接退出程序，打包后的安装版 / 便携版点 × 最小化到托盘。
  最小化到托盘后程序**继续在后台运行**（等待中的生成请求不会被中断），单击托盘图标或右键菜单「显示主界面」即可唤回窗口，
  彻底退出请用托盘菜单里的「退出程序」。改完设置立即生效，不需要重启。
- **size 参数**：按模型自动给出候选，下拉项末尾带上比例（如 `尺寸：2688×1536 · 7:4`），选中后右侧实时显示**比例**与一个按比例真实绘制的**方框示例**（无确定比例的 `自动 / 1K / 2K / 4K` 显示 `-`）。Qwen 共 19 档（官方推荐比例 1:1 / 3:2 / 2:3 / 4:3 / 3:4 / 16:9 / 9:16 / 21:9 + 旧候选）；Seedream 官方 20 档、New API 19 档（`1K/2K/4K` 预设 + 常用比例像素档）；Grsai / New API（GPT Image）沿用比例或像素值。
- **自定义尺寸 + 比例模式**：尺寸下拉最后一项「自定义…」可手填宽高；中间那个 `×` 是个小按钮，点一下变成 `:` 进入**比例模式** —— 后面多出两个比例输入框（中间是 `:`），改「宽」或「高」的任意一边，另一边按比例自动填入（按当前宽度改比例也一样）。两种模式都实时显示比例与方框示意图（宽或高为 0 时显示 `-`，不会出现除 0）。
- **高级参数**：随协议自动变化（Qwen：n、反向提示词、水印、提示词改写、随机种子；Seedream 官方：水印、输出格式；New API：n、quality、style；Grsai：无额外参数）。
- **同步模式（默认）**：当前对话需等待 API 返回才能继续发送（发送按钮置灰、超时恢复），多标签各自独立等待；其它标签返回结果时显示黄点，点开即消。
- **异步模式**：**只有 Qwen 系列支持**（`X-DashScope-Async` 提交 → 轮询 task，指数退避 3s→×1.5→上限 15s），状态卡片 + 取消按钮（仅 PENDING 可取消），应用重启后自动恢复轮询；其它系列固定同步。
- **超时**：单次请求超时默认 300 秒，可在设置中调整。
- **日志**：关键信息记录到 `stabstab-data/log/`，便于排查。

---

## 图像模型、模型系列与协议扩展

「设置 → 图像模型」按**模型系列**组织，初始为空，需要自己添加：

1. 在「添加模型系列」下拉框中选择一个**内置系列**（系列与其可用 API 来源由系统内置，配置存放在数据目录的 `model-series.json`），点「添加」；
2. 在系列卡片内点「添加模型」，填写**模型 id**（灰色提示给出示例，例如 `gpt-image-2`、`doubao-seedream-5-0-pro-260628`），并选择该模型使用的 **API 来源**；
3. 在系列卡片下方的**来源级配置**里填写 **API Key** 与 **API 地址**（地址默认自动填充内置地址，可改，点「恢复默认」还原）；
4. 模型行左侧的单选框 = **全局默认模型**（输入区默认选中的那个）。

> 这里说的是**图像**模型那条链。「对话生成」用的文本模型在**「设置 → 文本模型」**里配置（另一份配置文件、另一组字段，
> 见下方「对话生成模式（文本模型）」），两边互不影响。

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

## 对话生成模式（文本模型）

在「设置 → 基础设置 → 生成模式」里把模式切成 **对话生成**，聊天页就从「生成图片」变成「跟文本模型对话」：

- **只列文本模型**：模型选择器换成文本模型，尺寸与高级参数面板一并隐藏（文本模型没有这些）。
  「设置 → 文本模型」里按系列配置：内置 **Grsai 系列**（10 个 gemini 模型，默认 `gemini-3.5-flash`），
  每个来源填 **API Key**（点「获取 API Key」直达申请页）与 **API 地址**（默认内置 `https://grsai.dakka.com.cn/v1`，
  可改成自己的中转，点「恢复默认」还原）。
- **流式回答**：回答逐字显示（`POST {地址}/chat/completions`，SSE 流式），不用等整段生成完。
- **可以带图提问**：输入框还是同一个 —— 粘贴 / 拖入 / 多选图片，最多 3 张，多图一起发（程序转成 base64 传给模型）。
- **整段上下文**：本对话里对话生成模式的消息会**按顺序整段发出**（不截断、不摘要），所以模型记得住前面聊过什么；
  也因此 token 消耗随轮数增长，长对话请自行开新对话分叉。
- **同一个对话严格串行**：上一条回答结束前发不出下一条。两个请求同时飞会各自基于「同一段还不完整的历史」回答，
  顺序与上下文对不上，所以这里刻意不做并行（图片生成那边仍然是多个请求并行等待，不受影响）。
- **对话里不能再「重发」**：对历史气泡的「当前对话发送」与「编辑并重新发送」在对话生成模式下**不可用**（按钮置灰，
  悬停有说明）—— 把历史内容再插回同一段上下文会让模型前后矛盾。要把某条内容再发一遍，请用
  **「新对话发送」**：它会带着上下文分叉到一个**新对话**里发送。图片生成模式下这两个按钮一切照旧。

模型清单与系列定义在数据目录的 `text-model-series.json`（内置配置随程序发布，首次启动复制一份；手工编辑后重启生效），
API Key 只存在本机数据目录 `settings.json` 的 `textSourceConfig` 字段里 —— 与图像模型那条链（`model-series.json` /
`sourceConfig`）**各存各的**，互不覆盖。

---

## API 规则要点

**Qwen 图像系列 · 官方（DashScope）** —— 参考工作区文档「图像编辑 - 千问AI平台.html」与「异步任务管理 - 千问AI平台.html」：

- 同步端点：`POST {base}/services/aigc/multimodal-generation/generation`
- 异步：同一端点 + 请求头 `X-DashScope-Async: enable`，返回 `output.task_id`；轮询 `GET {base}/tasks/{task_id}`；取消 `POST {base}/tasks/{task_id}/cancel`
- 输入 `messages[].content` 为 `[{image: url|base64}, ...{text}]`，图片 1–3 张，格式 JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF，单张 ≤ 10MB
- 图片 base64 格式：`data:<mime>;base64,<data>`
- 参数：`n`（1–6）、`negative_prompt`、`watermark`、`prompt_extend`、`seed`、`size`（宽*高；常用档位取自官方「常见比例推荐分辨率」，见 `model-series.json`）
- 响应：`output.choices[].message.content[].image`（旧版万相为 `output.results[].url`）

**Doubao Seedream 系列 · 官方（火山方舟 Ark）** —— 参考「seedream系列api.md」（该文档给的是文本对话示例 `/responses`，生图实际用 `/images/generations`）：

- `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`，请求头 `Authorization: Bearer <ARK_API_KEY>`
- 请求体：`{model, prompt, size, image, response_format:"url", watermark, output_format}`
- `size` 支持 `1K/2K/4K` 或 `2048x2048` 像素值（两种模式不可混用）；常用像素档见 `model-series.json`；有输入图时用 `image`（URL 或 `data:base64`，多图传数组）
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

**文本模型 · Grsai 系列（「对话生成」模式）**：

- `POST {baseUrl}/chat/completions`（默认 `https://grsai.dakka.com.cn/v1/chat/completions`），请求头 `Authorization: Bearer sk-xxx`
- 请求体：`{model, stream:true, messages}`，`messages` 是整段对话（`[{role:'user'|'assistant', content:…}]`），**流式**返回增量
- 图片按 `image_url.url` 传 base64 data URL（`data:<mime>;base64,<data>`），支持多图与多轮
- 模型清单内置在 `electron/assets/text-model-series.json`（gemini 系列 10 个，默认 `gemini-3.5-flash`）

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
`stabstab-data/log/app-YYYYMMDD.log`（安装版在系统用户目录，便携版在可执行文件同级 —— 见上方「数据与缓存」）。

---

## 许可证

MIT
