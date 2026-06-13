// SetEngine — Preload script
// Exposes a safe IPC bridge to the renderer via window.setengine
// All communication between renderer ↔ main goes through these channels.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('setengine', {
  // ── Downloads ──────────────────────────────────────────────────────
  downloadURL: (url) => ipcRenderer.invoke('download:url', url),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', id),
  retryDownload: (id) => ipcRenderer.invoke('download:retry', id),
  getQueue: () => ipcRenderer.invoke('download:queue'),
  clearAll: () => ipcRenderer.invoke('download:clear'),

  // Progress events (main → renderer)
  onDownloadProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('download:progress', handler);
    return () => ipcRenderer.removeListener('download:progress', handler);
  },
  onDownloadComplete: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('download:complete', handler);
    return () => ipcRenderer.removeListener('download:complete', handler);
  },
  onDownloadError: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('download:error', handler);
    return () => ipcRenderer.removeListener('download:error', handler);
  },
  onQueueUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('download:queue-update', handler);
    return () => ipcRenderer.removeListener('download:queue-update', handler);
  },

  // ── Embedded Browser (per-source) ─────────────────────────────────
  openBrowser: (bounds, source) => ipcRenderer.invoke('browser:open', bounds, source),
  setBrowserSource: (source, bounds) => ipcRenderer.invoke('browser:set-source', source, bounds),
  resizeBrowser: (bounds) => ipcRenderer.invoke('browser:resize', bounds),
  closeBrowser: () => ipcRenderer.invoke('browser:close'),
  getBrowserSource: () => ipcRenderer.invoke('browser:get-source'),
  getAuthStatus: (source) => ipcRenderer.invoke('browser:auth-status', source),
  extractCookies: (source) => ipcRenderer.invoke('browser:extract-cookies', source),
  onAuthChange: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('browser:auth-change', handler);
    return () => ipcRenderer.removeListener('browser:auth-change', handler);
  },
  onBrowserNavigate: (cb) => {
    const handler = (_e, url) => cb(url);
    ipcRenderer.on('browser:navigate', handler);
    return () => ipcRenderer.removeListener('browser:navigate', handler);
  },
  onBrowserLoadFailed: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('browser:load-failed', handler);
    return () => ipcRenderer.removeListener('browser:load-failed', handler);
  },
  browserBack: () => ipcRenderer.invoke('browser:back'),
  browserForward: () => ipcRenderer.invoke('browser:forward'),
  browserRefresh: () => ipcRenderer.invoke('browser:refresh'),
  getBrowserUrl: () => ipcRenderer.invoke('browser:get-url'),
  scrapePageResults: () => ipcRenderer.invoke('browser:scrape-results'),

  // ── Settings ──────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  selectFolders: () => ipcRenderer.invoke('dialog:select-folders'),
  selectAudioFiles: () => ipcRenderer.invoke('dialog:select-audio-files'),
  scanFoldersForAudio: (paths) => ipcRenderer.invoke('match:scan-folders', paths),
  readAudioFileBytes: (filePath) => ipcRenderer.invoke('match:read-file', filePath),

  // ── Set Maker ─────────────────────────────────────────────────────
  buildSet: (tracks, opts) => ipcRenderer.invoke('setmaker:build', { tracks, opts }),
  rescoreTour: (tracks) => ipcRenderer.invoke('setmaker:rescore-tour', { tracks }),
  rateTrack: (filePath, stars) => ipcRenderer.invoke('setmaker:rate', { filePath, stars }),
  readRating: (filePath) => ipcRenderer.invoke('setmaker:read-rating', filePath),
  exportM3U: (tracks, destPath) => ipcRenderer.invoke('setmaker:export-m3u', { tracks, destPath }),
  importM3U: () => ipcRenderer.invoke('setmaker:import-m3u'),
  analyzeBatch: (tracks) => ipcRenderer.invoke('setmaker:analyze-batch', { tracks }),
  analyzeOne: (filePath) => ipcRenderer.invoke('setmaker:analyze-one', { path: filePath }),
  onAnalysisProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('setmaker:analysis-progress', handler);
    return () => ipcRenderer.removeListener('setmaker:analysis-progress', handler);
  },

  // ── BPM/Key detection + tagging ───────────────────────────────────
  detectAndTagFiles: (items) => ipcRenderer.invoke('tags:detect-and-tag', { items }),
  onTagProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('tags:progress', handler);
    return () => ipcRenderer.removeListener('tags:progress', handler);
  },

  // ── URL Detection ─────────────────────────────────────────────────
  detectURL: (url) => ipcRenderer.invoke('url:detect', url),
  classifyURL: (url) => ipcRenderer.invoke('url:classify', url),
  searchVideos: (query) => ipcRenderer.invoke('ytmusic:search', query),
  searchSpotify: (query) => ipcRenderer.invoke('spotify:search', query),

  // ── System ────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkDeps: () => ipcRenderer.invoke('deps:check'),
  updateYtdlp: () => ipcRenderer.invoke('ytdlp:update'),
  getYtdlpHealth: () => ipcRenderer.invoke('ytdlp:health'),
  updateSpotdl: () => ipcRenderer.invoke('spotdl:update'),
  getSpotdlHealth: () => ipcRenderer.invoke('spotdl:health'),
});
