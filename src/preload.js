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

  // ── Set Extraction ────────────────────────────────────────────────
  // Identify every track in a DJ set behind a YouTube link. `extractSet`
  // resolves with the final ordered tracklist; `onExtractProgress` streams
  // { phase, percent, ... } updates while it runs.
  extractSet: (url) => ipcRenderer.invoke('extract:start', url),
  cancelExtraction: () => ipcRenderer.invoke('extract:cancel'),
  onExtractProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('extract:progress', handler);
    return () => ipcRenderer.removeListener('extract:progress', handler);
  },

  // ── URL Classification ────────────────────────────────────────────
  // Identify a pasted link's source (youtube-music | spotify) and shape
  // (track | playlist) so the Download page can validate before queueing.
  classifyURL: (url) => ipcRenderer.invoke('url:classify', url),

  // ── System ────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkDeps: () => ipcRenderer.invoke('deps:check'),
  updateYtdlp: () => ipcRenderer.invoke('ytdlp:update'),
  getYtdlpHealth: () => ipcRenderer.invoke('ytdlp:health'),
  updateSpotdl: () => ipcRenderer.invoke('spotdl:update'),
  getSpotdlHealth: () => ipcRenderer.invoke('spotdl:health'),
});
