import { ipcMain, dialog, shell } from 'electron';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyUrl } from './sources.js';
import { buildSet, rescoreTour } from './set-maker.js';
import { writeRating, readRating, writeBpmKey } from './rating-writer.js';
import { analyzeTrack } from './audio-analyzer.js';
import { detectKeyBpm } from './key-bpm-detector.js';
import { lookupBpm, reconcileBpm } from './bpm-sources.js';
import { extractSet } from './set-extractor.js';

const MATCH_AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.wav', '.wave', '.aiff', '.aif',
  '.ogg', '.m4a', '.mp4', '.aac', '.alac', '.wma', '.opus',
]);

// Parse an .m3u / .m3u8 playlist file. Returns the file paths in order,
// optionally with the EXTINF duration/label that precedes them. Resolves
// relative paths against the playlist's own directory; accepts file:// URIs
// and percent-encoded paths (some software writes "%20" for spaces even
// without a file:// prefix).
function parseM3u(content, baseDir) {
  // Strip a UTF-8 BOM if present — common when a playlist was saved on
  // Windows. Without this, the first line starts with U+FEFF and our
  // `#EXTM3U`/`#EXTINF` checks all miss.
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  const out = [];
  let nextInfo = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const m = line.match(/^#EXTINF:(-?\d+(?:\.\d+)?)\s*,(.*)$/);
      if (m) nextInfo = { duration: parseFloat(m[1]), label: m[2].trim() };
      continue;
    }
    if (line.startsWith('#')) continue;

    let p = line;
    if (p.startsWith('file://')) {
      try { p = fileURLToPath(p); }
      catch { p = p.slice('file://'.length); }
    } else if (/%[0-9A-Fa-f]{2}/.test(p)) {
      // Bare percent-encoded path (no file:// prefix). Decode best-effort.
      try { p = decodeURIComponent(p); } catch { /* leave as-is */ }
    }
    if (!path.isAbsolute(p)) p = path.resolve(baseDir, p);
    out.push({ path: p, duration: nextInfo ? nextInfo.duration : null, label: nextInfo ? nextInfo.label : null });
    nextInfo = null;
  }
  return out;
}

// macOS HFS+ stores filenames as NFD (decomposed Unicode), but tag exporters
// frequently write NFC (composed). A path that exists on disk may not match
// what's literally in the M3U byte-for-byte. Try the as-is form first, then
// both normalizations before giving up.
async function resolveExisting(p) {
  const candidates = [p];
  const nfc = p.normalize('NFC'); if (nfc !== p) candidates.push(nfc);
  const nfd = p.normalize('NFD'); if (nfd !== p) candidates.push(nfd);
  for (const candidate of candidates) {
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

async function walkAudioDir(dirPath, relativeBase, out) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dirPath, e.name);
    const rel = relativeBase ? `${relativeBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walkAudioDir(full, rel, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (MATCH_AUDIO_EXTS.has(ext)) {
        try {
          const s = await stat(full);
          out.push({ path: full, name: e.name, size: s.size, relativePath: rel });
        } catch { /* unreadable, skip */ }
      }
    }
  }
}

export function registerIpcHandlers(mainWindow, ytDlp, spotdl, downloadManager, settingsManager) {
  // Open an external https URL in the user's default browser (e.g. the required
  // GetSongBPM attribution backlink). Only http/https — never local files.
  ipcMain.handle('app:open-external', async (event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'invalid url' };
    }
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Downloads run unauthenticated. The embedded sign-in browser was removed, so
  // there's no session to harvest cookies from — yt-dlp/spotdl fetch public
  // content directly (cookiePath is null). Spotify never needed cookies anyway.
  ipcMain.handle('download:url', async (event, url) => {
    try {
      const id = await downloadManager.addDownload(url, null);
      return { success: true, id };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('download:cancel', (event, id) => {
    downloadManager.cancelDownload(id);
    return { success: true };
  });

  ipcMain.handle('download:retry', async (event, id) => {
    try {
      downloadManager.retryDownload(id, null);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('download:queue', () => {
    return downloadManager.getQueue();
  });

  ipcMain.handle('download:clear', () => {
    downloadManager.clearAll();
    return { success: true };
  });

  ipcMain.handle('settings:get', () => {
    return settingsManager.getAll();
  });

  ipcMain.handle('settings:save', (event, newSettings) => {
    settingsManager.setAll(newSettings);
    const merged = settingsManager.getAll();
    downloadManager.setOutputDir(merged.downloadFolder);
    downloadManager.setBitrate(merged.audioQuality);
    downloadManager.setFilenameTemplate(merged.filenameTemplate);
    return { success: true };
  });

  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const p = result.filePaths[0];
      try {
        const s = await stat(p);
        if (s.isDirectory()) return p;
      } catch { /* path invalid or inaccessible */ }
      return null;
    }
    return null;
  });

  ipcMain.handle('dialog:select-folders', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'multiSelections'],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const valid = [];
      for (const p of result.filePaths) {
        try {
          const s = await stat(p);
          if (s.isDirectory()) valid.push(p);
        } catch { /* skip inaccessible paths */ }
      }
      return valid.length > 0 ? valid : null;
    }
    return null;
  });

  ipcMain.handle('dialog:select-audio-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'm4a', 'mp4', 'aac', 'flac', 'wav', 'wave', 'ogg', 'opus', 'aiff', 'aif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!result.canceled && result.filePaths.length > 0) return result.filePaths;
    return null;
  });

  ipcMain.handle('match:scan-folders', async (event, folderPaths) => {
    if (!Array.isArray(folderPaths)) return [];
    const out = [];
    for (const folderPath of folderPaths) {
      if (typeof folderPath !== 'string') continue;
      const baseName = path.basename(folderPath);
      await walkAudioDir(folderPath, baseName, out);
    }
    return out;
  });

  ipcMain.handle('match:read-file', async (event, filePath) => {
    if (typeof filePath !== 'string') throw new Error('invalid path');
    const buf = await readFile(filePath);
    // Return a transferable ArrayBuffer slice (not the Node Buffer's pool).
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('url:classify', (event, url) => classifyUrl(url));

  ipcMain.handle('deps:check', () => {
    return ytDlp.checkDependencies();
  });

  ipcMain.handle('ytdlp:health', () => {
    return ytDlp.getHealth();
  });

  ipcMain.handle('ytdlp:update', async () => {
    try {
      const info = await ytDlp.detectInstallMethod();
      const output = await ytDlp.runAutomaticUpdate();
      const health = await ytDlp.getHealth();
      return {
        success: true,
        method: info.method,
        output,
        version: health.version,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
      };
    }
  });

  ipcMain.handle('spotdl:health', () => spotdl.getHealth());

  ipcMain.handle('spotdl:update', async () => {
    try {
      const info = await spotdl.detectInstallMethod();
      const output = await spotdl.runAutomaticUpdate();
      const health = await spotdl.getHealth();
      return {
        success: true,
        method: info.method,
        output,
        version: health.version,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('setmaker:build', async (event, payload) => {
    try {
      const tracks = (payload && payload.tracks) || [];
      const opts = (payload && payload.opts) || {};
      const result = buildSet(tracks, opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Rescore an already-ordered tour after a manual edit (delete / move /
  // insert). Returns fresh transitions + totalCost without reordering.
  ipcMain.handle('setmaker:rescore-tour', async (event, payload) => {
    try {
      const tracks = (payload && payload.tracks) || [];
      const result = rescoreTour(tracks);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Analyze a single track on demand. Used as the synchronous fallback from
  // the renderer when Build Set is clicked before background analysis has
  // finished. Returns { success, features?, error? }.
  ipcMain.handle('setmaker:analyze-one', async (event, payload) => {
    try {
      const filePath = payload && payload.path;
      if (typeof filePath !== 'string') {
        return { success: false, error: 'path required' };
      }
      const features = await analyzeTrack(filePath);
      return { success: true, features };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Kick off background analysis for a batch of tracks. Returns immediately;
  // per-track results are streamed via `setmaker:analysis-progress` events.
  // The renderer subscribes once at page mount and merges each result into
  // its library state. Pre-existing analyzed tracks should be filtered out
  // by the renderer before calling — the main process treats every entry as
  // work to do.
  ipcMain.handle('setmaker:analyze-batch', (event, payload) => {
    const items = (payload && Array.isArray(payload.tracks)) ? payload.tracks : [];
    if (items.length === 0) return { success: true, started: 0 };

    for (const item of items) {
      if (!item || typeof item.path !== 'string') continue;
      analyzeTrack(item.path).then((features) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('setmaker:analysis-progress', {
            id: item.id,
            status: 'done',
            features,
          });
        }
      }).catch((err) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('setmaker:analysis-progress', {
            id: item.id,
            status: 'error',
            error: err.message,
          });
        }
      });
    }
    return { success: true, started: items.length };
  });

  // Detect missing BPM/key for a batch of files and write the values back into
  // the originals. Input: { items: [{ id, path, need, title?, artist? }] } where
  // need ∈ 'bpm'|'key'|'both'. For BPM, the local DSP estimate is cross-checked
  // against free external databases (Deezer + optional GetSongBPM) and the
  // consensus value — or a flagged best-guess on conflict — is what gets written.
  // Streams per-file results via `tags:progress` as each finishes, and returns
  // the full results array when all settle. Each result: { id, path, bpm?,
  // bpmSource?, needsReview?, localBpm?, externalBpm?, keyCamelot?, keyName?,
  // written, writeSupported, error? }.
  ipcMain.handle('tags:detect-and-tag', async (event, payload) => {
    const items = (payload && Array.isArray(payload.items)) ? payload.items : [];
    if (items.length === 0) return { success: true, results: [] };

    const online = settingsManager.get('bpmLookupOnline') !== false;
    const getSongBpmApiKey = settingsManager.get('getSongBpmApiKey') || '';

    const emit = (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tags:progress', data);
      }
    };

    const results = await Promise.all(items.map(async (item) => {
      const out = { id: item && item.id, path: item && item.path, written: false, writeSupported: true };
      if (!item || typeof item.path !== 'string') {
        out.error = 'invalid path';
        emit(out);
        return out;
      }
      const need = item.need || 'both';
      const needBpm = need === 'bpm' || need === 'both';
      const needKey = need === 'key' || need === 'both';
      try {
        const det = await detectKeyBpm(item.path, { needBpm, needKey });

        let finalBpm = needBpm ? det.bpm : 0;
        if (needBpm) {
          let externals = [];
          if (online && item.title) {
            externals = await lookupBpm({
              title: item.title,
              artist: item.artist,
              durationSec: det.durationSec,
              getSongBpmApiKey,
            });
          }
          const rec = reconcileBpm({ local: det, externals });
          finalBpm = rec.bpm;
          out.bpm = rec.bpm;
          out.bpmConfidence = det.bpmConfidence;
          out.bpmSource = rec.source;
          out.needsReview = rec.needsReview;
          out.localBpm = rec.localBpm;
          out.externalBpm = rec.externalBpm;
          if (rec.externalSource) out.externalSource = rec.externalSource;
        }
        if (needKey) { out.keyCamelot = det.keyCamelot; out.keyName = det.keyName; out.keyConfidence = det.keyConfidence; }

        const fields = {};
        if (needBpm) fields.bpm = finalBpm;
        if (needKey) { fields.keyName = det.keyName; fields.keyCamelot = det.keyCamelot; }
        const w = await writeBpmKey(item.path, fields);
        out.writeSupported = !(w && w.supported === false);
        out.written = !!(w && w.success && w.written);
        if (w && w.success === false) out.writeError = w.error;
      } catch (err) {
        out.error = err.message;
      }
      emit(out);
      return out;
    }));

    return { success: true, results };
  });

  ipcMain.handle('setmaker:rate', async (event, payload) => {
    try {
      if (!payload || typeof payload.filePath !== 'string') {
        return { success: false, error: 'filePath required' };
      }
      const res = await writeRating(payload.filePath, payload.stars);
      return { success: res.success, supported: res.supported, stars: res.stars, error: res.error };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('setmaker:read-rating', async (event, filePath) => {
    try {
      return await readRating(filePath);
    } catch (err) {
      return { supported: false, stars: null, error: err.message };
    }
  });

  ipcMain.handle('setmaker:import-m3u', async () => {
    try {
      const dlg = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
          { name: 'Playlist', extensions: ['m3u', 'm3u8'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (dlg.canceled || dlg.filePaths.length === 0) return { success: false, cancelled: true };
      const m3uPath = dlg.filePaths[0];
      const content = await readFile(m3uPath, 'utf8');
      const baseDir = path.dirname(m3uPath);
      const entries = parseM3u(content, baseDir);

      // Tag each entry with whether the file is currently present on disk.
      // resolveExisting tries NFC/NFD normalization variants so macOS HFS+
      // filenames with accents resolve even if the M3U was written in NFC.
      const enriched = [];
      for (const e of entries) {
        const resolved = await resolveExisting(e.path);
        enriched.push({
          ...e,
          path: resolved || e.path,   // rewrite to the variant that works
          exists: resolved != null,
        });
      }

      return {
        success: true,
        source: m3uPath,
        entries: enriched,
        parsed: entries.length,
        existing: enriched.filter((e) => e.exists).length,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('setmaker:export-m3u', async (event, payload) => {
    try {
      const tracks = (payload && Array.isArray(payload.tracks)) ? payload.tracks : [];
      if (tracks.length === 0) return { success: false, error: 'No tracks to export' };

      let destPath = payload && payload.destPath;
      if (!destPath) {
        const now = new Date();
        const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        const result = await dialog.showSaveDialog(mainWindow, {
          defaultPath: `setlist-${stamp}.m3u`,
          filters: [{ name: 'M3U Playlist', extensions: ['m3u'] }],
        });
        if (result.canceled || !result.filePath) return { success: false, cancelled: true };
        destPath = result.filePath;
      }

      const destDir = path.dirname(destPath);
      const lines = ['#EXTM3U'];
      for (const t of tracks) {
        const duration = typeof t.duration === 'number' && t.duration > 0 ? Math.round(t.duration) : -1;
        const artist = (t.artist || '').trim();
        const title = (t.title || path.basename(t.path || 'Unknown')).trim();
        const label = artist ? `${artist} - ${title}` : title;
        lines.push(`#EXTINF:${duration},${label}`);
        // Store paths relative to the .m3u location so the setlist stays portable
        // (move the folder, share it — players resolve tracks next to the playlist).
        // Always use forward slashes: the M3U convention, and players accept them
        // on Windows too, whereas back slashes break on macOS/Linux.
        const rel = t.path ? path.relative(destDir, t.path).split(path.sep).join('/') : '';
        lines.push(rel);
      }
      await writeFile(destPath, lines.join('\n') + '\n', 'utf8');
      return { success: true, destPath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── Set Extraction ──────────────────────────────────────────────────
  // Identify every track in a DJ set behind a YouTube link. Streams
  // { phase, percent, ... } via `extract:progress` and resolves with the final
  // ordered tracklist. Only one extraction runs at a time; a new start (or an
  // explicit cancel) aborts any in-flight run.
  let activeExtraction = null; // AbortController | null

  ipcMain.handle('extract:start', async (event, url) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { success: false, error: 'Paste a YouTube link to a DJ set.' };
    }
    const cls = classifyUrl(url);
    if (!cls || cls.source !== 'youtube-music') {
      return { success: false, error: 'That doesn\'t look like a YouTube link. Set Extraction works with YouTube / YouTube Music URLs.' };
    }

    if (activeExtraction) { try { activeExtraction.abort(); } catch (_) { /* ignore */ } }
    const controller = new AbortController();
    activeExtraction = controller;

    const emit = (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('extract:progress', data);
      }
    };

    try {
      const settings = settingsManager.getAll();
      return await extractSet(url, { ytDlp, settings, signal: controller.signal, onProgress: emit });
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (activeExtraction === controller) activeExtraction = null;
    }
  });

  ipcMain.handle('extract:cancel', () => {
    if (activeExtraction) {
      try { activeExtraction.abort(); } catch (_) { /* ignore */ }
      activeExtraction = null;
    }
    return { success: true };
  });

}
