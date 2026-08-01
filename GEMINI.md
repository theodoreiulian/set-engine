# GEMINI.md

This file provides guidance to Gemini (gemini.google.com) when working with code in this repository.

> **SYNC RULE:** This file is synced with CLAUDE.md and AGENTS.md. Any change to one must be applied to all three. Do not amend any of them without also updating the others.

## What this is

SetEngine is an Electron desktop app (macOS / Windows / Linux) built **for DJs**. It does five things:

1. **Download** — paste a YouTube / YouTube Music or Spotify link (song, playlist, or album) and it downloads MP3s. There is **no embedded browser**; the link's source and shape are auto-detected from the URL.
2. **Set Extraction** — paste a YouTube DJ-set link and it produces the tracklist, then lets you download each track (or the whole set). It uses the uploader's published tracklist when there is one, and otherwise identifies tracks from the audio via Shazam. **There is no engine choice and no API key anywhere in the app** — see "Song recognition" below.
3. **Set Maker** — analyze a folder of local audio (offline BPM + key detection), rate tracks, and build a harmonically-ordered setlist; import/export `.m3u`.
4. **Match Maker (TuneMatch)** — import a local library and get harmonic-mixing match suggestions for any selected track; detect + write missing BPM/key tags.
5. **Crate Sorter** — load one or more folders of local audio, pick destination folders ("crates"), then work through every track in alphabetical (filename) order with a seekable player and keyboard shortcuts, copying each into the crates you choose. Non-destructive (originals are never moved/deleted); no recognition or network needed.

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

`yt-dlp` and `ffmpeg` are **required system dependencies**. `aria2c` is optional but recommended (~2× faster downloads via multi-connection HTTP). `spotdl` is optional and only needed for Spotify links. All are auto-detected from `PATH`; if `aria2c` is present, yt-dlp downloads route through it, falling back automatically to the built-in downloader when aria2c fails (see `YtDlpWrapper` below).

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

  **aria2c failures self-heal.** YouTube intermittently serves media URLs that aria2c can't handle — its range requests come back with a response it refuses to parse, surfacing as the opaque `aria2c exited with code 22`. It is video-specific, not universal (most videos download fine with identical args). Since aria2c is *only* a speed optimization, `download()` catches any `aria2c exited with code …` failure and transparently retries that track with yt-dlp's built-in downloader; after two such failures aria2c is disabled for the rest of the session. Note that classification reads **`err.stderr`, not `err.message`** — `translateYtDlpError` rewrites the message for humans, which erases the string the check needs (this was a real bug: matching on the message silently disabled the whole fallback).

- **`SpotdlWrapper`** (`spotdl-wrapper.js`) — the Spotify sibling of `YtDlpWrapper`. Same surface (`download` / `getHealth` / `detectInstallMethod` / `runAutomaticUpdate` / `getTrackInfo` / `getPlaylistInfo`) and the same EventEmitter shape on `download`, so `DownloadManager` doesn't branch on engine. `spotdl` resolves Spotify URLs to YouTube matches and downloads via yt-dlp/ffmpeg under the hood.

- **`filename-template.js`** — `sanitizeFilenameTemplate()` is shared by **both** wrappers so the same yt-dlp-style template (e.g. `%(artist)s - %(title)s`) produces identical, path-safe filenames. It preserves spaces/hyphens/commas/brackets but strips directory separators, `..`, and OS-illegal characters.

**Download queue**

- **`DownloadManager`** (`download-manager.js`) — queue as `Map<id, item>` where items are songs or playlists with `children: []`. **Queue concurrency is hardcoded at `MAX_CONCURRENT_DOWNLOADS = 5`** (sized to YouTube's per-IP soft threshold combined with `--concurrent-fragments 4`) — intentionally not user-configurable. Picks the engine per item's `source` (`spotify` → spotdl, else yt-dlp). Exports `isPlaylistUrl(url)` and `normalizeWatchUrl(url)` (strips a `list=` param from `/watch` URLs so YT Music album pages download as a single track), both built on `classifyUrl` from `sources.js`. Emits `download:progress` / `download:complete` / `download:error` / `download:queue-update`. **Main is the source of truth for status — the renderer must never override it** (we hit a bug where forcing `status: 'complete'` on every complete event masked real errors). The sanitized item carries per-item percent as **`progress`** (not `percent`).

**Set Extraction (the job system)**

- **`ExtractionJobManager`** (`extraction-manager.js`) — the source of truth for DJ-set extraction, modeled on `DownloadManager`. State is `jobs = Map<id, job>`; up to `MAX_CONCURRENT_EXTRACTIONS = 3` run at once via `pLimit(3)`, extras sit in `queued`. Each job owns a **private cache directory** `userData/ExtractionCache/<id>`. Surface: `addJob(url)` (validates via `classifyUrl`, fire-and-forgets `_run` through the limiter, returns `{ success, id }` immediately), `cancelJob(id)`, `deleteJob(id)` (cancels if running, then `rm`s the job's cache dir — this is the per-job song-cache deletion), `recordTrackDownloads(jobId, entries)`, `getJobs()`, `abortAll()`. Broadcasts `extract:jobs-update` (full sanitized list, structural changes) and `extract:job-progress` (one job, phase/percent ticks). **Job shape:** `{ id, url, title, status: 'queued'|'running'|'done'|'error'|'cancelled', phase, percent, tracks, engine, info, error, createdAt, cacheDir, trackDownloads, _abort }` (`_abort` is an `AbortController`, stripped before broadcast). **Jobs are in-memory and NOT persisted across restart** — `main.js` wipes the whole `ExtractionCache` root at boot (every on-disk subdir is then orphaned), and `before-quit` calls `abortAll()`.

- **`set-extractor.js`** — `extractSet(url, { ytDlp, settings, signal, onProgress, cacheDir })` is the per-job pipeline the manager runs: read info → download the set audio at 128 kbps to a temp dir → hand the file to the selected recognizer → `dedupeTracks` (merge consecutive duplicate hits, reusing `cleanTitle` / `primaryArtist` from `bpm-sources.js`) → cache each track's download (at `settings.audioQuality`) into the job's `cacheDir`, keyed by `md5(identityKey(artist,title))`, resolving a YouTube URL via `resolveBestVideoUrl`. **Requires `cacheDir`** (throws otherwise) and never wipes it — the cache is owned by the job (`deleteJob` / boot cleanup handle it). Only the scratch temp dir is cleaned in `finally`. Cancellable via the `AbortSignal`.

- **No recognizer factory, and no `recognizers/` directory.** There is exactly one engine, so `set-extractor.js` imports `shazam/recognize.js` directly. AudD and ACRCloud were removed wholesale — along with `getRecognizer()`, the engine picker, `retry.js`, `util.js`, every credential setting, and the `app:open-external` IPC that existed only to open their dashboards. **Do not reintroduce a keyed recognition service**; the requirement is that Set Extraction works with no account, no key and no per-request cost. All recognition HTTP still runs in the main process, so the renderer CSP is unaffected. Nothing recognizes *every* track — unreleased IDs, bootlegs and heavily-effected sections defeat it.

  The factory validates credentials **before** any expensive work, so an error surfaces instantly rather than after a multi-minute download. `retry.js` provides `backoff` / `parseRetryAfter`; `util.js` provides the shared `minConfidenceOf(settings)`. **All recognition HTTP runs in the main process**, so the renderer CSP is unaffected. No engine recognizes *every* track (unreleased IDs, bootlegs, mashups, heavy effects defeat all of them) — the UI says so.

- **`track-match.js`** — `resolveBestVideoUrl(ytDlp, query, title, artist)` turns a recognized "Artist Title" into a concrete YouTube watch URL. It searches **YouTube Music first** (catalog songs, not reactions/mixes), then general YouTube as fallback, gated both ways by a strict title-containment check (`normalizeForMatch` strips bracketed/dash mix-edit noise and is Unicode-aware so non-Latin/accented titles aren't blanked). Known artist breaks ties between multiple title-passing candidates; returns `null` when nothing confident matches (caller then **skips** rather than download a wrong file). Used by the extraction cache, `download:track`, and `download:tracks`.

**Song recognition — how a tracklist is actually produced**

Set Extraction resolves a tracklist in two stages, cheapest first.

- **`tracklist-sources.js`** (pure, no I/O) — `parsePublishedTracklist(info)` reads the yt-dlp `--dump-json` payload we already fetch and pulls a tracklist out of **chapters** first, then timestamped **description** lines. A large share of DJ sets publish one, and when they do it beats every recognizer outright: correct remix names, correct spelling, exact start times, zero requests, zero cost — and `set-extractor.js` skips downloading the set entirely. Verified against real payloads (a Cercle set yields 18 entries; HÖR, which paywalls its track IDs, correctly yields nothing).
  - It **rejects** anything that doesn't look like a tracklist (< 3 entries, < 60% of entries naming an artist, or entries covering < 40% of the runtime) so a video's navigation chapters can't silently replace a good recognition run.
  - `Artist - Title` vs `Title - Artist` is undecidable from one line, so orientation is corrected **per entry** using bracketed mix/edit markers (an artist is never called "(Extended Mix)"). A list-wide majority vote was tried and is wrong — real uploaders mix both conventions inside one tracklist. Entries with no marker are left as parsed rather than guessed at.
  - Comments are deliberately not parsed (they need a second `--write-comments` pass and are much noisier).

- **`shazam/recognize.js`** — the only recognizer, used whenever nothing was published. Needs **no API key, no account and no local catalog**. Fingerprints on-device and uploads only a ~250-character signature — the audio itself never leaves the machine. It also owns `minConfidenceOf()` and is the code that actually applies `recognizerMinConfidence` (it filters its own output; nothing downstream does).
  - **It uses an unofficial, reverse-engineered endpoint.** That is against Shazam/Apple's terms, and it can break with no notice. If it does, switch the engine in Settings. This was a deliberate, informed choice — it is the only way to get "any song, no key, nothing to maintain".
  - **Use `net.fetch` from `electron`, never the global `fetch`.** Shazam's edge blackholes Node/undici connections (every request dies on a ~10 s connect timeout) while the identical request through Chromium's stack returns 200 in ~270 ms. This was a real bug: the fail-soft error path turned it into a silently empty tracklist. A total-failure guard now raises a real error instead.
  - **Confidence is derived, not reported.** Shazam returns no score, so a track seen by one probe scores 70, one seen at two independent points scores 95, and a hit obtained *only* by pitch-correcting the query scores 55 (below the default floor) because distorted queries are what make a recognizer volunteer a confident wrong title.
  - **Corroboration is NOT a false-positive defence, and the docs used to imply it was.** Recognizer errors are frequently *section-locked and repeatable*, not random — so a wrong answer gets corroborated too and scores 95. Raising `recognizerMinConfidence` does not filter that class. What filters it is the structural rule below.
  - **Measured robustness** (live endpoint, one commercial track, DJ-style abuse via ffmpeg): a second record mixed over it **6/6 up to equal loudness (0 dB)**; EQ kills **3/3** including a 300 Hz–3 kHz telephone band; keylock/master-tempo **4/4 across ±8%**; linked turntable pitch **7/9**, reliable roughly −6%…+6%. Combined pitch + overlap + bass-kill **3/3**. A purpose-built hostile mix (three tracks at −8%/+7%/−7%, all overlapping, 128 kbps) came back **3/3, all corroborated**.
  - **`PITCH_CORRECTIONS` is why the extremes work.** Past ~±6% of *linked* shift Shazam returns nothing — or a confident wrong title. Measured: a track at −8% was unidentifiable at four separate points, but the same audio re-sent at ×1.06 or ×1.08 matched every time. So a clean no-match is retried at a corrected rate, capped by `MAX_PITCH_RETRIES` so a set of genuinely unknown tracks can't double the scan. The last correction that worked is tried first, since a DJ tends to hold a pitch.
  - **`PROBE_SEC` is 8, not 6, for a measured reason**: a +6% track failed at 6 s and 7 s and matched at 8 s. Longer probes cost no extra requests.
  - **`dropEnclosed()` — the contiguity rule, and the most important precision mechanism here.** "A different song was identified" is not "a different song is playing": sections of one track routinely match a *different* record via shared sample packs, recycled loops and sparse breakdowns. Real measurement on a single-track upload — sweeping it every 12 s returned the correct title 13 times and an unrelated track 3 times, always at the same sections, so the wrong track scored 95 and was reported alongside the right one. The fix is the structural fact that a track occupies a *contiguous* stretch of a mix: if candidate Y has hits both before and after all of candidate X's and is stronger, X is a misreading of Y and is dropped. Verified to leave genuine multi-track sets untouched (7-track and 3-track fixtures both unchanged). **Don't remove this in favour of a score threshold — a threshold provably cannot catch this class.**
  - **Known limits.** Probe-based scanning samples, it doesn't sweep: a track played only briefly can fall between probes, and which inner track a nested mix reports can shift with window placement. The contiguity rule also drops a track genuinely played *between* two plays of another — rare, and the deliberate trade for precision. Unreleased/white-label material is simply not in Shazam's catalog and correctly returns nothing.

- **`shazam/signature.js`** — the only file that touches `shazamio-core` (zero-dependency WASM). Loaded via `createRequire`, deliberately: the package is CommonJS *and* a runtime require is invisible to Vite, so it is never bundled — which matters because its loader reads its `.wasm` relative to `__dirname`. **No `vite.main.config.mjs` change is needed; don't add one.**

- **`segmenter.js`** — `findProbePoints()` decides *where* to listen, and it is load-bearing rather than an optimisation. Measured against the live endpoint: **~15 requests go through in a burst, then 429 with no Retry-After; ~4 s spacing sustains indefinitely; ~90 s clears a block.** Probing a 90-minute set every 30 s would be ~180 requests — twelve minutes of pure waiting. Instead it builds a coarse novelty curve (mean spectral profile of the ~20 s before a moment vs the ~20 s after — frame-to-frame flux is useless here, it fires on every kick drum), picks transitions, and probes mid-segment, costing ~2 requests per *track*. Boundary precision matters less than coverage: on the validation mix it found 5/10 boundaries exactly but still placed a probe inside all 11 tracks.

**Offline analysis & tagging (Set Maker / Match Maker)****Offline analysis & tagging (Set Maker / Match Maker)**

- **`audio-analyzer.js`** — spawns `ffmpeg` to decode a file to mono Float32 PCM @ 22.05 kHz, then computes band balance (bass/mid/high), spectral brightness, and intro/outro length from an RMS-envelope walk. No WASM/native analysis lib.
- **`key-bpm-detector.js`** — fully-offline BPM + musical key estimation from the same decoded PCM: dual-band onset envelope → autocorrelation × comb-filter tempogram for tempo (returns candidate metrical levels), tuned chromagram → Krumhansl–Kessler correlation for key (Camelot + name). Shares the `dsp.js` FFT/Hann helpers.
- **`dsp.js`** — size-parameterized FFT + Hann window, used by the analyzer and detector.
- **`bpm-sources.js`** — free, keyless **Deezer** cross-check for detected BPM (`lookupBpm`, fail-soft) plus `reconcileBpm` consensus logic that resolves octave/half-time errors; also exports the `cleanTitle` / `primaryArtist` text helpers reused by Set Extraction. The cross-check **always runs** (no longer user-toggleable).
- **`set-maker.js`** — pure, IPC-free harmonic-mixing algorithm: Camelot key distance, half/double-time-aware BPM distance, move-type scoring, and a 2-opt tour optimizer. `buildSet(tracks, opts)` orders a library; `rescoreTour(tracks)` recomputes transitions after a manual edit.
- **`rating-writer.js`** — `writeRating` / `readRating` (MP3 ID3v2 POPM byte **and** a `[★★★★]` COMM marker so Serato shows it; native comment field via ffmpeg remux for M4A/FLAC/OGG/Opus/AAC) and `writeBpmKey` (writes detected BPM/key back into the file's tags).

**Settings, sources, streaming**

- **`SettingsManager`** (`settings-manager.js`) — `electron-store` wrapper (v11+ ESM-only). `concurrentDownloads` is **deliberately not in the schema** (queue concurrency is hardcoded; exposing it just lets users pick rate-limiting values). Default `downloadFolder` resolves to `app.getPath('music')` at construction. There are **no credential settings at all** any more; the constructor also runs a one-time delete of the keys left behind by the removed engines (`recognizer`, `auddApiToken`, `acrHost`, `acrAccessKey`, `acrAccessSecret`) so a stale API key doesn't sit in a plaintext JSON file forever. See "Settings keys" below.
- **`sources.js`** — URL-classification + registry. `classifyUrl(url)` returns `{ source: 'youtube-music'|'spotify', kind: 'track'|'playlist', id? }` (or `null`), used by `DownloadManager`, `ExtractionJobManager`, and the `url:classify` IPC. The `SOURCES` registry holds `{ id, label, downloader }` per source.
- **`stream-resolver.js`** — `handleStreamRequest(req, ytDlp)` backs the `setengine-stream://` protocol: it base64url-decodes a search query, resolves it to a direct YouTube audio URL via `ytDlp.getAudioStreamUrl()` (50-minute in-memory cache), and proxies the bytes with Range support — for previewing remote audio without downloading.
- **`session-roots.js`** — tiny in-memory allow-list (`addSessionRoot` / `isUnderSessionRoot`) of directories the user explicitly chose this session via the Crate Sorter dialogs. The `setengine-audio://` handler consults it so source/destination folders outside Music/Downloads/Home (e.g. a library on an external `/Volumes/…` drive) can be previewed. Populated **only** inside the dialog-backed `sorter:*` IPC handlers — the renderer can't inject a path.
- **`audio-files.js`** — one definition of "what counts as an audio file" (`AUDIO_EXTS`) and one recursive `walkAudioDir`, shared by Match Maker's library scan and the Crate Sorter's source folders.

**IPC** — `ipc-handlers.js` registers everything (see "IPC channel reference" below). `download:url`, `download:retry`, `download:track`, and `download:tracks` pass `null` for cookies (unauthenticated). `safeOutputDir()` there normalizes a renderer-supplied destination folder (expands `~`, requires an absolute path, else `null` → caller falls back to the configured folder). **Add new IPC here**, and expose it through the preload bridge.

### Preload — `src/preload.js`

Single source of truth for the renderer ↔ main contract. Every channel is exposed via `contextBridge` as `window.setengine`. **`on*` event subscribers return an unsubscribe function** — preserve this pattern when adding events so callers can clean up. Examples: `classifyURL(url)` validates a pasted link before queueing; `getExtractionJobs()` + `onExtractJobsUpdate` / `onExtractJobProgress` drive the Set Extraction page.

### Renderer — `src/renderer.js` + `src/renderer/*`

Vanilla JS, no framework, imperative DOM (no templates). `src/renderer.js` imports the global stylesheet and boots `App`. `App` (`renderer/app.js`) is a tiny page router: `PAGES` map → `new PageClass(this)` → `.render(container)`; pages may implement `.destroy()` for teardown, and stash state on the `app` singleton (e.g. `app.matchState`, `app.setMakerState`, `app.extractState`) so navigating away and back is cheap. `App.setupIpcListeners()` forwards realtime **download** events to the current page **only when it's the queue page** — pass `data` through unchanged, never override `status`.

**Pages** (`renderer/pages/*`):
- **`download.js`** — the landing page. One text box takes any YouTube / YouTube Music or Spotify link; Enter or DOWNLOAD classifies it via `classifyURL`, rejects unrecognized links, runs a just-in-time check that `spotdl` is installed for Spotify links, then calls `downloadURL`. The **destination folder lives on this page** (`.folder-display` + BROWSE, which persists `downloadFolder`). Input clears after queueing; a button jumps to the Queue.
- **`queue.js`** — the download queue: per-item status badges (queued/downloading/complete/error/cancelled), a source badge (YT / SPOTIFY), playlist children, cancel/retry/clear. Driven by `download:queue-update` + the per-item events.
- **`extract.js`** — **Set Extraction, as a job list + detail.** The list view has the URL box + EXTRACT (start several; they run in parallel) and one card per job (status dot, live phase/percent, delete ✕). Clicking a card opens the detail (tracklist, destination folder, per-track play/download, DOWNLOAD WHOLE SET → writes the files). Main is the source of truth: the page mirrors `getExtractionJobs()` and patches from `onExtractJobsUpdate` / `onExtractJobProgress`. **Navigating away does NOT cancel a job** — `destroy()` only unsubscribes, tears down audio, and stashes `{ view, selectedJobId, folderPath }`. Per-track downloads pass `jobId` + `trackIndex` so the ✔/progress state (stored on the job's `trackDownloads`) survives navigating off and back.
- **`setmaker.js`** — **Set Maker**, three views in one page (library / rate / setlist): analyze a folder of local audio (BPM/key), star-rate tracks, then build a harmonically-ordered setlist via `setmaker:build`; import/export `.m3u`. Missing BPM/key can be detected and written back (`tags:detect-and-tag`).
- **`match.js`** — **Match Maker (TuneMatch)**: import a local library, pick a track, and get harmonic-mixing match suggestions filtered by a BPM threshold; dedupe; detect + write missing BPM/key tags for path-bearing imports.
- **`sorter.js`** — **Crate Sorter**, two views in one page (setup / sort). Setup: "Add folder(s)" (multi-select source folders, each scanned recursively for audio) + "Add folder(s)" destination crates. Sort: a left sidebar lists every song (filename-alphabetical, numeric-aware) with per-song status (pending / current / sorted / skipped / missing) and is clickable to jump back and re-sort; the main pane has a seekable player (a bare `new Audio()` **independent of the DOM**, so a re-render on toggle doesn't interrupt playback) plus a crate-toggle grid. Advancing **commits**: copies the file into each newly-selected crate via `sorter:copy-into-folders` (idempotent — already-copied crates lock as "COPIED"; advancing with nothing selected = skip). Keyboard: Space play/pause · ←/→ seek 5s (Shift 15s) · 1–9 toggle crate · Enter/↓ next · ↑ previous · Esc pause. State (songs / crates / index) is in-memory only, stashed on `app.sorterState`; **not persisted across restart**.
- **`settings.js`** — the "use the uploader's tracklist" toggle, `recognizerMinConfidence`, audio quality, filename template, and the yt-dlp / spotdl version + accelerator readout. Nothing on the page is conditional any more (one engine, no credentials), so `attachListeners()` is empty and there is no `syncRecognizerFields`. The destination folder is **not** here — it lives on the Download page.

**Shared renderer code:**
- `renderer/pages/tunematch/engine.js` + `metadata.js` — Camelot/key math + audio-tag metadata parsing, shared by Match Maker and Set Maker.
- `renderer/components/` — `modal.js`, `toast.js` (supports persistent durations).
- `renderer/utils/escape-html.js` — shared HTML escaper (a few pages still define a local copy).
- `renderer/tool-update.js` — `runYtdlpUpdateFlow` / `runSpotdlUpdateFlow` (both built on `runToolUpdateFlow`), used by the startup outdated-yt-dlp modal in `app.js` and the Settings UPDATE buttons.
- `renderer/styles/` — `index.css` (global) plus page styles `extract.css`, `match.css`, `setmaker.css`, `sorter.css`.

### Custom protocols (`main.js`)

Both schemes are registered privileged (`standard`, `secure`, `stream`, `supportFetchAPI`) before `app.whenReady`, and both appear in the CSP `media-src`:

- **`setengine-audio://local/<base64url path>`** — serves a **local** audio file with proper HTTP **Range** support (so the audio element can seek, and so M4A files with a trailing `moov` atom load at all — see the long comment there). Access is restricted to files under the user's music / downloads / home directories **plus any directory the user explicitly picked this session via the Crate Sorter dialogs** (tracked in `session-roots.js` — this is what lets a Crate Sorter library on an external drive be previewed). Used for previewing cached/extracted/library tracks (Set Extraction, Set Maker, Match Maker, Crate Sorter). Note the per-job extraction cache lives under `userData`, which is itself under the home dir, so it passes the safe-dir check.
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
| `usePublishedTracklist` | boolean | (true) Use the uploader's chapters/description tracklist when present, skipping download + recognition entirely. |
| `recognizerMinConfidence` | number | 0–100 (60). Thresholds Shazam's *derived* score — 55 correction-only, 70 heard once, 95 corroborated. Note it cannot filter systematic misidentification (those get corroborated); `dropEnclosed()` handles that. Applied inside `shazam/recognize.js`. |

## IPC channel reference

All registered in `ipc-handlers.js`, all exposed via `preload.js`. `on*` subscribers return an unsubscribe fn.

- **Downloads:** `download:url`, `download:cancel`, `download:retry`, `download:queue`, `download:clear`. Events: `download:progress`, `download:complete`, `download:error`, `download:queue-update`.
- **Settings & dialogs:** `settings:get`, `settings:save`, `dialog:select-folder`, `dialog:select-folders`, `dialog:select-audio-files`.
- **URL / deps / health:** `url:classify`, `deps:check`, `ytdlp:health`, `ytdlp:update`, `spotdl:health`, `spotdl:update`.
- **Set Maker / tagging:** `setmaker:build`, `setmaker:rescore-tour`, `setmaker:analyze-one`, `setmaker:analyze-batch` (event `setmaker:analysis-progress`), `setmaker:rate`, `setmaker:read-rating`, `setmaker:import-m3u`, `setmaker:export-m3u`, `tags:detect-and-tag` (event `tags:progress`).
- **Match Maker:** `match:scan-folders`, `match:read-file`.
- **Set Extraction:** `extract:start` (add job), `extract:cancel` (by id), `extract:delete` (by id), `extract:jobs` (list). Events: `extract:jobs-update`, `extract:job-progress`. Track downloads from a job: `download:track`, `download:tracks` (accept `jobId` + `trackIndex` to record state on the job).
- **Crate Sorter:** `sorter:add-source-folder` (multi-select; scans each chosen folder recursively for audio), `sorter:add-dest-folders` (multi-select destination crates), `sorter:copy-into-folders` (`{ sourcePath, destFolders }` → copies into each crate; non-destructive: skips an identical-size collision, suffixes ` (n)` on a different-size one, never overwrites). All three register a session preview root (see `session-roots.js`). No events — request/response only.

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
- **Crate Sorter copies, never moves.** `sorter:copy-into-folders` is non-destructive (skip-if-identical, else ` (n)` suffix; never overwrites). Its state is in-memory only (`app.sorterState`), not persisted across restart. Previewing source files outside Music/Downloads/Home relies on `session-roots.js` — a path is only ever allow-listed from inside a dialog-backed `sorter:*` handler.
- **Recognition is the fallback, not the first move.** `set-extractor.js` checks for a published tracklist first; only if there isn't one does it download the audio and resolve a recognizer. That ordering is why a set with chapters works even when no engine credentials are configured.
- **Shazam's recognizer must use `net.fetch`, not global `fetch`** (see above) — and its rate limit (~15 burst, ~4 s sustained) is a measured constraint, not a guess. Lowering `REQUEST_GAP_MS` or bypassing `segmenter.js` will get the machine 429'd.
- **When adding a source:** add a `sources.js` entry + wrapper module + `DownloadManager` wiring (it already dispatches on `item.source`).
- **When adding IPC:** register in `ipc-handlers.js` **and** expose in `preload.js`; if it's an event, return an unsubscribe fn.
- **Adding a remote origin** (image/script/font) requires editing the CSP in `index.html`.
