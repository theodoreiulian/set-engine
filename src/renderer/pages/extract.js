import { showToast } from '../components/toast.js';

// Set Extraction — paste a YouTube DJ-set link and get the tracklist in play
// order. Each extraction is its own *job* owned by the main process (the source
// of truth): jobs run in parallel, keep running while you navigate away, and
// each owns a private cache. This page is a pure view — a list of job cards plus
// a per-job detail (tracklist) you can click on and off without disturbing the
// running extraction.

const PHASE_LABELS = {
  info: 'Reading set info…',
  downloading: 'Downloading set audio…',
  scanning: 'Identifying tracks…',
  merging: 'Building tracklist…',
  caching: 'Caching tracks…',
  done: 'Done',
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function audioUrlForPath(p) {
  const utf8 = new TextEncoder().encode(String(p));
  let bin = '';
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `setengine-audio://local/${b64}`;
}

export class ExtractPage {
  constructor(app) {
    this.app = app;
    this.container = null;

    // Source of truth lives in main. We mirror the sanitized job list and patch
    // it from the two broadcast channels.
    this.jobs = [];

    const saved = app.extractState || {};
    this.view = saved.view === 'detail' ? 'detail' : 'list';
    this.selectedJobId = saved.selectedJobId || null;
    // Resolved destination folder (absolute). The on-screen path can show the
    // literal "~/Music" placeholder before settings load; we send this real path
    // (or null → let main fall back) rather than the display text.
    this.folderPath = saved.folderPath || null;

    this.audio = new Audio();
    this.audio.addEventListener('play', () => this._updateTrackRows());
    this.audio.addEventListener('pause', () => this._updateTrackRows());
    this.audio.addEventListener('ended', () => { this.playingIndex = -1; this._updateTrackRows(); });
    this.audio.addEventListener('error', () => {
      if (this.playingIndex !== -1) {
        showToast('Playback failed', 'error');
        this.playingIndex = -1;
        this._updateTrackRows();
      }
    });
    this.playingIndex = -1;

    // Live download-queue items (real ids only); per-track ✔/✖ sentinels live on
    // the job's trackDownloads map in main.
    this.queueMap = new Map();

    this.destroyed = false;
    this._startBusy = false;        // re-entrancy guard for EXTRACT
    this._dlAllBusy = false;        // re-entrancy guard for DOWNLOAD WHOLE SET
    this._rowBusy = new Set();       // per-row download re-entrancy guard (by index)
    this._renderedTrackCount = -1;   // detail: rebuild rows only when this changes
    this._renderedStatus = null;     // detail: rebuild when the job's status flips

    this._unsubs = [];
    if (window.setengine) {
      const sub = (name, fn) => { if (window.setengine[name]) this._unsubs.push(window.setengine[name](fn)); };
      sub('onExtractJobsUpdate', (jobs) => this._onJobsUpdate(jobs));
      sub('onExtractJobProgress', (job) => this._onJobProgress(job));
      sub('onQueueUpdate', (queue) => this._onQueueUpdate(queue));
      sub('onDownloadProgress', (data) => this._onDownloadEvent(data));
      sub('onDownloadComplete', (data) => this._onDownloadEvent(data));
      sub('onDownloadError', (data) => this._onDownloadEvent(data));
    }
  }

  destroy() {
    this.destroyed = true;
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
    // Jobs keep running in main — navigating away must NOT cancel them.
    if (this.audio) {
      // Reset playingIndex *before* clearing src: src='' fires an `error` event,
      // and the handler would otherwise show a spurious "Playback failed".
      this.playingIndex = -1;
      this.audio.pause();
      this.audio.src = '';
    }
    if (this.container) this.container.classList.remove('page-host');
    this.app.extractState = { view: this.view, selectedJobId: this.selectedJobId, folderPath: this.folderPath };
  }

  async render(container) {
    this.container = container;
    container.classList.add('page-host');

    const shell = document.createElement('div');
    shell.className = 'page-shell';
    shell.innerHTML = '<div class="page-topbar"><h1 class="page-title">Set Extraction</h1></div>';
    const scroll = document.createElement('div');
    scroll.className = 'page-body';
    this.body = document.createElement('div');
    this.body.className = 'page-content page-content-narrow';
    scroll.appendChild(this.body);
    shell.appendChild(scroll);
    container.appendChild(shell);

    await this.loadFolder();

    // Pull current job + download state from main before the first paint.
    if (window.setengine && window.setengine.getExtractionJobs) {
      try { this.jobs = await window.setengine.getExtractionJobs(); } catch (_) { this.jobs = []; }
    }
    if (window.setengine && window.setengine.getQueue) {
      try {
        const q = await window.setengine.getQueue();
        for (const item of (q || [])) this.queueMap.set(item.id, item);
      } catch (_) { /* ignore */ }
    }

    // A previously-selected job may have been deleted while we were away.
    if (this.view === 'detail' && !this._selectedJob()) this.view = 'list';
    this._renderView();
  }

  async loadFolder() {
    if (!window.setengine || !window.setengine.getSettings) return;
    try {
      const settings = await window.setengine.getSettings();
      if (settings && settings.downloadFolder) this.folderPath = settings.downloadFolder;
    } catch (_) { /* ignore */ }
  }

  async handleBrowse() {
    if (!window.setengine || !window.setengine.selectFolder) { showToast('IPC not available', 'error'); return; }
    try {
      const folder = await window.setengine.selectFolder();
      if (!folder) return;
      this.folderPath = folder;
      if (this.folderPathEl) this.folderPathEl.textContent = folder;
      if (window.setengine.saveSettings) {
        await window.setengine.saveSettings({ downloadFolder: folder });
        showToast('Destination folder updated', 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to select folder', 'error');
    }
  }

  _selectedJob() {
    return this.jobs.find((j) => j.id === this.selectedJobId) || null;
  }

  // ── View routing ────────────────────────────────────────────────────
  _goToList() {
    this.playingIndex = -1;
    if (this.audio) { this.audio.pause(); this.audio.src = ''; }
    this.view = 'list';
    this.selectedJobId = null;
    this._renderView();
  }

  _openJob(id) {
    if (this.selectedJobId !== id) {
      this.playingIndex = -1;
      if (this.audio) { this.audio.pause(); this.audio.src = ''; }
    }
    this.selectedJobId = id;
    this.view = 'detail';
    this._renderView();
  }

  _renderView() {
    if (!this.body) return;
    this.body.innerHTML = '';
    // Drop stale cached element refs from the previous view.
    this.folderPathEl = null;
    this.detailStatusEl = this.resultsEl = this.dlAllBtn = null;
    if (this.view === 'detail' && this._selectedJob()) this._renderDetail();
    else { this.view = 'list'; this._renderList(); }
  }

  // ── List view ───────────────────────────────────────────────────────
  _renderList() {
    const urlGroup = document.createElement('div');
    urlGroup.className = 'form-group';
    urlGroup.innerHTML = `
      <label class="form-label" for="extract-url-input">Paste a DJ set link</label>
      <div class="url-download-row">
        <input type="text" class="input-lg" id="extract-url-input"
               placeholder="YouTube link to a DJ set"
               spellcheck="false" autocomplete="off">
        <button class="btn" id="extract-start-btn">EXTRACT</button>
      </div>
      <div class="form-helper">Each extraction runs as its own job — start several and they run in parallel.</div>
    `;
    this.body.appendChild(urlGroup);

    this.urlInput = urlGroup.querySelector('#extract-url-input');
    const startBtn = urlGroup.querySelector('#extract-start-btn');
    startBtn.addEventListener('click', () => this._start());
    this.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._start(); }
    });

    this.jobsListEl = document.createElement('div');
    this.jobsListEl.className = 'extract-jobs mt-24';
    this.body.appendChild(this.jobsListEl);

    this._renderJobList();
    if (!this.destroyed) this.urlInput.focus();
  }

  _renderJobList() {
    if (!this.jobsListEl) return;
    this.jobsListEl.innerHTML = '';
    if (!this.jobs.length) {
      this.jobsListEl.innerHTML = '<div class="extract-empty text-muted">No extractions yet. Paste a set link above and click EXTRACT.</div>';
      return;
    }
    for (const job of this.jobs) this.jobsListEl.appendChild(this._renderJobCard(job));
  }

  _renderJobCard(job) {
    const card = document.createElement('div');
    card.className = 'extract-job-card';
    card.dataset.jobId = job.id;
    card.innerHTML = `
      <span class="job-dot ${job.status}"></span>
      <div class="job-card-main">
        <div class="job-card-title">${escapeHtml(job.title || job.url)}</div>
        <div class="job-card-sub text-muted"></div>
      </div>
      <button class="job-card-delete" aria-label="Delete job" title="Delete job">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" fill="none"/></svg>
      </button>
    `;
    card.querySelector('.job-card-sub').textContent = this._jobSubtitle(job);

    card.addEventListener('click', (e) => {
      if (e.target.closest('.job-card-delete')) return;
      this._openJob(job.id);
    });
    card.querySelector('.job-card-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      this._deleteJob(job.id);
    });
    return card;
  }

  _jobSubtitle(job) {
    switch (job.status) {
      case 'queued': return 'Queued';
      case 'running': {
        const label = PHASE_LABELS[job.phase] || 'Working…';
        const p = Math.round(job.percent || 0);
        const showPct = !(job.phase === 'scanning' && p === 0) && p > 0;
        return showPct ? `${label} ${p}%` : label;
      }
      case 'done': {
        const n = (job.tracks || []).length;
        return n ? `Done · ${n} track${n === 1 ? '' : 's'}` : 'Done · no tracks identified';
      }
      case 'error': return `Failed: ${job.error || 'unknown error'}`;
      case 'cancelled': return 'Cancelled';
      default: return '';
    }
  }

  _updateJobCard(job) {
    if (!this.jobsListEl) return;
    const card = this.jobsListEl.querySelector(`.extract-job-card[data-job-id="${job.id}"]`);
    if (!card) { this._renderJobList(); return; }
    const dot = card.querySelector('.job-dot');
    if (dot) dot.className = `job-dot ${job.status}`;
    const title = card.querySelector('.job-card-title');
    if (title) title.textContent = job.title || job.url;
    const sub = card.querySelector('.job-card-sub');
    if (sub) sub.textContent = this._jobSubtitle(job);
  }

  // ── Detail view ─────────────────────────────────────────────────────
  _renderDetail() {
    const job = this._selectedJob();
    if (!job) { this._goToList(); return; }
    this._renderedTrackCount = (job.tracks || []).length;
    this._renderedStatus = job.status;

    const back = document.createElement('button');
    back.className = 'btn-link extract-back';
    back.innerHTML = '← All extractions';
    back.addEventListener('click', () => this._goToList());
    this.body.appendChild(back);

    const head = document.createElement('div');
    head.className = 'extract-detail-head';
    head.innerHTML = `<div class="card-title">${escapeHtml(job.title || job.url)}</div>`;
    this.body.appendChild(head);

    // Destination folder (downloads from this job land here).
    const folderGroup = document.createElement('div');
    folderGroup.className = 'form-group mt-12';
    folderGroup.innerHTML = `
      <label class="form-label">Destination folder</label>
      <div class="folder-display">
        <span class="folder-path" id="extract-folder-path">${escapeHtml(this.folderPath || '~/Music')}</span>
        <button class="btn-secondary btn-sm" id="extract-browse-btn">BROWSE</button>
      </div>
    `;
    this.body.appendChild(folderGroup);
    this.folderPathEl = folderGroup.querySelector('#extract-folder-path');
    folderGroup.querySelector('#extract-browse-btn').addEventListener('click', () => this.handleBrowse());

    // Status bar — visible while the job is queued or running.
    this.detailStatusEl = document.createElement('div');
    this.detailStatusEl.className = 'extract-status mt-12';
    this.detailStatusEl.innerHTML = `
      <div class="extract-status-row">
        <span class="extract-phase text-secondary"></span>
        <span class="extract-percent text-muted"></span>
      </div>
      <div class="progress-bar progress-lg mt-8"><div class="progress-fill"></div></div>
      <div class="extract-status-actions mt-8">
        <button class="btn-secondary btn-sm extract-cancel-btn">CANCEL</button>
      </div>
    `;
    this.body.appendChild(this.detailStatusEl);
    this.detailStatusEl.querySelector('.extract-cancel-btn').addEventListener('click', () => this._cancelJob(job.id));

    // Results area.
    this.resultsEl = document.createElement('div');
    this.resultsEl.className = 'extract-results mt-16';
    this.body.appendChild(this.resultsEl);

    this._renderResults(job);
    this._updateDetailStatus(job);
  }

  _renderResults(job) {
    if (!this.resultsEl) return;
    this.resultsEl.innerHTML = '';
    const tracks = job.tracks || [];

    if (!tracks.length) {
      if (job.status === 'error') {
        this.resultsEl.innerHTML = `<div class="extract-empty text-danger">${escapeHtml(job.error || 'Extraction failed')}</div>`;
      } else if (job.status === 'done') {
        this.resultsEl.innerHTML = '<div class="extract-empty text-muted">No tracks could be identified in this set.</div>';
      } else if (job.status === 'cancelled') {
        this.resultsEl.innerHTML = '<div class="extract-empty text-muted">Extraction cancelled.</div>';
      } // running/queued → status bar carries the state; leave results empty
      return;
    }

    const head = document.createElement('div');
    head.className = 'extract-results-head flex-space-between';
    head.innerHTML = `
      <div>
        <div class="card-title">Tracklist</div>
        <div class="text-muted mt-4">${tracks.length} tracks</div>
      </div>
      <button class="btn btn-sm" id="extract-dl-all-btn">DOWNLOAD WHOLE SET</button>
    `;
    this.resultsEl.appendChild(head);
    this.dlAllBtn = head.querySelector('#extract-dl-all-btn');
    this.dlAllBtn.addEventListener('click', () => this._downloadAll());

    const list = document.createElement('div');
    list.className = 'extract-list';
    tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'extract-row';
      row.dataset.index = i;
      const label = t.artist ? `${t.artist} — ${t.title}` : t.title;
      row.innerHTML = `
        <button class="extract-play-btn" aria-label="Play/Pause">
          <svg viewBox="0 0 24 24" class="icon-play"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
          <svg viewBox="0 0 24 24" class="icon-pause hidden"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>
        </button>
        <span class="extract-row-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="extract-row-title">${escapeHtml(label)}</span>
        <div class="extract-row-actions">
          <button class="extract-dl-btn" aria-label="Download">
            <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>
          </button>
          <span class="extract-dl-status hidden"></span>
        </div>
      `;
      row.querySelector('.extract-play-btn').addEventListener('click', () => this._togglePlay(i, t));
      row.querySelector('.extract-dl-btn').addEventListener('click', () => this._downloadTrack(i, t));
      list.appendChild(row);
    });
    this.resultsEl.appendChild(list);
    this._updateTrackRows();
  }

  _updateDetailStatus(job) {
    if (!this.detailStatusEl) return;
    const active = job.status === 'running' || job.status === 'queued';
    this.detailStatusEl.classList.toggle('hidden', !active);
    if (!active) return;

    const phaseEl = this.detailStatusEl.querySelector('.extract-phase');
    const pctEl = this.detailStatusEl.querySelector('.extract-percent');
    const fillEl = this.detailStatusEl.querySelector('.progress-fill');
    const label = job.status === 'queued' ? 'Queued — waiting for a free slot…' : (PHASE_LABELS[job.phase] || '');
    if (phaseEl) phaseEl.textContent = label;

    const p = Math.max(0, Math.min(100, Math.round(job.percent || 0)));
    // AudD scans server-side and reports no intermediate progress (0→100), so
    // show an indeterminate bar while scanning sits at 0% rather than a stuck bar.
    const indeterminate = job.status === 'queued' || (job.phase === 'scanning' && p === 0);
    if (fillEl) {
      fillEl.classList.toggle('indeterminate', indeterminate);
      fillEl.style.width = indeterminate ? '' : `${p}%`;
    }
    if (pctEl) pctEl.textContent = indeterminate ? '' : `${p}%`;
  }

  // ── Job actions ─────────────────────────────────────────────────────
  async _start() {
    if (this._startBusy) return;
    const url = (this.urlInput && this.urlInput.value || '').trim();
    if (!url) { showToast('Paste a DJ set link first', 'warning'); if (this.urlInput) this.urlInput.focus(); return; }
    if (!window.setengine || !window.setengine.extractSet) { showToast('IPC not available', 'error'); return; }

    this._startBusy = true;
    try {
      const res = await window.setengine.extractSet(url);
      if (res && res.success) {
        if (this.urlInput) { this.urlInput.value = ''; this.urlInput.focus(); }
        showToast('Extraction started', 'success');
        // The jobs-update broadcast adds the card; nothing else to do here.
      } else {
        showToast((res && res.error) || 'Could not start extraction', 'error', 5000);
      }
    } catch (err) {
      showToast(err.message || 'Could not start extraction', 'error', 5000);
    } finally {
      this._startBusy = false;
    }
  }

  async _cancelJob(id) {
    if (window.setengine && window.setengine.cancelExtraction) {
      try { await window.setengine.cancelExtraction(id); } catch (_) { /* ignore */ }
    }
  }

  async _deleteJob(id) {
    if (!window.setengine || !window.setengine.deleteExtraction) return;
    try {
      await window.setengine.deleteExtraction(id);
      // If we were viewing this job, fall back to the list.
      if (this.selectedJobId === id) this._goToList();
    } catch (err) {
      showToast(err.message || 'Failed to delete job', 'error');
    }
  }

  // ── Broadcast handlers ──────────────────────────────────────────────
  _onJobsUpdate(jobs) {
    this.jobs = Array.isArray(jobs) ? jobs : [];
    if (this.destroyed) return;
    if (this.view === 'list') {
      this._renderJobList();
    } else {
      const job = this._selectedJob();
      if (!job) { this._goToList(); return; }
      // Rebuild the detail only when the track set or status changed; otherwise
      // patch in place so playback/scroll survive a routine trackDownloads tick.
      const tracksChanged = (job.tracks || []).length !== this._renderedTrackCount;
      const statusChanged = job.status !== this._renderedStatus;
      if (tracksChanged || statusChanged) this._renderView();   // clears body, rebuilds detail
      else { this._updateDetailStatus(job); this._updateTrackRows(); }
    }
  }

  _onJobProgress(job) {
    if (!job || !job.id) return;
    const idx = this.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) this.jobs[idx] = job; else this.jobs.unshift(job);
    if (this.destroyed) return;
    if (this.view === 'list') this._updateJobCard(job);
    else if (job.id === this.selectedJobId) this._updateDetailStatus(job);
  }

  _onQueueUpdate(queue) {
    this.queueMap.clear();
    for (const item of (queue || [])) this.queueMap.set(item.id, item);
    if (this.view === 'detail') this._updateTrackRows();
  }

  _onDownloadEvent(data) {
    if (!data || !data.id) return;
    this.queueMap.set(data.id, data);
    if (this.view === 'detail') this._updateTrackRowDOM(data.id);
  }

  // ── Tracklist playback + downloads ──────────────────────────────────
  _togglePlay(index, track) {
    if (this.playingIndex === index) {
      if (!this.audio.paused) this.audio.pause();
      else this.audio.play().catch(() => showToast('Failed to play audio', 'error'));
      return;
    }
    if (!track.cachePath) { showToast('Track not available in cache', 'error'); return; }
    this.audio.src = audioUrlForPath(track.cachePath);
    this.playingIndex = index;
    this.audio.play().catch(() => showToast('Failed to start audio', 'error'));
    this._updateTrackRows();
  }

  async _downloadTrack(index, track) {
    if (!window.setengine || !window.setengine.downloadTrack) return;
    if (this._rowBusy.has(index)) return;   // guard a fast double-click
    this._rowBusy.add(index);

    const query = track.artist ? `${track.artist} ${track.title}` : track.title;
    const row = this.resultsEl ? this.resultsEl.querySelector(`.extract-row[data-index="${index}"]`) : null;
    const dlBtn = row ? row.querySelector('.extract-dl-btn') : null;
    if (dlBtn) dlBtn.disabled = true;

    try {
      const res = await window.setengine.downloadTrack({
        query,
        title: track.title,
        artist: track.artist,
        trackNumber: String(index + 1),
        cachePath: track.cachePath,
        outputDir: this.folderPath,   // real path or null → main falls back
        jobId: this.selectedJobId,
        trackIndex: index,
      });
      if (res && res.success) {
        showToast(res.copied ? `Saved ${track.title}` : `Started downloading ${track.title}`, 'success');
      } else if (res && res.skipped) {
        showToast(res.error, 'warning', 5000);
      } else {
        showToast(res ? res.error : 'Download failed', 'error');
      }
    } catch (e) {
      showToast(e.message || 'Download error', 'error');
    } finally {
      this._rowBusy.delete(index);
      if (dlBtn) dlBtn.disabled = false;
      this._updateTrackRows();
    }
  }

  async _downloadAll() {
    const job = this._selectedJob();
    if (!job || !(job.tracks || []).length) return;
    if (!window.setengine || !window.setengine.downloadTracks) return;
    if (this._dlAllBusy) return;
    this._dlAllBusy = true;
    if (this.dlAllBtn) this.dlAllBtn.disabled = true;

    try {
      const res = await window.setengine.downloadTracks({
        tracks: job.tracks,
        outputDir: this.folderPath,
        playlistName: (job.info && job.info.title) || job.title || 'Tracklist',
        jobId: this.selectedJobId,
      });
      if (res && res.success) {
        const skipped = (res.ids || []).filter((id) => id == null).length;
        const ok = job.tracks.length - skipped;
        showToast(
          skipped ? `Processed ${ok} tracks · ${skipped} skipped (no match)` : `Processed ${ok} tracks and saved playlist`,
          skipped ? 'warning' : 'success',
        );
      } else {
        showToast(res ? res.error : 'Download all failed', 'error');
      }
    } catch (e) {
      showToast(e.message || 'Download error', 'error');
    } finally {
      this._dlAllBusy = false;
      if (this.dlAllBtn) this.dlAllBtn.disabled = false;
    }
  }

  _updateTrackRows() {
    if (!this.resultsEl) return;
    this.resultsEl.querySelectorAll('.extract-row').forEach((row) => {
      this._updateSingleRow(row, parseInt(row.dataset.index, 10));
    });
  }

  _updateTrackRowDOM(id) {
    const job = this._selectedJob();
    if (!job || !job.trackDownloads || !this.resultsEl) return;
    for (const [idxStr, dlId] of Object.entries(job.trackDownloads)) {
      if (dlId === id) {
        const row = this.resultsEl.querySelector(`.extract-row[data-index="${idxStr}"]`);
        if (row) this._updateSingleRow(row, parseInt(idxStr, 10));
        break;
      }
    }
  }

  _updateSingleRow(row, index) {
    const isPlaying = (this.playingIndex === index) && !this.audio.paused;
    const playIcon = row.querySelector('.icon-play');
    const pauseIcon = row.querySelector('.icon-pause');
    if (isPlaying) {
      row.classList.add('playing');
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    } else {
      row.classList.remove('playing');
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
    }

    const job = this._selectedJob();
    const dlId = job && job.trackDownloads ? job.trackDownloads[index] : undefined;
    let dlItem = null;
    if (dlId != null) {
      if (typeof dlId === 'string' && dlId.startsWith('copied-')) dlItem = { status: 'complete' };
      else if (typeof dlId === 'string' && dlId.startsWith('skipped-')) dlItem = { status: 'error', error: 'No matching YouTube result found' };
      else dlItem = this.queueMap.get(dlId) || { status: 'queued' };
    }

    const dlBtn = row.querySelector('.extract-dl-btn');
    const dlStatus = row.querySelector('.extract-dl-status');
    if (!dlItem) {
      dlBtn.classList.remove('hidden');
      dlStatus.classList.add('hidden');
      return;
    }
    dlBtn.classList.add('hidden');
    dlStatus.classList.remove('hidden');
    if (dlItem.status === 'complete') {
      dlStatus.innerHTML = '<span class="text-success" role="img" aria-label="Downloaded">✔</span>';
    } else if (dlItem.status === 'error') {
      dlStatus.innerHTML = '<span class="text-danger" role="img" aria-label="Download failed" title="' + escapeHtml(dlItem.error) + '">✖</span>';
      dlBtn.classList.remove('hidden'); // allow retry by clicking download again
    } else if (dlItem.status === 'downloading') {
      // The sanitized download item carries progress as `progress` (not `percent`).
      const pct = Math.round(dlItem.progress != null ? dlItem.progress : (dlItem.percent || 0));
      dlStatus.textContent = `${pct}%`;
    } else {
      dlStatus.textContent = 'Queued';
    }
  }
}
