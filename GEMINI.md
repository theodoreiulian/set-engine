# GEMINI.md

This file provides guidance to Gemini (gemini.google.com) when working with code in this repository.

> **SYNC RULE:** This file is synced with CLAUDE.md and AGENTS.md. Any change to one must be applied to all three. Do not amend any of them without also updating the others.

## What this is

SetEngine is an Electron desktop app (macOS / Windows / Linux) that downloads songs, playlists, and albums as MP3s. The user **pastes a link** (YouTube / YouTube Music or Spotify) on the Download page and the download starts — there is no embedded browser. It wraps the system-installed `yt-dlp` (for YouTube) and `spotdl` (for Spotify) binaries; the link's source and shape (song vs. playlist/album) are auto-detected from the URL.

Downloads run **unauthenticated** — there is no sign-in surface, so only public content is reachable. (Auth-gated YouTube content such as private playlists or age-restricted videos will fail; Spotify never needed a session because `spotdl` resolves public metadata + a YouTube audio match.)

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
| yt-dlp  | **Yes**   | Downloads audio from YouTube |
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

`yt-dlp` and `ffmpeg` are **required system dependencies**. `aria2c` is optional but recommended (~2× faster downloads via multi-connection HTTP). `spotdl` is optional and only needed for Spotify links. All are auto-detected from `PATH`; if `aria2c` is present, yt-dlp downloads route through it.

`main.js` prepends `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` plus common pip/pipx/conda paths to `process.env.PATH` on startup (macOS/Linux). Without this, Electron processes launched from environments with a stripped PATH miss Homebrew/pip installs and detection incorrectly reports "not found". Keep this in mind when adding new external-binary dependencies.

The `yt-dlp-wrap` npm package is **not used** — `src/main/ytdlp-wrapper.js` spawns `yt-dlp` itself.

## Electron runtime — stock Electron

This app runs on **stock Electron** (`electron` from npm). It previously used the [Castlabs Electron](https://github.com/castlabs/electron-releases) fork for Widevine DRM, but that existed **solely** to play Spotify audio inside the (now removed) embedded browser. With downloads driven by pasted URLs there is no DRM requirement, so the fork was dropped — this also removed a recurring packaging failure (the `+wvcus` binary 404ing at package time). Do not reintroduce the Castlabs fork or a Widevine fuse.

## Architecture

Three-tier Electron split with strict process boundaries via `contextIsolation`:

### Main process — `src/main.js` + `src/main/*`

`main.js` wires the singletons, registers the `setengine-audio://` protocol, and delegates all IPC to `ipc-handlers.js`.

- **`YtDlpWrapper`** (`ytdlp-wrapper.js`) — the only module that spawns `yt-dlp`. Builds CLI args including `--extractor-args "youtube:player_client=default,web_safari,tv,mweb"` (SABR-resilient, cookie-compatible — `tv_simply` is deliberately *not* included because it gets skipped whenever `--cookies` is passed), `--concurrent-fragments 4`, and aria2c routing when available. Exposes `download()`, `getVideoInfo()`, `getPlaylistInfo()`, `getHealth()`, `detectInstallMethod()`, `runAutomaticUpdate()`. The `translateYtDlpError` helper turns raw stderr into actionable messages for SABR, video-unavailable, private, age-restricted, members-only, and bot-challenge failures.

- **`SpotdlWrapper`** (`spotdl-wrapper.js`) — the Spotify sibling of `YtDlpWrapper`. Same surface (`download` / `getHealth` / `detectInstallMethod` / `runAutomaticUpdate` / `getTrackInfo` / `getPlaylistInfo`) and the same EventEmitter shape on `download`, so `DownloadManager` doesn't branch on engine. `spotdl` resolves Spotify URLs to YouTube matches and downloads via yt-dlp/ffmpeg under the hood.

- **`DownloadManager`** (`download-manager.js`) — queue as `Map<id, item>` where items are songs or playlists with `children: []`. **Queue concurrency is hardcoded at `MAX_CONCURRENT_DOWNLOADS = 5`** at the top of the file — intentionally not user-configurable. Sized to YouTube's per-IP soft threshold combined with `--concurrent-fragments 4`. Picks the engine per item's `source` (`spotify` → spotdl, else yt-dlp). Exports `isPlaylistUrl(url)` and `normalizeWatchUrl(url)` (strips a `list=` param from `/watch` URLs so YT Music album pages download as a single track), both built on `classifyUrl` from `sources.js`. Emits `download:progress` / `download:complete` / `download:error` / `download:queue-update`. **Main is the source of truth for status — renderer must never override** (we hit a bug where forcing `status: 'complete'` on every complete event was masking real errors).

- **`SettingsManager`** (`settings-manager.js`) — `electron-store` wrapper. v11+ is ESM-only. `concurrentDownloads` is **deliberately not in the schema** (queue concurrency is hardcoded; exposing it as a knob just lets users pick values that get them rate-limited). Default `downloadFolder` resolves to `app.getPath('music')` at construction, so the manager must be instantiated after `app.whenReady()`.

There is **no embedded browser, no `WebContentsView`, no per-source Electron sessions, no `CookieManager`, and no DRM/Widevine init.** Downloads call the wrappers with `cookiePath = null`.

`src/main/sources.js` is now a small **URL-classification + registry** module: `classifyUrl(url)` returns `{ source: 'youtube-music'|'spotify', kind: 'track'|'playlist', id? }` (or null), used by both `DownloadManager` and the `url:classify` IPC. The `SOURCES` registry holds only `{ id, label, downloader }` per source.

`ipc-handlers.js` registers everything: queue ops (`download:url`, `:cancel`, `:retry`, `:queue`, `:clear`), settings, folder dialogs, dependency check, yt-dlp/spotdl health + auto-update, `url:classify`, and the Set Maker / Match / tagging handlers. `download:url` and `download:retry` pass `null` for cookies (unauthenticated). Add new IPC there.

`main.js` also hosts the `setengine-audio://` protocol handler used by the Set Maker / Match views. It serves local audio files with **proper HTTP Range support** so the audio element can seek (and so M4A files with a trailing `moov` atom load at all — see the long comment there). Access is restricted to files under the user's music / downloads / home directories.

### Preload — `src/preload.js`

Single source of truth for the renderer ↔ main contract. Every channel exposed via `contextBridge` as `window.setengine`. `on*` event subscribers return an unsubscribe function — preserve this pattern when adding events so callers can clean up. `classifyURL(url)` lets the Download page validate/identify a pasted link before queueing.

### Renderer — `src/renderer.js` + `src/renderer/*`

Vanilla JS, no framework. `App` (`renderer/app.js`) is a tiny page router: `PAGES` map → `new PageClass(this)` → `.render(container)`. Pages may implement `.destroy()` for teardown.

Pages live in `renderer/pages/*` (`download`, `queue`, `match`, `setmaker`, `settings`). They build their DOM imperatively — no framework, no templates. Shared UI in `renderer/components/` (`modal.js`, `toast.js` with persistent-duration support). Shared flows in `renderer/` root: `tool-update.js` runs the parameterized auto-update sequence (`runYtdlpUpdateFlow` / `runSpotdlUpdateFlow`, both built on `runToolUpdateFlow`), used by both the startup outdated-yt-dlp modal in `app.js` and the Settings page UPDATE buttons.

`App.setupIpcListeners()` forwards realtime download events to the current page if it's the queue page. Pass `data` through unchanged — do not override `status`.

### The Download page — `renderer/pages/download.js`

The app's landing page. A single text box takes any YouTube / YouTube Music or Spotify link (song, playlist, or album); pressing Enter or clicking DOWNLOAD classifies it via `classifyURL`, rejects unrecognized links, runs a just-in-time check that `spotdl` is installed for Spotify links, then calls `downloadURL`. The **destination folder lives on this page** (a `.folder-display` with a BROWSE button) so there's no need to open Settings to change it — BROWSE persists `downloadFolder` to the settings store. After queueing, the input clears for the next paste; a button jumps to the Queue.

### CSP

`index.html` Content-Security-Policy is minimal: `img-src 'self' data:` and `media-src 'self' blob: setengine-audio:` (the latter for local audio playback). There are no remote image/script origins — if a future feature needs to load remote images, add the origin here or it will be blocked silently.

### Build-time globals

`forge.config.js` uses the Forge Vite plugin with `name: 'main_window'`. Two globals are injected at build time into `src/main.js`:
- `MAIN_WINDOW_VITE_DEV_SERVER_URL` — set during `npm start`
- `MAIN_WINDOW_VITE_NAME` — set at package time

Both look undefined to a linter but are real, injected by Forge.

### Health & auto-update

`YtDlpWrapper.getHealth()` returns `{ version, outdated, recommendedMin, aria2c }`. `MIN_RECOMMENDED_YTDLP` constant at the top of `ytdlp-wrapper.js` — bump it as new SABR-class breakages emerge. The startup modal in `app.js checkYtDlpHealth` prompts when `outdated: true`; click-through runs `runYtdlpUpdateFlow()` in `renderer/tool-update.js` which calls the `ytdlp:update` IPC. `SpotdlWrapper` mirrors this (`MIN_RECOMMENDED_SPOTDL`, `spotdl:health` / `spotdl:update`), surfaced on the Settings page and via the Download page's just-in-time check rather than a startup nag.

`detectInstallMethod()` distinguishes Homebrew / pipx / pip / standalone via `brew list --versions` and shebang parsing of the binary file. `runAutomaticUpdate()` runs the matching command:
- Homebrew → `brew upgrade <tool>`
- pipx → `pipx upgrade <tool>`
- pip → `<detected python> -m pip install -U <tool>` with PEP 668 `--break-system-packages` retry
- Standalone → `yt-dlp -U` (yt-dlp only; spotdl standalone has no self-update)
- Missing → throws "install it first" error

The Settings page surfaces `yt-dlp <version>`, `spotdl <version>`, and `Accelerator: aria2c (active)` / `Accelerator: built-in. Install aria2 for ~2× faster downloads` so users can see at a glance what's running. The destination folder is **not** in Settings — it lives on the Download page.
