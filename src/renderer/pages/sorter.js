import { showToast } from '../components/toast.js';
import { escapeHtml } from '../utils/escape-html.js';

// Crate Sorter — triage loose audio files into destination "crates" by copying.
// Two views in one page: a SETUP view (load songs + choose crates) and a SORT
// view (sidebar of all songs + player + per-song crate toggles). Advancing
// commits the current selection by copying the file into each chosen crate.
// The source file is never moved or deleted. State lives on app.sorterState and
// survives in-app navigation, not an app restart.
export class SorterPage {
  constructor(app) {
    this.app = app;
    const s = app.sorterState || {};
    this.view = s.view === 'sort' ? 'sort' : 'setup';
    this.songs = Array.isArray(s.songs) ? s.songs : [];
    this.sources = Array.isArray(s.sources) ? s.sources : [];
    this.destFolders = Array.isArray(s.destFolders) ? s.destFolders : [];
    this.currentIndex = typeof s.currentIndex === 'number' ? s.currentIndex : 0;

    this.player = null;       // { audio, handlers }
    this._onKeyDown = null;
    this.dom = {};
    this._dupNames = new Set();
  }

  render(container) {
    this.container = container;
    container.classList.add('sorter-host');
    const root = document.createElement('div');
    root.className = 'sorter-page';
    container.appendChild(root);
    this.dom.root = root;

    if (this.view === 'sort' && this.songs.length === 0) this.view = 'setup';
    this._renderCurrentView();

    if (this.view === 'sort') {
      this._attachKeys();
      if (this.currentIndex < this.songs.length) {
        this._scrollCurrentIntoView();
        this._startPlaybackForCurrent();
      }
    }
  }

  destroy() {
    this._stopPlayback();
    this._detachKeys();
    if (this.container) this.container.classList.remove('sorter-host');
    this.app.sorterState = {
      view: this.view,
      songs: this.songs,
      sources: this.sources,
      destFolders: this.destFolders,
      currentIndex: this.currentIndex,
    };
  }

  // ── View switching ─────────────────────────────────────────────────

  _renderCurrentView() {
    if (this.view === 'sort' && this.songs.length === 0) this.view = 'setup';
    if (this.view === 'setup') this._renderSetup(this.dom.root);
    else this._renderSort(this.dom.root);
  }

  _setView(v) {
    this._detachKeys();
    this._stopPlayback();
    this.view = v;
    this._renderCurrentView();
    if (v === 'sort') {
      this._attachKeys();
      if (this.currentIndex < this.songs.length) {
        this._scrollCurrentIntoView();
        this._startPlaybackForCurrent();
      }
    }
  }

  // ── SETUP view ─────────────────────────────────────────────────────

  _renderSetup(root) {
    const songCount = this.songs.length;
    const ready = songCount > 0 && this.destFolders.length > 0;
    root.innerHTML = `
      <div class="sorter-topbar"><div class="page-title">Crate Sorter</div></div>
      <div class="sorter-setup">
        <div class="sorter-setup-inner">
          <p class="sorter-lead">Load a batch of songs, pick the crates to sort them into, then work through them one at a time. Songs are <strong>copied</strong> into the crates you choose — the originals are never moved or deleted.</p>

          <div class="section">
            <div class="section-title">Songs to sort</div>
            <div class="sorter-btn-row">
              <button class="btn-secondary" id="sorter-add-folder">+ Add folder(s)</button>
              ${songCount ? '<button class="btn-secondary" id="sorter-clear-songs">Clear all</button>' : ''}
            </div>
            <div class="sorter-count">${songCount} song${songCount === 1 ? '' : 's'} loaded</div>
            <div class="sorter-source-list">${this._renderSourceRows()}</div>
          </div>

          <div class="section">
            <div class="section-title">Destination crates</div>
            <div class="sorter-btn-row">
              <button class="btn-secondary" id="sorter-add-dest">+ Add folder(s)</button>
            </div>
            <div class="sorter-chips">${this._renderDestChips()}</div>
          </div>

          <div class="sorter-start-row">
            <button class="btn" id="sorter-start" ${ready ? '' : 'disabled'}>Start sorting →</button>
            ${ready ? '' : '<span class="sorter-hint">Add at least one song and one destination crate to begin.</span>'}
          </div>
        </div>
      </div>
    `;

    root.querySelector('#sorter-add-folder').addEventListener('click', () => this._addSourceFolder());
    const clearBtn = root.querySelector('#sorter-clear-songs');
    if (clearBtn) clearBtn.addEventListener('click', () => this._clearSongs());
    root.querySelector('#sorter-add-dest').addEventListener('click', () => this._addDestFolders());
    const startBtn = root.querySelector('#sorter-start');
    if (startBtn) startBtn.addEventListener('click', () => this._startSorting());
    root.querySelectorAll('[data-remove-source]').forEach((b) =>
      b.addEventListener('click', () => this._removeSource(b.dataset.removeSource)));
    root.querySelectorAll('[data-remove-dest]').forEach((b) =>
      b.addEventListener('click', () => this._removeDest(parseInt(b.dataset.removeDest, 10))));
  }

  _renderSourceRows() {
    if (!this.sources.length) return '<div class="sorter-empty">No songs added yet.</div>';
    return this.sources.map((s) => `
      <div class="sorter-source-row" title="${escapeHtml(s.title || '')}">
        <span class="sorter-source-label">${escapeHtml(s.label)}</span>
        <span class="sorter-source-count">${s.count} song${s.count === 1 ? '' : 's'}</span>
        <button class="sorter-x" data-remove-source="${escapeHtml(s.id)}" title="Remove">✕</button>
      </div>`).join('');
  }

  _renderDestChips() {
    if (!this.destFolders.length) return '<div class="sorter-empty">No crates chosen yet.</div>';
    return this.destFolders.map((f, i) => `
      <div class="sorter-chip" title="${escapeHtml(f.path)}">
        <span class="sorter-chip-key">${i < 9 ? i + 1 : ''}</span>
        <span class="sorter-chip-name">${escapeHtml(f.name)}</span>
        <button class="sorter-x" data-remove-dest="${i}" title="Remove">✕</button>
      </div>`).join('');
  }

  _rerenderSetup() {
    this._renderSetup(this.dom.root);
  }

  async _addSourceFolder() {
    let res;
    try { res = await window.setengine.sorterAddSourceFolder(); }
    catch (err) { showToast(`Could not read folder: ${err.message}`, 'error'); return; }
    if (!res || !res.success) { if (res && res.error) showToast(res.error, 'error'); return; }

    let totalAdded = 0;
    let totalFound = 0;
    for (const entry of res.folders) {
      totalFound += entry.files.length;
      if (!entry.files.length) continue;
      const sourceId = this._uid();
      const added = this._mergeFiles(entry.files, sourceId);
      if (added === 0) continue;
      this.sources.push({ id: sourceId, kind: 'folder', label: this._basename(entry.folder), title: entry.folder, count: added });
      totalAdded += added;
    }

    if (totalAdded === 0) {
      showToast(totalFound === 0 ? 'No audio files found in the selected folder(s).' : 'Those songs are already in the list.', 'warning', 3500);
      return;
    }
    this._sortSongs();
    this._rerenderSetup();
    showToast(`Added ${totalAdded} song${totalAdded === 1 ? '' : 's'}.`, 'success', 2500);
  }

  _mergeFiles(files, sourceId) {
    const existing = new Set(this.songs.map((s) => s.normPath));
    let added = 0;
    for (const f of files) {
      const normPath = String(f.path);
      if (existing.has(normPath)) continue;
      existing.add(normPath);
      this.songs.push(this._makeRecord(f, sourceId, normPath));
      added++;
    }
    return added;
  }

  _makeRecord(f, sourceId, normPath) {
    return {
      id: this._uid(),
      sourceId,
      path: f.path,
      normPath,
      name: f.name || this._basename(f.path),
      size: f.size || 0,
      parentName: this._parentName(f.path),
      selectedFolders: new Set(),
      copiedFolders: new Set(),
      status: 'pending',
      missing: false,
    };
  }

  _sortSongs() {
    this.songs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }

  _removeSource(id) {
    this.sources = this.sources.filter((s) => s.id !== id);
    this.songs = this.songs.filter((s) => s.sourceId !== id);
    if (this.currentIndex > this.songs.length) this.currentIndex = this.songs.length;
    this._rerenderSetup();
  }

  _clearSongs() {
    this.songs = [];
    this.sources = [];
    this.currentIndex = 0;
    this._rerenderSetup();
  }

  async _addDestFolders() {
    let res;
    try { res = await window.setengine.sorterAddDestFolders(); }
    catch (err) { showToast(`Could not add crates: ${err.message}`, 'error'); return; }
    if (!res || !res.success) { if (res && res.error) showToast(res.error, 'error'); return; }
    const existing = new Set(this.destFolders.map((f) => f.path));
    let added = 0;
    for (const f of res.folders) {
      if (existing.has(f.path)) continue;
      existing.add(f.path);
      this.destFolders.push(f);
      added++;
    }
    this._rerenderSetup();
    if (added === 0) showToast('Those crates are already in the list.', 'info', 3000);
  }

  _removeDest(i) {
    if (i >= 0 && i < this.destFolders.length) {
      this.destFolders.splice(i, 1);
      this._rerenderSetup();
    }
  }

  _startSorting() {
    if (!this.songs.length || !this.destFolders.length) return;
    let idx = this.songs.findIndex((s) => s.status === 'pending');
    if (idx < 0) idx = 0;
    this.currentIndex = idx;
    this._seedSelectionForCurrent();
    this._setView('sort');
  }

  // ── SORT view ──────────────────────────────────────────────────────

  _renderSort(root) {
    const total = this.songs.length;
    const sorted = this.songs.filter((s) => s.status === 'sorted').length;
    const skipped = this.songs.filter((s) => s.status === 'skipped').length;
    const done = this.currentIndex >= total;

    // Precompute which display names are shared so we can show a parent-folder
    // subtitle only where it's needed to disambiguate.
    const counts = new Map();
    for (const s of this.songs) {
      const k = s.name.toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    this._dupNames = new Set([...counts].filter(([, c]) => c > 1).map(([n]) => n));

    root.innerHTML = `
      <div class="sorter-sort-layout">
        <aside class="sorter-sidebar">
          <div class="sorter-sidebar-head">
            <div class="sorter-progress">${Math.min(this.currentIndex, total)} / ${total}</div>
            <div class="sorter-progress-sub">${sorted} sorted · ${skipped} skipped</div>
          </div>
          <div class="sorter-sidebar-list">
            ${this.songs.map((s, i) => this._songRow(s, i)).join('')}
          </div>
          <div class="sorter-sidebar-foot">
            <button class="btn-secondary btn-sm" id="sorter-back-setup">← Setup</button>
          </div>
        </aside>
        <main class="sorter-main">
          ${done ? this._completionHtml(sorted, skipped) : this._playerHtml()}
        </main>
      </div>
    `;

    root.querySelectorAll('[data-song-idx]').forEach((b) =>
      b.addEventListener('click', () => this._goToSong(parseInt(b.dataset.songIdx, 10))));
    root.querySelector('#sorter-back-setup').addEventListener('click', () => this._setView('setup'));

    if (done) {
      const rev = root.querySelector('#sorter-review');
      if (rev) rev.addEventListener('click', () => this._goToSong(0));
      const cs = root.querySelector('#sorter-complete-setup');
      if (cs) cs.addEventListener('click', () => this._setView('setup'));
      return;
    }

    root.querySelector('#sorter-play').addEventListener('click', () => this._togglePlay());
    const seek = root.querySelector('#sorter-seek');
    seek.addEventListener('click', (e) => this._seekClick(e, seek));
    root.querySelector('#sorter-prev').addEventListener('click', () => this._goToSong(this.currentIndex - 1));
    root.querySelector('#sorter-next').addEventListener('click', () => this._advance());
    root.querySelectorAll('[data-folder-idx]').forEach((b) =>
      b.addEventListener('click', () => this._toggleFolder(this.destFolders[parseInt(b.dataset.folderIdx, 10)].path)));

    // Sync the freshly-built DOM with any playback already in progress.
    this._updatePlayBtn();
    this._updateSeek();
  }

  _songRow(s, i) {
    const cls = ['sorter-song'];
    if (i === this.currentIndex) cls.push('is-current');
    if (s.missing) cls.push('is-missing');
    else cls.push('is-' + s.status);
    const sub = this._dupNames.has(s.name.toLowerCase()) && s.parentName
      ? `<span class="sorter-song-sub">${escapeHtml(s.parentName)}</span>` : '';
    return `
      <button class="${cls.join(' ')}" data-song-idx="${i}">
        <span class="sorter-song-dot"></span>
        <span class="sorter-song-main">
          <span class="sorter-song-name">${escapeHtml(s.name)}</span>
          ${sub}
        </span>
      </button>`;
  }

  _foldersHtml(song) {
    return this.destFolders.map((f, i) => {
      const copied = song.copiedFolders.has(f.path);
      const selected = song.selectedFolders.has(f.path);
      const cls = ['sorter-folder'];
      if (copied) cls.push('is-copied');
      else if (selected) cls.push('is-selected');
      const badge = copied
        ? '<span class="sorter-folder-badge copied">COPIED</span>'
        : (selected ? '<span class="sorter-folder-badge sel">SELECTED</span>' : '');
      return `
        <button class="${cls.join(' ')}" data-folder-idx="${i}">
          <span class="sorter-folder-key">${i < 9 ? i + 1 : ''}</span>
          <span class="sorter-folder-name">${escapeHtml(f.name)}</span>
          ${badge}
        </button>`;
    }).join('');
  }

  _playerHtml() {
    const song = this.songs[this.currentIndex];
    return `
      <div class="sorter-now">
        <div class="sorter-now-index">${this.currentIndex + 1} of ${this.songs.length}</div>
        <div class="sorter-now-title">${escapeHtml(song.name)}</div>
        ${song.parentName ? `<div class="sorter-now-sub">${escapeHtml(song.parentName)}</div>` : ''}
        ${song.missing ? '<div class="sorter-now-missing">This file is no longer on disk.</div>' : ''}
        <div class="sorter-player">
          <button class="sorter-play-btn" id="sorter-play">▶</button>
          <div class="sorter-seek" id="sorter-seek"><div class="sorter-seek-fill"></div></div>
          <div class="sorter-seek-time">0:00 / 0:00</div>
        </div>
      </div>
      <div class="sorter-folders-head">Sort into crates <span class="sorter-folders-hint">(press 1–9 to toggle)</span></div>
      <div class="sorter-folders">${this._foldersHtml(song)}</div>
      <div class="sorter-actions">
        <button class="btn-secondary" id="sorter-prev" ${this.currentIndex <= 0 ? 'disabled' : ''}>← Previous</button>
        <button class="btn" id="sorter-next">${this._nextLabel(song)}</button>
      </div>
      <div class="sorter-keyhint">Space play/pause · ←/→ seek 5s (Shift 15s) · 1–9 crate · Enter next · ↑ previous</div>
    `;
  }

  _nextLabel(song) {
    const hasPending = [...song.selectedFolders].some((f) => !song.copiedFolders.has(f));
    if (hasPending) return 'Sort & Next →';
    if (song.copiedFolders.size > 0) return 'Next →';
    return 'Skip & Next →';
  }

  _completionHtml(sorted, skipped) {
    const missing = this.songs.filter((s) => s.missing).length;
    return `
      <div class="sorter-complete">
        <div class="sorter-complete-title">All done</div>
        <div class="sorter-complete-stats">${sorted} sorted · ${skipped} skipped${missing ? ` · ${missing} missing` : ''}</div>
        <div class="sorter-complete-actions">
          <button class="btn-secondary" id="sorter-review">Review from start</button>
          <button class="btn" id="sorter-complete-setup">Back to setup</button>
        </div>
      </div>`;
  }

  _rerenderSort(opts) {
    if (this.view !== 'sort') return;
    const listEl = this.dom.root.querySelector('.sorter-sidebar-list');
    const scroll = listEl ? listEl.scrollTop : 0;
    this._renderSort(this.dom.root);
    const newList = this.dom.root.querySelector('.sorter-sidebar-list');
    if (newList) {
      if (opts && opts.scrollToCurrent) {
        const cur = newList.querySelector('.sorter-song.is-current');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      } else {
        newList.scrollTop = scroll;
      }
    }
  }

  _scrollCurrentIntoView() {
    const newList = this.dom.root.querySelector('.sorter-sidebar-list');
    if (!newList) return;
    const cur = newList.querySelector('.sorter-song.is-current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  _toggleFolder(folderPath) {
    const song = this.songs[this.currentIndex];
    if (!song) return;
    if (song.copiedFolders.has(folderPath)) return; // already committed — locked
    if (song.selectedFolders.has(folderPath)) song.selectedFolders.delete(folderPath);
    else song.selectedFolders.add(folderPath);
    // Only the crate region + the Next-button label change on a toggle; the
    // sidebar (statuses) is untouched, so update in place rather than rebuild it.
    this._renderFolders();
  }

  _renderFolders() {
    const song = this.songs[this.currentIndex];
    if (!song) return;
    const cont = this.dom.root.querySelector('.sorter-folders');
    if (cont) {
      cont.innerHTML = this._foldersHtml(song);
      cont.querySelectorAll('[data-folder-idx]').forEach((b) =>
        b.addEventListener('click', () => this._toggleFolder(this.destFolders[parseInt(b.dataset.folderIdx, 10)].path)));
    }
    const nextBtn = this.dom.root.querySelector('#sorter-next');
    if (nextBtn) nextBtn.textContent = this._nextLabel(song);
  }

  _seedSelectionForCurrent() {
    const song = this.songs[this.currentIndex];
    if (!song) return;
    for (const f of song.copiedFolders) song.selectedFolders.add(f);
  }

  _goToSong(i) {
    if (i < 0) return;
    this._stopPlayback();
    if (i > this.songs.length) i = this.songs.length;
    this.currentIndex = i;
    if (i < this.songs.length) this._seedSelectionForCurrent();
    this._rerenderSort({ scrollToCurrent: true });
    if (i < this.songs.length) this._startPlaybackForCurrent();
  }

  async _advance() {
    const song = this.songs[this.currentIndex];
    if (song) await this._commit(song);
    this._goToSong(this.currentIndex + 1);
  }

  async _commit(song) {
    const toCopy = [...song.selectedFolders].filter((f) => !song.copiedFolders.has(f));
    if (toCopy.length) {
      let res;
      try { res = await window.setengine.sorterCopyIntoFolders({ sourcePath: song.path, destFolders: toCopy }); }
      catch (err) { showToast(`Copy failed: ${err.message}`, 'error', 4000); return; }
      if (res && res.missing) {
        song.missing = true;
        showToast(`"${song.name}" is no longer on disk — not copied.`, 'error', 4500);
        return;
      }
      if (res && res.success) {
        const failed = [];
        for (const r of res.results) {
          if (r.status === 'copied' || r.status === 'exists') song.copiedFolders.add(r.folder);
          else if (r.status === 'error') failed.push(this._folderName(r.folder));
        }
        if (failed.length) showToast(`Couldn't copy into: ${failed.join(', ')}`, 'error', 5000);
      } else {
        showToast(`Copy failed: ${(res && res.error) || 'unknown'}`, 'error', 4000);
        return;
      }
    }
    song.status = song.copiedFolders.size > 0 ? 'sorted' : 'skipped';
  }

  _folderName(folderPath) {
    const f = this.destFolders.find((d) => d.path === folderPath);
    return f ? f.name : this._basename(folderPath);
  }

  // ── Audio playback (audio object is independent of the DOM, so a re-render
  //    of the sort view does NOT interrupt playback) ─────────────────────────

  _startPlaybackForCurrent() {
    this._stopPlayback();
    const song = this.songs[this.currentIndex];
    if (!song || song.missing) return;
    try {
      const audio = new Audio(audioUrlForPath(song.path));
      audio.preload = 'auto';
      const repaintBtn = () => this._updatePlayBtn();
      const onTimeUpdate = () => this._updateSeek();
      const onLoadedMetadata = () => this._updateSeek();
      const onError = () => {
        if (!this.player || this.player.audio !== audio) return;
        const code = audio.error && audio.error.code;
        const ext = (song.path.split('.').pop() || '').toLowerCase();
        const msg = code === 4
          ? `Chromium can't decode this .${ext} file. Try re-encoding to MP3 or AAC.`
          : `Playback error (code ${code || '?'})`;
        this._stopPlayback();
        showToast(msg, 'error', 4000);
      };
      const onEnded = () => this._updatePlayBtn(); // do NOT auto-advance
      audio.addEventListener('play', repaintBtn);
      audio.addEventListener('pause', repaintBtn);
      audio.addEventListener('timeupdate', onTimeUpdate);
      audio.addEventListener('loadedmetadata', onLoadedMetadata);
      audio.addEventListener('error', onError);
      audio.addEventListener('ended', onEnded);
      this.player = { audio, handlers: { repaintBtn, onTimeUpdate, onLoadedMetadata, onError, onEnded } };
      audio.play().then(() => this._updatePlayBtn()).catch(() => this._updatePlayBtn());
    } catch (err) {
      this._stopPlayback();
      showToast(`Playback failed: ${err.message}`, 'error', 3000);
    }
  }

  _stopPlayback() {
    if (!this.player) return;
    const { audio, handlers } = this.player;
    if (audio) {
      if (handlers) {
        audio.removeEventListener('play', handlers.repaintBtn);
        audio.removeEventListener('pause', handlers.repaintBtn);
        audio.removeEventListener('timeupdate', handlers.onTimeUpdate);
        audio.removeEventListener('loadedmetadata', handlers.onLoadedMetadata);
        audio.removeEventListener('error', handlers.onError);
        audio.removeEventListener('ended', handlers.onEnded);
      }
      try { audio.pause(); } catch { /* ignore */ }
      try { audio.src = ''; } catch { /* ignore */ }
    }
    this.player = null;
  }

  _togglePlay() {
    if (!this.player || !this.player.audio) { this._startPlaybackForCurrent(); return; }
    const a = this.player.audio;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  _seek(deltaSeconds) {
    if (!this.player || !this.player.audio) return;
    const a = this.player.audio;
    if (!isFinite(a.duration) || a.duration <= 0) return;
    a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + deltaSeconds));
    this._updateSeek();
  }

  _seekClick(e, el) {
    if (!this.player || !this.player.audio) return;
    const a = this.player.audio;
    if (!isFinite(a.duration) || a.duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = a.duration * frac;
    this._updateSeek();
  }

  _updateSeek() {
    if (!this.player || !this.player.audio || this.view !== 'sort') return;
    const a = this.player.audio;
    const fill = this.dom.root.querySelector('.sorter-seek-fill');
    const time = this.dom.root.querySelector('.sorter-seek-time');
    if (fill && isFinite(a.duration) && a.duration > 0) {
      fill.style.width = `${(a.currentTime / a.duration * 100).toFixed(2)}%`;
    }
    if (time) time.textContent = `${formatTime(a.currentTime)} / ${formatTime(isFinite(a.duration) ? a.duration : 0)}`;
  }

  _updatePlayBtn() {
    const btn = this.dom.root.querySelector('.sorter-play-btn');
    if (btn) btn.textContent = (this.player && this.player.audio && !this.player.audio.paused) ? '⏸' : '▶';
  }

  // ── Keyboard ───────────────────────────────────────────────────────

  _attachKeys() {
    if (this._onKeyDown) return;
    this._onKeyDown = (e) => this._handleKey(e);
    document.addEventListener('keydown', this._onKeyDown);
  }

  _detachKeys() {
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
  }

  _handleKey(e) {
    if (this.view !== 'sort') return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack the crate-name field

    if (this.currentIndex >= this.songs.length) {
      if (e.key === 'ArrowUp') { e.preventDefault(); this._goToSong(this.songs.length - 1); }
      return;
    }

    switch (e.key) {
      case ' ': e.preventDefault(); this._togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); this._seek(e.shiftKey ? 15 : 5); break;
      case 'ArrowLeft': e.preventDefault(); this._seek(e.shiftKey ? -15 : -5); break;
      case 'Enter':
      case 'ArrowDown': e.preventDefault(); this._advance(); break;
      case 'ArrowUp': e.preventDefault(); this._goToSong(this.currentIndex - 1); break;
      case 'Escape': e.preventDefault(); if (this.player && this.player.audio) this.player.audio.pause(); break;
      default:
        if (e.key >= '1' && e.key <= '9') {
          const n = parseInt(e.key, 10) - 1;
          if (n < this.destFolders.length) { e.preventDefault(); this._toggleFolder(this.destFolders[n].path); }
        }
    }
  }

  // ── Path helpers (renderer has no node:path) ───────────────────────

  _basename(p) {
    return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  }

  _parentName(p) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : '';
  }

  _uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Build a setengine-audio:// URL for an absolute file path. base64url-encode so
// slashes / spaces / NFD Unicode survive URL parsing. Mirrors setmaker.js /
// extract.js; the decoder lives in main.js's protocol handler.
function audioUrlForPath(p) {
  const utf8 = new TextEncoder().encode(String(p));
  let bin = '';
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `setengine-audio://local/${b64}`;
}
