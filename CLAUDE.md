# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

> **SYNC RULE:** This file is synced with AGENTS.md and GEMINI.md. Any change to one must be applied to all three. Do not amend any of them without also updating the others.

## What this is

SetEngine is an Electron desktop app (macOS / Windows / Linux) built **for DJs**. It does four things:

1. **Download** — paste a YouTube / YouTube Music or Spotify link (song, playlist, or album) and it downloads MP3s. There is **no embedded browser**; the link's source and shape are auto-detected from the URL.
2. **Set Extraction** — paste a YouTube DJ-set link and it fingerprint-identifies the tracks played, lists them in play order, and lets you download each (or the whole set + an `.m3u`).
3. **Set Maker** — analyze a folder of local audio (offline BPM + key detection), rate tracks, and build a harmonically-ordered setlist; import/export `.m3u`.
4. **Match Maker (TuneMatch)** — import a local library and get harmonic-mixing match suggestions for any selected track; detect + write missing BPM/key tags.

It wraps the system-installed `yt-dlp` (YouTube) and `spotdl` (Spotify) binaries; `ffmpeg` does the audio conversion. Downloads run **unauthenticated** — there is no sign-in surface, so only public content is reachable. (Auth-gated YouTube content such as private playlists or age-restricted videos will fail; Spotify never needed a session because `spotdl` resolves public metadata + a YouTube audio match.)

## Getting Started (first-time setup)

```bash
# macOS / Linux — one command
npm run setup
# or: ./scripts/setup.sh

# Windows — one command
.\scripts\setup.ps1
```

The setup script checks for Node.js, installs npm dependencies, and verifies the
system tools SetEngine needs. It prints copy-pasteable install commands for
anything missing:

| Tool    | Required? | Purpose |
|---------|-----------|---------|
| yt-dlp  | **Yes**   | Downloads audio from YouTube |
| ffmpeg  | **Yes**   | Converts downloaded audio to MP3; decodes audio for BPM/key analysis |
| aria2c  | Optional  | ~2× faster downloads (multi-connection HTTP) |
| spotdl  | Optional  | Downloads from Spotify |

Once all required tools are green, run `npm start` to launch the dev build.

## Commands

Build / run is driven entirely by Electron Forge + the Vite plugin:

- `npm start` — Electron Forge dev: starts the Vite dev server, builds main + preload, launches Electron. Renderer changes hot-reload; **main-process changes need a full restart.**
- `npm run package` — produce an unpacked app in `out/`
- `npm run make` — installers per `forge.config.js` (Squirrel/Windows, zip/macOS, deb/rpm/Linux)
- `npm run publish` — Forge publish targets
- `npm run lint` — currently a no-op (`echo "No linting configured"`)

There is **no test framework** and no linter. The only mechanical check available is `node --check <file>` for syntax. Pure-logic modules (e.g. `set-maker.js`, `track-match.js`) are written as side-effect-free ESM so they can be exercised from a scratch script.

## Tech stack & build

- **Stock Electron** (`electron` ^42 from npm) — see "Electron runtime" below.
- **Electron Forge** (`@electron-forge/cli` ^7) with the **Vite plugin**. Three Vite builds: `src/main.js` (main), `src/preload.js` (preload), and the `main_window` renderer, configured by `vite.main.config.mjs` / `vite.preload.config.mjs` / `vite.renderer.config.mjs`. `package.json` `main` points at the built `.vite/build/main.js`.
- **Source is ESM** (`import`/`export`), compiled by Vite. Build config files (`forge.config.js`) are CommonJS; Vite configs are `.mjs`. `package.json` has no `"type": "module"` — don't rely on it; the Vite builds handle module format.
- **Runtime dependencies are deliberately few:** `electron-store` (settings; v11+ is ESM-only), `node-id3` (MP3 tag read/write), `p-limit` (concurrency caps), `electron-squirrel-startup` (Windows installer shortcut handling). Everything else (DSP, fingerprint signing, matching) is hand-rolled to avoid heavy/native deps.
- **Forge fuses** (`forge.config.js`): `RunAsNode` off, `OnlyLoadAppFromAsar` on, ASAR integrity validation on, cookie encryption on, Node CLI inspect/`NODE_OPTIONS` off. No Widevine fuse.

## External binaries — not bundled

`yt-dlp` and `ffmpeg` are **required system dependencies**. `aria2c` is optional but recommended (~2× faster downloads via multi-connection HTTP). `spotdl` is optional and only needed for Spotify links. All are auto-detected from `PATH`; if `aria2c` is present, yt-dlp downloads route through it.

`main.js` prepends `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` plus common pip/pipx/conda paths to `process.env.PATH` on startup (macOS/Linux). Without this, Electron processes launched from environments with a stripped PATH miss Homebrew/pip installs and detection incorrectly reports "not found". Keep this in mind when adding new external-binary dependencies.

The `yt-dlp-wrap` npm package is **not used** — `src/main/ytdlp-wrapper.js` spawns `yt-dlp` itself.

## Electron runtime — stock Electron

This app runs on **stock Electron**. It previously used the [Castlabs Electron](https://github.com/castlabs/electron-releases) fork for Widevine DRM, but that existed **solely** to play Spotify audio inside the (now removed) embedded browser. With downloads driven by pasted URLs there is no DRM requirement, so the fork was dropped — this also removed a recurring packaging failure (the `+wvcus` binary 404ing at package time). **Do not reintroduce the Castlabs fork or a Widevine fuse.**

`main.js` also sets `use-mock-keychain` + `password-store=basic` (so macOS doesn't prompt for keychain access — nothing sensitive is persisted) and, because the mock keychain can hang on graceful quit, the `before-quit` handler force-exits via `app.exit(0)` **after** killing child processes.

## Architecture

Three-tier Electron split with strict process boundaries via `contextIsolation`. **There is no embedded browser, no `WebContentsView`, no per-source Electron sessions, no `CookieManager`, and no DRM/Widevine init.** Downloads call the wrappers with `cookiePath = null`.

### Main process — `src/main.js` + `src/main/*`

`main.js` shims PATH, registers two custom schemes as privileged, wires the singletons, installs the protocol handlers, and delegates all IPC to `ipc-handlers.js`. The managers are constructed in `createWindow()` (after `app.whenReady()`), so anything that reads `app.getPath(...)` at construction is safe.

**Binary wrappers**

- **`YtDlpWrapper`** (`ytdlp-wrapper.js`) — the only module that spawns `yt-dlp`. Builds CLI args including `--extractor-args "youtube:player_client=default,web_safari,tv,mweb"` (SABR-resilient, cookie-compatible — `tv_simply` is deliberately *not* included because it gets skipped whenever `--cookies` is passed), `--concurrent-fragments 4`, and aria2c routing when available. Surface: `download()` (returns an EventEmitter: `progress` / `complete` / `error`, plus `cancel()`), `getVideoInfo()`, `getPlaylistInfo()`, `getAudioStreamUrl(query)`, `searchMusic(query, limit)` (YouTube **Music** search), `searchYouTube(query, limit)` (general search), `getHealth()`, `checkDependencies()`, `detectInstallMethod()`, `runAutomaticUpdate()`, `killAll()`. `_flatSearch()` is the shared `--flat-playlist --dump-json` engine behind the two search methods (20 s timeout, resolves `[]` on any failure, filters out non-`Youtube` `ie_key` entries). `translateYtDlpError` turns raw stderr into actionable messages for SABR, video-unavailable, private, age-restricted, members-only, and bot-challenge failures.

- **`SpotdlWrapper`** (`spotdl-wrapper.js`) — the Spotify sibling of `YtDlpWrapper`. Same surface (`download` / `getHealth` / `detectInstallMethod` / `runAutomaticUpdate` / `getTrackInfo` / `getPlaylistInfo`) and the same EventEmitter shape on `download`, so `DownloadManager` doesn't branch on engine. `spotdl` resolves Spotify URLs to YouTube matches and downloads via yt-dlp/ffmpeg under the hood.

- **`filename-template.js`** — `sanitizeFilenameTemplate()` is shared by **both** wrappers so the same yt-dlp-style template (e.g. `%(artist)s - %(title)s`) produces identical, path-safe filenames. It preserves spaces/hyphens/commas/brackets but strips directory separators, `..`, and OS-illegal characters.

**Download queue**

- **`DownloadManager`** (`download-manager.js`) — queue as `Map<id, item>` where items are songs or playlists with `children: []`. **Queue concurrency is hardcoded at `MAX_CONCURRENT_DOWNLOADS = 5`** (sized to YouTube's per-IP soft threshold combined with `--concurrent-fragments 4`) — intentionally not user-configurable. Picks the engine per item's `source` (`spotify` → spotdl, else yt-dlp). Exports `isPlaylistUrl(url)` and `normalizeWatchUrl(url)` (strips a `list=` param from `/watch` URLs so YT Music album pages download as a single track), both built on `classifyUrl` from `sources.js`. Emits `download:progress` / `download:complete` / `download:error` / `download:queue-update`. **Main is the source of truth for status — the renderer must never override it** (we hit a bug where forcing `status: 'complete'` on every complete event masked real errors). The sanitized item carries per-item percent as **`progress`** (not `percent`).

**Set Extraction (the job system)**

- **`ExtractionJobManager`** (`extraction-manager.js`) — the source of truth for DJ-set extraction, modeled on `DownloadManager`. State is `jobs = Map<id, job>`; up to `MAX_CONCURRENT_EXTRACTIONS = 3` run at once via `pLimit(3)`, extras sit in `queued`. Each job owns a **private cache directory** `userData/ExtractionCache/<id>`. Surface: `addJob(url)` (validates via `classifyUrl`, fire-and-forgets `_run` through the limiter, returns `{ success, id }` immediately), `cancelJob(id)`, `deleteJob(id)` (cancels if running, then `rm`s the job's cache dir — this is the per-job song-cache deletion), `recordTrackDownloads(jobId, entries)`, `getJobs()`, `abortAll()`. Broadcasts `extract:jobs-update` (full sanitized list, structural changes) and `extract:job-progress` (one job, phase/percent ticks). **Job shape:** `{ id, url, title, status: 'queued'|'running'|'done'|'error'|'cancelled', phase, percent, tracks, engine, info, error, createdAt, cacheDir, trackDownloads, _abort }` (`_abort` is an `AbortController`, stripped before broadcast). **Jobs are in-memory and NOT persisted across restart** — `main.js` wipes the whole `ExtractionCache` root at boot (every on-disk subdir is then orphaned), and `before-quit` calls `abortAll()`.

- **`set-extractor.js`** — `extractSet(url, { ytDlp, settings, signal, onProgress, cacheDir })` is the per-job pipeline the manager runs: read info → download the set audio at 128 kbps to a temp dir → hand the file to the selected recognizer → `dedupeTracks` (merge consecutive duplicate hits, reusing `cleanTitle` / `primaryArtist` from `bpm-sources.js`) → cache each track's download (at `settings.audioQuality`) into the job's `cacheDir`, keyed by `md5(identityKey(artist,title))`, resolving a YouTube URL via `resolveBestVideoUrl`. **Requires `cacheDir`** (throws otherwise) and never wipes it — the cache is owned by the job (`deleteJob` / boot cleanup handle it). Only the scratch temp dir is cleaned in `finally`. Cancellable via the `AbortSignal`.

- **Recognizers** (`recognizers/`): `index.js` `getRecognizer(settings)` returns the **AudD** (`audd.js` — one enterprise-endpoint whole-file upload → timestamped tracks) or **ACRCloud** (`acrcloud.js` — ffmpeg-cut 12 s windows at 50% overlap, each identified with an HMAC-SHA1-signed request, with an explicit `AcrAuthError` for 401/403 + auth codes so credential failures don't masquerade as "no tracks") implementation, throwing a clear error if the engine's key is missing. `retry.js` provides `backoff` / `parseRetryAfter`; `util.js` provides the shared `minConfidenceOf(settings)`. **All recognition HTTP runs in the main process**, so the renderer CSP is unaffected. No engine recognizes *every* track (unreleased IDs, bootlegs, mashups, heavy effects defeat all of them) — the UI says so.

- **`track-match.js`** — `resolveBestVideoUrl(ytDlp, query, title, artist)` turns a recognized "Artist Title" into a concrete YouTube watch URL. It searches **YouTube Music first** (catalog songs, not reactions/mixes), then general YouTube as fallback, gated both ways by a strict title-containment check (`normalizeForMatch` strips bracketed/dash mix-edit noise and is Unicode-aware so non-Latin/accented titles aren't blanked). Known artist breaks ties between multiple title-passing candidates; returns `null` when nothing confident matches (caller then **skips** rather than download a wrong file). Used by the extraction cache, `download:track`, and `download:tracks`.

**Offline analysis & tagging (Set Maker / Match Maker)**

- **`audio-analyzer.js`** — spawns `ffmpeg` to decode a file to mono Float32 PCM @ 22.05 kHz, then computes band balance (bass/mid/high), spectral brightness, and intro/outro length from an RMS-envelope walk. No WASM/native analysis lib.
- **`key-bpm-detector.js`** — fully-offline BPM + musical key estimation from the same decoded PCM: dual-band onset envelope → autocorrelation × comb-filter tempogram for tempo (returns candidate metrical levels), tuned chromagram → Krumhansl–Kessler correlation for key (Camelot + name). Shares the `dsp.js` FFT/Hann helpers.
- **`dsp.js`** — size-parameterized FFT + Hann window, used by the analyzer and detector.
- **`bpm-sources.js`** — free, keyless **Deezer** cross-check for detected BPM (`lookupBpm`, fail-soft) plus `reconcileBpm` consensus logic that resolves octave/half-time errors; also exports the `cleanTitle` / `primaryArtist` text helpers reused by Set Extraction. The cross-check **always runs** (no longer user-toggleable).
- **`set-maker.js`** — pure, IPC-free harmonic-mixing algorithm: Camelot key distance, half/double-time-aware BPM distance, move-type scoring, and a 2-opt tour optimizer. `buildSet(tracks, opts)` orders a library; `rescoreTour(tracks)` recomputes transitions after a manual edit.
- **`rating-writer.js`** — `writeRating` / `readRating` (MP3 ID3v2 POPM byte **and** a `[★★★★]` COMM marker so Serato shows it; native comment field via ffmpeg remux for M4A/FLAC/OGG/Opus/AAC) and `writeBpmKey` (writes detected BPM/key back into the file's tags).

**Settings, sources, streaming**

- **`SettingsManager`** (`settings-manager.js`) — `electron-store` wrapper (v11+ ESM-only). `concurrentDownloads` is **deliberately not in the schema** (queue concurrency is hardcoded; exposing it just lets users pick rate-limiting values). Default `downloadFolder` resolves to `app.getPath('music')` at construction. Credential fields (`auddApiToken`, `acrHost`, `acrAccessKey`, `acrAccessSecret`) are **trimmed on write** (`_normalize`) — a pasted trailing space would otherwise silently 401 every recognition. See "Settings keys" below for the full schema.
- **`sources.js`** — URL-classification + registry. `classifyUrl(url)` returns `{ source: 'youtube-music'|'spotify', kind: 'track'|'playlist', id? }` (or `null`), used by `DownloadManager`, `ExtractionJobManager`, and the `url:classify` IPC. The `SOURCES` registry holds `{ id, label, downloader }` per source.
- **`stream-resolver.js`** — `handleStreamRequest(req, ytDlp)` backs the `setengine-stream://` protocol: it base64url-decodes a search query, resolves it to a direct YouTube audio URL via `ytDlp.getAudioStreamUrl()` (50-minute in-memory cache), and proxies the bytes with Range support — for previewing remote audio without downloading.

**IPC** — `ipc-handlers.js` registers everything (see "IPC channel reference" below). `download:url`, `download:retry`, `download:track`, and `download:tracks` pass `null` for cookies (unauthenticated). `safeOutputDir()` there normalizes a renderer-supplied destination folder (expands `~`, requires an absolute path, else `null` → caller falls back to the configured folder). **Add new IPC here**, and expose it through the preload bridge.

### Preload — `src/preload.js`

Single source of truth for the renderer ↔ main contract. Every channel is exposed via `contextBridge` as `window.setengine`. **`on*` event subscribers return an unsubscribe function** — preserve this pattern when adding events so callers can clean up. Examples: `classifyURL(url)` validates a pasted link before queueing; `getExtractionJobs()` + `onExtractJobsUpdate` / `onExtractJobProgress` drive the Set Extraction page.

### Renderer — `src/renderer.js` + `src/renderer/*`

Vanilla JS, no framework, imperative DOM (no templates). `src/renderer.js` imports the global stylesheet and boots `App`. `App` (`renderer/app.js`) is a tiny page router: `PAGES` map → `new PageClass(this)` → `.render(container)`; pages may implement `.destroy()` for teardown, and stash state on the `app` singleton (e.g. `app.matchState`, `app.setMakerState`, `app.extractState`) so navigating away and back is cheap. `App.setupIpcListeners()` forwards realtime **download** events to the current page **only when it's the queue page** — pass `data` through unchanged, never override `status`.

**Pages** (`renderer/pages/*`):
- **`download.js`** — the landing page. One text box takes any YouTube / YouTube Music or Spotify link; Enter or DOWNLOAD classifies it via `classifyURL`, rejects unrecognized links, runs a just-in-time check that `spotdl` is installed for Spotify links, then calls `downloadURL`. The **destination folder lives on this page** (`.folder-display` + BROWSE, which persists `downloadFolder`). Input clears after queueing; a button jumps to the Queue.
- **`queue.js`** — the download queue: per-item status badges (queued/downloading/complete/error/cancelled), a source badge (YT / SPOTIFY), playlist children, cancel/retry/clear. Driven by `download:queue-update` + the per-item events.
- **`extract.js`** — **Set Extraction, as a job list + detail.** The list view has the URL box + EXTRACT (start several; they run in parallel) and one card per job (status dot, live phase/percent, delete ✕). Clicking a card opens the detail (tracklist, destination folder, per-track play/download, DOWNLOAD WHOLE SET → writes the files + an `.m3u`). Main is the source of truth: the page mirrors `getExtractionJobs()` and patches from `onExtractJobsUpdate` / `onExtractJobProgress`. **Navigating away does NOT cancel a job** — `destroy()` only unsubscribes, tears down audio, and stashes `{ view, selectedJobId, folderPath }`. Per-track downloads pass `jobId` + `trackIndex` so the ✔/progress state (stored on the job's `trackDownloads`) survives navigating off and back.
- **`setmaker.js`** — **Set Maker**, three views in one page (library / rate / setlist): analyze a folder of local audio (BPM/key), star-rate tracks, then build a harmonically-ordered setlist via `setmaker:build`; import/export `.m3u`. Missing BPM/key can be detected and written back (`tags:detect-and-tag`).
- **`match.js`** — **Match Maker (TuneMatch)**: import a local library, pick a track, and get harmonic-mixing match suggestions filtered by a BPM threshold; dedupe; detect + write missing BPM/key tags for path-bearing imports.
- **`settings.js`** — engine choice + recognizer keys, audio quality, filename template, `recognizerMinConfidence`, and the yt-dlp / spotdl version + accelerator readout. The destination folder is **not** here — it lives on the Download page.

**Shared renderer code:**
- `renderer/pages/tunematch/engine.js` + `metadata.js` — Camelot/key math + audio-tag metadata parsing, shared by Match Maker and Set Maker.
- `renderer/components/` — `modal.js`, `toast.js` (supports persistent durations).
- `renderer/utils/escape-html.js` — shared HTML escaper (a few pages still define a local copy).
- `renderer/tool-update.js` — `runYtdlpUpdateFlow` / `runSpotdlUpdateFlow` (both built on `runToolUpdateFlow`), used by the startup outdated-yt-dlp modal in `app.js` and the Settings UPDATE buttons.
- `renderer/styles/` — `index.css` (global) plus page styles `extract.css`, `match.css`, `setmaker.css`.

### Custom protocols (`main.js`)

Both schemes are registered privileged (`standard`, `secure`, `stream`, `supportFetchAPI`) before `app.whenReady`, and both appear in the CSP `media-src`:

- **`setengine-audio://local/<base64url path>`** — serves a **local** audio file with proper HTTP **Range** support (so the audio element can seek, and so M4A files with a trailing `moov` atom load at all — see the long comment there). Access is restricted to files under the user's music / downloads / home directories. Used for previewing cached/extracted/library tracks (Set Extraction, Set Maker, Match Maker). Note the per-job extraction cache lives under `userData`, which is itself under the home dir, so it passes the safe-dir check.
- **`setengine-stream://<base64url query>`** — proxies a yt-dlp-resolved **remote** YouTube audio stream (via `stream-resolver.js`) for preview without downloading.

### CSP

`index.html` Content-Security-Policy: `default-src 'self'`, `script-src 'self'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`, `font-src https://fonts.gstatic.com`, `media-src 'self' blob: setengine-audio: setengine-stream:`. The only remote origins are Google Fonts. **If a future feature needs to load remote images/scripts, add the origin here or it will be blocked silently.** All recognizer/Deezer HTTP runs in the main process, so it is exempt from this CSP.

### Build-time globals

The Forge Vite plugin uses `name: 'main_window'`. Two globals are injected at build time into `src/main.js`:
- `MAIN_WINDOW_VITE_DEV_SERVER_URL` — set during `npm start`
- `MAIN_WINDOW_VITE_NAME` — set at package time

Both look undefined to a linter but are real, injected by Forge.

## Settings keys

`electron-store` schema (in `settings-manager.js`). Defaults in parentheses:

| Key | Type | Notes |
|-----|------|-------|
| `downloadFolder` | string | Defaults to `app.getPath('music')`. Changed from the Download page. |
| `audioQuality` | number | `128` \| `192` \| `320` kbps (320). |
| `filenameTemplate` | string | yt-dlp-style (`%(title)s`). |
| `showDisclaimer` | boolean | (true) First-launch disclaimer. |
| `extractionBetaAck` | boolean | (false) Set when the user dismisses the one-time Set Extraction beta/accuracy warning (shown on first open of the page). |
| `recognizer` | string | `'audd'` \| `'acrcloud'` (audd). |
| `auddApiToken` | string | AudD enterprise token (trimmed on write). |
| `acrHost` / `acrAccessKey` / `acrAccessSecret` | string | ACRCloud project creds (trimmed on write). |
| `recognizerMinConfidence` | number | 0–100 (60). Thresholds ACRCloud's per-match score; **no-op for AudD** (which often returns no score). |

## IPC channel reference

All registered in `ipc-handlers.js`, all exposed via `preload.js`. `on*` subscribers return an unsubscribe fn.

- **Downloads:** `download:url`, `download:cancel`, `download:retry`, `download:queue`, `download:clear`. Events: `download:progress`, `download:complete`, `download:error`, `download:queue-update`.
- **Settings & dialogs:** `settings:get`, `settings:save`, `dialog:select-folder`, `dialog:select-folders`, `dialog:select-audio-files`.
- **URL / deps / health:** `url:classify`, `deps:check`, `ytdlp:health`, `ytdlp:update`, `spotdl:health`, `spotdl:update`, `app:open-external`.
- **Set Maker / tagging:** `setmaker:build`, `setmaker:rescore-tour`, `setmaker:analyze-one`, `setmaker:analyze-batch` (event `setmaker:analysis-progress`), `setmaker:rate`, `setmaker:read-rating`, `setmaker:import-m3u`, `setmaker:export-m3u`, `tags:detect-and-tag` (event `tags:progress`).
- **Match Maker:** `match:scan-folders`, `match:read-file`.
- **Set Extraction:** `extract:start` (add job), `extract:cancel` (by id), `extract:delete` (by id), `extract:jobs` (list). Events: `extract:jobs-update`, `extract:job-progress`. Track downloads from a job: `download:track`, `download:tracks` (accept `jobId` + `trackIndex` to record state on the job).

## Health & auto-update

`YtDlpWrapper.getHealth()` returns `{ version, outdated, recommendedMin, aria2c }`. `MIN_RECOMMENDED_YTDLP` (currently `2025.09.05`) is a constant at the top of `ytdlp-wrapper.js` — **bump it as new SABR-class breakages emerge.** The startup modal in `app.js checkYtDlpHealth` prompts when `outdated: true`; click-through runs `runYtdlpUpdateFlow()` (`renderer/tool-update.js`) → `ytdlp:update` IPC. `SpotdlWrapper` mirrors this (`MIN_RECOMMENDED_SPOTDL`, `spotdl:health` / `spotdl:update`), surfaced on Settings and via the Download page's just-in-time check rather than a startup nag.

`detectInstallMethod()` distinguishes Homebrew / pipx / pip / standalone via `brew list --versions` and shebang parsing of the binary. `runAutomaticUpdate()` runs the matching command:
- Homebrew → `brew upgrade <tool>`
- pipx → `pipx upgrade <tool>`
- pip → `<detected python> -m pip install -U <tool>` (with PEP 668 `--break-system-packages` retry)
- Standalone → `yt-dlp -U` (yt-dlp only; spotdl standalone has no self-update)
- Missing → throws an "install it first" error

The Settings page shows `yt-dlp <version>`, `spotdl <version>`, and `Accelerator: aria2c (active)` / `Accelerator: built-in. Install aria2 for ~2× faster downloads`.

## Conventions & gotchas

- **Main is the source of truth.** `DownloadManager` and `ExtractionJobManager` own state and broadcast it; the renderer mirrors and patches, never overrides `status`. Forcing renderer-side status has masked real errors before.
- **Main-process changes need a full `npm start` restart** (renderer hot-reloads).
- **Sanitized download items carry percent as `progress`, not `percent`.** Reading the wrong field pins rows at 0%.
- **Preload `on*` must return an unsubscribe fn**, and pages must call them in `destroy()`.
- **Per-track download state uses sentinels:** `copied-<i>` (served from cache) and `skipped-<i>` (no confident match). For Set Extraction these live on the job's `trackDownloads` map in main; real download ids resolve against the live download queue.
- **`resolveBestVideoUrl` returns `null` to mean "skip"** — never substitute a guessed URL; a wrong file is worse than a missing one.
- **When adding a source:** add a `sources.js` entry + wrapper module + `DownloadManager` wiring (it already dispatches on `item.source`).
- **When adding IPC:** register in `ipc-handlers.js` **and** expose in `preload.js`; if it's an event, return an unsubscribe fn.
- **Adding a remote origin** (image/script/font) requires editing the CSP in `index.html`.
