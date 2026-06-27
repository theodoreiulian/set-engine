// SetEngine — Set Extraction job manager
//
// Each DJ-set extraction is its own *job*. This manager is the single source of
// truth for every job's state (mirroring DownloadManager): the renderer is a
// pure view that lists jobs, subscribes to updates, and can navigate on/off a
// running job without affecting it. Multiple jobs run in parallel under a small
// concurrency cap; each owns a private cache directory, so deleting a job also
// deletes its cached track downloads.
//
// Events (main → renderer):
//   extract:jobs-update   — the full sanitized job list (structural changes)
//   extract:job-progress  — one sanitized job (phase/percent ticks)

import pLimit from 'p-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { app } from 'electron';
import { classifyUrl } from './sources.js';
import { extractSet } from './set-extractor.js';

// How many extractions may scan/download at once. Extra jobs sit in `queued`
// and start as slots free up. Kept low to stay under AudD/ACRCloud rate limits
// and YouTube's per-IP bot-check threshold when many sets are fired off at once.
const MAX_CONCURRENT_EXTRACTIONS = 3;

export default class ExtractionJobManager {
  constructor(mainWindow, ytDlp, settingsManager) {
    this.mainWindow = mainWindow;
    this.ytDlp = ytDlp;
    this.settingsManager = settingsManager;
    this.jobs = new Map();
    this.limit = pLimit(MAX_CONCURRENT_EXTRACTIONS);
  }

  // Root that holds every job's private cache subdir. Jobs are in-memory (not
  // persisted across restart), so main.js wipes this whole dir at boot.
  static cacheRoot() {
    return path.join(app.getPath('userData'), 'ExtractionCache');
  }

  // Validate + enqueue a new extraction. Returns { success, id } | { success:false, error }.
  // Mirrors the gate the old extract:start used so the renderer gets the same
  // friendly messages.
  addJob(url) {
    if (typeof url !== 'string' || !url.trim()) {
      return { success: false, error: 'Paste a YouTube link to a DJ set.' };
    }
    const cls = classifyUrl(url);
    if (!cls || cls.source !== 'youtube-music') {
      return { success: false, error: 'That doesn\'t look like a YouTube link. Set Extraction works with YouTube / YouTube Music URLs.' };
    }

    const id = crypto.randomUUID();
    const job = {
      id,
      url: url.trim(),
      title: url.trim(),       // replaced with the set title once info loads
      status: 'queued',        // queued | running | done | error | cancelled
      phase: null,             // info | downloading | scanning | merging | caching | done
      percent: 0,
      tracks: [],
      engine: null,
      info: null,
      error: null,
      createdAt: Date.now(),
      cacheDir: path.join(ExtractionJobManager.cacheRoot(), id),
      trackDownloads: {},      // { [trackIndex]: downloadId | sentinel }
      _abort: null,
    };
    this.jobs.set(id, job);
    this._broadcast();

    // Fire-and-forget through the limiter so the IPC returns the id immediately
    // and the cap naturally queues extras.
    this.limit(() => this._run(job));

    return { success: true, id };
  }

  async _run(job) {
    // The job may have been cancelled/deleted while it waited for a slot.
    if (!this.jobs.has(job.id) || job.status === 'cancelled') return;

    const controller = new AbortController();
    job._abort = controller;
    job.status = 'running';
    job.phase = 'info';
    job.percent = 0;
    this._broadcast();

    const onProgress = (data) => {
      if (!data) return;
      if (data.phase) job.phase = data.phase;
      if (typeof data.percent === 'number') job.percent = data.percent;
      if (data.info) { job.info = data.info; if (data.info.title) job.title = data.info.title; }
      this._emitProgress(job);
    };

    try {
      const settings = this.settingsManager.getAll();
      const res = await extractSet(job.url, {
        ytDlp: this.ytDlp,
        settings,
        signal: controller.signal,
        cacheDir: job.cacheDir,
        onProgress,
      });
      // Deleted mid-run — nothing to record.
      if (!this.jobs.has(job.id)) return;
      job.tracks = (res && res.tracks) || [];
      job.engine = (res && res.engine) || null;
      job.info = (res && res.info) || job.info;
      job.status = 'done';
      job.phase = 'done';
      job.percent = 100;
    } catch (err) {
      if (!this.jobs.has(job.id)) return;
      if (controller.signal.aborted) {
        job.status = 'cancelled';
      } else {
        job.status = 'error';
        job.error = err && err.message ? err.message : 'Extraction failed';
      }
    } finally {
      job._abort = null;
      this._broadcast();
    }
  }

  cancelJob(id) {
    const job = this.jobs.get(id);
    if (!job) return { success: false };
    if (job._abort) { try { job._abort.abort(); } catch (_) { /* ignore */ } }
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled';
    }
    this._broadcast();
    return { success: true };
  }

  // Cancel (if running) then remove the job and its private cache directory.
  async deleteJob(id) {
    const job = this.jobs.get(id);
    if (!job) return { success: true };
    if (job._abort) { try { job._abort.abort(); } catch (_) { /* ignore */ } }
    // Drop from the map first so a late _run resolution can't resurrect it.
    this.jobs.delete(id);
    this._broadcast();
    try {
      await rm(job.cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (_) { /* best-effort */ }
    return { success: true };
  }

  // Persist the track-index → download-id mapping onto the job so the per-row
  // ✔/progress state survives navigating off and back onto the job. `entries`
  // is an array of { index, id } (id may be a 'copied-'/'skipped-' sentinel).
  recordTrackDownloads(jobId, entries) {
    const job = this.jobs.get(jobId);
    if (!job || !Array.isArray(entries)) return;
    for (const e of entries) {
      if (!e || typeof e.index !== 'number') continue;
      job.trackDownloads[e.index] = e.id;
    }
    this._broadcast();
  }

  // Abort every in-flight job without removing it — used on app quit so no
  // recognizer/API work keeps running after the window is gone.
  abortAll() {
    for (const job of this.jobs.values()) {
      if (job._abort) { try { job._abort.abort(); } catch (_) { /* ignore */ } }
    }
  }

  _sanitize(job) {
    const { _abort, ...clean } = job;
    return clean;
  }

  getJobs() {
    // Newest first so a freshly added job lands at the top of the list.
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => this._sanitize(j));
  }

  _broadcast() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('extract:jobs-update', this.getJobs());
    }
  }

  _emitProgress(job) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('extract:job-progress', this._sanitize(job));
    }
  }
}
