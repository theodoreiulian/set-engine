import { app, BrowserWindow, components, session, ipcMain, WebContentsView, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import started from 'electron-squirrel-startup';
import YtDlpWrapper from './main/ytdlp-wrapper.js';
import SpotdlWrapper from './main/spotdl-wrapper.js';
import DownloadManager from './main/download-manager.js';
import CookieManager from './main/cookie-manager.js';
import SettingsManager from './main/settings-manager.js';
import { SOURCES, isKnownSource } from './main/sources.js';
import { registerIpcHandlers } from './main/ipc-handlers.js';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Custom audio scheme used by the Set Maker / Rate views.
//
// Blob-URL playback in Chromium can't seek backward through a blob to find an
// MP4 `moov` atom located at the end of the file. iTunes / Apple Music exports
// routinely produce M4A files in that layout, and they fail to load with a
// MEDIA_ERR_SRC_NOT_SUPPORTED error. Serving the file through a real
// network-style scheme (with byte-range support) sidesteps the problem
// entirely — the audio element fetches the tail, finds moov, then seeks
// forward to the audio data.
//
// `registerSchemesAsPrivileged` must be called before `app.whenReady`. The
// privileges below allow streaming (so byte-range responses work), let the
// renderer treat the URL as a normal HTTP-ish source (`standard`), and let
// fetch() against it work (`supportFetchAPI`).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'setengine-audio',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

const AUDIO_MIME = {
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.mp4':  'audio/mp4',
  '.aac':  'audio/aac',
  '.wav':  'audio/wav',
  '.wave': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.aiff': 'audio/aiff',
  '.aif':  'audio/aiff',
};
function audioMimeForPath(p) {
  return AUDIO_MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// macOS / Linux: prepend common package-manager bin directories to PATH.
// Electron processes — even when launched via `npm start` — sometimes inherit
// a PATH that's missing /opt/homebrew/bin (Apple Silicon Homebrew) and other
// non-default locations. Without this, user-installed yt-dlp / ffmpeg / aria2c
// / spotdl can be on the system but invisible to `which` and `spawn`. Adding
// these directories is harmless if they don't exist — PATH lookup just skips
// them. Order matters here: earlier entries win on name conflicts.
if (process.platform !== 'win32') {
  const home = process.env.HOME || '';
  const COMMON_BIN_DIRS = [
    '/opt/homebrew/bin',                                       // Apple Silicon Homebrew
    '/usr/local/bin',                                          // Intel Homebrew, many other installs
    '/opt/local/bin',                                          // MacPorts
    // Pip / pipx / conda / miniforge user paths — spotdl ships via pip
    // and rarely lands on the default PATH.
    `${home}/.local/bin`,                                      // pip install --user / pipx default
    `${home}/Library/Python/3.13/bin`,                         // macOS framework Python (per-version)
    `${home}/Library/Python/3.12/bin`,
    `${home}/Library/Python/3.11/bin`,
    `${home}/miniforge3/bin`,                                  // miniforge in $HOME
    `${home}/miniconda3/bin`,
    `${home}/anaconda3/bin`,
    '/usr/local/Caskroom/miniforge/base/bin',                  // miniforge via Homebrew cask (Intel)
    '/opt/homebrew/Caskroom/miniforge/base/bin',               // miniforge via Homebrew cask (Apple Silicon)
    '/opt/anaconda3/bin',
    '/opt/miniconda3/bin',
    '/Library/Frameworks/Python.framework/Versions/3.13/bin',  // python.org installer
    '/Library/Frameworks/Python.framework/Versions/3.12/bin',
    '/Library/Frameworks/Python.framework/Versions/3.11/bin',
  ];
  const current = (process.env.PATH || '').split(':').filter(Boolean);
  const missing = COMMON_BIN_DIRS.filter((d) => !current.includes(d));
  if (missing.length > 0) {
    process.env.PATH = [...missing, ...current].join(':');
  }
}

let mainWindow;
// Per-source { view, attached, session } records. Views are created lazily on
// the first browser:open for their source and kept alive for the rest of the
// app lifetime — switching sources or leaving the browser tab detaches the
// view from the window's content tree without destroying its WebContents.
// This is what lets login state, scroll position, and playback survive both
// tab switches and source switches.
const browserViews = new Map();
// Which source is currently mounted in the window's content tree. Null means
// no view is attached (browser tab closed, or initial state).
let activeBrowserSource = null;
let ytDlp, spotdl, downloadManager, settingsManager;
// Per-source CookieManager instances, keyed by source id.
const cookieManagers = new Map();

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0a0a0a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Initialize managers
  ytDlp = new YtDlpWrapper();
  spotdl = new SpotdlWrapper();
  settingsManager = new SettingsManager();
  downloadManager = new DownloadManager(mainWindow, ytDlp, spotdl);

  // One CookieManager + persistent session per source. Each source's session
  // is partitioned so cookies, localStorage, and login state are siloed.
  for (const source of Object.values(SOURCES)) {
    const sess = session.fromPartition(source.partition);
    cookieManagers.set(source.id, new CookieManager({
      session: sess,
      cookieDomain: source.cookieDomain,
      cookieFileName: source.cookieFileName,
      authCookieNames: source.authCookieNames,
    }));
  }

  // Lazy load settings and configure download manager. Queue concurrency is
  // hardcoded in DownloadManager (sized to YouTube's per-IP tolerance), so it
  // isn't pushed from settings.
  const settings = settingsManager.getAll();
  downloadManager.setOutputDir(settings.downloadFolder || app.getPath('music'));
  downloadManager.setBitrate(settings.audioQuality);
  downloadManager.setFilenameTemplate(settings.filenameTemplate);

  registerIpcHandlers(mainWindow, ytDlp, spotdl, downloadManager, cookieManagers, settingsManager);

  // Per-source WebContentsView management.
  //
  // Each entry in `browserViews` holds a kept-alive view; the renderer asks
  // the main process which one should currently composite into the window via
  // browser:open(bounds, source) or browser:set-source(source). Only one view
  // is attached at a time — switching sources detaches the previous view and
  // attaches the new one at the same bounds. Detaching preserves the page
  // entirely (login, scroll, playback), so source switches feel instant.

  function getOrCreateView(sourceId, initialBounds) {
    const source = SOURCES[sourceId];
    if (!source) return null;
    if (browserViews.has(sourceId)) return browserViews.get(sourceId);

    const sess = session.fromPartition(source.partition);
    const view = new WebContentsView({
      webPreferences: {
        session: sess,
        nodeIntegration: false,
        contextIsolation: true,
        // Widevine + autoplay are required for the Spotify web player (DRM),
        // while YouTube Music gets by without them. enableBlinkFeatures is
        // needed for the Web Audio API path used by Spotify's player core.
        plugins: true,
        webSecurity: false,
        allowRunningInsecureContent: true,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });

    // User-agent override. Critical for Spotify, harmless for YT Music. Must
    // be set before loadURL so the very first request goes out with the
    // spoofed UA — Spotify's SPA reads navigator.userAgent at boot and locks
    // in layout based on it.
    if (source.userAgent) {
      view.webContents.setUserAgent(source.userAgent);
    }

    // Spotify's web player needs media (and related) permissions that
    // Electron's default handler silently denies. Grant anything the page
    // asks for — the user is intentionally browsing open.spotify.com.
    view.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(true);
    });

    view.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
      return true;
    });

    view.webContents.on('did-navigate', (event, url) => {
      if (activeBrowserSource === sourceId) {
        mainWindow.webContents.send('browser:navigate', url);
      }
    });
    view.webContents.on('did-navigate-in-page', (event, url) => {
      if (activeBrowserSource === sourceId) {
        mainWindow.webContents.send('browser:navigate', url);
      }
    });

    // Spotify (and any SPA that redirects mid-navigation, runs an interstitial,
    // or aborts a request after a JS-initiated nav) emits a spurious
    // did-fail-load even when the eventual page load is successful. Don't
    // dispatch the failure IPC immediately — schedule it, and cancel if a
    // did-finish-load arrives first. We also discard once any successful
    // navigation has been observed for the view's lifetime so a transient
    // error after a working session never re-triggers the fallback UI.
    let pendingFailureTimer = null;
    let hasLoadedSuccessfully = false;

    const clearPendingFailure = () => {
      if (pendingFailureTimer) {
        clearTimeout(pendingFailureTimer);
        pendingFailureTimer = null;
      }
    };

    view.webContents.on('did-finish-load', () => {
      hasLoadedSuccessfully = true;
      clearPendingFailure();
    });
    view.webContents.on('did-frame-finish-load', (event, isMainFrame) => {
      if (isMainFrame) {
        hasLoadedSuccessfully = true;
        clearPendingFailure();
      }
    });

    view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Skip sub-resource failures and the noisy ERR_ABORTED (-3) that fires
      // on user-initiated navigation interrupts.
      if (!isMainFrame || errorCode === -3) return;
      // If the view has already successfully loaded once, the user is mid-
      // session — surface as a toast through the navigate channel rather than
      // the load-failed channel which triggers fallback UI.
      if (hasLoadedSuccessfully) return;

      clearPendingFailure();
      pendingFailureTimer = setTimeout(() => {
        pendingFailureTimer = null;
        // Re-check at fire time. If a successful load slipped in during the
        // grace window, drop the failure entirely.
        if (hasLoadedSuccessfully) return;
        if (activeBrowserSource !== sourceId) return;
        mainWindow.webContents.send('browser:load-failed', {
          source: sourceId,
          errorCode,
          errorDescription,
          url: validatedURL,
        });
      }, 2500);
    });

    // Forward console messages from the embedded browser to the main process
    // log so playback / DRM errors are visible when debugging. Only enabled
    // for Spotify because YT Music is already known-good.
    const currentSourceId = sourceId;
    view.webContents.on('console-message', (event) => {
      // Filter out expected noise: Spotify's security warnings are harmless
      // (we intentionally disable webSecurity for DRM/CDN loading), font
      // preload messages are cosmetic, and sandbox warnings come from
      // Spotify's embedded iframes which we can't control.
      const skipPatterns = [
        'Disabled webSecurity',
        'allowRunningInsecureContent',
        'Insecure Content-Security-Policy',
        'preloaded using link preload but not used',
        'both allow-scripts and allow-same-origin',
      ];
      if (skipPatterns.some((p) => event.message.includes(p))) return;

      const label = currentSourceId === 'spotify' ? '[Spotify]' : '[Browser]';
      if (event.level >= 3) {
        console.error(`${label} ${event.message}`);
      } else if (event.level >= 2) {
        console.warn(`${label} ${event.message}`);
      }
    });

    // -----------------------------------------------------------------------
    // Spotify browse-only mode
    // -----------------------------------------------------------------------
    // Spotify's Widevine DRM requires Verified Media Path (VMP) signing that
    // only production browsers possess. Without it the EME license request
    // fails silently, causing a rapid skip-loop through every track in a
    // playlist. Rather than letting users hit this, we strip all playback
    // affordances so the embedded browser is purely for browsing + downloading.
    //
    // The injections run on every top-level and in-page navigation because
    // Spotify is a React SPA — the DOM is rebuilt on route transitions.
    if (sourceId === 'spotify') {
      const SPOTIFY_DISABLE_PLAYBACK_CSS = `
        /* ── Hide the bottom now-playing / player bar ────────────── */
        footer,
        [data-testid="now-playing-bar"],
        [data-testid="now-playing-widget"],
        .Root__now-playing-bar { display: none !important; height: 0 !important; }

        /* ── Reclaim the space the player bar stole ──────────────── */
        .Root__main-view { bottom: 0 !important; padding-bottom: 36px !important; }

        /* ── Hide all play/pause buttons and overlays ─────────────── */
        [data-testid="play-button"],
        [data-testid="pause-button"],
        [data-testid="control-button-playpause"],
        [data-testid="player-controls"],
        button[aria-label="Play"],
        button[aria-label="Pause"],
        .player-controls,
        .player-controls__buttons { display: none !important; }

        /* ── Play overlay on cards / album art ───────────────────── */
        [data-testid="card-click-handler"] button[data-testid="play-button"],
        .CardButton { display: none !important; }

        /* ── Volume, seek bar, repeat, shuffle ───────────────────── */
        [data-testid="volume-bar"],
        [data-testid="playback-progressbar"],
        [data-testid="control-button-repeat"],
        [data-testid="control-button-shuffle"],
        [data-testid="control-button-skip-forward"],
        [data-testid="control-button-skip-back"],
        .progress-bar,
        .playback-bar,
        .volume-bar { display: none !important; }

        /* ── Browse-only banner (fixed at bottom) ────────────────── */
        #setengine-browse-banner {
          position: fixed; bottom: 0; left: 0; right: 0;
          height: 36px; display: flex; align-items: center; justify-content: center;
          background: #181818; border-top: 1px solid #282828;
          color: #b3b3b3; font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          letter-spacing: 0.4px; z-index: 99999; pointer-events: none;
          user-select: none;
        }
      `;

      const SPOTIFY_DISABLE_PLAYBACK_JS = `
        (function() {
          if (window.__setengine_playback_blocked) return;
          window.__setengine_playback_blocked = true;

          // Neuter the Audio constructor so no <audio> element can play
          const OrigAudio = window.Audio;
          window.Audio = function() {
            const a = new OrigAudio();
            a.play = function() { return Promise.reject(new DOMException('Blocked by SetEngine', 'NotAllowedError')); };
            Object.defineProperty(a, 'src', { set: function() {}, get: function() { return ''; } });
            return a;
          };
          window.Audio.prototype = OrigAudio.prototype;

          // Block play() on any HTMLMediaElement
          const origPlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function() {
            return Promise.reject(new DOMException('Blocked by SetEngine', 'NotAllowedError'));
          };

          // Block MediaSource so EME/DRM can't even start
          if (window.MediaSource) {
            window.MediaSource = class FakeMediaSource {
              constructor() { throw new DOMException('Blocked by SetEngine', 'NotSupportedError'); }
              static isTypeSupported() { return false; }
            };
          }

          // Inject the browse-only banner if not present
          if (!document.getElementById('setengine-browse-banner')) {
            var banner = document.createElement('div');
            banner.id = 'setengine-browse-banner';
            banner.textContent = 'BROWSE ONLY \\u2014 use the DOWNLOAD button in the toolbar to save songs';
            document.body.appendChild(banner);
          }
        })();
      `;

      const injectSpotifyBrowseMode = () => {
        if (view.webContents.isDestroyed()) return;
        view.webContents.insertCSS(SPOTIFY_DISABLE_PLAYBACK_CSS).catch(() => {});
        view.webContents.executeJavaScript(SPOTIFY_DISABLE_PLAYBACK_JS, true).catch(() => {});
      };

      view.webContents.on('did-finish-load', injectSpotifyBrowseMode);
      view.webContents.on('did-navigate-in-page', injectSpotifyBrowseMode);
      // Also inject after a short delay to catch late SPA hydration
      view.webContents.on('dom-ready', () => {
        setTimeout(injectSpotifyBrowseMode, 500);
      });
    }

    // Order matters here. We attach + setBounds BEFORE loadURL so the SPA
    // sees the right viewport on its very first paint. Spotify in particular
    // reads window.innerWidth/innerHeight during its hydration step and
    // doesn't recompute its layout on later resizes for the icon/control
    // sizing tier — leaving Spotify with a 0×0 boot viewport produces
    // disproportionate icons and missing controls.
    if (initialBounds) {
      mainWindow.contentView.addChildView(view);
      view.setBounds(initialBounds);
    }

    view.webContents.loadURL(source.entryUrl);

    const record = { view, attached: !!initialBounds, source };
    browserViews.set(sourceId, record);
    return record;
  }

  function attachSource(sourceId, bounds) {
    if (!isKnownSource(sourceId)) return false;

    // Detach whoever is currently attached
    if (activeBrowserSource && activeBrowserSource !== sourceId) {
      const prev = browserViews.get(activeBrowserSource);
      if (prev && prev.attached) {
        mainWindow.contentView.removeChildView(prev.view);
        prev.attached = false;
      }
    }

    // Hand the initial bounds into getOrCreateView so first-launch sizing
    // happens before loadURL fires (see comment in getOrCreateView).
    const record = getOrCreateView(sourceId, bounds);
    if (!record) return false;

    if (!record.attached) {
      mainWindow.contentView.addChildView(record.view);
      record.attached = true;
    }
    if (bounds) {
      record.view.setBounds(bounds);
    }
    activeBrowserSource = sourceId;
    return true;
  }

  function activeRecord() {
    return activeBrowserSource ? browserViews.get(activeBrowserSource) : null;
  }

  ipcMain.handle('browser:open', (event, bounds, sourceId) => {
    const target = isKnownSource(sourceId) ? sourceId : (settingsManager.get('preferredSource') || 'youtube-music');
    return attachSource(target, bounds);
  });

  ipcMain.handle('browser:set-source', (event, sourceId, bounds) => {
    return attachSource(sourceId, bounds);
  });

  ipcMain.handle('browser:resize', (event, bounds) => {
    const rec = activeRecord();
    if (rec && bounds) {
      rec.view.setBounds(bounds);
    }
  });

  ipcMain.handle('browser:close', () => {
    // Detach but do NOT destroy. Preserves session and playback so the next
    // browser:open resumes exactly where the user left off.
    const rec = activeRecord();
    if (rec && rec.attached) {
      mainWindow.contentView.removeChildView(rec.view);
      rec.attached = false;
    }
    activeBrowserSource = null;
    return true;
  });

  ipcMain.handle('browser:get-url', () => {
    const rec = activeRecord();
    if (rec && !rec.view.webContents.isDestroyed()) {
      return rec.view.webContents.getURL();
    }
    return null;
  });

  ipcMain.handle('browser:get-source', () => activeBrowserSource);

  ipcMain.handle('browser:back', () => {
    const rec = activeRecord();
    if (rec && rec.view.webContents.canGoBack()) {
      rec.view.webContents.goBack();
    }
  });

  ipcMain.handle('browser:forward', () => {
    const rec = activeRecord();
    if (rec && rec.view.webContents.canGoForward()) {
      rec.view.webContents.goForward();
    }
  });

  ipcMain.handle('browser:refresh', () => {
    const rec = activeRecord();
    if (rec) {
      rec.view.webContents.reload();
    }
  });

  // Scrape visible song rows from the currently active source. Each source
  // ships its own DOM-walking script via SOURCES[id].scrapeScript. Used by the
  // Browser tab DOWNLOAD button to show a picker of exactly what the user
  // sees on screen.
  ipcMain.handle('browser:scrape-results', async () => {
    const rec = activeRecord();
    if (!rec || rec.view.webContents.isDestroyed()) {
      return { success: false, error: 'Browser is not open' };
    }
    try {
      const results = await rec.view.webContents.executeJavaScript(rec.source.scrapeScript, true);
      return {
        success: true,
        source: rec.source.id,
        results: Array.isArray(results) ? results : [],
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Detect aria2c first (cheap `which` call) so the very first download already
  // knows whether to route through the accelerator. Fire-and-forget — if a
  // download somehow starts before this resolves, it just uses the built-in
  // downloader.
  ytDlp.detectExternalDownloader().then((hasAria2c) => {
    if (hasAria2c) {
      console.log('[SetEngine] aria2c detected — using it for accelerated downloads.');
    } else {
      console.log('[SetEngine] aria2c not detected. `brew install aria2` for ~2× faster downloads.');
    }
  });

  // Health check: log version, warn if outdated. Renderer also pulls this via
  // `ytdlp:health` to show a startup modal when the version is too old.
  ytDlp.getHealth().then((health) => {
    if (!health.version) {
      console.warn('[SetEngine] yt-dlp not detected on PATH.');
    } else if (health.outdated === true) {
      console.warn(
        `[SetEngine] yt-dlp ${health.version} is older than the recommended ` +
        `minimum (${health.recommendedMin}). Downloads may fail with ` +
        `"Requested format is not available" until you update.`
      );
    } else {
      console.log(`[SetEngine] yt-dlp ${health.version} detected.`);
    }
  });

  // spotdl health check (informational at boot — the renderer pulls
  // `spotdl:health` and decides whether to nag the user based on
  // preferredSource).
  spotdl.getHealth().then((health) => {
    if (!health.version) {
      console.log('[SetEngine] spotdl not detected on PATH. Spotify downloads will require `brew install spotdl` (or `pipx install spotdl`).');
    } else if (health.outdated === true) {
      console.warn(`[SetEngine] spotdl ${health.version} is older than the recommended minimum (${health.recommendedMin}).`);
    } else {
      console.log(`[SetEngine] spotdl ${health.version} detected.`);
    }
  }).catch(() => { /* ignore */ });

  // Auto update check
  if (settings.autoUpdateYtdlp) {
    ytDlp.update().catch(err => {
      if (err.managedInstall) {
        console.log('yt-dlp is managed by an external package manager; skipping auto-update.');
      } else {
        console.error('Failed to update yt-dlp:', err);
      }
    });
  }
};

app.whenReady().then(async () => {
  // Castlabs Electron for Content Security: wait for Widevine CDM to be
  // downloaded and installed before anything touches a WebContentsView.
  // Without this, Spotify's EME/DRM path reports "No supported keysystem".
  try {
    await components.whenReady();
    console.log('[SetEngine] Widevine CDM status:', components.status());
  } catch {
    // components.whenReady() may not exist on stock Electron — the try/catch
    // lets the app start gracefully without DRM support.
    console.warn('[SetEngine] components API not available — DRM playback disabled');
  }

  // Wire the setengine-audio:// handler. The renderer builds URLs of the form
  //   setengine-audio://local/<base64url-encoded absolute path>
  // We encode the path so '/' and Unicode characters survive URL parsing
  // (file paths can contain anything; the URL spec can't).
  //
  // We MUST honor Range requests properly. When the user seeks the audio
  // element issues a Range request for the byte offset corresponding to the
  // target playback position. A handler that ignores Range and returns the
  // whole file is the reason seek "appears to restart playback" — the audio
  // element discards the new fetch and falls back to its prior buffered
  // position (often the start). Delegating to net.fetch(file://) does NOT
  // give us proper Range support from a protocol handler, so we do it here.
  protocol.handle('setengine-audio', async (request) => {
    try {
      const url = new URL(request.url);
      const encoded = url.pathname.replace(/^\/+/, '');
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!filePath) return new Response('Bad path', { status: 400 });

      const musicDir = app.getPath('music');
      const downloadsDir = app.getPath('downloads');
      const homeDir = app.getPath('home');
      const normalized = path.normalize(filePath);
      const isInSafeDir =
        normalized.startsWith(musicDir + path.sep) ||
        normalized.startsWith(downloadsDir + path.sep) ||
        normalized.startsWith(homeDir + path.sep);
      if (!isInSafeDir) {
        console.warn(`[SetEngine] setengine-audio blocked access to: ${normalized}`);
        return new Response('Forbidden', { status: 403 });
      }

      let stat;
      try { stat = await fsStat(filePath); }
      catch { return new Response('Not found', { status: 404 }); }
      if (!stat.isFile()) return new Response('Not a file', { status: 404 });

      const fileSize = stat.size;
      const contentType = audioMimeForPath(filePath);
      const rangeHeader = request.headers.get('range');

      // Parse "bytes=START-END" (END optional). Chromium audio element sends
      // this for seeks. If START is past EOF, respond with 416.
      if (rangeHeader) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] === '' ? fileSize - 1 : parseInt(m[2], 10);
          if (start >= fileSize || end >= fileSize || start > end) {
            return new Response('Range not satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${fileSize}` },
            });
          }
          const nodeStream = fs.createReadStream(filePath, { start, end });
          return new Response(Readable.toWeb(nodeStream), {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(end - start + 1),
              'Cache-Control': 'no-store',
            },
          });
        }
      }

      // No (or unparseable) Range header → return the whole file. Still
      // advertise Accept-Ranges so the audio element knows it CAN issue a
      // Range request later when the user seeks.
      const fullStream = fs.createReadStream(filePath);
      return new Response(Readable.toWeb(fullStream), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return new Response(`Audio fetch failed: ${err.message}`, { status: 500 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
