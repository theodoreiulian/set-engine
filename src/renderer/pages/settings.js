import { showToast } from '../components/toast.js';

export class SettingsPage {
  constructor(app) {
    this.app = app;
    this.container = null;
  }

  destroy() {
    if (this.container) this.container.classList.remove('page-host');
  }

  render(container) {
    this.container = container;
    container.classList.add('page-host');

    // Page shell: dark-gray topbar with a green title over a scrolling body,
    // matching the Match Maker / Set Maker layout.
    const shell = document.createElement('div');
    shell.className = 'page-shell';
    shell.innerHTML = '<div class="page-topbar"><h1 class="page-title">Settings</h1></div>';
    const scroll = document.createElement('div');
    scroll.className = 'page-body';
    const body = document.createElement('div');
    body.className = 'page-content page-content-narrow';
    scroll.appendChild(body);
    shell.appendChild(scroll);
    container.appendChild(shell);

    // Settings form
    const form = document.createElement('div');
    form.id = 'settings-form';

    // The destination folder lives on the Download page now (set it right where
    // you paste the link), so it's intentionally not duplicated here.

    // --- Audio Quality ---
    form.appendChild(this.createFormGroup(
      'Audio Quality (kbps)',
      `<select class="input" id="settings-quality" style="max-width: 200px;">
        <option value="128">128</option>
        <option value="192">192</option>
        <option value="320" selected>320</option>
      </select>`
    ));

    // --- Filename Format ---
    form.appendChild(this.createFormGroup(
      'Filename Format',
      `<select class="input" id="settings-filename-template" style="max-width: 320px;">
        <option value="%(title)s" selected>Title</option>
        <option value="%(artist)s - %(title)s">Title and artist</option>
      </select>
      <div class="form-helper" style="margin-top: 6px;">How downloaded files are named. The artist is always written into the file's metadata tags — so choosing "Title" alone doesn't lose the artist, it just isn't part of the filename.</div>`
    ));

    // --- Set Extraction (song recognition) ---
    form.appendChild(this.createFormGroup(
      'Set Extraction — Song Recognition',
      `<select class="input" id="settings-recognizer" style="max-width: 260px;">
        <option value="audd" selected>AudD (enterprise)</option>
        <option value="acrcloud">ACRCloud</option>
      </select>
      <div class="form-helper" style="margin-top: 6px;">The engine the Set Extraction page uses to identify tracks in a DJ set. Both need an API key below — recognition can't run offline. No engine is perfect: unreleased IDs, bootlegs, mashups and heavily-effected sections may not resolve.</div>
      <div id="settings-audd-fields" style="margin-top: 12px;">
        <input type="password" class="input" id="settings-audd-token" placeholder="AudD API token" spellcheck="false" autocomplete="off" style="max-width: 360px;">
        <div class="form-helper" style="margin-top: 6px;">Get a token at <a href="#" class="ext-link" data-href="https://dashboard.audd.io/">dashboard.audd.io</a>. Billed 1 request per 12 s of audio (first 300 free) — a 1 h set is ≈300 requests.</div>
      </div>
      <div id="settings-acr-fields" style="margin-top: 12px;">
        <input type="text" class="input" id="settings-acr-host" placeholder="ACRCloud host (e.g. identify-eu-west-1.acrcloud.com)" spellcheck="false" autocomplete="off" style="max-width: 360px; margin-bottom: 8px;">
        <input type="text" class="input" id="settings-acr-key" placeholder="Access key" spellcheck="false" autocomplete="off" style="max-width: 360px; margin-bottom: 8px;">
        <input type="password" class="input" id="settings-acr-secret" placeholder="Access secret" spellcheck="false" autocomplete="off" style="max-width: 360px;">
        <div class="form-helper" style="margin-top: 6px;">Create an Audio &amp; Video Recognition project at <a href="#" class="ext-link" data-href="https://console.acrcloud.com/">console.acrcloud.com</a> and copy its host + access key/secret.</div>
      </div>
      <div id="settings-confidence-fields" style="margin-top: 16px;">
        <div class="form-helper" style="margin-bottom: 6px;">Minimum match confidence (0–100)</div>
        <input type="number" class="input" id="settings-recognizer-confidence" min="0" max="100" step="5" style="max-width: 120px;">
        <div class="form-helper" style="margin-top: 6px;">Recognized tracks scoring below this are discarded as likely false positives. Higher = fewer wrong tracks, but more genuine ones missed. ACRCloud reports a per-match score to threshold on.</div>
      </div>`
    ));

    // --- Tool versions (yt-dlp / spotdl / accelerator) ---
    form.appendChild(this.createFormGroup(
      'Tools',
      `<div id="settings-ytdlp-version" class="form-helper" style="margin-bottom: 4px;">Checking yt-dlp version…</div>
      <div id="settings-downloader" class="form-helper" style="margin-bottom: 8px;">Checking accelerator…</div>
      <div id="settings-spotdl-version" class="form-helper" style="margin-top: 12px;">Checking spotdl version…</div>`
    ));

    body.appendChild(form);

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
    body.appendChild(saveRow);

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
    // Show only the credential fields relevant to the chosen recognizer.
    const recognizerEl = document.getElementById('settings-recognizer');
    if (recognizerEl) {
      recognizerEl.addEventListener('change', () => this.syncRecognizerFields());
    }

    // External links (e.g. the AudD / ACRCloud dashboards) open in the
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

  async loadSettings() {
    if (!window.setengine || !window.setengine.getSettings) return;

    try {
      const settings = await window.setengine.getSettings();
      if (!settings) return;

      if (settings.audioQuality) {
        const qualityEl = document.getElementById('settings-quality');
        if (qualityEl) qualityEl.value = settings.audioQuality;
      }

      if (settings.filenameTemplate) {
        const templateEl = document.getElementById('settings-filename-template');
        if (templateEl) {
          templateEl.value = settings.filenameTemplate;
          // A previously-saved custom/free-text template won't match any option;
          // a <select> then reports value "". Fall back to the default preset.
          if (templateEl.value === '') templateEl.value = '%(title)s';
        }
      }

      const recognizerEl = document.getElementById('settings-recognizer');
      if (recognizerEl) recognizerEl.value = settings.recognizer || 'audd';
      const auddTokenEl = document.getElementById('settings-audd-token');
      if (auddTokenEl) auddTokenEl.value = settings.auddApiToken || '';
      const acrHostEl = document.getElementById('settings-acr-host');
      if (acrHostEl) acrHostEl.value = settings.acrHost || '';
      const acrKeyEl = document.getElementById('settings-acr-key');
      if (acrKeyEl) acrKeyEl.value = settings.acrAccessKey || '';
      const acrSecretEl = document.getElementById('settings-acr-secret');
      if (acrSecretEl) acrSecretEl.value = settings.acrAccessSecret || '';
      const confidenceEl = document.getElementById('settings-recognizer-confidence');
      if (confidenceEl) confidenceEl.value = settings.recognizerMinConfidence != null ? settings.recognizerMinConfidence : 60;
      this.syncRecognizerFields();
    } catch (err) {
      showToast('Failed to load settings', 'error');
    }
  }

  // Hide the credential block for whichever engine isn't selected. The minimum
  // match confidence only applies to ACRCloud (AudD's response carries no score),
  // so it's hidden unless ACRCloud is the selected engine.
  syncRecognizerFields() {
    const engine = document.getElementById('settings-recognizer')?.value || 'audd';
    const auddFields = document.getElementById('settings-audd-fields');
    const acrFields = document.getElementById('settings-acr-fields');
    const confidenceFields = document.getElementById('settings-confidence-fields');
    if (auddFields) auddFields.classList.toggle('hidden', engine !== 'audd');
    if (acrFields) acrFields.classList.toggle('hidden', engine !== 'acrcloud');
    if (confidenceFields) confidenceFields.classList.toggle('hidden', engine !== 'acrcloud');
  }

  async handleSave() {
    const audioQuality = parseInt(document.getElementById('settings-quality')?.value || '320', 10);
    const filenameTemplate = document.getElementById('settings-filename-template')?.value || '%(title)s';
    const recognizer = document.getElementById('settings-recognizer')?.value || 'audd';
    const auddApiToken = (document.getElementById('settings-audd-token')?.value || '').trim();
    const acrHost = (document.getElementById('settings-acr-host')?.value || '').trim();
    const acrAccessKey = (document.getElementById('settings-acr-key')?.value || '').trim();
    const acrAccessSecret = (document.getElementById('settings-acr-secret')?.value || '').trim();
    const confidenceRaw = parseInt(document.getElementById('settings-recognizer-confidence')?.value, 10);
    const recognizerMinConfidence = Math.min(100, Math.max(0, Number.isFinite(confidenceRaw) ? confidenceRaw : 60));

    const settings = {
      audioQuality,
      filenameTemplate,
      recognizer,
      auddApiToken,
      acrHost,
      acrAccessKey,
      acrAccessSecret,
      recognizerMinConfidence,
    };

    if (!window.setengine || !window.setengine.saveSettings) {
      showToast('IPC not available', 'error');
      return;
    }

    try {
      await window.setengine.saveSettings(settings);
      showToast('Settings saved', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to save settings', 'error');
    }
  }
}
