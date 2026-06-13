import { showToast } from '../components/toast.js';
import { runYtdlpUpdateFlow, runSpotdlUpdateFlow } from '../tool-update.js';

export class SettingsPage {
  constructor(app) {
    this.app = app;
    this.container = null;
  }

  render(container) {
    this.container = container;

    // Page header
    const header = document.createElement('div');
    header.className = 'page-header';
    header.innerHTML = '<h1 class="page-title">Settings</h1>';
    container.appendChild(header);

    // Settings form
    const form = document.createElement('div');
    form.id = 'settings-form';

    // --- Preferred Source ---
    form.appendChild(this.createFormGroup(
      'Preferred Source',
      `<div class="segmented" id="settings-preferred-source" style="display: inline-flex; gap: 4px;">
        <button type="button" class="btn-secondary btn-sm" data-source="youtube-music" id="settings-source-yt">YOUTUBE MUSIC</button>
        <button type="button" class="btn-secondary btn-sm" data-source="spotify" id="settings-source-spotify">SPOTIFY</button>
      </div>
      <div class="form-helper" style="margin-top: 6px;">Which music site the Browser tab opens by default.</div>`
    ));

    // --- Download Folder ---
    form.appendChild(this.createFormGroup(
      'Download Folder',
      `<div class="folder-display" id="settings-folder-display">
        <span class="folder-path" id="settings-folder-path">~/Music/SetEngine</span>
        <button class="btn-secondary btn-sm" id="settings-browse-btn">BROWSE</button>
      </div>`
    ));

    // --- Audio Quality ---
    form.appendChild(this.createFormGroup(
      'Audio Quality (kbps)',
      `<select class="input" id="settings-quality" style="max-width: 200px;">
        <option value="128">128</option>
        <option value="192">192</option>
        <option value="320" selected>320</option>
      </select>`
    ));

    // --- Filename Template ---
    form.appendChild(this.createFormGroup(
      'Filename Template',
      `<input type="text" class="input" id="settings-filename-template" value="%(title)s" spellcheck="false">
      <div class="form-helper">Available: %(title)s, %(artist)s, %(album)s, %(track_number)s, %(upload_date)s</div>`
    ));

    // --- BPM Detection ---
    form.appendChild(this.createFormGroup(
      'BPM Detection',
      `<label class="checkbox-wrapper">
        <input type="checkbox" id="settings-bpm-online" checked>
        <span>Cross-check detected BPM against online databases</span>
      </label>
      <div class="form-helper" style="margin-top: 6px;">The local analyzer always runs. When on, it's verified against free databases (Deezer, and GetSongBPM if a key is set) and any tempo that can't be confirmed is flagged for review. Turn off to tag fully offline.</div>
      <input type="text" class="input" id="settings-getsongbpm-key" placeholder="GetSongBPM API key (optional)" spellcheck="false" autocomplete="off" style="margin-top: 10px; max-width: 360px;">
      <div class="form-helper" style="margin-top: 6px;">Optional: a free key from <a href="#" class="ext-link" data-href="https://getsongbpm.com/api">getsongbpm.com/api</a> adds a second source. Using it requires their attribution: <a href="#" class="ext-link" data-href="https://getsongbpm.com">Powered by GetSongBPM</a>.</div>`
    ));

    // --- Auto-update yt-dlp ---
    form.appendChild(this.createFormGroup(
      '',
      `<label class="checkbox-wrapper">
        <input type="checkbox" id="settings-auto-update" checked>
        <span>Auto-update yt-dlp on startup</span>
      </label>`
    ));

    // --- yt-dlp version + Manual Update ---
    form.appendChild(this.createFormGroup(
      'Tools',
      `<div id="settings-ytdlp-version" class="form-helper" style="margin-bottom: 4px;">Checking yt-dlp version…</div>
      <div id="settings-downloader" class="form-helper" style="margin-bottom: 8px;">Checking accelerator…</div>
      <button class="btn-secondary" id="settings-update-ytdlp-btn" style="margin-right: 8px;">UPDATE YT-DLP</button>
      <div id="settings-spotdl-version" class="form-helper" style="margin-top: 12px; margin-bottom: 8px;">Checking spotdl version…</div>
      <button class="btn-secondary" id="settings-update-spotdl-btn">UPDATE SPOTDL</button>`
    ));

    container.appendChild(form);

    // --- Save Button ---
    const saveRow = document.createElement('div');
    saveRow.className = 'mt-24';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.id = 'settings-save-btn';
    saveBtn.textContent = 'SAVE';
    saveBtn.style.padding = '12px 32px';
    saveBtn.addEventListener('click', () => this.handleSave());
    saveRow.appendChild(saveBtn);
    container.appendChild(saveRow);

    // Attach event listeners
    this.attachListeners();

    // Load current settings
    this.loadSettings();
    this.loadYtDlpHealth();
    this.loadSpotdlHealth();
  }

  async loadSpotdlHealth() {
    const versionEl = document.getElementById('settings-spotdl-version');
    if (!versionEl || !window.setengine || !window.setengine.getSpotdlHealth) return;

    try {
      const health = await window.setengine.getSpotdlHealth();
      if (!health || !health.version) {
        versionEl.textContent = 'spotdl not detected on PATH (required only for Spotify downloads).';
        versionEl.style.color = '';
      } else if (health.outdated === true) {
        versionEl.textContent = `spotdl ${health.version} — outdated (minimum ${health.recommendedMin}).`;
        versionEl.style.color = 'var(--danger, #ff5c5c)';
      } else {
        versionEl.textContent = `spotdl ${health.version}`;
        versionEl.style.color = '';
      }
    } catch (_) {
      versionEl.textContent = 'Could not check spotdl version.';
    }
  }

  async loadYtDlpHealth() {
    const versionEl = document.getElementById('settings-ytdlp-version');
    const downloaderEl = document.getElementById('settings-downloader');
    if (!window.setengine || !window.setengine.getYtdlpHealth) return;

    try {
      const health = await window.setengine.getYtdlpHealth();

      if (versionEl) {
        if (!health || !health.version) {
          versionEl.textContent = 'yt-dlp not detected on PATH.';
          versionEl.style.color = 'var(--danger, #ff5c5c)';
        } else if (health.outdated === true) {
          versionEl.textContent = `yt-dlp ${health.version} — outdated (minimum ${health.recommendedMin}). Update to fix download failures.`;
          versionEl.style.color = 'var(--danger, #ff5c5c)';
        } else {
          versionEl.textContent = `yt-dlp ${health.version}`;
          versionEl.style.color = '';
        }
      }

      if (downloaderEl) {
        if (health && health.aria2c) {
          downloaderEl.textContent = 'Accelerator: aria2c (multi-connection downloader, active)';
          downloaderEl.style.color = '';
        } else {
          downloaderEl.innerHTML = 'Accelerator: built-in. Install aria2 for ~2× faster downloads — <code>brew install aria2</code>';
          downloaderEl.style.color = '';
        }
      }
    } catch (_) {
      if (versionEl) versionEl.textContent = 'Could not check yt-dlp version.';
    }
  }

  createFormGroup(label, contentHtml) {
    const group = document.createElement('div');
    group.className = 'form-group';

    if (label) {
      const labelEl = document.createElement('label');
      labelEl.className = 'form-label';
      labelEl.textContent = label;
      group.appendChild(labelEl);
    }

    const content = document.createElement('div');
    content.innerHTML = contentHtml;
    // Unwrap single child
    while (content.children.length > 0) {
      group.appendChild(content.children[0]);
    }

    return group;
  }

  attachListeners() {
    const browseBtn = document.getElementById('settings-browse-btn');
    if (browseBtn) {
      browseBtn.addEventListener('click', () => this.handleBrowse());
    }

    const updateBtn = document.getElementById('settings-update-ytdlp-btn');
    if (updateBtn) {
      updateBtn.addEventListener('click', () => this.handleUpdateYtDlp());
    }

    const updateSpotdlBtn = document.getElementById('settings-update-spotdl-btn');
    if (updateSpotdlBtn) {
      updateSpotdlBtn.addEventListener('click', () => this.handleUpdateSpotdl());
    }

    const sourceGroup = document.getElementById('settings-preferred-source');
    if (sourceGroup) {
      sourceGroup.querySelectorAll('button[data-source]').forEach((btn) => {
        btn.addEventListener('click', () => this.handlePreferredSource(btn.dataset.source));
      });
    }

    // External links (e.g. the required GetSongBPM attribution) open in the
    // system browser rather than navigating the app's own window.
    this.container.querySelectorAll('a.ext-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const url = a.dataset.href;
        if (url && window.setengine && window.setengine.openExternal) {
          window.setengine.openExternal(url);
        }
      });
    });
  }

  _paintPreferredSource(sourceId) {
    const group = document.getElementById('settings-preferred-source');
    if (!group) return;
    group.querySelectorAll('button[data-source]').forEach((btn) => {
      btn.style.opacity = btn.dataset.source === sourceId ? '1' : '0.5';
    });
  }

  async handlePreferredSource(sourceId) {
    if (!sourceId) return;
    this._paintPreferredSource(sourceId);
    if (window.setengine && window.setengine.saveSettings) {
      try {
        await window.setengine.saveSettings({ preferredSource: sourceId });
        showToast(`Preferred source: ${sourceId === 'spotify' ? 'Spotify' : 'YouTube Music'}`, 'success');
      } catch (err) {
        showToast(err.message || 'Failed to save preference', 'error');
      }
    }
  }

  async loadSettings() {
    if (!window.setengine || !window.setengine.getSettings) return;

    try {
      const settings = await window.setengine.getSettings();
      if (!settings) return;

      if (settings.downloadFolder) {
        const pathEl = document.getElementById('settings-folder-path');
        if (pathEl) pathEl.textContent = settings.downloadFolder;
      }

      if (settings.audioQuality) {
        const qualityEl = document.getElementById('settings-quality');
        if (qualityEl) qualityEl.value = settings.audioQuality;
      }

      if (settings.filenameTemplate) {
        const templateEl = document.getElementById('settings-filename-template');
        if (templateEl) templateEl.value = settings.filenameTemplate;
      }

      if (settings.autoUpdateYtdlp !== undefined) {
        const autoUpdateEl = document.getElementById('settings-auto-update');
        if (autoUpdateEl) autoUpdateEl.checked = settings.autoUpdateYtdlp;
      }

      if (settings.bpmLookupOnline !== undefined) {
        const bpmOnlineEl = document.getElementById('settings-bpm-online');
        if (bpmOnlineEl) bpmOnlineEl.checked = settings.bpmLookupOnline;
      }

      const keyEl = document.getElementById('settings-getsongbpm-key');
      if (keyEl) keyEl.value = settings.getSongBpmApiKey || '';

      this._paintPreferredSource(settings.preferredSource || 'youtube-music');
    } catch (err) {
      showToast('Failed to load settings', 'error');
    }
  }

  async handleUpdateSpotdl() {
    const btn = document.getElementById('settings-update-spotdl-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'UPDATING...';
    }
    try {
      await runSpotdlUpdateFlow();
      this.loadSpotdlHealth();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'UPDATE SPOTDL';
      }
    }
  }

  async handleSave() {
    const audioQuality = parseInt(document.getElementById('settings-quality')?.value || '320', 10);
    const filenameTemplate = document.getElementById('settings-filename-template')?.value || '%(title)s';
    const autoUpdateYtdlp = document.getElementById('settings-auto-update')?.checked ?? true;
    const downloadFolder = document.getElementById('settings-folder-path')?.textContent || '';
    const bpmLookupOnline = document.getElementById('settings-bpm-online')?.checked ?? true;
    const getSongBpmApiKey = (document.getElementById('settings-getsongbpm-key')?.value || '').trim();

    const settings = {
      audioQuality,
      filenameTemplate,
      autoUpdateYtdlp,
      downloadFolder,
      bpmLookupOnline,
      getSongBpmApiKey,
    };

    if (!window.setengine || !window.setengine.saveSettings) {
      showToast('IPC not available', 'error');
      return;
    }

    try {
      await window.setengine.saveSettings(settings);
      showToast('Settings saved', 'success');

      // Refresh status bar to reflect new quality
      if (this.app && typeof this.app.setupStatusBar === 'function') {
        this.app.setupStatusBar();
      }
    } catch (err) {
      showToast(err.message || 'Failed to save settings', 'error');
    }
  }

  async handleBrowse() {
    if (!window.setengine || !window.setengine.selectFolder) {
      showToast('IPC not available', 'error');
      return;
    }

    try {
      const folder = await window.setengine.selectFolder();
      if (!folder) return;

      const pathEl = document.getElementById('settings-folder-path');
      if (pathEl) pathEl.textContent = folder;

      if (window.setengine.saveSettings) {
        await window.setengine.saveSettings({ downloadFolder: folder });
        showToast('Download folder updated', 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to select folder', 'error');
    }
  }

  async handleUpdateYtDlp() {
    const btn = document.getElementById('settings-update-ytdlp-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'UPDATING...';
    }
    try {
      await runYtdlpUpdateFlow();
      this.loadYtDlpHealth();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'UPDATE YT-DLP';
      }
    }
  }
}
