# StabStab

<div align="center">

[中文](./README.md) &nbsp;·&nbsp; [**English**](./README.en.md)

</div>

An **Electron + React + Vite** desktop AI image generation & editing workbench, with a Cherry Studio–style interaction.

- **Text-to-image**: generate images from a text prompt
- **Image-to-image**: 1–3 input images + an editing instruction, or pure image input
- **Model-series based setup** (you type the model id; each series can use several API sources):

  | Model series | Available API sources |
  |--------------|----------------------|
  | **Qwen Image series** (qwen-image-3.0-pro …) | Official (DashScope / Alibaba Cloud Bailian) · sync + async Task API |
  | **Doubao Seedream series** (doubao-seedream-*) | Official (Volcano Ark) · New API |
  | **GPT Image series** (gpt-image-2 / 2.5 …) | Grsai · NewApi |

- Except for the async option on Qwen, every source is **synchronous**: one blocking request that waits for the image
- A **protocol adapter** architecture lets you keep adding series / alternative API request & parsing rules

> For AI / developers, the in-depth development & debugging guide lives in **[AIDEV.md](./AIDEV.md)** (Chinese).

---

## Project Structure

```
stabstab/
├── electron/               # Electron main process (main.js + preload.js)
│   ├── assets/             # Window icon + built-in model-series.json
│   └── src/
│       ├── api/            # Protocol adapters (dashscope / seedream / newapi-images / grsai) + registry + runner
│       ├── paths.js        # Data-root resolution (installed → user dir, portable → next to exe) + legacy migration
│       ├── logger.js       # File logging (<data>/log/app-YYYYMMDD.log)
│       ├── store.js        # Settings / conversations JSON persistence (atomic write + legacy migration)
│       ├── modelSeries.js  # Model-series config IO & resolution (authoritative for requests)
│       └── imageutil.js    # Image dimension sniffing / cache download
├── src/                    # React renderer (Vite)
│   ├── components/         # Sidebar, chat, messages, composer, settings, lightbox, toasts
│   ├── lib/                # State store, model resolution, image compression, send logic
│   └── styles/app.css      # Light / dark theme styles
├── build/                  # Logo (icon.svg / icon.png / icon.ico)
├── scripts/
│   ├── test-api.js         # Backend end-to-end tests (mock HTTP servers per protocol)
│   ├── gen-logo.js         # Generate the logo (Penrose triangle / Monument Valley style)
│   ├── package.sh          # Ubuntu one-click packaging
│   └── package.cmd         # Windows one-click packaging
├── AIDEV.md                # AI / developer continuation guide
└── electron-builder.yml    # Packaging config
```

---

## Quick Start (Development)

Prerequisites: Node.js ≥ 18 (20+ recommended), npm, Git.

```bash
# 1. Clone the repository
git clone https://github.com/ExploringBB/stabstab.git
cd stabstab

# 2. Install dependencies (auto-configured, see note below)
npm install

# 3. Development mode: start Vite + Electron (F12 opens DevTools)
npm run dev
```

> **Dependency auto-configuration**: the `.npmrc` in the project root already
> points `electron_mirror` / `electron_builder_binaries_mirror` to npmmirror,
> so `npm install` automatically uses the mirror to speed up Electron and
> electron-builder binary downloads — no environment variables needed.

### Build production assets (optional)

Packaging scripts build automatically, so this is usually unnecessary; to build the
renderer manually:

```bash
npm run build      # Vite builds the renderer into dist/
```

> **Command naming**: use `npm run dev` and `npm run build`.
> `npm dev` is not a valid command; `npm build` is a legacy alias but `npm run build` is recommended.

In dev mode, data is written to `dev-data/` inside the project.

---

## One-Click Packaging

### Ubuntu 24 (current platform, verified)

```bash
cd stabstab
./scripts/package.sh
```

Artifacts in `release/`:

| File | Description |
|------|-------------|
| `stabstab-<version>-amd64.deb` | deb installer |
| `StabStab-linux-x64.tar.gz` | portable directory (contains `StabStab.sh` launcher) |

Install / run:

```bash
# install deb
sudo dpkg -i release/stabstab-<version>-amd64.deb

# run portable
tar -xzf release/StabStab-linux-x64.tar.gz
cd linux-unpacked
./StabStab.sh
```

> Note: packaging requires ImageMagick (`convert` / `magick`) to rasterize the SVG logo into png/ico.
> Without it, the script skips logo generation and reuses the committed `build/` icons.

### Windows (run on Windows; verified)

```bat
cd stabstab
scripts\package.cmd
```

Artifacts in `release\`:

| File | Description |
|------|-------------|
| `StabStab-<version>-x64-setup.exe` | NSIS installer |
| `StabStab-<version>-x64-portable.exe` | portable executable |

> Note: on Windows the script only auto-detects `magick` (ImageMagick 7); `convert` is no longer used
> because it collides with the system `C:\Windows\System32\convert.exe`. Without ImageMagick the script
> skips logo generation and reuses the committed `build/` icons.

---

## Data & Cache (Important)

App data lives in a single `stabstab-data/` directory whose **location depends on how the app runs** (it survives uninstall and overwrite upgrades):

| How it runs | Data directory |
|---|---|
| Installed build (Windows installer / Linux deb) | Windows: `%APPDATA%\StabStab\stabstab-data`; Linux: `~/.config/StabStab/stabstab-data` |
| Portable build (Windows portable / Linux portable tar.gz) | `stabstab-data/` next to the executable (copy the whole folder to take your config along) |
| Dev mode (`npm run dev`) | `dev-data/` inside the project |

```
stabstab-data/
├── conversations.json   # Conversations & history (text + image references)
├── settings.json        # Settings (model series & models, API keys, theme, timeout, ...)
├── model-series.json    # Built-in model-series definitions (series / API sources / default URLs / sync-async switch)
├── rename-model.json    # Title-model config (prompt template / temperature / Top-P / default URL & model)
├── .migration.json      # Legacy-data migration record (source directory, whether the copy finished)
├── cache/               # Generated result images (downloaded immediately from API URLs)
├── uploads/             # User input images (paste / drop / picker)
├── downloads/           # Default save path (download result images)
└── log/                 # Logs (app-YYYYMMDD.log)
```

- **Your config survives uninstall and overwrite installs**: data sits in the system user directory (portable builds keep it next to the executable) while the installer only removes the install directory. Earlier versions kept data next to the executable; the first upgrade **migrates it automatically** (including your image history, copy-only — originals are never deleted), and the Windows installer grabs a copy before deleting the old directory (progress is printed in the installer's details pane).
- The main page offers a one-click “open cache directory” button; **deleting `cache/` frees space and does not affect the next run** (result images in history show a "image cleared" placeholder).
- `model-series.json` can be hand-edited (e.g. point a source at your own relay); it takes effect after restart, and deleting it re-creates it from the built-in defaults.
- To find the data directory in use, check the startup log — it records `dataRoot`, and `migratedFrom` when a migration happened.

---

## Features

- **Conversation management**: left-side tabs (numeric names 1234… by default), new / rename / delete / delete-all; the "⋯" menu per tab.
- **No context**: each request contains only the current single input — context length is always 0.
- **Message actions**: edit a past user input in place and resend (auto-deletes the old reply, overwrites in place). A resend always uses the **model and parameters currently selected in the composer** (switch to model B or change the resolution below and the resend follows it; the edit bubble can also override the size for that single resend); delete a single message; copy text / image; result images show their resolution.
- **Image input**: paste (common formats), drag into the composer, or click "+" for multi-select; up to 3 images; pure image / pure text / text+image all supported.
- **Image preview**: click any input/result image to zoom, scroll to zoom, drag to pan, ESC to close, arrow keys to switch.
- **Pre-send compression**: enable in Settings → Basic; single images exceeding the threshold (10 MB by default) are compressed; multiple images are checked individually.
- **size parameter**: candidates depend on the model — Qwen: `Auto / 2688*1536 / 2368*1728 / 2048*2048 / 1728*2368 / 1536*2688`; Seedream official: `1K / 2K / 4K / 2048x2048` …; Grsai: ratios such as `16:9 / 9:16 / 1:1` or pixel values; New API: `1024x1024` …
- **Advanced parameters**: driven by the protocol (Qwen: n, negative prompt, watermark, prompt rewriting, seed; Seedream official: watermark, output format; New API: n, quality, style; Grsai: no extra parameters).
- **Sync mode (default)**: the current conversation must wait for the API response before sending again (send button disabled, re-enabled on timeout); multiple tabs wait independently; a yellow dot marks results arriving on other tabs and disappears once opened.
- **Async mode**: **Qwen series only** (`X-DashScope-Async` submit → task polling with exponential backoff 3s → ×1.5 → 15s cap), status card + cancel button (only PENDING can be cancelled), auto-resume after app restart; all other series are always synchronous.
- **Timeout**: single request timeout defaults to 300 s, configurable in Settings.
- **Logging**: key events are written to `stabstab-data/log/` for troubleshooting.

---

## Model Settings, Series & Protocol Extension

Settings → Model is organised by **model series** and starts empty:

1. Pick a **built-in series** from the "Add model series" dropdown (series and their API sources are built in; the definitions live in `model-series.json` inside the data directory) and click Add;
2. Inside the series card, click "Add model", type the **model id** (the grey placeholder shows examples such as `gpt-image-2` or `doubao-seedream-5-0-pro-260628`) and choose its **API source**;
3. Fill in the **API Key** and **API URL** per source (the URL is pre-filled from the built-in default, editable, with a "restore default" button);
4. The radio button on the left of each model row marks the **global default model** (the one pre-selected in the composer).

Other notes:

- Each model can have its own API key / URL (stored per *series·source*), so they never interfere;
- Two levels of deletion: delete a model, or remove a model series (a built-in series is only hidden from the list — keys are kept and it can be re-added at any time);
- The **sync / async** switch in Settings → Advanced is only shown for series that support it (currently Qwen only) and is stored in `model-series.json`;
- The model list starts **completely empty** (both on a fresh install and when upgrading from an older version): add a series from the dropdown, then add models inside it.
  Your old API key / custom base URL is carried over on upgrade (usable as soon as you add that series), but **no series or model is added automatically**.

**To add another API request & parsing rule set**:

1. Create an adapter file in `electron/src/api/` (mirroring `dashscope.js`: `buildSubmitRequest / parseSubmit / buildTaskQuery / parseTask / buildTaskCancel`, plus `sizeOptions / paramSchema` metadata);
2. Register it in `electron/src/api/registry.js` under `adapters`;
3. Add a series (or a `sources[]` entry) in `electron/assets/model-series.json` whose `protocol` is the adapter id — the series/source dropdowns pick it up automatically.

The `reserved` list in `registry.js` shows "reserved but not implemented" protocols (placeholder, disabled). See [AIDEV.md §0 and §7](./AIDEV.md).

---

## API Rules Summary

**Qwen Image series · Official (DashScope)** — based on the workspace docs "图像编辑 - 千问AI平台.html" and "异步任务管理 - 千问AI平台.html":

- Sync endpoint: `POST {base}/services/aigc/multimodal-generation/generation`
- Async: same endpoint + header `X-DashScope-Async: enable` → returns `output.task_id`; poll `GET {base}/tasks/{task_id}`; cancel `POST {base}/tasks/{task_id}/cancel`
- Input `messages[].content` is `[{image: url|base64}, ...{text}]`; 1–3 images; formats JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF; ≤ 10 MB each
- Base64 format: `data:<mime>;base64,<data>`
- Parameters: `n` (1–6), `negative_prompt`, `watermark`, `prompt_extend`, `seed`, `size` (width*height)
- Response: `output.choices[].message.content[].image` (legacy Wan models use `output.results[].url`)

**Doubao Seedream series · Official (Volcano Ark)** — see "seedream系列api.md" (its `/responses` example is a text-chat sample; image generation uses `/images/generations`):

- `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`, header `Authorization: Bearer <ARK_API_KEY>`
- Body: `{model, prompt, size, image, response_format:"url", watermark, output_format}`
- `size` accepts `1K/2K/4K` presets or explicit `2048x2048` pixels (do not mix); pass input images via `image` (URL or `data:` base64, array for multiple)
- Response: `data[].url` plus `usage.generated_images`; this source is **synchronous only**

**Doubao Seedream series · New API / GPT Image series · NewApi** — see the New Api section of "gpt-image系列.md":

- `POST {base}/images/generations` (e.g. `https://toprouter.sealoshzh.site/v1`), header `Authorization: Bearer <TOKEN>`
- Parameters: `prompt` (required), `size` (default `1024x1024`), `quality` (default `standard`), `style` (default `vivid`), `n` (1–10), `response_format` (default `url`)
- Response: `data[].url` or `data[].b64_json` (both are saved into the local cache)

**GPT Image series · Grsai** — see the Grsai API section of "gpt-image系列.md":

- `POST https://grsaiapi.com/v1/api/generate` (China node: `https://grsai.dakka.com.cn/v1/api/generate`), header `Authorization: Bearer sk-xxx`
- Body: `{model, prompt, images?, aspectRatio?}`; `images` accepts base64 data URLs and http URLs, `aspectRatio` accepts ratios like `16:9` or pixel values like `1024x1024`
- Supported model ids: `gpt-image-2`, `gpt-image-2-vip`, `gpt-image-2.5`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` (you type them yourself)
- Response: `results[].url` inside the SSE stream, or JSON `{code:0,data:{results:[{url}]}}`; if the server only returns a task id, the app automatically polls the result endpoint

---

## FAQ

**Window won't open / GPU errors on Linux?**
The main process already handles Linux compatibility (disables GPU process sandbox, and fully disables the sandbox when necessary). If issues persist, append flags manually:

```bash
./StabStab.sh --disable-gpu       # fully disable GPU acceleration (software rendering)
./StabStab.sh --no-sandbox        # disable sandbox (rare restricted environments)
```

**Window never appears / app exits right after launch on Windows?**
Enterprise EDR / security agents (confirmed: Sangfor aES) hook process creation, so Chromium cannot create its
sandboxed restricted token / AppContainer. The log shows `renderer process gone {"reason":"launch-failed","exitCode":57}`
(blank window) or a GPU process `error_code=57` followed by `GPU process isn't usable. Goodbye.` and an immediate exit.
The main process now appends `--no-sandbox` on Windows by default; set `STABSTAB_KEEP_SANDBOX=1` to restore the sandbox.

**Where are the logs?**
`stabstab-data/log/app-YYYYMMDD.log` (system user directory for installed builds, next to the executable for portable builds — see "Data & Cache" above).

---

## License

MIT
