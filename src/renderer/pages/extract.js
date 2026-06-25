import { showToast } from '../components/toast.js';

// Set Extraction — paste a YouTube DJ-set link, get back the tracklist in play
// order. The heavy lifting (download → fingerprint scan → merge) happens in the
// main process; this page drives it, shows progress, and renders the result.
// State is stashed on the app singleton so navigating away and back keeps the
// last result visible.

const PHASE_LABELS = {
  info: 'Reading set info…',
  downloading: 'Downloading set audio…',
  scanning: 'Identifying tracks…',
  merging: 'Building tracklist…',
  done: 'Done',
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export class ExtractPage {
  constructor(app) {
    this.app = app;
    this.container = null;
    this.running = false;

    const saved = app.extractState || {};
    this.tracks = saved.tracks || [];
    this.info = saved.info || null;
    this.lastUrl = saved.lastUrl || '';

    this._unsub = null;
    if (window.setengine && window.setengine.onExtractProgress) {
      this._unsub = window.setengine.onExtractProgress((data) => this._onProgress(data));
    }
  }

  destroy() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this.app.extractState = { tracks: this.tracks, info: this.info, lastUrl: this.lastUrl };
  }

  render(container) {
    this.container = container;

    const header = document.createElement('div');
    header.className = 'page-header';
    header.innerHTML = '<h1 class="page-title">Set Extraction</h1>';
    container.appendChild(header);

    const urlGroup = document.createElement('div');
    urlGroup.className = 'form-group';
    urlGroup.innerHTML = `
      <label class="form-label" for="extract-url-input">Paste a DJ set link</label>
      <div class="url-download-row">
        <input type="text" class="input-lg" id="extract-url-input"
               placeholder="YouTube link to a DJ set (long sets are fine)"
               spellcheck="false" autocomplete="off">
        <button class="btn" id="extract-start-btn">EXTRACT</button>
      </div>
      <div class="form-helper">Identifies the tracks played in the set and lists them in play order. Recognition runs through your configured engine (AudD or ACRCloud) — set it up in Settings. Heads-up: no engine is perfect — unreleased IDs, bootlegs, mashups and heavily-effected sections may not resolve.</div>
    `;
    container.appendChild(urlGroup);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'extract-status hidden';
    this.statusEl.innerHTML = `
      <div class="extract-status-row">
        <span id="extract-phase" class="text-secondary"></span>
        <span id="extract-percent" class="text-muted"></span>
      </div>
      <div class="progress-bar progress-lg mt-8"><div class="progress-fill" id="extract-progress-fill"></div></div>
    `;
    container.appendChild(this.statusEl);

    this.resultsEl = document.createElement('div');
    this.resultsEl.className = 'extract-results mt-24';
    container.appendChild(this.resultsEl);

    this.urlInput = container.querySelector('#extract-url-input');
    this.startBtn = container.querySelector('#extract-start-btn');
    if (this.lastUrl) this.urlInput.value = this.lastUrl;

    this.startBtn.addEventListener('click', () => (this.running ? this._cancel() : this._start()));
    this.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (!this.running) this._start(); }
    });

    this._renderResults();
    if (!this.running) this.urlInput.focus();
  }

  async _start() {
    const url = (this.urlInput.value || '').trim();
    if (!url) { showToast('Paste a DJ set link first', 'warning'); this.urlInput.focus(); return; }
    if (!window.setengine || !window.setengine.extractSet) { showToast('IPC not available', 'error'); return; }

    this.lastUrl = url;
    this.tracks = [];
    this.info = null;
    this._renderResults();
    this._setRunning(true);
    this._showStatus('info', 0);

    try {
      const res = await window.setengine.extractSet(url);
      if (!res || res.success === false) {
        showToast((res && res.error) || 'Extraction failed', 'error', 5000);
        return;
      }
      this.tracks = res.tracks || [];
      this.info = res.info || this.info;
      this._renderResults();
      if (this.tracks.length === 0) {
        showToast('No tracks could be identified in this set.', 'warning', 5000);
      } else {
        showToast(`Identified ${this.tracks.length} track${this.tracks.length === 1 ? '' : 's'}`, 'success');
      }
    } catch (err) {
      showToast(err.message || 'Extraction failed', 'error', 5000);
    } finally {
      this._setRunning(false);
      this._hideStatus();
    }
  }

  async _cancel() {
    if (window.setengine && window.setengine.cancelExtraction) {
      try { await window.setengine.cancelExtraction(); } catch (_) { /* ignore */ }
    }
  }

  _onProgress(data) {
    if (!data) return;
    if (data.info && data.info.title) this.info = data.info;
    this._showStatus(data.phase, data.percent);
  }

  _setRunning(on) {
    this.running = on;
    if (this.startBtn) this.startBtn.textContent = on ? 'CANCEL' : 'EXTRACT';
    if (this.urlInput) this.urlInput.disabled = on;
  }

  _showStatus(phase, percent) {
    if (!this.statusEl) return;
    this.statusEl.classList.remove('hidden');
    const phaseEl = document.getElementById('extract-phase');
    const pctEl = document.getElementById('extract-percent');
    const fill = document.getElementById('extract-progress-fill');
    if (phaseEl) phaseEl.textContent = PHASE_LABELS[phase] || '';
    const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
    if (pctEl) pctEl.textContent = `${p}%`;
    if (fill) fill.style.width = `${p}%`;
  }

  _hideStatus() {
    if (this.statusEl) this.statusEl.classList.add('hidden');
  }

  _renderResults() {
    if (!this.resultsEl) return;
    this.resultsEl.innerHTML = '';

    if (!this.tracks.length) {
      this.resultsEl.innerHTML = '<div class="extract-empty text-muted">No tracks yet. Paste a set link and click EXTRACT.</div>';
      return;
    }

    const head = document.createElement('div');
    head.className = 'extract-results-head';
    const title = (this.info && this.info.title) ? this.info.title : 'Tracklist';
    head.innerHTML = `<span class="card-title">${escapeHtml(title)}</span>`
      + `<span class="text-muted">${this.tracks.length} tracks</span>`;
    this.resultsEl.appendChild(head);

    const list = document.createElement('div');
    list.className = 'extract-list';
    this.tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'extract-row';
      const label = t.artist ? `${t.artist} — ${t.title}` : t.title;
      row.innerHTML = `
        <span class="extract-row-num">${i + 1}</span>
        <span class="extract-row-title">${escapeHtml(label)}</span>
        <span class="extract-row-time text-muted">${formatTime(t.offsetSec)}</span>
      `;
      list.appendChild(row);
    });
    this.resultsEl.appendChild(list);
  }
}
