# SetEngine — Codebase Bug & Dead-Code Audit

> Generated 2026-06-23 by a full line-by-line scan of every source file under `src/`,
> plus `forge.config.js`, `package.json`, `index.html`, the Vite configs, and the
> setup scripts. **Nothing here has been fixed** — this is an inventory only.
>
> Each entry lists the location, what's wrong, and the practical impact. Severity:
> 🔴 functional bug · 🟠 latent/correctness risk · 🟡 dead code / unused · ⚪ minor / style.

---

## 🔴 Functional bugs

### 1. Widevine fuse is never actually set (typo'd enum key)
**`forge.config.js:64`**
```js
[FuseV1Options.EnableWidevineCdm]: true,
```
`@electron/fuses` (v1.8.0, the installed version) has **no** `EnableWidevineCdm` member. The
valid `FuseV1Options` members are only: `RunAsNode`, `EnableCookieEncryption`,
`EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`,
`EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`,
`LoadBrowserProcessSpecificV8Snapshot`, `GrantFileProtocolExtraPrivileges`.

So `FuseV1Options.EnableWidevineCdm` evaluates to `undefined`, and the object literal becomes
`{ ["undefined"]: true }` — a junk key named literally `"undefined"`. **The Widevine CDM fuse
the author intended to flip is not being set at all**, and a meaningless property is injected
into the FusesPlugin config. (Playback may still work because the Castlabs fork ships Widevine
by default, masking the mistake — but the line is dead/ineffective and misleading.)

### 2. spotdl stderr progress parsing drops lines (and contains dead code)
**`src/main/spotdl-wrapper.js:412-418`**
```js
proc.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  stderrBuffer += text;
  // spotdl writes progress to stderr in some versions, so process it too.
  let buf = text;
  buf = flushBuffered(buf);          // <-- return value discarded
});
```
`flushBuffered` returns the trailing partial line so it can be carried into the next chunk
(the stdout handler does this correctly via `stdoutBuffer = flushBuffered(stdoutBuffer)`).
Here the return value is thrown away and `buf` is never read again. Consequences:
- The last line of every stderr chunk (a line without a trailing newline) is silently dropped.
- Lines split across chunk boundaries are mis-parsed.
- `let buf = text; buf = flushBuffered(buf);` is effectively dead code.

For spotdl versions that emit `Downloaded "…"` / `Found N songs` on **stderr**, per-track
progress is unreliable.

### 3. Filename template sanitizer strips spaces → mangles custom templates
**`src/main/ytdlp-wrapper.js:621-626`**
```js
function sanitizeFilenameTemplate(template) {
  let s = String(template || '%(title)s');
  s = s.replace(/[^a-zA-Z0-9_\-%\(\)s]/g, '');   // space NOT in allow-list
  ...
}
```
The Settings page (`src/renderer/pages/settings.js:56`) advertises templates like
`%(title)s, %(artist)s, %(album)s, %(track_number)s, %(upload_date)s` and lets the user type
free text. But the allow-list excludes the space character, so a natural template such as
`%(artist)s - %(title)s` is rewritten to `%(artist)s-%(title)s` (space removed; hyphen kept) —
producing filenames the user did not ask for. Any separators, brackets, or punctuation the user
types are silently deleted. The spotdl path (`_translateFilenameTemplate`) does **not** apply
this stripping, so the two engines produce different filenames from the same template.

### 4. Playlist "X/Y songs" progress UI never renders (`childrenProgress` is never set)
**`src/renderer/pages/queue.js:145-149` and `:265-270`**
```js
${item.type === 'playlist' && item.childrenProgress ? `... ${item.childrenProgress.complete}/${item.childrenProgress.total} songs ...` : ''}
```
The renderer reads `item.childrenProgress.{complete,total}` in two places, but
`DownloadManager` never assigns a `childrenProgress` field anywhere — it only sets the numeric
`item.progress` (0-100) in `_updatePlaylistProgress` (`src/main/download-manager.js:266-276`).
So `childrenProgress` is always `undefined` and the per-playlist song-count line **never
appears**. Dead UI branch / missing feature.

### 5. 2-opt optimizer uses symmetric-cost math on an asymmetric cost function
**`src/main/set-maker.js:232-282` (twoOpt) vs `:131-167` (phrasingScore / transitionCost)**

`transitionCost(a, b)` is **not symmetric**: `phrasingScore(a, b)` uses `a.features.outroMs`
and `b.features.introMs`, so `transitionCost(a,b) ≠ transitionCost(b,a)` in general.

The 2-opt move evaluations (interior, prefix, and suffix reversals) compute the cost delta from
**only the boundary edges** — e.g. interior reversal compares
`cost(i-1,i)+cost(j,j+1)` vs `cost(i-1,j)+cost(i,j+1)`. That shortcut is valid only when the
cost is symmetric, because reversing a segment flips the direction of every interior edge.
With an asymmetric cost those interior edge costs change too, and they're never accounted for.

Net effect: the optimizer can accept moves that actually **increase** the true tour cost (or
skip genuinely improving ones). The final reported `totalCost` (recomputed via
`totalTourCost`) is correct, but the ordering it produces is optimizing an inconsistent
objective. Bug is "suboptimal output," not a crash.

---

## 🟡 Dead code / unused files & APIs

### 6. Entire orphaned page: `DownloadPage` (224 lines)
**`src/renderer/pages/download.js`** — defines and exports `DownloadPage` (URL paste → DETECT →
download UI), but it is **never imported anywhere**. `src/renderer/app.js`'s `PAGES` map routes
the "Download" nav button to `BrowserPage`, not `DownloadPage`. The whole file is dead (legacy
URL-paste flow superseded by the embedded browser).

### 7. Re-export shim nobody imports: `ytdlp-update.js`
**`src/renderer/ytdlp-update.js`** — just re-exports from `tool-update.js`. Both `app.js` and
`settings.js` import directly from `./tool-update.js`. Nothing imports `ytdlp-update.js`. Dead
file. (Note: `CLAUDE.md` still documents `renderer/ytdlp-update.js` as the live update flow —
stale doc, see #22.)

### 8. Unused scaffold stylesheet: `src/index.css`
**`src/index.css`** — the default Electron-Forge body styling (`max-width: 38rem`, etc.). The app
imports `./renderer/styles/index.css` from `renderer.js`; `src/index.css` is referenced nowhere.
Dead file.

### 9. Spotify fallback UI is never triggered
**`src/renderer/pages/browser.js:306-437`** — `_enableSpotifyFallback()` (and the
`_runSpotifySearch` / `_lastSpotifyResults` machinery it sets up) is never called. The
`onBrowserLoadFailed` handler (`:252-268`) was deliberately reduced to a `console.warn` and the
comment notes the fallback "is still reachable via the public method below for future manual
triggers" — but there is no caller. `_removeSpotifyFallback()` is still called (in
`switchSource`/`destroy`) but is always a no-op because `fallbackEl` is never created. Dead.

### 10. `diagnose()` exported but never called; `diagFiles` accumulated but never used
- **`src/renderer/pages/tunematch/metadata.js:771`** `export async function diagnose(...)` — no
  importer anywhere.
- **`src/renderer/pages/match.js:530,563,568,573,580,609`** — `diagFiles` is built (capped at
  10 entries) but never read after collection. The collection only exists to feed the unused
  `diagnose()`. Dead bookkeeping.

### 11. Unused IPC / preload bridge surface
The following `window.setengine.*` methods are exposed in `src/preload.js` but called by **no
renderer code**; several have live main-side handlers that are therefore also unreachable:
- `getAuthStatus` → `browser:auth-status` (`ipc-handlers.js:265`) + `CookieManager.isAuthenticated` — unused by UI.
- `extractCookies` → `browser:extract-cookies` (`ipc-handlers.js:271`) — unused (cookies are exported internally on the download path instead).
- `onAuthChange` → channel `browser:auth-change` — **main never emits this channel**, so the subscriber can never fire.
- `getBrowserSource` → `browser:get-source` (`main.js:497`) — never called by renderer.
- `onQueueUpdate` → `download:queue-update` — broadcast by the manager but **never subscribed** (see #14 for the functional consequence).

### 12. `settings.js` calls a method that doesn't exist
**`src/renderer/pages/settings.js:333-335`**
```js
if (this.app && typeof this.app.setupStatusBar === 'function') {
  this.app.setupStatusBar();
}
```
`App` (`src/renderer/app.js`) has no `setupStatusBar` method — the status-bar feature was
removed. The guard makes it a harmless no-op, but it's a dead reference (the "refresh status bar
to reflect new quality" intent silently does nothing).

### 13. Unused build dependency
**`package.json:36`** — `@electron-forge/plugin-auto-unpack-natives` is in `devDependencies` but
is not registered in `forge.config.js`'s `plugins` array. Unused.

---

## 🟠 Latent / correctness risks

### 14. Queue page goes stale because nothing consumes `download:queue-update`
**`src/renderer/app.js:130-156`** subscribes to `onDownloadProgress/Complete/Error` only — not
`onQueueUpdate`. The manager broadcasts `download:queue-update` on add/cancel/clear/retry, but
no one listens. Result: while the user is **on** the Queue page, newly-queued items don't appear
until a per-item progress event arrives. Because concurrency is capped at 5
(`MAX_CONCURRENT_DOWNLOADS`), if you queue 10 songs you'll only see the 5 that start downloading;
the other 5 stay invisible (no progress event yet) until a slot frees up. `updateItem` only
self-heals by calling `loadQueue()` when it receives an event for an **unknown** id. Same gap
makes a playlist's children appear late (children are added to the parent after metadata loads,
but the queue page won't rebuild that subtree until a child emits its first progress event).

### 15. `console-message` handler compares a string level numerically
**`src/main.js:278-298`**
```js
view.webContents.on('console-message', (event) => {
  ...
  if (event.level >= 3) { console.error(...) }
  else if (event.level >= 2) { console.warn(...) }
});
```
The single-argument `(event) => ... event.message` form matches the **newer** Electron
`console-message` API, where `event.level` is a **string** (`'info'|'warning'|'error'|…`), not
an integer. `'error' >= 3` is `NaN`-comparison → always `false`, so the Spotify console
forwarding **never logs anything**. (Conversely, under the *old* `(event, level, message, …)`
signature, `event.message` would be `undefined` and `.includes` would throw.) Either way the
handler is inconsistent with the actual API. Low impact (debug logging only) but currently
non-functional. Verify against the installed Castlabs Electron build.

### 16. Unescaped `title` in `showModal`
**`src/renderer/components/modal.js:17`**
```js
modal.innerHTML = `<h2 class="modal-title">${title}</h2><div class="modal-content">${content}</div>`;
```
`content` is intentionally HTML, but `title` is also interpolated raw. All current callers pass
static literal titles, so there's no live injection — but it's a latent XSS/markup-injection
sink if a dynamic/user-derived title is ever passed. (`escapeHtml` exists and is used elsewhere.)

### 17. Permission handlers grant everything to every source
**`src/main.js:202-208`** — `setPermissionRequestHandler`/`setPermissionCheckHandler` return
`true` for **all** permissions on **all** sources, even though the comment scopes the need to
Spotify's media playback. YouTube Music (and any future source) silently gets geolocation,
notifications, etc. Over-permissive.

### 18. Hard `app.exit(0)` orphans in-flight downloader processes
**`src/main.js:702-708`** — `before-quit` forces `app.exit(0)`. Neither `DownloadManager` nor
the wrappers kill their active `yt-dlp` / `spotdl` / `ffmpeg` children on quit
(`activeProcesses` is never drained on shutdown). Quitting mid-download can leave those child
processes running/orphaned until they finish on their own.

### 19. `includeSubdomains` flag is always TRUE (dead conditional)
**`src/main/cookie-manager.js:42-43`**
```js
const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
```
`domain` is forced to start with `.` on the line above, so the ternary can never yield `'FALSE'`.
The `'FALSE'` branch is unreachable. Works for the current use case but the conditional is
misleading/dead.

### 20. Exported M3U always has duration `-1`
**`src/renderer/pages/setmaker.js:1301-1308`**
```js
const tracks = this.lastSet.tour.map(t => ({ ..., duration: t.duration }));
```
Tour payloads (`_tourPayloadFor`, build/rescore payloads) never carry a `duration` field — the
only duration data lives in `t.features.durationMs`. So `t.duration` is always `undefined`, and
`ipc-handlers.js:596` writes `#EXTINF:-1,...` for every track. The exporter has the data
(`features.durationMs`) but doesn't use it.

### 21. `setup.sh` never auto-installs aria2c despite its comment
**`scripts/setup.sh:118-119`**
```sh
# Optional tools — attempt auto-install
check_binary "aria2c" "aria2c   (...)" "brew install aria2" ""   # <- empty auto_hint
```
The 4th arg (`auto_hint`) is an empty string, so the `if [ -n "$auto_hint" ]` block in
`check_binary` is skipped — aria2c is **never** auto-installed, contradicting the "attempt
auto-install" comment directly above it. (spotdl is auto-installed only when `pipx` exists.)

---

## ⚪ Minor / style / housekeeping

### 22. CLAUDE.md documentation drift
- States the auto-update flow lives in `renderer/ytdlp-update.js` — it now lives in
  `renderer/tool-update.js` (ytdlp-update.js is the dead shim, see #7).
- States `SCRAPE_RESULTS_SCRIPT` lives "at the top of `main.js`" — the scrape scripts now live
  per-source in `src/main/sources.js` (`YTMUSIC_SCRAPE_SCRIPT` / `SPOTIFY_SCRAPE_SCRIPT`), and
  `main.js` reads `rec.source.scrapeScript`. The named constant is no longer in `main.js`.

### 23. Committed build artifacts
`.vite/build/main.js` and `.vite/build/preload.js` (and the `.omo/run-continuation/*.json` files)
are checked into the repo. These are generated outputs and will drift from source; they're
normally git-ignored.

### 24. `parseKey` treats a bare `M` suffix as minor
**`src/renderer/pages/tunematch/engine.js:48-57`** — the regex group `(M|MIN|MINOR|MAJ|MAJOR)`
maps `M` → minor (`isMinor = modeStr === 'M'`). A tag written as `CM` meaning "C **Major**" would
be parsed as C minor. Ambiguous-notation edge case; matches the common "m = minor" convention but
can mis-tag files from software that uses `M` for major.

### 25. `findActiveRegion` can silently return 0 intro/outro
**`src/main/audio-analyzer.js:190-220`** — in the start-scan loop, when a run fails the index is
advanced (`i = i + j; break;`) and the `i === envelope.length - runFrames` fallback can be
jumped over, leaving `introFrames`/`outroFrames` at 0 when no sustained region is found. Degrades
gracefully (treated as "no intro/outro") but the fallback isn't guaranteed to fire.

### 26. `_handleSingle` schedules the download without awaiting the concurrency limiter
**`src/main/download-manager.js:135`** — `this.limit(() => this._runDownload(...))` is fire-and-
forget; the returned promise isn't awaited or returned, so `addDownload`'s `work.catch` only
covers the metadata-fetch phase, never the download itself. Works today because `_runDownload`
swallows its own errors and always resolves — but it means the info-fetch (`getVideoInfo` /
`getPlaylistInfo`) runs **outside** the 5-way concurrency cap (a separate unbounded yt-dlp
spawn per add).

---

## Summary counts
- 🔴 Functional bugs: **5** (#1–#5)
- 🟡 Dead code / unused: **8** (#6–#13)
- 🟠 Latent/correctness risks: **8** (#14–#21)
- ⚪ Minor/style: **5** (#22–#26)

### Highest-impact items to look at first
1. **#1** — Widevine fuse silently not applied (build/DRM correctness).
2. **#3** — filename templates with spaces are mangled (user-visible, every custom template).
3. **#4 / #14** — Queue page playlist progress + live-update gaps (user-visible queue UX).
4. **#2** — spotdl progress parsing drops lines.
5. **#5** — Set Maker 2-opt optimizes an inconsistent objective.
