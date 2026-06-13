import * as TuneMatch from './tunematch/engine.js';
import * as MetadataParser from './tunematch/metadata.js';
import { showToast } from '../components/toast.js';

export class MatchPage {
  constructor(app) {
    this.app = app;
    this.container = null;

    // Restore state from app singleton if it exists — preserves library across tab switches
    const saved = app.matchState;
    this.library = saved?.library || [];
    this.keyIndex = saved?.keyIndex || {};
    this.selectedSong = saved?.selectedSong || null;
    this.sortCol = saved?.sortCol || 'title';
    this.sortDir = saved?.sortDir || 1;
    this.nextId = saved?.nextId || 0;
    this.dedupeSet = saved?.dedupeSet || new Set();
    this.bpmThresholdValue = saved?.bpmThresholdValue || 10;
    this.lastSearchQuery = saved?.lastSearchQuery || '';

    // Path-bearing files that imported without a usable BPM/key tag, retained so
    // the user can detect + write the missing tags. Drag-dropped File objects
    // have no disk path and can't be analyzed, so they're never retained here.
    this.untaggedFiles = saved?.untaggedFiles || [];
    this._untaggedSeen = new Set(this.untaggedFiles.map(u => u.path));
    this.tagging = false;

    this.filtered = this.library;
    this.importing = false;
    this.dragCounter = 0;
    this.cancelled = false;

    this.dom = {};
    this._unsubscribeTagProgress = null;
    if (window.setengine && window.setengine.onTagProgress) {
      this._unsubscribeTagProgress = window.setengine.onTagProgress(
        (data) => this._handleTagProgress(data)
      );
    }
    this._boundKeydown = null;
    this._boundDragEnter = null;
    this._boundDragLeave = null;
    this._boundDragOver = null;
    this._boundDrop = null;
  }

  saveState() {
    this.app.matchState = {
      library: this.library,
      keyIndex: this.keyIndex,
      selectedSong: this.selectedSong,
      sortCol: this.sortCol,
      sortDir: this.sortDir,
      nextId: this.nextId,
      dedupeSet: this.dedupeSet,
      untaggedFiles: this.untaggedFiles,
      bpmThresholdValue: parseInt(this.dom.bpmThreshold?.value ?? this.bpmThresholdValue, 10),
      lastSearchQuery: this.dom.searchInput?.value ?? this.lastSearchQuery,
      tagging: this.tagging,
    };
  }

  render(container) {
    this.container = container;
    container.classList.add('match-host');

    container.innerHTML = `
      <div class="match-page">
        <div class="match-topbar">
          <div class="match-titlewrap">
            <h1 class="page-title">Match Maker</h1>
            <div class="match-stats">
              <span>Songs: <strong id="m-stat-songs">0</strong></span>
              <span>Keys: <strong id="m-stat-keys">0</strong></span>
              <span>BPM: <strong id="m-stat-bpm">—</strong></span>
            </div>
          </div>
        </div>

        <div class="match-toolbar">
          <input type="file" id="m-folder-input" webkitdirectory multiple style="display:none">
          <button class="btn" id="m-import-folder-btn">IMPORT FOLDERS</button>
          <button class="btn-secondary" id="m-clear-btn">CLEAR</button>

          <div class="m-toolbar-sep"></div>

          <input type="text" class="input m-search" id="m-search-input" placeholder="Search title, artist, key, bpm...">

          <div class="m-toolbar-sep"></div>

          <label class="m-slider-label">BPM ±</label>
          <span class="m-slider-val" id="m-bpm-threshold-val">10</span>
          <input type="range" id="m-bpm-threshold" min="1" max="30" value="10" class="m-slider">
        </div>

        <div class="match-progress" id="m-progress-wrap" style="display:none;">
          <div class="m-progress-track"><div class="m-progress-bar" id="m-progress-bar"></div></div>
          <span class="m-progress-text" id="m-progress-text"></span>
        </div>


        <div class="match-main">
          <div class="match-library">
            <div class="match-panel-header">
              <h2>Library</h2>
              <span id="m-library-count">0 songs</span>
            </div>
            <div class="match-empty" id="m-empty-state">
              <div class="match-empty-icon">▼</div>
              <p>Drop a folder of audio files here<br>or click <strong>Import Folder</strong></p>
              <p class="hint">Supports MP3, FLAC, WAV, AIFF, OGG, M4A</p>
              <p class="hint">Reads BPM &amp; Key from file metadata (ID3 / Vorbis)</p>
              <p class="hint">You can also import CSV or JSON files</p>
            </div>
            <div class="match-table-wrap" id="m-table-wrap" style="display:none;">
              <div class="match-table-head">
                <table>
                  <thead id="m-thead">
                    <tr>
                      <th class="m-col-num">#</th>
                      <th class="m-col-title" data-col="title">Title</th>
                      <th class="m-col-artist" data-col="artist">Artist</th>
                      <th class="m-col-bpm" data-col="bpm">BPM</th>
                      <th class="m-col-key" data-col="key">Key</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div class="match-table-body">
                <table>
                  <tbody id="m-tbody"></tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="match-results-panel">
            <div class="match-empty" id="m-match-empty">
              <div class="match-empty-icon">◆</div>
              <p>Select a song to see matches</p>
            </div>
            <div class="match-selected" id="m-match-selected" style="display:none;">
              <h3 id="m-match-song-title"></h3>
              <div class="meta" id="m-match-song-meta"></div>
            </div>
            <div class="match-results" id="m-match-results" style="display:none;">
              <div class="tier-section tier-1">
                <div class="tier-header">
                  <h4>Tier 1 — Same Key</h4>
                  <span class="tier-count" id="m-tier1-count">0</span>
                </div>
                <ul class="tier-list" id="m-tier1-list"></ul>
              </div>
              <div class="tier-section tier-2">
                <div class="tier-header">
                  <h4>Tier 2 — ±1 Semitone</h4>
                  <span class="tier-count" id="m-tier2-count">0</span>
                </div>
                <ul class="tier-list" id="m-tier2-list"></ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="m-drop-overlay" class="match-drop-overlay">
        <div class="match-drop-msg">DROP FILES OR FOLDERS TO IMPORT</div>
      </div>


    `;

    this.cacheDom();
    this.bindEvents();

    // Restore UI state from persisted values
    this.dom.bpmThreshold.value = this.bpmThresholdValue;
    this.dom.bpmThresholdVal.textContent = this.bpmThresholdValue;
    if (this.lastSearchQuery) {
      this.dom.searchInput.value = this.lastSearchQuery;
    }

    this.applySearch();
    this.applySort();
    this.renderLibrary();
    this.updateSortIndicators();
    this.updateStats();

    // Auto-detect BPM/key for untagged files retained from a previous visit.
    if (this.untaggedFiles.length > 0 && !this.tagging) {
      this._handleAnalyzeTag();
    }

    if (this.selectedSong) this.showMatches(this.selectedSong);
  }

  destroy() {
    this.cancelled = true;
    this.saveState();

    if (this._unsubscribeTagProgress) {
      this._unsubscribeTagProgress();
      this._unsubscribeTagProgress = null;
    }

    if (this.container) {
      this.container.classList.remove('match-host');
    }

    if (this._boundKeydown) document.removeEventListener('keydown', this._boundKeydown);
    if (this._boundDragEnter) document.removeEventListener('dragenter', this._boundDragEnter);
    if (this._boundDragLeave) document.removeEventListener('dragleave', this._boundDragLeave);
    if (this._boundDragOver) document.removeEventListener('dragover', this._boundDragOver);
    if (this._boundDrop) document.removeEventListener('drop', this._boundDrop);
  }

  cacheDom() {
    const d = this.dom;
    const $ = (id) => document.getElementById(id);
    d.folderInput     = $('m-folder-input');
    d.importFolderBtn = $('m-import-folder-btn');
    d.clearBtn        = $('m-clear-btn');
    d.searchInput     = $('m-search-input');
    d.bpmThreshold    = $('m-bpm-threshold');
    d.bpmThresholdVal = $('m-bpm-threshold-val');
    d.libraryCount    = $('m-library-count');
    d.tableHead       = $('m-thead');
    d.tableBody       = $('m-tbody');
    d.emptyState      = $('m-empty-state');
    d.matchEmpty      = $('m-match-empty');
    d.matchSelected   = $('m-match-selected');
    d.matchResults    = $('m-match-results');
    d.matchTitle      = $('m-match-song-title');
    d.matchMeta       = $('m-match-song-meta');
    d.tier1List       = $('m-tier1-list');
    d.tier2List       = $('m-tier2-list');
    d.tier1Count      = $('m-tier1-count');
    d.tier2Count      = $('m-tier2-count');
    d.dropOverlay     = $('m-drop-overlay');
    d.statSongs       = $('m-stat-songs');
    d.statKeys        = $('m-stat-keys');
    d.statBpm         = $('m-stat-bpm');

    d.tableWrap       = $('m-table-wrap');
    d.progressWrap    = $('m-progress-wrap');
    d.progressBar     = $('m-progress-bar');
    d.progressText    = $('m-progress-text');
  }

  bindEvents() {
    const d = this.dom;

    d.importFolderBtn.addEventListener('click', () => {
      if (this.importing) return;
      if (window.setengine && window.setengine.selectFolders) {
        this.handleImportFolders();
      } else {
        // Fallback: single-folder webkitdirectory picker
        d.folderInput.click();
      }
    });
    d.folderInput.addEventListener('change', (e) => this.handleFolderSelect(e));
    d.clearBtn.addEventListener('click', () => this.clearLibrary());
    d.searchInput.addEventListener('input', () => this.onSearch());
    d.bpmThreshold.addEventListener('input', () => this.onThresholdChange());


    d.tableHead.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      const col = th.dataset.col;
      if (this.sortCol === col) {
        this.sortDir *= -1;
      } else {
        this.sortCol = col;
        this.sortDir = 1;
      }
      this.applySort();
      this.renderLibrary();
      this.updateSortIndicators();
    });

    d.tableBody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const id = parseInt(tr.dataset.id, 10);
      const song = this.library.find(s => s._id === id);
      if (song) this.selectSong(song);
    });

    // Drag and drop (document-level so any drop into the renderer is captured)
    this._boundDragEnter = (e) => {
      // Only respond to file drags
      if (e.dataTransfer && e.dataTransfer.types &&
          Array.from(e.dataTransfer.types).indexOf('Files') === -1) return;
      e.preventDefault();
      this.dragCounter++;
      d.dropOverlay.classList.add('visible');
    };
    this._boundDragLeave = (e) => {
      e.preventDefault();
      this.dragCounter--;
      if (this.dragCounter <= 0) {
        this.dragCounter = 0;
        d.dropOverlay.classList.remove('visible');
      }
    };
    this._boundDragOver = (e) => {
      if (e.dataTransfer && e.dataTransfer.types &&
          Array.from(e.dataTransfer.types).indexOf('Files') === -1) return;
      e.preventDefault();
    };
    this._boundDrop = (e) => {
      if (e.dataTransfer && e.dataTransfer.types &&
          Array.from(e.dataTransfer.types).indexOf('Files') === -1) return;
      e.preventDefault();
      this.dragCounter = 0;
      d.dropOverlay.classList.remove('visible');
      if (this.importing) return;
      this.handleDrop(e);
    };
    document.addEventListener('dragenter', this._boundDragEnter);
    document.addEventListener('dragleave', this._boundDragLeave);
    document.addEventListener('dragover', this._boundDragOver);
    document.addEventListener('drop', this._boundDrop);

    this._boundKeydown = (e) => {
      if (e.key === 'Escape') this.deselectSong();
    };
    document.addEventListener('keydown', this._boundKeydown);
  }

  // ---- File / folder handling ----

  async handleImportFolders() {
    if (this.importing) return;
    let folderPaths;
    try {
      folderPaths = await window.setengine.selectFolders();
    } catch (e) {
      showToast('Failed to open folder picker: ' + (e.message || e), 'error');
      return;
    }
    if (!folderPaths || !folderPaths.length) return;

    this.importing = true;
    this.setImportingUI(true);
    this.showProgress(0, 0, 'Scanning folders...');

    let descriptors;
    try {
      descriptors = await window.setengine.scanFoldersForAudio(folderPaths);
    } catch (e) {
      this.hideProgress();
      this.importing = false;
      this.setImportingUI(false);
      showToast('Failed to scan folders: ' + (e.message || e), 'error');
      return;
    }

    if (!descriptors || !descriptors.length) {
      this.hideProgress();
      this.importing = false;
      this.setImportingUI(false);
      showToast('No audio files found', 'info');
      return;
    }

    // processIncomingFiles owns the importing/UI flag flip; release before calling it.
    this.importing = false;
    this.setImportingUI(false);
    this.hideProgress();
    this.processIncomingFiles(descriptors);
  }

  handleFolderSelect(e) {
    if (!e.target.files.length) return;
    const files = Array.from(e.target.files);
    e.target.value = '';
    this.processIncomingFiles(files);
  }

  async handleDrop(e) {
    const items = e.dataTransfer.items;
    if (!items || !items.length) return;

    const files = [];
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }

    if (entries.length > 0) {
      this.showProgress(0, 0, 'Scanning folders...');
      for (const entry of entries) {
        await this.traverseEntry(entry, files);
      }
      this.processIncomingFiles(files);
    }
  }

  traverseEntry(entry, files) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => {
          f._relativePath = entry.fullPath || f.name;
          files.push(f);
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        this.readAllEntries(entry.createReader()).then(async (entries) => {
          for (const e of entries) {
            await this.traverseEntry(e, files);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  readAllEntries(reader) {
    return new Promise((resolve) => {
      const all = [];
      const readBatch = () => {
        reader.readEntries((entries) => {
          if (entries.length === 0) return resolve(all);
          all.push(...entries);
          readBatch();
        }, () => resolve(all));
      };
      readBatch();
    });
  }

  async processIncomingFiles(files) {
    if (this.importing) return;
    this.importing = true;
    this.setImportingUI(true);

    const audioFiles = [];
    const dataFiles = [];

    for (const f of files) {
      // Path descriptors come from the IPC scan — already filtered, no Blob to inspect.
      if (f && typeof f.path === 'string' && typeof f.size === 'number' && !(f instanceof Blob)) {
        audioFiles.push(f);
        continue;
      }
      const name = f.name.toLowerCase();
      if (name.endsWith('.csv') || name.endsWith('.json')) {
        dataFiles.push(f);
      } else if (MetadataParser.isAudioFile(f.name)) {
        audioFiles.push(f);
      }
    }

    let totalAdded = 0;
    let totalDupes = 0;
    let totalErrors = 0;

    for (const f of dataFiles) {
      const text = await this.readFileText(f);
      let songs;
      if (f.name.toLowerCase().endsWith('.json')) {
        songs = this.parseJSON(text);
      } else {
        songs = this.parseCSV(text);
      }
      const { added, dupes } = this.deduplicateAndAdd(songs);
      totalAdded += added;
      totalDupes += dupes;
    }

    if (audioFiles.length > 0) {
      const result = await this.processAudioFiles(audioFiles);
      totalAdded += result.added;
      totalDupes += result.dupes;
      totalErrors += result.errors;
    }

    this.importing = false;

    // If the page was torn down mid-import, persist what we got and bail —
    // skip DOM writes (stale refs) and skip the completion toast (user has left).
    if (this.cancelled) {
      this.app.matchState = {
        ...(this.app.matchState || {}),
        library: this.library,
        keyIndex: TuneMatch.buildIndex(this.library),
        selectedSong: this.selectedSong,
        sortCol: this.sortCol,
        sortDir: this.sortDir,
        nextId: this.nextId,
        dedupeSet: this.dedupeSet,
      };
      return;
    }

    this.onLibraryChanged();
    if (!this.tagging) {
      this.hideProgress();
    }
    this.setImportingUI(false);

    let msg = `Imported ${totalAdded} song${totalAdded !== 1 ? 's' : ''}`;
    const notes = [];
    if (totalDupes > 0) notes.push(`${totalDupes} duplicates skipped`);
    if (totalErrors > 0) notes.push(`${totalErrors} skipped — see log`);
    if (notes.length) msg += ` (${notes.join(', ')})`;
    showToast(msg, totalAdded > 0 ? 'success' : 'info');
  }

  readFileText(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve('');
      r.readAsText(file);
    });
  }

  async processAudioFiles(files) {
    let added = 0, dupes = 0;
    const skip = { noBpm: 0, noKey: 0, badKey: 0, parseErr: 0 };
    const skippedSamples = [];
    const diagFiles = [];

    this.showProgress(0, files.length, 'Reading metadata...');

    for (let i = 0; i < files.length; i++) {
      if (this.cancelled) break;
      let parseTarget = files[i];
      try {
        // Path descriptor: load bytes via IPC and wrap as a real File so MetadataParser works unchanged.
        if (parseTarget && typeof parseTarget.path === 'string' && !(parseTarget instanceof Blob)) {
          try {
            const buffer = await window.setengine.readAudioFileBytes(parseTarget.path);
            const real = new File([buffer], parseTarget.name);
            real._relativePath = parseTarget.relativePath || parseTarget.name;
            parseTarget = real;
          } catch (readErr) {
            skip.parseErr++;
            this.logSkipped(skippedSamples, files[i], 'read failed: ' + (readErr.message || readErr));
            this._retainUntagged(files[i], null);
            // No real File yet — diagnose can't read this file, so skip diag for it.
            if (i % 20 === 0 || i === files.length - 1) {
              this.showProgress(i + 1, files.length, 'Reading metadata...');
              await this.yieldUI();
            }
            continue;
          }
        }
        const meta = await MetadataParser.parse(parseTarget);

        if (!meta) {
          skip.parseErr++;
          this.logSkipped(skippedSamples, parseTarget, 'parse returned null');
          this._retainUntagged(files[i], null);
          if (diagFiles.length < 10) diagFiles.push(parseTarget);
        } else if (!meta.bpm) {
          skip.noBpm++;
          this.logSkipped(skippedSamples, parseTarget, 'no BPM found (key=' + (meta.key || 'none') + ')');
          this._retainUntagged(files[i], meta);
          if (diagFiles.length < 10) diagFiles.push(parseTarget);
        } else if (!meta.key) {
          skip.noKey++;
          this.logSkipped(skippedSamples, parseTarget, 'no Key found (bpm=' + meta.bpm + ')');
          this._retainUntagged(files[i], meta);
          if (diagFiles.length < 10) diagFiles.push(parseTarget);
        } else {
          const parsedKey = TuneMatch.parseKey(meta.key);
          if (!parsedKey) {
            skip.badKey++;
            this.logSkipped(skippedSamples, parseTarget, 'key not recognized: "' + meta.key + '" (bpm=' + meta.bpm + ')');
            this._retainUntagged(files[i], meta);
            if (diagFiles.length < 10) diagFiles.push(parseTarget);
          } else {
            const title = (meta.title || 'Untitled').trim();
            const artist = (meta.artist || 'Unknown').trim();
            const bpm = Math.round(meta.bpm * 10) / 10;

            const dk = this.dedupeKey(title, artist, bpm, parsedKey.code);
            if (this.dedupeSet.has(dk)) {
              dupes++;
            } else {
              this.dedupeSet.add(dk);
              this.library.push({
                _id: this.nextId++,
                title,
                artist,
                bpm,
                key: parsedKey.code,
                parsedKey,
                folder: this.folderFromPath(files[i]),
              });
              added++;
            }
          }
        }
      } catch (e) {
        skip.parseErr++;
        this.logSkipped(skippedSamples, parseTarget, 'exception: ' + (e.message || e));
        this._retainUntagged(files[i], null);
        // Only push to diagFiles if parseTarget can be read by diagnose() (i.e., is a Blob/File).
        if (parseTarget instanceof Blob && diagFiles.length < 10) diagFiles.push(parseTarget);
      }

      if (i % 20 === 0 || i === files.length - 1) {
        this.showProgress(i + 1, files.length, 'Reading metadata...');
        await this.yieldUI();
      }
    }

    const totalSkipped = skip.noBpm + skip.noKey + skip.badKey + skip.parseErr;
    if (this.cancelled) return { added, dupes, errors: totalSkipped };

    // Auto-detect BPM/key for any files that need it (no manual banner).
    if (this.untaggedFiles.length > 0) {
      this._handleAnalyzeTag();
    }
    return { added, dupes, errors: totalSkipped };
  }

  logSkipped(arr, file, reason) {
    if (arr.length < 30) {
      const name = file.webkitRelativePath || file._relativePath || file.relativePath || file.name;
      arr.push({ name, reason });
    }
  }

  folderFromPath(file) {
    const path = file.webkitRelativePath || file._relativePath || file.relativePath || '';
    if (!path) return '';
    const parts = path.split('/');
    parts.pop();
    return parts.join('/');
  }

  yieldUI() {
    return new Promise((r) => setTimeout(r, 0));
  }

  // ---- Dedup ----

  dedupeKey(title, artist, bpm, keyCode) {
    return `${String(title).toLowerCase()}|${String(artist).toLowerCase()}|${bpm}|${keyCode}`;
  }

  deduplicateAndAdd(songs) {
    let added = 0, dupes = 0;
    for (const s of songs) {
      const dk = this.dedupeKey(s.title, s.artist, s.bpm, s.key);
      if (this.dedupeSet.has(dk)) {
        dupes++;
      } else {
        this.dedupeSet.add(dk);
        this.library.push(s);
        added++;
      }
    }
    return { added, dupes };
  }

  // ---- CSV / JSON ----

  parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];

    const header = this.splitCSVLine(lines[0]).map(h => h.toLowerCase().trim());
    const colTitle  = this.findCol(header, ['title', 'name', 'track', 'track name', 'song']);
    const colArtist = this.findCol(header, ['artist', 'artist name', 'performer']);
    const colBpm    = this.findCol(header, ['bpm', 'tempo']);
    const colKey    = this.findCol(header, ['key', 'camelot', 'camelot key']);

    if (colBpm === -1 || colKey === -1) {
      showToast('CSV missing required columns: bpm, key', 'error');
      return [];
    }

    const songs = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this.splitCSVLine(lines[i]);
      if (cols.length <= Math.max(colBpm, colKey)) continue;

      const bpmRaw = parseFloat(cols[colBpm]);
      const keyRaw = cols[colKey];
      if (isNaN(bpmRaw) || !keyRaw) continue;

      const parsedKey = TuneMatch.parseKey(keyRaw);
      if (!parsedKey) continue;

      songs.push({
        _id: this.nextId++,
        title: colTitle !== -1 ? cols[colTitle].trim() : 'Untitled',
        artist: colArtist !== -1 ? cols[colArtist].trim() : 'Unknown',
        bpm: Math.round(bpmRaw * 10) / 10,
        key: parsedKey.code,
        parsedKey,
      });
    }
    return songs;
  }

  splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = false;
        } else { current += ch; }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { result.push(current); current = ''; }
        else current += ch;
      }
    }
    result.push(current);
    return result;
  }

  findCol(headers, aliases) {
    for (const a of aliases) {
      const idx = headers.indexOf(a);
      if (idx !== -1) return idx;
    }
    return -1;
  }

  parseJSON(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { showToast('Invalid JSON file', 'error'); return []; }

    if (!Array.isArray(data)) { showToast('JSON must be an array', 'error'); return []; }

    const songs = [];
    for (const item of data) {
      const bpmRaw = parseFloat(item.bpm || item.BPM || item.tempo);
      const keyRaw = item.key || item.Key || item.camelot;
      if (isNaN(bpmRaw) || !keyRaw) continue;

      const parsedKey = TuneMatch.parseKey(keyRaw);
      if (!parsedKey) continue;

      songs.push({
        _id: this.nextId++,
        title: (item.title || item.Title || item.name || 'Untitled').toString().trim(),
        artist: (item.artist || item.Artist || item.performer || 'Unknown').toString().trim(),
        bpm: Math.round(bpmRaw * 10) / 10,
        key: parsedKey.code,
        parsedKey,
      });
    }
    return songs;
  }

  // ---- Library lifecycle ----

  onLibraryChanged() {
    this.applySort();
    this.applySearch();
    this.keyIndex = TuneMatch.buildIndex(this.library);
    this.renderLibrary();
    this.updateStats();
    this.updateSortIndicators();

    if (this.selectedSong) this.showMatches(this.selectedSong);
  }

  // ---- BPM/Key detection + tagging ----

  // Retain a path-bearing file that imported without a usable BPM/key so the
  // user can detect + write the missing tags. `meta` may be null (unreadable).
  _retainUntagged(descriptor, meta) {
    const p = descriptor && typeof descriptor.path === 'string' ? descriptor.path : '';
    if (!p) return;                       // drag-dropped File: no disk path → can't analyze
    if (this._untaggedSeen.has(p)) return;
    this._untaggedSeen.add(p);
    const bpm = meta && meta.bpm ? Math.round(meta.bpm * 10) / 10 : 0;
    const parsed = meta && meta.key ? TuneMatch.parseKey(meta.key) : null;
    this.untaggedFiles.push({
      path: p,
      name: descriptor.name || p.split(/[\\/]/).pop(),
      relativePath: descriptor.relativePath || descriptor.name || '',
      bpm,
      keyCode: parsed ? parsed.code : '',
      title: (meta && meta.title) || '',
      artist: (meta && meta.artist) || '',
    });
  }

  // Which fields a retained record is missing (gap-fill), preferring captured
  // partial metadata.
  _needForUntagged(u) {
    const haveBpm = !!u.bpm, haveKey = !!u.keyCode;
    if (haveBpm && !haveKey) return 'key';
    if (!haveBpm && haveKey) return 'bpm';
    return 'both';
  }



  // Detect the missing BPM/key for every retained file, write the values into
  // the originals, and add the successfully-tagged files into the library.
  async _handleAnalyzeTag() {
    if (this.tagging || this.untaggedFiles.length === 0) return;
    if (!window.setengine || !window.setengine.detectAndTagFiles) {
      showToast('Tagging not available.', 'error', 3000);
      return;
    }

    const targets = this.untaggedFiles.slice();
    const items = targets.map(u => ({
      id: u.path, path: u.path, need: this._needForUntagged(u),
      title: u.title || '', artist: u.artist || '',
    }));
    this.tagging = true;
    this._tagTotal = items.length;
    this._tagDone = 0;
    this._tagPending = new Set(items.map(i => i.path));
    this.showProgress(0, this._tagTotal, 'Detecting BPM & key...');


    let resp;
    try {
      resp = await window.setengine.detectAndTagFiles(items);
    } catch (err) {
      this.tagging = false;
      this._tagPending = null;
      this.hideProgress();

      showToast(`Tagging failed: ${err.message}`, 'error', 5000);
      return;
    }

    const results = (resp && resp.results) || [];
    const byPath = new Map(results.map(r => [r.path, r]));
    const songs = [];
    const stillUntagged = [];
    let notWritten = 0, failed = 0, review = 0;

    for (const u of targets) {
      const r = byPath.get(u.path);
      if (!r || r.error) { stillUntagged.push(u); failed++; continue; }
      const bpmRaw = (typeof r.bpm === 'number' && r.bpm > 0) ? r.bpm : (u.bpm || 0);
      const keyCode = r.keyCamelot || u.keyCode || '';
      const parsedKey = keyCode ? TuneMatch.parseKey(keyCode) : null;
      if (!bpmRaw || !parsedKey) { stillUntagged.push(u); failed++; continue; }
      if (r.writeSupported === false || !r.written) notWritten++;
      if (r.needsReview) review++;
      songs.push({
        _id: this.nextId++,
        title: (u.title || u.name.replace(/\.[^./\\]+$/, '') || 'Untitled').trim(),
        artist: (u.artist || 'Unknown').trim(),
        bpm: Math.round(bpmRaw * 10) / 10,
        bpmReview: !!r.needsReview,
        key: parsedKey.code,
        parsedKey,
        folder: this.folderFromPath({ relativePath: u.relativePath, name: u.name }),
      });
    }

    const { added } = this.deduplicateAndAdd(songs);
    this.untaggedFiles = stillUntagged;
    this._untaggedSeen = new Set(stillUntagged.map(u => u.path));
    this.tagging = false;
    this._tagPending = null;
    this.hideProgress();
    this.onLibraryChanged();



    let msg = `Tagged ${added} file${added === 1 ? '' : 's'}`;
    const notes = [];
    if (review) notes.push(`${review} may need review`);
    if (notWritten) notes.push(`${notWritten} not saved to disk (e.g. WAV/AIFF)`);
    if (failed) notes.push(`${failed} could not be detected`);
    if (notes.length) msg += ` · ${notes.join(' · ')}`;
    showToast(msg, added > 0 ? 'success' : 'warning', 4500);
  }

  // Per-file streaming progress; only advances the progress bar. The library is
  // reconciled once detectAndTagFiles resolves in _handleAnalyzeTag.
  _handleTagProgress(data) {
    if (!data || !this._tagPending || !this._tagPending.has(data.path)) return;
    this._tagDone = (this._tagDone || 0) + 1;
    this.showProgress(this._tagDone, this._tagTotal || 1, 'Detecting BPM & key...');
  }

  clearLibrary() {
    this.library = [];
    this.filtered = [];
    this.keyIndex = {};
    this.nextId = 0;
    this.dedupeSet.clear();
    this.untaggedFiles = [];
    this._untaggedSeen.clear();
    this.selectedSong = null;
    this.dom.searchInput.value = '';

    this.renderLibrary();
    this.updateStats();
    this.deselectSong();
  }

  applySort() {
    const col = this.sortCol;
    const dir = this.sortDir;
    const cmp = (a, b) => {
      let va = a[col], vb = b[col];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    };
    this.library.sort(cmp);
    if (this.filtered !== this.library) this.filtered.sort(cmp);
  }

  updateSortIndicators() {
    const ths = this.dom.tableHead.querySelectorAll('th[data-col]');
    for (const th of ths) {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.col === this.sortCol)
        th.classList.add(this.sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
    }
  }

  onSearch() {
    this.applySearch();
    this.renderLibrary();
  }

  applySearch() {
    const q = this.dom.searchInput.value.trim().toLowerCase();
    if (!q) { this.filtered = this.library; return; }
    this.filtered = this.library.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      s.key.toLowerCase().includes(q) ||
      s.bpm.toString().includes(q)
    );
  }

  renderLibrary() {
    const d = this.dom;
    const data = this.filtered.length > 0 || d.searchInput.value ? this.filtered : this.library;

    d.emptyState.style.display = this.library.length === 0 ? 'flex' : 'none';
    d.tableWrap.style.display = this.library.length === 0 ? 'none' : 'flex';

    d.libraryCount.textContent = data.length === this.library.length
      ? `${data.length} songs`
      : `${data.length} / ${this.library.length}`;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < data.length; i++) {
      const s = data[i];
      const tr = document.createElement('tr');
      tr.dataset.id = s._id;
      if (this.selectedSong && s._id === this.selectedSong._id) tr.classList.add('selected');

      const tooltip = s.folder ? `${s.folder}/` : '';
      tr.innerHTML =
        `<td class="m-col-num">${i + 1}</td>` +
        `<td class="m-col-title" title="${this.esc(tooltip + s.title)}">${this.esc(s.title)}</td>` +
        `<td class="m-col-artist" title="${this.esc(s.artist)}">${this.esc(s.artist)}</td>` +
        `<td class="m-col-bpm">${s.bpm}</td>` +
        `<td class="m-col-key">${s.key}</td>`;
      frag.appendChild(tr);
    }
    d.tableBody.innerHTML = '';
    d.tableBody.appendChild(frag);
  }

  esc(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  selectSong(song) {
    this.selectedSong = song;
    const rows = this.dom.tableBody.querySelectorAll('tr');
    for (const r of rows)
      r.classList.toggle('selected', parseInt(r.dataset.id, 10) === song._id);
    this.showMatches(song);
  }

  deselectSong() {
    this.selectedSong = null;
    if (!this.dom.tableBody) return;
    const rows = this.dom.tableBody.querySelectorAll('tr');
    for (const r of rows) r.classList.remove('selected');
    this.dom.matchEmpty.style.display = 'flex';
    this.dom.matchSelected.style.display = 'none';
    this.dom.matchResults.style.display = 'none';
  }

  showMatches(song) {
    const d = this.dom;
    d.matchEmpty.style.display = 'none';
    d.matchSelected.style.display = 'block';
    d.matchResults.style.display = 'block';

    d.matchTitle.textContent = song.title;
    const adj = TuneMatch.getAdjacentKeys(song.key);
    d.matchMeta.innerHTML =
      `<span>${this.esc(song.artist)}</span> &middot; ` +
      `<span>${song.bpm} BPM</span> &middot; ` +
      `Key <span>${song.key}</span>` +
      (adj.length ? ` &middot; Adjacent: <span>${adj.join(', ')}</span>` : '');

    const threshold = parseInt(d.bpmThreshold.value, 10);
    const matches = TuneMatch.findMatches(song, this.keyIndex, threshold);
    this.renderTier(d.tier1List, d.tier1Count, matches.tier1);
    this.renderTier(d.tier2List, d.tier2Count, matches.tier2);
  }

  renderTier(listEl, countEl, matches) {
    countEl.textContent = matches.length;
    listEl.innerHTML = '';

    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'tier-empty';
      empty.textContent = 'No matches';
      listEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of matches) {
      const li = document.createElement('li');
      li.dataset.id = m._id;
      li.innerHTML =
        `<span class="match-row-title" title="${this.esc(m.title)}">${this.esc(m.title)}</span>` +
        `<span class="match-row-artist" title="${this.esc(m.artist)}">${this.esc(m.artist)}</span>` +
        `<span class="match-row-bpm">${m.bpm}</span>` +
        `<span class="match-row-key">${m.key}</span>` +
        `<span class="match-row-diff">${m.bpmDiff > 0 ? '±' + m.bpmDiff : '='}</span>`;
      li.addEventListener('click', () => {
        const orig = this.library.find(s => s._id === m._id);
        if (orig) this.selectSong(orig);
        const row = this.dom.tableBody.querySelector(`tr[data-id="${m._id}"]`);
        if (row) row.scrollIntoView({ block: 'center' });
      });
      frag.appendChild(li);
    }
    listEl.appendChild(frag);
  }

  onThresholdChange() {
    this.dom.bpmThresholdVal.textContent = this.dom.bpmThreshold.value;
    if (this.selectedSong) this.showMatches(this.selectedSong);
  }

  updateStats() {
    const d = this.dom;
    d.statSongs.textContent = this.library.length;
    const keys = new Set();
    let minBpm = Infinity, maxBpm = -Infinity;
    for (const s of this.library) {
      keys.add(s.key);
      if (s.bpm < minBpm) minBpm = s.bpm;
      if (s.bpm > maxBpm) maxBpm = s.bpm;
    }
    d.statKeys.textContent = keys.size;
    d.statBpm.textContent = this.library.length > 0 ? `${minBpm}–${maxBpm}` : '—';
  }

  showProgress(current, total, label) {
    const d = this.dom;
    d.progressWrap.style.display = 'flex';
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    d.progressBar.style.width = pct + '%';
    d.progressText.textContent = label
      ? `${label} ${current} / ${total}`
      : `${current} / ${total}`;
  }

  hideProgress() {
    this.dom.progressWrap.style.display = 'none';
    this.dom.progressBar.style.width = '0%';
  }

  setImportingUI(active) {
    this.dom.importFolderBtn.disabled = active;
    this.dom.clearBtn.disabled = active;
  }
}
