# AGENTS.md

This file provides guidance to OpenCode agents when working with code in this repository.

> **SYNC RULE:** This file is synced with CLAUDE.md and GEMINI.md. Any change to one must be applied to all three. Do not amend any of them without also updating the others.

## What this is

SetEngine is an Electron desktop app (macOS / Windows / Linux) that downloads songs and playlists from YouTube Music as MP3s. It wraps the system-installed `yt-dlp` binary and embeds an authenticated YouTube Music browser so users can navigate to content and trigger downloads.

## Getting Started (first-time setup)

```bash
# macOS / Linux — one command
npm run setup
# or: ./scripts/setup.sh

# Windows — one command
.\scripts\setup.ps1
```

The setup script checks for Node.js, installs npm dependencies, and verifies
the system tools SetEngine needs.  It prints copy-pasteable install commands
for anything that's missing:

| Tool    | Required? | Purpose |
|---------|-----------|---------|
| yt-dlp  | **Yes**   | Downloads audio from YouTube Music |
| ffmpeg  | **Yes**   | Converts downloaded audio to MP3 |
| aria2c  | Optional  | ~2× faster downloads (multi-connection HTTP) |
| spotdl  | Optional  | Downloads from Spotify |

Once all tools are green, run `npm start` to launch the dev build.

## Commands

Build / run is driven entirely by Electron Forge + the Vite plugin:

- `npm start` — Electron Forge dev: starts the Vite dev server, builds main + preload, launches Electron. Renderer changes hot-reload; **main-process changes need a full restart.**
- `npm run package` — produce an unpacked app in `out/`
- `npm run make` — installers per `forge.config.js` (Squirrel/Windows, zip/macOS, deb/rpm/Linux)
- `npm run publish` — Forge publish targets
- `npm run lint` — currently a no-op (`echo "No linting configured"`)

There is no test framework.

## External binaries — not bundled

`yt-dlp` and `ffmpeg` are **required system dependencies**. `aria2c` is optional but recommended (~2× faster downloads via multi-connection HTTP). All three are auto-detected from `PATH`; if `aria2c` is present, yt-dlp downloads route through it.

`main.js` prepends `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` to `process.env.PATH` on startup (macOS/Linux). Without this, Electron processes launched from environments with a stripped PATH miss Homebrew installs and detection incorrectly reports "not found". Keep this in mind when adding new external-binary dependencies.

The `yt-dlp-wrap` npm package is **not used** — `src/main/ytdlp-wrapper.js` spawns `yt-dlp` itself and has been removed as a dependency.

## Electron runtime — Castlabs fork

Spotify playback requires Widevine DRM which stock Electron does not ship. This project uses [Castlabs Electron for Content Security](https://github.com/castlabs/electron-releases) as a drop-in replacement. `src/main.js` calls `components.whenReady()` before `createWindow()` to wait for the Widevine CDM to download and install on first launch. If Widevine is unavailable — for example on a stock Electron build — the `try/catch` around `components.whenReady()` lets the app start without DRM, and Spotify will show "playback disabled" in the browser view.

## Architecture

Three-tier Electron split with strict process boundaries via `contextIsolation`:

### Main process — `src/main.js` + `src/main/*`

`main.js` wires four singletons and registers IPC.

- **`YtDlpWrapper`** (`ytdlp-wrapper.js`) — the only module that spawns `yt-dlp`. Builds CLI args including `--extractor-args "youtube:player_client=default,web_safari,tv,mweb"` (SABR-resilient, cookie-compatible — `tv_simply` is deliberately *not* included because it gets skipped whenever `--cookies` is passed), `--concurrent-fragments 4`, and aria2c routing when available. Exposes `download()`, `getVideoInfo()`, `getPlaylistInfo()`, `searchYouTube()`, `getHealth()`, `detectInstallMethod()`, `runAutomaticUpdate()`. The `translateYtDlpError` helper turns raw stderr into actionable messages for SABR, video-unavailable, private, age-restricted, members-only, and bot-challenge failures.

- **`DownloadManager`** (`download-manager.js`) — queue as `Map<id, item>` where items are songs or playlists with `children: []`. **Queue concurrency is hardcoded at `MAX_CONCURRENT_DOWNLOADS = 5`** at the top of the file — intentionally not user-configurable. Sized to YouTube's per-IP soft threshold combined with `--concurrent-fragments 4` and an authenticated cookie session. Exports `isPlaylistUrl(url)` used by both the manager and `ipc-handlers.js`: `/playlist?` → playlist, `/watch?` → song (regardless of `list=` mix parameters), standalone `?list=` → playlist. Emits `download:progress` / `download:complete` / `download:error` / `download:queue-update`. **Main is the source of truth for status — renderer must never override** (we hit a bug where forcing `status: 'complete'` on every complete event was masking real errors).

- **`CookieManager`** (`cookie-manager.js`) — reads cookies from the `persist:youtube-music` Electron session, converts to Netscape HTTP Cookie File format, writes to `userData/cookies.txt`, passes to yt-dlp via `--cookies`. Re-exported before every download from `ipc-handlers.js download:url`. The session is the single source of truth — login state in the embedded browser is automatically reflected in downloads.

- **`SettingsManager`** (`settings-manager.js`) — `electron-store` wrapper. v11+ is ESM-only. `concurrentDownloads` is **deliberately not in the schema** (queue concurrency is hardcoded; exposing it as a knob just lets users pick values that get them rate-limited). Default `downloadFolder` resolves to `app.getPath('music')` at construction, so the manager must be instantiated after `app.whenReady()`.

`main.js` also hosts the YT Music browser overlay IPC: `browser:open` / `:close` / `:resize` / `:back` / `:forward` / `:refresh` / `:get-url` / `:scrape-results`.

The WebContentsView is **created once and never destroyed** — `browser:close` only detaches it from `mainWindow.contentView` (tracked by `ytMusicViewAttached`). Leaving and returning to the browser tab preserves login session, page state, scroll position, and playback. `browser:get-url` lets the renderer resync its URL bar after re-attach since no navigation event fires on a simple re-attach.

`SCRAPE_RESULTS_SCRIPT` at the top of `main.js` is injected via `executeJavaScript` to walk `<ytmusic-responsive-list-item-renderer>` rows and return `{id, url, title, channel, duration, thumbnail}`. **DOM-fragile** — YT Music ships layout changes occasionally. The search-API path in `ipc-handlers.js ytmusic:search` (which runs `yt-dlp ytsearch5:<query> --flat-playlist --dump-single-json`) is the documented fallback when scraping returns empty.

`ipc-handlers.js` registers everything that doesn't touch `WebContentsView`: queue ops, settings, folder dialog, dependency check, health, auto-update, URL detect, search. Add new IPC there.

### Preload — `src/preload.js`

Single source of truth for the renderer ↔ main contract. Every channel exposed via `contextBridge` as `window.setengine`. `on*` event subscribers return an unsubscribe function — preserve this pattern when adding events so callers can clean up.

### Renderer — `src/renderer.js` + `src/renderer/*`

Vanilla JS, no framework. `App` (`renderer/app.js`) is a tiny page router: `PAGES` map → `new PageClass(this)` → `.render(container)`. Pages may implement `.destroy()` for teardown (`BrowserPage` uses this to disconnect its `ResizeObserver` and detach the WebContentsView).

Pages live in `renderer/pages/*` (`download`, `browser`, `queue`, `settings`). They build their DOM imperatively — no framework, no templates. Shared UI in `renderer/components/` (`modal.js`, `toast.js` with persistent-duration support, `search-picker.js`). Shared flows in `renderer/` root: `ytdlp-update.js` runs the auto-update sequence (used by both the startup outdated-yt-dlp modal in `app.js` and the Settings page UPDATE YT-DLP button).

`App.setupIpcListeners()` forwards realtime download events to the current page if it's the queue page. Pass `data` through unchanged — do not override `status`.

### The browser-view layering trick

`BrowserPage.openBrowser()` creates a placeholder `<div>`, measures it via `getBoundingClientRect()`, and ships the bounds to main so the native `WebContentsView` overlays exactly that region. A `ResizeObserver` keeps it in sync on window resize.

**Native `WebContentsView` always renders above DOM regardless of CSS z-index** (it's a separate OS-level compositing layer). Any modal that needs to be visible over the browser tab must collapse the WebContentsView to 0×0 first and restore from the placeholder rect on dismiss. `search-picker.js` does this via the `collapseBrowserView()` helper at the bottom of the file using the exported `resizeBrowser` IPC — copy that pattern for any new modal that appears over the browser tab.

### CSP

`index.html` Content-Security-Policy allows `img-src` from `i.ytimg.com`, `yt3.ggpht.com`, `lh3.googleusercontent.com` for picker thumbnails. New external image origins must be added there or they will be blocked silently.

### Build-time globals

`forge.config.js` uses the Forge Vite plugin with `name: 'main_window'`. Two globals are injected at build time into `src/main.js`:
- `MAIN_WINDOW_VITE_DEV_SERVER_URL` — set during `npm start`
- `MAIN_WINDOW_VITE_NAME` — set at package time

Both look undefined to a linter but are real, injected by Forge.

### Health & auto-update

`YtDlpWrapper.getHealth()` returns `{ version, outdated, recommendedMin, aria2c }`. `MIN_RECOMMENDED_YTDLP` constant at the top of `ytdlp-wrapper.js` — bump it as new SABR-class breakages emerge. The startup modal in `app.js checkYtDlpHealth` prompts when `outdated: true`; click-through runs `runYtdlpUpdateFlow()` in `renderer/ytdlp-update.js` which calls the `ytdlp:update` IPC.

`detectInstallMethod()` distinguishes Homebrew / pipx / pip / standalone via `brew list --versions yt-dlp` and shebang parsing of the binary file. `runAutomaticUpdate()` runs the matching command:
- Homebrew → `brew upgrade yt-dlp`
- pipx → `pipx upgrade yt-dlp`
- pip → `<detected python> -m pip install -U yt-dlp` with PEP 668 `--break-system-packages` retry
- Standalone → `yt-dlp -U`
- Missing → throws "install it first" error

The Settings page surfaces `yt-dlp <version>` and `Accelerator: aria2c (active)` / `Accelerator: built-in. Install aria2 for ~2× faster downloads` so users can see at a glance what's running.
