# StabStab

<div align="center">

[中文](./README.md) &nbsp;·&nbsp; [**English**](./README.en.md)

</div>

An **Electron + React + Vite** desktop AI image generation & editing workbench, with a Cherry Studio–style interaction.

- **Text-to-image**: generate images from a text prompt
- **Image-to-image**: 1–3 input images + an editing instruction, or pure image input
- First integration: **Qwen-Image-3.0-Pro** (DashScope multimodal generation protocol, sync + async Task API)
- A **protocol adapter** architecture reserves extension points for other models / alternative API request & parsing rules

> For AI / developers, the in-depth development & debugging guide lives in **[AIDEV.md](./AIDEV.md)** (Chinese).

---

## Project Structure

```
stabstab/
├── electron/               # Electron main process (main.js + preload.js)
│   └── src/
│       ├── api/            # Protocol adapters (dashscope.js) + registry + runner
│       ├── paths.js        # Data-root resolution (next to executable, fallback to user dir)
│       ├── logger.js       # File logging (<data>/log/app-YYYYMMDD.log)
│       ├── store.js        # Settings / conversations JSON persistence (atomic write)
│       └── imageutil.js    # Image dimension sniffing / cache download
├── src/                    # React renderer (Vite)
│   ├── components/         # Sidebar, chat, messages, composer, settings, lightbox, toasts
│   ├── lib/                # State store, image compression, send logic
│   └── styles/app.css      # Light / dark theme styles
├── build/                  # Logo (icon.svg / icon.png / icon.ico)
├── scripts/
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

App data is stored in `stabstab-data/`, next to the executable:

```
stabstab-data/
├── conversations.json   # Conversations & history (text + image references)
├── settings.json        # Settings (API Key, models, theme, timeout, ...)
├── cache/               # Generated result images (downloaded immediately from API URLs)
├── uploads/             # User input images (paste / drop / picker)
├── downloads/           # Default save path (download result images)
└── log/                 # Logs (app-YYYYMMDD.log)
```

- The main page offers a one-click “open cache directory” button; **deleting `cache/` frees space and does not affect the next run** (result images in history show a "image cleared" placeholder).
- If the executable directory is not writable (e.g. deb into `/opt`, Windows into `Program Files`), the app automatically falls back to the system user-data directory (`~/.config/StabStab/` or `%APPDATA%/StabStab/`).

---

## Features

- **Conversation management**: left-side tabs (numeric names 1234… by default), new / rename / delete / delete-all; the "⋯" menu per tab.
- **No context**: each request contains only the current single input — context length is always 0.
- **Message actions**: edit a past user input in place and resend (auto-deletes the old reply, overwrites in place); delete a single message; copy text / image; result images show their resolution.
- **Image input**: paste (common formats), drag into the composer, or click "+" for multi-select; up to 3 images; pure image / pure text / text+image all supported.
- **Image preview**: click any input/result image to zoom, scroll to zoom, drag to pan, ESC to close, arrow keys to switch.
- **Pre-send compression**: enable in Settings → Basic; single images exceeding the threshold (10 MB by default) are compressed; multiple images are checked individually.
- **size parameter**: `Auto / 2688*1536 / 2368*1728 / 2048*2048 / 1728*2368 / 1536*2688`.
- **Advanced parameters**: n (1–6 images), negative prompt, watermark, prompt rewriting, random seed.
- **Sync mode (default)**: the current conversation must wait for the API response before sending again (send button disabled, re-enabled on timeout); multiple tabs wait independently; a yellow dot marks results arriving on other tabs and disappears once opened.
- **Async mode**: `X-DashScope-Async` submit → task polling (exponential backoff 3s → ×1.5 → 15s cap), status card + cancel button (only PENDING can be cancelled), auto-resume after app restart.
- **Timeout**: single request timeout defaults to 300 s, configurable in Settings.
- **Logging**: key events are written to `stabstab-data/log/` for troubleshooting.

---

## Model Settings & Protocol Extension

Settings → Model:

- API Key, Base URL (default `https://dashscope.aliyuncs.com/api/v1`)
- Model list: built-in `qwen-image-3.0-pro` (DashScope protocol); add / remove / set default

**To add another API request & parsing rule set** (other models):

1. Create an adapter file in `electron/src/api/` (mirroring `dashscope.js`: `buildSubmitRequest / parseSubmit / buildTaskQuery / parseTask / buildTaskCancel`, etc.);
2. Register it in `electron/src/api/registry.js` under `adapters`;
3. The protocol dropdown in Settings → Model automatically picks it up.

The `reserved` list in `registry.js` shows "reserved but not implemented" protocols (placeholder, disabled). See [AIDEV.md §7](./AIDEV.md).

---

## API Rules Summary (DashScope Qwen Image)

Based on the workspace docs "图像编辑 - 千问AI平台.html" and "异步任务管理 - 千问AI平台.html":

- Sync endpoint: `POST {base}/services/aigc/multimodal-generation/generation`
- Async: same endpoint + header `X-DashScope-Async: enable` → returns `output.task_id`; poll `GET {base}/tasks/{task_id}`; cancel `POST {base}/tasks/{task_id}/cancel`
- Input `messages[].content` is `[{image: url|base64}, ...{text}]`; 1–3 images; formats JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF; ≤ 10 MB each
- Base64 format: `data:<mime>;base64,<data>`
- Parameters: `n` (1–6), `negative_prompt`, `watermark`, `prompt_extend`, `seed`, `size` (width*height)
- Response: `output.choices[].message.content[].image` (legacy Wan models use `output.results[].url`)

---

## FAQ

**Window won't open / GPU errors on Linux?**
The main process already handles Linux compatibility (disables GPU process sandbox, and fully disables the sandbox when necessary). If issues persist, append flags manually:

```bash
./StabStab.sh --disable-gpu       # fully disable GPU acceleration (software rendering)
./StabStab.sh --no-sandbox        # disable sandbox (rare restricted environments)
```

**Where are the logs?**
`stabstab-data/log/app-YYYYMMDD.log` (next to the executable for the portable build).

---

## License

MIT
