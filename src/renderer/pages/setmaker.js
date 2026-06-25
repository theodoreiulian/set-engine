// SetEngine — Set Maker page
// Three views in one page (library / rate / setlist), no router change.

import * as MetadataParser from './tunematch/metadata.js';
import * as TuneMatch from './tunematch/engine.js';
import { showToast } from '../components/toast.js';
import { showModal } from '../components/modal.js';
import { escapeHtml } from '../utils/escape-html.js';

function cssEscape(s) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
}

const CAMELOT_KEYS = (() => {
  const out = [];
  for (let n = 1; n <= 12; n++) { out.push(`${n}A`); out.push(`${n}B`); }
  return out;
})();

export class SetMakerPage {
  constructor(app) {
    this.app = app;

    // Persisted across navigation (lives on app instance, like MatchPage)
    const s = app.setMakerState || {};
    this.library = s.library || [];           // tagged tracks: { id, path, name, title, artist, bpm, key, popularity }
    this.untagged = s.untagged || [];         // files missing bpm/key: { path, name, missing: 'bpm'|'key'|'both' }
    this.startKey = s.startKey || '';
    this.lastSet = s.lastSet || null;

    this.view = s.view || 'library';
    this.scanning = false;
    this.cancelled = false;
    this.tagging = false;           // BPM/key detection batch in progress

    // Per-track analysis status: id → 'pending' | 'analyzing' | 'done' | 'error'.
    // Tracks that already carry .features start as 'done'.
    this.analysisStatus = new Map();
    for (const t of this.library) {
      if (t.features) this.analysisStatus.set(t.id, 'done');
    }

    // Rate-view state (rebuilt each entry — not persisted across nav)
    this.rate = null;

    this.dom = {};
    this._onKeyDown = null;
    this._unsubscribeAnalysis = null;
    if (window.setengine && window.setengine.onAnalysisProgress) {
      this._unsubscribeAnalysis = window.setengine.onAnalysisProgress(
        (data) => this._handleAnalysisProgress(data)
      );
    }
    this._unsubscribeTagProgress = null;
    if (window.setengine && window.setengine.onTagProgress) {
      this._unsubscribeTagProgress = window.setengine.onTagProgress(
        (data) => this._handleTagProgress(data)
      );
    }
  }

  destroy() {
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._unsubscribeAnalysis) {
      this._unsubscribeAnalysis();
      this._unsubscribeAnalysis = null;
    }
    if (this._unsubscribeTagProgress) {
      this._unsubscribeTagProgress();
      this._unsubscribeTagProgress = null;
    }
    this._stopRatePlayback();
    this._stopSetPlayback();
    this.app.setMakerState = {
      library: this.library,
      untagged: this.untagged,
      startKey: this.startKey,
      lastSet: this.lastSet,
      view: this.view,
    };
  }

  render(container) {
    this.container = container;
    container.classList.add('setmaker-host');
    container.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'setmaker-page';
    container.appendChild(root);
    this.dom.root = root;

    this._renderCurrentView();
  }

  _renderCurrentView() {
    // Snapshot scroll positions of the page's scrollable regions BEFORE we
    // blow away the DOM. Without this, clicking play/pause or a star pip
    // re-renders the setlist and snaps the user back to the top — annoying
    // on long sets.
    const SCROLL_TARGETS = ['.sm-set-list', '.sm-body'];
    const scrollSnapshot = new Map();
    if (this.dom.root) {
      for (const sel of SCROLL_TARGETS) {
        const el = this.dom.root.querySelector(sel);
        if (el && el.scrollTop > 0) scrollSnapshot.set(sel, el.scrollTop);
      }
    }

    this.dom.root.innerHTML = '';
    if (this.view === 'rate') this._renderRateView();
    else if (this.view === 'setlist') this._renderSetlistView();
    else this._renderLibraryView();

    for (const [sel, top] of scrollSnapshot) {
      const el = this.dom.root.querySelector(sel);
      if (el) el.scrollTop = top;
    }
  }

  _setView(v) {
    if (this.view === v) return;
    this._stopRatePlayback();
    if (this.view === 'setlist' && v !== 'setlist') this._stopSetPlayback();
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    this.view = v;
    this._renderCurrentView();
  }

  // ── Library view ────────────────────────────────────────────────────

  _renderLibraryView() {
    const root = this.dom.root;
    root.innerHTML = `
      <div class="sm-topbar">
        <div class="sm-titlewrap">
          <div class="page-title">SET MAKER</div>
          <div class="sm-stats">
            <span><strong>${this.library.length}</strong> tagged</span>
            <span><strong>${this.library.filter(t => t.popularity != null).length}</strong> rated</span>
          </div>
        </div>
      </div>

      <div class="sm-controls">
        <button class="btn" id="sm-import">+ Add folders</button>
        <button class="btn-secondary" id="sm-import-setlist">Import setlist</button>
        ${this.library.length > 0 ? `<button class="btn-secondary" id="sm-clear">Clear library</button>` : ''}
        <div class="sm-spacer"></div>
        <div class="sm-startkey">
          <label>Start key</label>
          <select id="sm-startkey" class="input">
            <option value="">auto</option>
            ${CAMELOT_KEYS.map(k => `<option value="${k}" ${k === this.startKey ? 'selected' : ''}>${k}</option>`).join('')}
          </select>
        </div>
        <button class="btn" id="sm-build" ${this.library.length < 2 ? 'disabled' : ''}>Build set →</button>
      </div>

      ${(this.scanning || this.tagging) ? `
        <div class="sm-progress">
          <div class="sm-progress-bar"><div class="sm-progress-fill" id="sm-progress-fill"></div></div>
          <div class="sm-progress-label" id="sm-progress-label">${this.tagging ? 'Detecting BPM &amp; key…' : 'Scanning…'}</div>
        </div>
      ` : ''}

      <div class="sm-body">
        ${this._renderLibraryList()}
      </div>
    `;

    root.querySelector('#sm-import').addEventListener('click', () => this._handleImportFolders());
    root.querySelector('#sm-import-setlist').addEventListener('click', () => this._handleImportSetlist());
    const clearBtn = root.querySelector('#sm-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => this._handleClear());
    root.querySelector('#sm-startkey').addEventListener('change', (e) => {
      this.startKey = e.target.value;
    });
    root.querySelector('#sm-build').addEventListener('click', () => this._handleBuildSet());

    // Row click → rate-mode entry; per-star click → rate inline. Stars are
    // rendered as buttons with data-action="rate-library"; the row container
    // gets data-rate-track. Order matters: handle the star click first and
    // stopPropagation so the rate-mode entry doesn't also fire.
    root.querySelectorAll('[data-rate-track]').forEach(el => {
      el.addEventListener('click', (e) => {
        const star = e.target.closest('[data-action="rate-library"]');
        if (star) {
          e.stopPropagation();
          const idx = parseInt(star.dataset.idx, 10);
          const stars = parseInt(star.dataset.stars, 10);
          this._rateInline(idx, stars, 'library');
          return;
        }
        this._enterRateModeAt(parseInt(el.dataset.rateTrack, 10));
      });
    });
  }

  _renderLibraryList() {
    if (this.library.length === 0) {
      return `
        <div class="sm-section">
          <div class="sm-section-title">Library</div>
          <div class="sm-empty">Add one or more folders of MP3s with BPM & key tags.</div>
        </div>
      `;
    }
    const analyzed = this.library.filter(t => this.analysisStatus.get(t.id) === 'done').length;
    const analyzing = this.library.filter(t => this.analysisStatus.get(t.id) === 'analyzing').length;
    const pendingAnalysis = this.library.length - analyzed - analyzing;
    const rows = this.library.map((t, i) => `
      <div class="sm-row" data-rate-track="${i}" data-track-id="${escapeHtml(t.id)}">
        <div class="sm-row-pop">${this._renderStars(t, i, 'library')}</div>
        <div class="sm-row-title"><div class="sm-title">${escapeHtml(t.title || t.name)}</div><div class="sm-artist">${escapeHtml(t.artist || '')}</div></div>
        <div class="sm-row-key">${t.key}</div>
        <div class="sm-row-bpm">${t.bpm}</div>
        <div class="sm-row-analysis" data-analysis-chip="${escapeHtml(t.id)}">${this._renderAnalysisChip(t)}</div>
      </div>
    `).join('');
    const analysisLine = (analyzing + pendingAnalysis > 0)
      ? `<span class="sm-analysis-line">Analyzing ${analyzed}/${this.library.length}</span>`
      : `<span class="sm-analysis-line sm-analysis-line-done">${analyzed}/${this.library.length} analyzed</span>`;
    return `
      <div class="sm-section">
        <div class="sm-section-title">Library (${this.library.length}) · ${analysisLine}</div>
        <div class="sm-row sm-row-head">
          <div class="sm-row-pop">RATING</div>
          <div class="sm-row-title">TITLE</div>
          <div class="sm-row-key">KEY</div>
          <div class="sm-row-bpm">BPM</div>
          <div class="sm-row-analysis">ANALYSIS</div>
        </div>
        ${rows}
      </div>
    `;
  }

  _renderAnalysisChip(t) {
    const status = this.analysisStatus.get(t.id);
    if (status === 'done' || t.features) return `<span class="sm-chip sm-chip-done" title="Frequency + phrasing analyzed">✓</span>`;
    if (status === 'analyzing') return `<span class="sm-chip sm-chip-analyzing" title="Analyzing…">↻</span>`;
    if (status === 'error') return `<span class="sm-chip sm-chip-error" title="Analysis failed (transition will use neutral fallback)">!</span>`;
    return `<span class="sm-chip sm-chip-pending" title="Not yet analyzed">▒</span>`;
  }

  _handleAnalysisProgress(data) {
    if (!data || !data.id) return;
    const idx = this.library.findIndex(t => t.id === data.id);
    if (idx === -1) {
      this.analysisStatus.delete(data.id);
      return;
    }
    if (data.status === 'done' && data.features) {
      this.library[idx].features = data.features;
      this.analysisStatus.set(data.id, 'done');
    } else if (data.status === 'error') {
      this.analysisStatus.set(data.id, 'error');
    }
    // Patch just the affected row's chip instead of re-rendering the whole list.
    if (this.view !== 'library' || !this.dom.root) return;
    const cell = this.dom.root.querySelector(`[data-analysis-chip="${cssEscape(data.id)}"]`);
    if (cell) cell.innerHTML = this._renderAnalysisChip(this.library[idx]);
    const line = this.dom.root.querySelector('.sm-analysis-line');
    if (line) {
      const analyzed = this.library.filter(t => this.analysisStatus.get(t.id) === 'done').length;
      const remaining = this.library.length - analyzed;
      if (remaining > 0) line.textContent = `Analyzing ${analyzed}/${this.library.length}`;
      else { line.textContent = `${analyzed}/${this.library.length} analyzed`; line.classList.add('sm-analysis-line-done'); }
    }
  }

  _kickoffAnalysis(tracks) {
    if (!window.setengine || !window.setengine.analyzeBatch) return;
    const payload = [];
    for (const t of tracks) {
      if (t.features) continue;
      if (this.analysisStatus.get(t.id) === 'analyzing') continue;
      this.analysisStatus.set(t.id, 'analyzing');
      payload.push({ id: t.id, path: t.path });
    }
    if (payload.length === 0) return;
    window.setengine.analyzeBatch(payload).catch(() => { /* per-track errors surface via progress events */ });
  }

  // ── BPM/Key detection + tagging ─────────────────────────────────────

  // Which fields a "needs tagging" record is actually missing. Prefers the
  // partial metadata captured at scan time; falls back to the `missing` label
  // for records persisted before that field existed.
  _needForUntagged(u) {
    if (u.bpm !== undefined || u.keyCode !== undefined) {
      const haveBpm = !!u.bpm, haveKey = !!u.keyCode;
      if (haveBpm && !haveKey) return 'key';
      if (!haveBpm && haveKey) return 'bpm';
      return 'both';
    }
    if (u.missing === 'bpm') return 'bpm';
    if (u.missing === 'key') return 'key';
    return 'both';
  }

  // Detect the missing BPM/key for every "needs tagging" file, write the values
  // into the originals, and promote the successfully-tagged files into the
  // library. Progress streams in via `_handleTagProgress`.
  async _handleAnalyzeTag() {
    if (this.tagging || this.untagged.length === 0) return;
    if (!window.setengine || !window.setengine.detectAndTagFiles) {
      showToast('Tagging not available.', 'error', 3000);
      return;
    }

    const items = this.untagged.map(u => ({
      id: u.path, path: u.path, need: this._needForUntagged(u),
      title: u.title || '', artist: u.artist || '',
    }));
    this.tagging = true;
    this._tagTotal = items.length;
    this._tagDone = 0;
    this._tagPending = new Set(items.map(i => i.path));
    this._renderCurrentView();   // surfaces the progress bar + disables the button

    let resp;
    try {
      resp = await window.setengine.detectAndTagFiles(items);
    } catch (err) {
      this.tagging = false;
      this._tagPending = null;
      this._renderCurrentView();
      showToast(`Tagging failed: ${err.message}`, 'error', 5000);
      return;
    }

    const results = (resp && resp.results) || [];
    const byPath = new Map(results.map(r => [r.path, r]));
    const stillUntagged = [];
    const newTracks = [];
    let notWritten = 0, failed = 0, review = 0;

    for (const u of this.untagged) {
      const r = byPath.get(u.path);
      if (!r || r.error) { stillUntagged.push(u); failed++; continue; }
      const bpm = (typeof r.bpm === 'number' && r.bpm > 0) ? r.bpm : (u.bpm || 0);
      const keyCode = r.keyCamelot || u.keyCode || '';
      const parsed = keyCode ? TuneMatch.parseKey(keyCode) : null;
      if (!bpm || !parsed) { stillUntagged.push(u); failed++; continue; }
      if (r.writeSupported === false || !r.written) notWritten++;
      if (r.needsReview) review++;
      newTracks.push({
        id: u.path,
        path: u.path,
        name: u.name,
        title: (u.title || stripExt(u.name)).trim(),
        artist: (u.artist || '').trim(),
        bpm: Math.round(bpm * 10) / 10,
        bpmReview: !!r.needsReview,
        key: parsed.code,
        popularity: null,
        ratingSupported: true,
      });
    }

    const seen = new Set(this.library.map(t => t.path));
    for (const t of newTracks) {
      if (seen.has(t.path)) continue;
      this.library.push(t);
      seen.add(t.path);
    }
    this.untagged = stillUntagged;
    this.tagging = false;
    this._tagPending = null;
    this._renderCurrentView();

    // Newly-tagged tracks still need their transition (frequency/phrasing)
    // analysis for set building.
    this._kickoffAnalysis(newTracks);

    const tagged = newTracks.length;
    let msg = `Tagged ${tagged} file${tagged === 1 ? '' : 's'}`;
    const notes = [];
    if (review) notes.push(`${review} may need review`);
    if (notWritten) notes.push(`${notWritten} not saved to disk (e.g. WAV/AIFF)`);
    if (failed) notes.push(`${failed} could not be detected`);
    if (notes.length) msg += ` · ${notes.join(' · ')}`;
    showToast(msg, tagged > 0 ? 'success' : 'warning', 4500);
  }

  // Per-file streaming progress from the detect-and-tag batch. Only advances the
  // progress bar; the library/untagged arrays are reconciled once the batch
  // promise resolves in _handleAnalyzeTag (avoids mid-stream re-render races).
  _handleTagProgress(data) {
    if (!data || !this._tagPending || !this._tagPending.has(data.path)) return;
    this._tagDone = (this._tagDone || 0) + 1;
    if (this.view !== 'library' || !this.dom.root) return;
    const total = this._tagTotal || 1;
    const fill = this.dom.root.querySelector('#sm-progress-fill');
    const label = this.dom.root.querySelector('#sm-progress-label');
    if (fill) fill.style.width = `${Math.round((this._tagDone / total) * 100)}%`;
    if (label) label.textContent = `Detecting BPM & key… ${this._tagDone} / ${total}`;
  }



  // Interactive 5-star control. Each star is a button so a click rates that
  // track to N stars without entering the dedicated Rate view. ctx tells the
  // delegated click handler which list this row belongs to (library or
  // setlist tour) so the right state gets updated.
  _renderStars(t, idx, ctx) {
    if (t && t.ratingSupported === false) {
      return `<span class="sm-stars-na" title="Rating not supported for this format">—</span>`;
    }
    const rating = (t && typeof t.popularity === 'number') ? Math.round(t.popularity) : 0;
    let html = `<span class="sm-stars-interactive" data-rating="${rating}">`;
    for (let n = 1; n <= 5; n++) {
      const filled = n <= rating;
      html += `<button class="sm-star-pip${filled ? ' sm-star-pip-filled' : ''}" data-action="rate-${ctx}" data-idx="${idx}" data-stars="${n}" title="Rate ${n}">${filled ? '★' : '☆'}</button>`;
    }
    // Sixth pip for clearing — only shown when the track has a rating so it
    // doesn't add visual noise to unrated rows.
    if (rating > 0) {
      html += `<button class="sm-star-pip sm-star-pip-clear" data-action="rate-${ctx}" data-idx="${idx}" data-stars="0" title="Clear rating">×</button>`;
    }
    html += `</span>`;
    return html;
  }

  // Inline rating handler — used by clickable stars in both the library row
  // and the setlist row. ctx is 'library' or 'setlist'; we update the local
  // state on whichever side the click came from, plus the OTHER side too if
  // the same track is present (so a rating change in the setlist is
  // reflected back in the library and vice versa).
  async _rateInline(idx, stars, ctx) {
    const fromList = ctx === 'setlist' ? (this.lastSet && this.lastSet.tour) : this.library;
    if (!fromList) return;
    const track = fromList[idx];
    if (!track || !track.path) return;
    if (track.ratingSupported === false) {
      showToast('Rating not supported for this file format.', 'warning', 2500);
      return;
    }
    try {
      const res = await window.setengine.rateTrack(track.path, stars);
      if (res && res.supported === false) {
        track.ratingSupported = false;
        showToast('Format does not support ratings.', 'warning', 2500);
      } else if (res && res.success) {
        const newPop = stars > 0 ? stars : null;
        track.popularity = newPop;
        // Mirror to the other list if the same file is present there.
        const mirrorList = ctx === 'setlist' ? this.library : (this.lastSet && this.lastSet.tour);
        if (mirrorList) {
          const mirror = mirrorList.find((x) => x && x.id === track.id);
          if (mirror) mirror.popularity = newPop;
        }
      } else {
        showToast(`Rating save failed: ${(res && res.error) || 'unknown'}`, 'error', 3000);
        return;
      }
    } catch (err) {
      showToast(`Rating save failed: ${err.message}`, 'error', 3000);
      return;
    }
    this._renderCurrentView();
  }

  // ── Import / scan ──────────────────────────────────────────────────

  async _handleImportFolders() {
    if (!window.setengine || !window.setengine.selectFolders) return;
    const folders = await window.setengine.selectFolders();
    if (!folders || folders.length === 0) return;

    this.scanning = true;
    this.cancelled = false;
    this._renderCurrentView();

    try {
      const files = await window.setengine.scanFoldersForAudio(folders);
      await this._processFiles(files);
    } catch (err) {
      showToast(`Scan failed: ${err.message}`, 'error', 5000);
    } finally {
      this.scanning = false;
      this._renderCurrentView();
    }
  }

  async _processFiles(files) {
    const seen = new Set(this.library.map(t => t.path));
    const seenUn = new Set(this.untagged.map(u => u.path));
    let added = 0, skipped = 0;
    const fill = this.dom.root.querySelector('#sm-progress-fill');
    const label = this.dom.root.querySelector('#sm-progress-label');

    for (let i = 0; i < files.length; i++) {
      if (this.cancelled) break;
      const f = files[i];
      if (seen.has(f.path) || seenUn.has(f.path)) { skipped++; continue; }

      let buffer;
      try {
        buffer = await window.setengine.readAudioFileBytes(f.path);
      } catch {
        this.untagged.push({ path: f.path, name: f.name, missing: 'both', bpm: 0, keyCode: '', title: '', artist: '' });
        seenUn.add(f.path);
        continue;
      }

      const realFile = new File([buffer], f.name);
      let meta;
      try { meta = await MetadataParser.parse(realFile); }
      catch { meta = null; }

      const bpm = meta && meta.bpm ? Math.round(meta.bpm * 10) / 10 : 0;
      const parsedKey = meta && meta.key ? TuneMatch.parseKey(meta.key) : null;

      if (!bpm || !parsedKey) {
        const missing = !bpm && !parsedKey ? 'bpm + key' : (!bpm ? 'bpm' : 'key');
        this.untagged.push({
          path: f.path,
          name: f.name,
          missing,
          bpm: bpm || 0,
          keyCode: parsedKey ? parsedKey.code : '',
          title: (meta && meta.title) || '',
          artist: (meta && meta.artist) || '',
        });
        seenUn.add(f.path);
      } else {
        // Read existing rating (POPM) for MP3s
        let popularity = null, ratingSupported = true;
        try {
          const r = await window.setengine.readRating(f.path);
          if (r && r.supported === false) ratingSupported = false;
          if (r && typeof r.stars === 'number') popularity = r.stars;
        } catch { /* ignore */ }

        this.library.push({
          id: f.path,
          path: f.path,
          name: f.name,
          title: (meta.title || stripExt(f.name)).trim(),
          artist: (meta.artist || '').trim(),
          bpm,
          key: parsedKey.code,
          popularity,
          ratingSupported,
        });
        seen.add(f.path);
        added++;
      }

      if (i % 10 === 0 || i === files.length - 1) {
        const pct = Math.round(((i + 1) / files.length) * 100);
        if (fill) fill.style.width = `${pct}%`;
        if (label) label.textContent = `Scanning… ${i + 1} / ${files.length}`;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (added > 0 || skipped > 0) {
      showToast(`Added ${added} tagged${skipped > 0 ? ` · ${skipped} duplicates skipped` : ''}`, 'info', 3500);
    }
    // Kick off background analysis for everything newly imported. Pre-existing
    // analyzed tracks short-circuit in _kickoffAnalysis.
    this._kickoffAnalysis(this.library);
    
    // Auto-detect BPM/key for any files that need it.
    if (this.untagged.length > 0) {
      this._handleAnalyzeTag();
    }
  }

  async _handleImportSetlist() {
    if (!window.setengine || !window.setengine.importM3U) return;
    let res;
    try { res = await window.setengine.importM3U(); }
    catch (err) { showToast(`Import failed: ${err.message}`, 'error', 4000); return; }
    if (!res || res.cancelled) return;
    if (!res.success) { showToast(`Import failed: ${res.error || 'unknown'}`, 'error', 4000); return; }
    const entries = Array.isArray(res.entries) ? res.entries : [];
    if (entries.length === 0) {
      showToast('Playlist is empty.', 'warning', 3000);
      return;
    }

    this.scanning = true;
    this._renderCurrentView();

    const tour = [];
    const missing = [];
    const untagged = [];
    const seenLibrary = new Set(this.library.map((t) => t.path));

    try {
      for (const entry of entries) {
        if (!entry.exists) { missing.push(entry.path); continue; }

        // Already in the library? Use the existing entry verbatim — preserves
        // features, ratingSupported, popularity, etc.
        const existing = this.library.find((t) => t.path === entry.path);
        if (existing) { tour.push(existing); continue; }

        // Otherwise: ingest fresh, same path as _processFiles.
        let buffer;
        try { buffer = await window.setengine.readAudioFileBytes(entry.path); }
        catch { missing.push(entry.path); continue; }

        const fileName = entry.path.split(/[\\/]/).pop();
        const realFile = new File([buffer], fileName);
        let meta;
        try { meta = await MetadataParser.parse(realFile); }
        catch { meta = null; }

        const bpm = meta && meta.bpm ? Math.round(meta.bpm * 10) / 10 : 0;
        const parsedKey = meta && meta.key ? TuneMatch.parseKey(meta.key) : null;
        if (!bpm || !parsedKey) { untagged.push(entry.path); continue; }

        let popularity = null, ratingSupported = true;
        try {
          const r = await window.setengine.readRating(entry.path);
          if (r && r.supported === false) ratingSupported = false;
          if (r && typeof r.stars === 'number') popularity = r.stars;
        } catch { /* ignore */ }

        const track = {
          id: entry.path,
          path: entry.path,
          name: fileName,
          title: (meta.title || stripExt(fileName)).trim(),
          artist: (meta.artist || '').trim(),
          bpm,
          key: parsedKey.code,
          popularity,
          ratingSupported,
        };
        if (!seenLibrary.has(track.path)) {
          this.library.push(track);
          seenLibrary.add(track.path);
        }
        tour.push(track);
      }
    } finally {
      this.scanning = false;
    }

    if (tour.length === 0) {
      this._renderCurrentView();
      // Detailed modal — a toast can't show enough context for the user to
      // debug a busted playlist. Include the parsed/existing counts and a
      // couple of sample paths so they can see exactly what was tried.
      const sample = (arr) => arr.slice(0, 3).map((p) => `• ${escapeHtml(p)}`).join('<br>');
      const parts = [`<p><strong>0 of ${entries.length} tracks loaded.</strong></p>`];
      if (missing.length) {
        parts.push(`<p>${missing.length} file${missing.length === 1 ? '' : 's'} not found on disk:</p><pre style="white-space:pre-wrap;font-size:11px">${sample(missing)}</pre>`);
      }
      if (untagged.length) {
        parts.push(`<p>${untagged.length} file${untagged.length === 1 ? '' : 's'} missing BPM/key tags:</p><pre style="white-space:pre-wrap;font-size:11px">${sample(untagged)}</pre>`);
      }
      parts.push(`<p style="font-size:11px;color:var(--text-muted)">Tip: SetEngine reads paths exactly as written in the .m3u. If Serato finds these files via its own library index, the .m3u paths themselves may be stale.</p>`);
      showModal('Playlist import failed', parts.join(''), ['OK']);
      return;
    }

    // Rescore the tour in the imported order (do NOT run buildSet — that
    // would reorder). The result is a normal lastSet shape, flagged
    // modified=true so the setlist top bar shows the "modified" pill.
    const payload = tour.map((t) => ({
      id: t.id, title: t.title, artist: t.artist, bpm: t.bpm, key: t.key,
      popularity: t.popularity, path: t.path, features: t.features || null,
    }));
    let rescore;
    try { rescore = await window.setengine.rescoreTour(payload); }
    catch { rescore = null; }
    const transitions = (rescore && rescore.success && rescore.result) ? rescore.result.transitions : [];
    const totalCost = (rescore && rescore.success && rescore.result) ? rescore.result.totalCost : 0;

    this.lastSet = {
      tour: payload,
      transitions,
      totalCost,
      warnings: [],
      meta: {
        algorithm: 'imported',
        elapsedMs: 0,
        analyzedTracks: tour.filter((t) => t.features).length,
        totalTracks: tour.length,
      },
      modified: true,
    };

    // Kick off background analysis for any newly-added tracks (so freq /
    // phrasing diagnostics fill in if the user rescores after editing).
    this._kickoffAnalysis(this.library);

    // Warn after switching views so the toasts appear over the setlist.
    this._setView('setlist');
    if (missing.length) showToast(`${missing.length} file${missing.length === 1 ? '' : 's'} not found, skipped.`, 'warning', 4500);
    
    // Auto-detect BPM/key for untagged tracks found in the playlist.
    if (untagged.length) {
      // Instead of skipping, put them in this.untagged and kick off detection.
      // _handleAnalyzeTag promotes successful detects to this.library.
      // However, for playlists, we also want them in the tour. _handleAnalyzeTag 
      // doesn't know about the tour, so we run it, wait for it, then resync the tour
      // by pulling the newly-analyzed tracks from the library based on path.
      for (const p of untagged) {
        if (!seenLibrary.has(p)) {
          this.untagged.push({ path: p, name: p.split(/[\\/]/).pop(), missing: 'both', bpm: 0, keyCode: '', title: '', artist: '' });
          seenLibrary.add(p);
        }
      }
      if (this.untagged.length > 0) {
        await this._handleAnalyzeTag();
        // After auto-tagging, anything successfully added to the library can now be 
        // appended to the tour payload.
        for (const p of untagged) {
          const newlyTagged = this.library.find(t => t.path === p);
          if (newlyTagged && !tour.find(t => t.path === p)) {
            tour.push(newlyTagged);
          }
        }
        
        // Re-build the payload and rescore since the tour changed.
        const updatedPayload = tour.map((t) => ({
          id: t.id, title: t.title, artist: t.artist, bpm: t.bpm, key: t.key,
          popularity: t.popularity, path: t.path, features: t.features || null,
        }));
        let newRescore;
        try { newRescore = await window.setengine.rescoreTour(updatedPayload); }
        catch { newRescore = null; }
        
        this.lastSet.tour = updatedPayload;
        this.lastSet.transitions = (newRescore && newRescore.success && newRescore.result) ? newRescore.result.transitions : [];
        this.lastSet.totalCost = (newRescore && newRescore.success && newRescore.result) ? newRescore.result.totalCost : 0;
        this.lastSet.meta.totalTracks = updatedPayload.length;
        this._renderCurrentView();
      }
    }
  }

  _handleClear() {
    this.library = [];
    this.untagged = [];
    this.lastSet = null;
    this.analysisStatus.clear();
    this._renderCurrentView();
  }

  // ── Build set ──────────────────────────────────────────────────────

  async _handleBuildSet() {
    if (this.library.length < 2) {
      showToast('Need at least 2 tagged tracks to build a set.', 'warning', 3000);
      return;
    }
    try {
      // Opportunistic completion: any track still missing features at this
      // point gets analyzed synchronously so the build uses the richest cost
      // function we can produce. Already-running analyses are awaited via the
      // same call (analyzeOne is independent of the batch queue, so worst
      // case the work happens twice — still cheap relative to the FFTs).
      const missing = this.library.filter(t => !t.features);
      if (missing.length > 0) {
        showToast(`Analyzing ${missing.length} track${missing.length === 1 ? '' : 's'} before building…`, 'info', 4000);
        await Promise.all(missing.map(async (t) => {
          try {
            const res = await window.setengine.analyzeOne(t.path);
            if (res && res.success && res.features) {
              t.features = res.features;
              this.analysisStatus.set(t.id, 'done');
            } else {
              this.analysisStatus.set(t.id, 'error');
            }
          } catch {
            this.analysisStatus.set(t.id, 'error');
          }
        }));
      }
      const payload = this.library.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        bpm: t.bpm,
        key: t.key,
        popularity: t.popularity,
        path: t.path,
        features: t.features || null,
      }));
      const opts = {
        startKey: this.startKey || null,
      };
      const res = await window.setengine.buildSet(payload, opts);
      if (!res || !res.success) {
        showToast(`Build failed: ${(res && res.error) || 'unknown error'}`, 'error', 5000);
        return;
      }
      this.lastSet = res.result;
      if (res.result.warnings && res.result.warnings.length) {
        for (const w of res.result.warnings) showToast(w, 'warning', 4000);
      }
      this._setView('setlist');
    } catch (err) {
      showToast(`Build failed: ${err.message}`, 'error', 5000);
    }
  }

  // ── Setlist view ───────────────────────────────────────────────────

  _renderSetlistView() {
    const root = this.dom.root;
    const set = this.lastSet;
    if (!set) { this._setView('library'); return; }

    const counts = set.transitions.reduce((acc, t) => (acc[t.quality] = (acc[t.quality] || 0) + 1, acc), {});
    const playingIdx = this.setPlayer ? this.setPlayer.idx : -1;
    const playingNow = this.setPlayer && this.setPlayer.audio && !this.setPlayer.audio.paused;
    const playingAudio = this.setPlayer ? this.setPlayer.audio : null;
    // Fraction of the currently playing track that's elapsed — used so the
    // bar isn't reset to 0 on every re-render (we re-render on play/pause/
    // edits, while the timeupdate handler patches the DOM at ~4 Hz between).
    const playingFraction = (playingAudio && isFinite(playingAudio.duration) && playingAudio.duration > 0)
      ? playingAudio.currentTime / playingAudio.duration
      : 0;
    const last = set.tour.length - 1;

    const rows = [];
    for (let i = 0; i < set.tour.length; i++) {
      const t = set.tour[i];
      const isPlaying = (i === playingIdx);
      const playIcon = (isPlaying && playingNow) ? '⏸' : '▶';
      const fillPct = isPlaying ? (playingFraction * 100) : 0;
      const durText = (isPlaying && playingAudio && isFinite(playingAudio.duration))
        ? `${formatTime(playingAudio.currentTime)} / ${formatTime(playingAudio.duration)}`
        : (t.features && t.features.durationMs ? formatTime(t.features.durationMs / 1000) : '');
      rows.push(`
        <div class="sm-set-row ${isPlaying ? 'sm-set-row-playing' : ''}" data-row-idx="${i}">
          <div class="sm-set-num">${String(i + 1).padStart(2, '0')}</div>
          <button class="sm-set-play" data-action="play" data-idx="${i}" title="Play / pause">${playIcon}</button>
          <div class="sm-set-title"><div class="sm-title">${escapeHtml(t.title || '')}</div><div class="sm-artist">${escapeHtml(t.artist || '')}</div></div>
          <div class="sm-set-key">${t.key}</div>
          <div class="sm-set-bpm">${t.bpm}</div>
          <div class="sm-set-pop">${this._renderStars(t, i, 'setlist')}</div>
          <div class="sm-set-actions">
            <button class="sm-set-action" data-action="up"     data-idx="${i}" ${i === 0    ? 'disabled' : ''} title="Move up">↑</button>
            <button class="sm-set-action" data-action="down"   data-idx="${i}" ${i === last ? 'disabled' : ''} title="Move down">↓</button>
            <button class="sm-set-action sm-set-delete" data-action="delete" data-idx="${i}" title="Remove from set">✕</button>
          </div>
          <div class="sm-set-progress" data-progress-idx="${i}" title="Click to seek">
            <div class="sm-set-progress-fill" data-progress-fill-idx="${i}" style="width: ${fillPct.toFixed(2)}%"></div>
            <span class="sm-set-progress-time" data-progress-time-idx="${i}">${durText}</span>
          </div>
        </div>
      `);
      if (i + 1 < set.tour.length) {
        const tr = set.transitions[i];
        const arrow = tr.bpmDelta > 0 ? '↑' : (tr.bpmDelta < 0 ? '↓' : '→');
        const badge = tr.isHalfDouble ? '<span class="sm-set-half">½×/2×</span>' : '';
        const moveLabel = tr.keyMove && tr.keyMove !== 'unknown' ? `<span class="sm-trans-move sm-trans-move-${tr.keyMove}">${tr.keyMove}</span>` : '';
        const freqLabel = (typeof tr.freqClash === 'number')
          ? `<span class="sm-trans-freq" title="Frequency clash (0=clean, 1=muddy)">freq ${tr.freqClash.toFixed(2)}</span>`
          : '';
        const phraseLabel = (typeof tr.phrasing === 'number')
          ? `<span class="sm-trans-phrase" title="${tr.mixableMs != null ? Math.round(tr.mixableMs/1000) + 's mixable overlap' : 'no analysis'}">phrase ${tr.phrasing.toFixed(2)}</span>`
          : '';
        rows.push(`
          <div class="sm-set-transition sm-set-transition-${tr.quality}">
            <span class="sm-set-trans-label">${arrow} ${Math.abs(tr.bpmDelta).toFixed(1)} BPM · key Δ${tr.keyDist}</span>
            ${moveLabel}
            ${freqLabel}
            ${phraseLabel}
            ${badge}
          </div>
        `);
      }
    }

    const inSet = new Set(set.tour.map(t => t.id));
    const candidatesCount = this.library.filter(t => !inSet.has(t.id)).length;
    // The Add button stays enabled even when there are no library candidates
    // — the picker also exposes a "Browse files…" path that ingests audio
    // from disk on the fly. After an M3U import, library == tour, so
    // candidates is 0; this used to disable the button permanently.

    root.innerHTML = `
      <div class="sm-topbar">
        <div class="sm-titlewrap">
          <div class="page-title">SETLIST · ${set.tour.length} TRACKS ${set.modified ? '<span class="sm-set-modified">modified</span>' : ''}</div>
          <div class="sm-stats">
            <span class="sm-q-green">${counts.green || 0} smooth</span>
            <span class="sm-q-yellow">${counts.yellow || 0} ok</span>
            <span class="sm-q-red">${counts.red || 0} rough</span>
            <span class="sm-q-total">cost ${set.totalCost}</span>
            ${set.meta && set.meta.elapsedMs != null ? `<span class="sm-q-elapsed">${set.meta.elapsedMs} ms</span>` : ''}
          </div>
        </div>
      </div>
      <div class="sm-controls">
        <button class="btn-secondary" id="sm-back">← Back to library</button>
        <button class="btn-secondary" id="sm-rebuild">Rebuild</button>
        <button class="btn-secondary" id="sm-add">+ Add track${candidatesCount > 0 ? ` (${candidatesCount})` : ''}</button>
        <div class="sm-spacer"></div>
        <button class="btn-secondary" id="sm-copy">Copy</button>
        <button class="btn" id="sm-export-m3u">Export M3U →</button>
      </div>
      <div class="sm-set-list" id="sm-set-list">${rows.join('')}</div>
    `;

    root.querySelector('#sm-back').addEventListener('click', () => this._setView('library'));
    root.querySelector('#sm-rebuild').addEventListener('click', () => this._handleBuildSet());
    root.querySelector('#sm-copy').addEventListener('click', () => this._handleCopySetlist());
    root.querySelector('#sm-export-m3u').addEventListener('click', () => this._handleExportM3U());
    root.querySelector('#sm-add').addEventListener('click', () => this._openAddTrackPicker());

    // Single delegated click handler for row actions — saves binding N×4 listeners.
    root.querySelector('#sm-set-list').addEventListener('click', (e) => {
      // Progress-bar clicks: seek to the click position, starting playback
      // on that row if it isn't already playing.
      const bar = e.target.closest('[data-progress-idx]');
      if (bar) {
        const idx = parseInt(bar.dataset.progressIdx, 10);
        const rect = bar.getBoundingClientRect();
        const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this._playSetRow(idx, { startFraction: fraction });
        return;
      }
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.idx, 10);
      if (action === 'play')   this._playSetRow(idx);
      else if (action === 'up')     this._editSetlist('up', idx);
      else if (action === 'down')   this._editSetlist('down', idx);
      else if (action === 'delete') this._editSetlist('delete', idx);
      else if (action === 'rate-setlist') {
        const stars = parseInt(btn.dataset.stars, 10);
        this._rateInline(idx, stars, 'setlist');
      }
    });
  }

  // ── Setlist editing ────────────────────────────────────────────────

  async _editSetlist(action, idx, insertTrack) {
    const set = this.lastSet;
    if (!set || !Array.isArray(set.tour)) return;
    const tour = set.tour;
    if (action === 'delete') {
      if (idx < 0 || idx >= tour.length) return;
      // If the deleted row is currently playing, stop playback.
      if (this.setPlayer && this.setPlayer.idx === idx) this._stopSetPlayback();
      else if (this.setPlayer && this.setPlayer.idx > idx) this.setPlayer.idx--;
      tour.splice(idx, 1);
    } else if (action === 'up') {
      if (idx <= 0 || idx >= tour.length) return;
      [tour[idx - 1], tour[idx]] = [tour[idx], tour[idx - 1]];
      if (this.setPlayer) {
        if (this.setPlayer.idx === idx) this.setPlayer.idx = idx - 1;
        else if (this.setPlayer.idx === idx - 1) this.setPlayer.idx = idx;
      }
    } else if (action === 'down') {
      if (idx < 0 || idx >= tour.length - 1) return;
      [tour[idx], tour[idx + 1]] = [tour[idx + 1], tour[idx]];
      if (this.setPlayer) {
        if (this.setPlayer.idx === idx) this.setPlayer.idx = idx + 1;
        else if (this.setPlayer.idx === idx + 1) this.setPlayer.idx = idx;
      }
    } else if (action === 'insert') {
      if (!insertTrack) return;
      const at = (idx == null || idx < 0) ? tour.length : Math.min(idx, tour.length);
      tour.splice(at, 0, insertTrack);
      if (this.setPlayer && this.setPlayer.idx >= at) this.setPlayer.idx++;
    } else {
      return;
    }
    set.modified = true;
    await this._rescoreSet();
    this._renderCurrentView();
  }

  async _rescoreSet() {
    if (!this.lastSet || !window.setengine || !window.setengine.rescoreTour) return;
    try {
      const payload = this.lastSet.tour.map(t => ({
        id: t.id, title: t.title, artist: t.artist, bpm: t.bpm, key: t.key,
        popularity: t.popularity, path: t.path, features: t.features || null,
      }));
      const res = await window.setengine.rescoreTour(payload);
      if (res && res.success && res.result) {
        this.lastSet.transitions = res.result.transitions;
        this.lastSet.totalCost = res.result.totalCost;
      }
    } catch { /* leave stale values rather than crash */ }
  }

  _openAddTrackPicker() {
    const overlay = document.createElement('div');
    overlay.className = 'sm-picker-overlay';
    overlay.innerHTML = `
      <div class="sm-picker">
        <div class="sm-picker-head">
          <strong>Add to set</strong>
          <input type="text" class="input sm-picker-search" placeholder="Filter library…" />
          <button class="btn-secondary sm-picker-browse" title="Add files from disk">Browse files…</button>
          <button class="btn-secondary sm-picker-close">Close</button>
        </div>
        <div class="sm-picker-list"></div>
      </div>
    `;
    this.dom.root.appendChild(overlay);

    const listEl = overlay.querySelector('.sm-picker-list');
    const searchEl = overlay.querySelector('.sm-picker-search');

    // The candidate list is computed fresh on every render so that newly-
    // browsed files appear instantly without closing/re-opening the picker.
    const renderList = (filter) => {
      const inSet = new Set(this.lastSet.tour.map((t) => t.id));
      const candidates = this.library.filter((t) => !inSet.has(t.id));
      const q = (filter || '').toLowerCase().trim();
      const shown = q
        ? candidates.filter((t) => `${t.title || ''} ${t.artist || ''}`.toLowerCase().includes(q))
        : candidates;
      if (shown.length === 0) {
        const msg = candidates.length === 0
          ? 'All library tracks are already in this set. Use <strong>Browse files…</strong> to add more.'
          : 'No matches.';
        listEl.innerHTML = `<div class="sm-empty">${msg}</div>`;
        return;
      }
      listEl.innerHTML = shown.map((t) => `
        <div class="sm-picker-row" data-pick-id="${escapeHtml(t.id)}">
          <div class="sm-picker-title">
            <div class="sm-title">${escapeHtml(t.title || t.name)}</div>
            <div class="sm-artist">${escapeHtml(t.artist || '')}</div>
          </div>
          <div class="sm-picker-meta">${t.key} · ${t.bpm} BPM</div>
        </div>
      `).join('');
    };
    renderList('');

    const close = () => overlay.remove();
    overlay.querySelector('.sm-picker-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    searchEl.addEventListener('input', (e) => renderList(e.target.value));
    searchEl.focus();

    overlay.querySelector('.sm-picker-browse').addEventListener('click', async () => {
      const added = await this._browseAndInsertFiles();
      if (added > 0) {
        // Refresh the candidate list (browsed files that weren't appended
        // straight into the tour still went into the library, though by
        // default this path appends them, so the list will be empty again
        // — re-render in case the user filtered).
        renderList(searchEl.value);
      }
    });

    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-pick-id]');
      if (!row) return;
      const id = row.dataset.pickId;
      const track = this.library.find((t) => t.id === id);
      if (!track) return;
      const payload = {
        id: track.id, title: track.title, artist: track.artist,
        bpm: track.bpm, key: track.key, popularity: track.popularity,
        path: track.path, features: track.features || null,
      };
      close();
      this._editSetlist('insert', this.lastSet.tour.length, payload);
    });
  }

  // Open a multi-file picker, ingest each selected audio file the same way
  // _processFiles / _handleImportSetlist do (parse tags, read rating, push
  // into library), then append every successfully-ingested track to the end
  // of the current setlist tour. Returns the number of tracks added so the
  // caller can decide whether to refresh.
  async _browseAndInsertFiles() {
    if (!window.setengine || !window.setengine.selectAudioFiles) return 0;
    const picked = await window.setengine.selectAudioFiles();
    if (!picked || picked.length === 0) return 0;

    const insertPayloads = [];
    const missingTags = [];
    for (const filePath of picked) {
      // Already in library? Just append it.
      const existing = this.library.find((t) => t.path === filePath);
      if (existing) {
        insertPayloads.push(this._tourPayloadFor(existing));
        continue;
      }
      let buffer;
      try { buffer = await window.setengine.readAudioFileBytes(filePath); }
      catch { missingTags.push(filePath); continue; }
      const fileName = filePath.split(/[\\/]/).pop();
      const realFile = new File([buffer], fileName);
      let meta;
      try { meta = await MetadataParser.parse(realFile); }
      catch { meta = null; }
      const bpm = meta && meta.bpm ? Math.round(meta.bpm * 10) / 10 : 0;
      const parsedKey = meta && meta.key ? TuneMatch.parseKey(meta.key) : null;
      if (!bpm || !parsedKey) { missingTags.push(filePath); continue; }
      let popularity = null, ratingSupported = true;
      try {
        const r = await window.setengine.readRating(filePath);
        if (r && r.supported === false) ratingSupported = false;
        if (r && typeof r.stars === 'number') popularity = r.stars;
      } catch { /* ignore */ }
      const track = {
        id: filePath,
        path: filePath,
        name: fileName,
        title: (meta.title || stripExt(fileName)).trim(),
        artist: (meta.artist || '').trim(),
        bpm,
        key: parsedKey.code,
        popularity,
        ratingSupported,
      };
      this.library.push(track);
      insertPayloads.push(this._tourPayloadFor(track));
    }

    // Append each successfully-ingested track at the end of the tour. We
    // append in one shot to avoid N rescore round-trips.
    if (insertPayloads.length > 0) {
      this.lastSet.tour.push(...insertPayloads);
      this.lastSet.modified = true;
      await this._rescoreSet();
      this._renderCurrentView();

      // Kick off background analysis for the new tracks so freq/phrase
      // diagnostics fill in.
      this._kickoffAnalysis(this.library);
    }
    
    // Auto-detect BPM/key for untagged tracks dragged into the setlist.
    if (missingTags.length > 0) {
      for (const p of missingTags) {
        this.untagged.push({ path: p, name: p.split(/[\\/]/).pop(), missing: 'both', bpm: 0, keyCode: '', title: '', artist: '' });
      }
      await this._handleAnalyzeTag();
      
      // Pull successfully-tagged tracks from library and append to tour.
      const newlyTaggedPayloads = [];
      for (const p of missingTags) {
        const newlyTagged = this.library.find(t => t.path === p);
        if (newlyTagged) newlyTaggedPayloads.push(this._tourPayloadFor(newlyTagged));
      }
      
      if (newlyTaggedPayloads.length > 0) {
        this.lastSet.tour.push(...newlyTaggedPayloads);
        this.lastSet.modified = true;
        await this._rescoreSet();
        this._renderCurrentView();
        
        // Ensure new ones get analyzed too
        this._kickoffAnalysis(this.library);
      }
      
      const totalAdded = insertPayloads.length + newlyTaggedPayloads.length;
      if (totalAdded > 0) showToast(`Added ${totalAdded} track${totalAdded === 1 ? '' : 's'}.`, 'success', 2500);
      return totalAdded;
    }

    if (insertPayloads.length > 0) {
      showToast(`Added ${insertPayloads.length} track${insertPayloads.length === 1 ? '' : 's'}.`, 'success', 2500);
    }
    return insertPayloads.length;
  }

  _tourPayloadFor(track) {
    return {
      id: track.id, title: track.title, artist: track.artist,
      bpm: track.bpm, key: track.key, popularity: track.popularity,
      path: track.path, features: track.features || null,
    };
  }

  // ── Setlist playback ───────────────────────────────────────────────

  async _playSetRow(idx, opts) {
    const set = this.lastSet;
    if (!set) return;
    const t = set.tour[idx];
    if (!t || !t.path) return;
    const startFraction = opts && typeof opts.startFraction === 'number' ? opts.startFraction : null;

    // Same row already loaded:
    //   - If we got a startFraction (progress-bar click), seek to it and
    //     resume from pause if needed. Don't restart playback.
    //   - Otherwise it's a play-button click → toggle pause.
    if (this.setPlayer && this.setPlayer.idx === idx && this.setPlayer.audio) {
      const a = this.setPlayer.audio;
      if (startFraction != null) {
        if (isFinite(a.duration) && a.duration > 0) {
          a.currentTime = Math.max(0, Math.min(a.duration, a.duration * startFraction));
        }
        if (a.paused) a.play().catch(() => {});
        return;
      }
      if (a.paused) a.play().catch(() => {});
      else a.pause();
      this._renderCurrentView();
      return;
    }

    this._stopSetPlayback();
    try {
      const audio = new Audio(audioUrlForPath(t.path));
      audio.preload = 'auto';
      const repaint = () => { if (this.view === 'setlist') this._renderCurrentView(); };
      const onTimeUpdate = () => this._updateSetProgress();
      const onLoadedMetadata = () => {
        if (startFraction != null && isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = Math.max(0, Math.min(audio.duration, audio.duration * startFraction));
        }
        this._updateSetProgress();
      };
      const onError = () => {
        if (!this.setPlayer || this.setPlayer.audio !== audio) return;
        const code = audio.error && audio.error.code;
        const ext = (t.path.split('.').pop() || '').toLowerCase();
        const msg = code === 4
          ? `Chromium can't decode this .${ext} file. Try re-encoding to MP3 or AAC.`
          : `Playback error (code ${code || '?'})`;
        this._stopSetPlayback();
        showToast(msg, 'error', 4000);
      };
      const onEnded = () => {
        if (!this.setPlayer || this.setPlayer.audio !== audio) return;
        const nextIdx = this.setPlayer.idx + 1;
        this._stopSetPlayback();
        if (nextIdx < set.tour.length) this._playSetRow(nextIdx);
        else repaint();
      };
      audio.addEventListener('play', repaint);
      audio.addEventListener('pause', repaint);
      audio.addEventListener('timeupdate', onTimeUpdate);
      audio.addEventListener('loadedmetadata', onLoadedMetadata);
      audio.addEventListener('error', onError);
      audio.addEventListener('ended', onEnded);
      this.setPlayer = { idx, audio, handlers: { repaint, onTimeUpdate, onLoadedMetadata, onError, onEnded } };
      await audio.play();
    } catch (err) {
      this._stopSetPlayback();
      showToast(`Playback failed: ${err.message}`, 'error', 3000);
    }
  }

  _stopSetPlayback() {
    if (!this.setPlayer) return;
    const { audio, handlers } = this.setPlayer;
    if (audio) {
      if (handlers) {
        audio.removeEventListener('play', handlers.repaint);
        audio.removeEventListener('pause', handlers.repaint);
        audio.removeEventListener('timeupdate', handlers.onTimeUpdate);
        audio.removeEventListener('loadedmetadata', handlers.onLoadedMetadata);
        audio.removeEventListener('error', handlers.onError);
        audio.removeEventListener('ended', handlers.onEnded);
      }
      try { audio.pause(); } catch {}
      try { audio.src = ''; } catch {}
    }
    this.setPlayer = null;
  }

  _updateSetProgress() {
    if (!this.setPlayer || !this.setPlayer.audio || this.view !== 'setlist' || !this.dom.root) return;
    const a = this.setPlayer.audio;
    if (!isFinite(a.duration) || a.duration <= 0) return;
    const idx = this.setPlayer.idx;
    const fill = this.dom.root.querySelector(`[data-progress-fill-idx="${idx}"]`);
    if (fill) fill.style.width = `${(a.currentTime / a.duration * 100).toFixed(2)}%`;
    const time = this.dom.root.querySelector(`[data-progress-time-idx="${idx}"]`);
    if (time) time.textContent = `${formatTime(a.currentTime)} / ${formatTime(a.duration)}`;
  }

  _handleCopySetlist() {
    if (!this.lastSet) return;
    const text = this.lastSet.tour.map((t, i) =>
      `${String(i + 1).padStart(2, '0')}. ${t.artist ? t.artist + ' - ' : ''}${t.title || ''}  [${t.key} · ${t.bpm} BPM]`
    ).join('\n');
    navigator.clipboard.writeText(text).then(
      () => showToast('Setlist copied', 'success', 2000),
      () => showToast('Clipboard write failed', 'error', 3000),
    );
  }

  async _handleExportM3U() {
    if (!this.lastSet) return;
    const tracks = this.lastSet.tour.map(t => ({
      title: t.title,
      artist: t.artist,
      path: t.path,
      // EXTINF wants seconds. The tour carries duration in features.durationMs
      // (populated by analysis); fall back to undefined so the writer emits the
      // standard "-1" for tracks that were never analyzed.
      duration: (t.features && typeof t.features.durationMs === 'number' && t.features.durationMs > 0)
        ? t.features.durationMs / 1000
        : undefined,
    }));
    const res = await window.setengine.exportM3U(tracks);
    if (res && res.success) showToast(`Exported to ${res.destPath}`, 'success', 4000);
    else if (res && res.cancelled) { /* user cancelled — silent */ }
    else showToast(`Export failed: ${(res && res.error) || 'unknown'}`, 'error', 4000);
  }

  // ── Rate view ──────────────────────────────────────────────────────

  _enterRateModeAt(idx) {
    if (idx < 0 || idx >= this.library.length) return;
    const t = this.library[idx];
    if (t.ratingSupported === false) {
      showToast('Rating not supported for this file format.', 'warning', 3000);
      return;
    }
    this.rate = { idx, skipped: new Set(), audio: null, playing: false };
    this._setView('rate');
  }

  _renderRateView() {
    const root = this.dom.root;
    const t = this.library[this.rate.idx];
    const total = this.library.length;
    const rated = this.library.filter(x => x.popularity != null).length;

    root.innerHTML = `
      <div class="sm-rate-wrap">
        <div class="sm-rate-header">
          <button class="btn-secondary" id="sm-rate-exit">← Done</button>
          <div class="sm-rate-progress">Rated <strong>${rated}</strong> of <strong>${total}</strong> · ${this.rate.skipped.size} skipped</div>
        </div>
        <div class="sm-rate-card">
          <div class="sm-rate-title">${escapeHtml(t.title || t.name)}</div>
          <div class="sm-rate-artist">${escapeHtml(t.artist || '')}</div>
          <div class="sm-rate-meta">${t.key} · ${t.bpm} BPM</div>
          <div class="sm-rate-stars" id="sm-rate-stars">
            ${[1,2,3,4,5].map(n => `<button class="sm-star-btn" data-star="${n}">${n}★</button>`).join('')}
          </div>
          <div class="sm-rate-keyhint">1–5 rate · S skip · ← prev · → next · Space play/pause · Esc exit</div>
          <div class="sm-rate-audio">
            <button class="sm-rate-play" id="sm-rate-play">⏸</button>
            <div class="sm-rate-seek"><div class="sm-rate-seek-fill" id="sm-rate-seek-fill"></div></div>
            <div class="sm-rate-time" id="sm-rate-time">0:00</div>
          </div>
        </div>
        <div class="sm-rate-footer">
          <button class="btn-secondary" id="sm-rate-prev">← Previous</button>
          <button class="btn-secondary" id="sm-rate-skip">Skip (S)</button>
          <button class="btn-secondary" id="sm-rate-next">Next →</button>
        </div>
      </div>
    `;

    root.querySelector('#sm-rate-exit').addEventListener('click', () => this._setView('library'));
    root.querySelector('#sm-rate-prev').addEventListener('click', () => this._rateMove(-1));
    root.querySelector('#sm-rate-next').addEventListener('click', () => this._rateMove(+1));
    root.querySelector('#sm-rate-skip').addEventListener('click', () => this._rateSkip());
    root.querySelector('#sm-rate-play').addEventListener('click', () => this._togglePlay());
    root.querySelectorAll('.sm-star-btn').forEach(b => {
      b.addEventListener('click', () => this._submitRating(parseInt(b.dataset.star, 10)));
    });

    this._onKeyDown = (e) => this._handleRateKey(e);
    document.addEventListener('keydown', this._onKeyDown);

    this._startRatePlayback();
  }

  _handleRateKey(e) {
    if (this.view !== 'rate') return;
    if (e.key >= '1' && e.key <= '5') { e.preventDefault(); this._submitRating(parseInt(e.key, 10)); }
    else if (e.key === '0' || e.key === 's' || e.key === 'S') { e.preventDefault(); this._rateSkip(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this._rateMove(+1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this._rateMove(-1); }
    else if (e.key === ' ') { e.preventDefault(); this._togglePlay(); }
    else if (e.key === 'Escape') { e.preventDefault(); this._setView('library'); }
  }

  async _submitRating(stars) {
    const t = this.library[this.rate.idx];
    if (!t || t.ratingSupported === false) { this._rateMove(+1); return; }
    try {
      const res = await window.setengine.rateTrack(t.path, stars);
      if (res && res.supported === false) {
        t.ratingSupported = false;
        showToast('Format does not support ratings.', 'warning', 2500);
      } else if (res && res.success) {
        t.popularity = stars;
      } else {
        showToast(`Rating save failed: ${(res && res.error) || 'unknown'}`, 'error', 3000);
        return;
      }
    } catch (err) {
      showToast(`Rating save failed: ${err.message}`, 'error', 3000);
      return;
    }
    this._rateMove(+1);
  }

  _rateSkip() {
    const t = this.library[this.rate.idx];
    if (t) this.rate.skipped.add(t.id);
    this._rateMove(+1);
  }

  _rateMove(delta) {
    let next = this.rate.idx + delta;
    if (delta > 0) {
      // Skip rating-unsupported tracks while moving forward
      while (next < this.library.length && this.library[next] && this.library[next].ratingSupported === false) next++;
    } else {
      while (next >= 0 && this.library[next] && this.library[next].ratingSupported === false) next--;
    }
    if (next >= this.library.length) {
      showToast('End of library.', 'success', 2500);
      this._setView('library');
      return;
    }
    if (next < 0) next = 0;
    this.rate.idx = next;
    this._renderCurrentView();
  }

  async _startRatePlayback() {
    this._stopRatePlayback();
    const t = this.library[this.rate.idx];
    if (!t) return;
    try {
      const audio = new Audio(audioUrlForPath(t.path));
      audio.preload = 'auto';
      this.rate.audio = audio;

      const onLoadedMetadata = () => {
        if (isFinite(audio.duration) && audio.duration > 1) {
          audio.currentTime = Math.min(audio.duration * 0.30, audio.duration - 5);
        }
        audio.play().then(() => { this.rate.playing = true; this._updatePlayBtn(); })
          .catch(() => { /* autoplay denied — user can press Space */ });
      };
      const onTimeUpdate = () => this._updateSeek();
      const onEnded = () => { this.rate.playing = false; this._updatePlayBtn(); };

      audio.addEventListener('loadedmetadata', onLoadedMetadata);
      audio.addEventListener('timeupdate', onTimeUpdate);
      audio.addEventListener('ended', onEnded);
      this.rate.handlers = { onLoadedMetadata, onTimeUpdate, onEnded };
    } catch (err) {
      showToast(`Playback unavailable: ${err.message}`, 'warning', 3000);
    }
  }

  _updateSeek() {
    if (!this.rate || !this.rate.audio) return;
    const fill = this.dom.root.querySelector('#sm-rate-seek-fill');
    const time = this.dom.root.querySelector('#sm-rate-time');
    const a = this.rate.audio;
    if (fill && isFinite(a.duration)) fill.style.width = `${(a.currentTime / a.duration) * 100}%`;
    if (time) {
      const s = Math.floor(a.currentTime);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
  }

  _updatePlayBtn() {
    const btn = this.dom.root.querySelector('#sm-rate-play');
    if (btn) btn.textContent = this.rate.playing ? '⏸' : '▶';
  }

  _togglePlay() {
    if (!this.rate || !this.rate.audio) return;
    if (this.rate.playing) { this.rate.audio.pause(); this.rate.playing = false; }
    else { this.rate.audio.play(); this.rate.playing = true; }
    this._updatePlayBtn();
  }

  _stopRatePlayback() {
    if (this.rate && this.rate.audio) {
      const { audio, handlers } = this.rate;
      if (handlers) {
        audio.removeEventListener('loadedmetadata', handlers.onLoadedMetadata);
        audio.removeEventListener('timeupdate', handlers.onTimeUpdate);
        audio.removeEventListener('ended', handlers.onEnded);
      }
      try { audio.pause(); audio.src = ''; } catch {}
    }
    if (this.rate) {
      this.rate.audio = null;
      this.rate.handlers = null;
      this.rate.playing = false;
    }
  }
}

function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? name : name.slice(0, i);
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Build a setengine-audio:// URL for an absolute file path. We base64url-
// encode the path so that anything goes — slashes, spaces, NFD Unicode on
// macOS — without colliding with URL parser semantics. The matching decoder
// lives in main.js's protocol handler.
function audioUrlForPath(p) {
  const utf8 = new TextEncoder().encode(String(p));
  let bin = '';
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `setengine-audio://local/${b64}`;
}
