import { app, BrowserWindow, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import started from 'electron-squirrel-startup';
import YtDlpWrapper from './main/ytdlp-wrapper.js';
import SpotdlWrapper from './main/spotdl-wrapper.js';
import DownloadManager from './main/download-manager.js';
import SettingsManager from './main/settings-manager.js';
import ExtractionJobManager from './main/extraction-manager.js';
import { registerIpcHandlers } from './main/ipc-handlers.js';
import { handleStreamRequest } from './main/stream-resolver.js';
import { isUnderSessionRoot } from './main/session-roots.js';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Prevent the macOS "Electron wants to use your confidential information stored
// in your keychain" prompt on startup. We don't need secure local cookie
// encryption since nothing here persists sensitive credentials.
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('password-store', 'basic');

// Custom audio scheme used by the Set Maker / Match views.
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
  {
    scheme: 'setengine-stream',
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
let ytDlp, spotdl, downloadManager, settingsManager, extractionManager;

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
  extractionManager = new ExtractionJobManager(mainWindow, ytDlp, settingsManager);

  // Extraction jobs live only in memory (not persisted across restart), so every
  // on-disk cache subdir from a previous session is orphaned. Wipe the whole
  // ExtractionCache root once at boot — fire-and-forget.
  fs.promises.rm(ExtractionJobManager.cacheRoot(), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    .catch(() => { /* best-effort */ });

  // Lazy load settings and configure download manager. Queue concurrency is
  // hardcoded in DownloadManager (sized to YouTube's per-IP tolerance), so it
  // isn't pushed from settings.
  const settings = settingsManager.getAll();
  downloadManager.setOutputDir(settings.downloadFolder || app.getPath('music'));
  downloadManager.setBitrate(settings.audioQuality);
  downloadManager.setFilenameTemplate(settings.filenameTemplate);

  registerIpcHandlers(mainWindow, ytDlp, spotdl, downloadManager, settingsManager, extractionManager);

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

  // spotdl health check (informational at boot — only needed for Spotify links,
  // and the Download page does a just-in-time check before queueing one).
  spotdl.getHealth().then((health) => {
    if (!health.version) {
      console.log('[SetEngine] spotdl not detected on PATH. Spotify downloads will require `brew install spotdl` (or `pipx install spotdl`).');
    } else if (health.outdated === true) {
      console.warn(`[SetEngine] spotdl ${health.version} is older than the recommended minimum (${health.recommendedMin}).`);
    } else {
      console.log(`[SetEngine] spotdl ${health.version} detected.`);
    }
  }).catch(() => { /* ignore */ });

  // Auto-update yt-dlp at boot. Always on — YouTube's SABR changes break older
  // builds, so a stale yt-dlp means every download fails. Managed installs
  // (Homebrew/pipx) are skipped automatically below.
  ytDlp.update().catch(err => {
    if (err.managedInstall) {
      console.log('yt-dlp is managed by an external package manager; skipping auto-update.');
    } else {
      console.error('Failed to update yt-dlp:', err);
    }
  });
};

app.whenReady().then(async () => {
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
        normalized.startsWith(homeDir + path.sep) ||
        // Directories the user explicitly picked this session via the Crate
        // Sorter dialogs (e.g. a library on an external /Volumes/... drive).
        isUnderSessionRoot(normalized);
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

  // setengine-stream:// — proxy YouTube audio for in-app playback.
  // Registered after createWindow() so ytDlp is initialized.
  protocol.handle('setengine-stream', (req) => handleStreamRequest(req, ytDlp));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  // Abort in-flight extraction jobs so no recognizer/API work continues after
  // the window is gone (their yt-dlp/ffmpeg children are reaped by killAll below).
  try { if (extractionManager) extractionManager.abortAll(); } catch (_) { /* ignore */ }

  // Kill any in-flight downloader children first, otherwise the hard exit below
  // orphans running yt-dlp / spotdl (and their ffmpeg / aria2c) processes, which
  // would keep downloading after the app is gone.
  try { if (ytDlp) ytDlp.killAll(); } catch (_) { /* ignore */ }
  try { if (spotdl) spotdl.killAll(); } catch (_) { /* ignore */ }

  // The --use-mock-keychain flag causes a known bug on macOS where the mock
  // keychain thread fails to terminate cleanly, resulting in an infinite
  // hang (beachball) when the app tries to gracefully quit. We bypass it
  // entirely by forcing a hard process exit.
  app.exit(0);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
