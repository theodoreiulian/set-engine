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
      `<div class="checkbox-wrapper" style="margin-bottom: 14px;">
        <input type="checkbox" id="settings-use-published">
        <label for="settings-use-published" style="cursor:pointer;">Use the uploader's tracklist when there is one</label>
      </div>
      <div class="form-helper" style="margin-bottom: 16px;">Many DJ sets already list their tracks — as YouTube chapters, as timestamps in the description, or in a pinned comment. When they do, that list is exact and free, and SetEngine skips downloading and scanning the set entirely. Anything else is identified from the audio.</div>
      <div class="form-helper" style="margin-bottom: 16px;">Identification needs no account and no API key, and costs nothing. Your machine computes the fingerprint and sends only that — your audio is never uploaded.</div>
      <div style="margin-top: 16px;">
        <div class="form-helper" style="margin-bottom: 6px;">How much evidence to require (0–100)</div>
        <input type="number" class="input" id="settings-recognizer-confidence" min="0" max="100" step="5" style="max-width: 120px;">
        <div class="form-helper" style="margin-top: 6px;">SetEngine confirms a track by checking that the audio keeps lining up with the same record as the set plays on. At the default, tracks it couldn't confirm that way are still listed but marked <em>uncertain</em>, and left out of DOWNLOAD WHOLE SET — play them and download the ones you agree with. Above 80 only confirmed tracks are listed at all: the cleanest tracklist, but a briefly-played track can be dropped. Below 40 it additionally lists tracks heard only once, which is noticeably noisier.</div>
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
    // Nothing conditional left on this page: there is one recognition engine and
    // it has no credentials, so every control is always visible.
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

      const publishedEl = document.getElementById('settings-use-published');
      if (publishedEl) publishedEl.checked = settings.usePublishedTracklist !== false;
      const confidenceEl = document.getElementById('settings-recognizer-confidence');
      if (confidenceEl) confidenceEl.value = settings.recognizerMinConfidence != null ? settings.recognizerMinConfidence : 60;
    } catch (err) {
      showToast('Failed to load settings', 'error');
    }
  }

  async handleSave() {
    const audioQuality = parseInt(document.getElementById('settings-quality')?.value || '320', 10);
    const filenameTemplate = document.getElementById('settings-filename-template')?.value || '%(title)s';
    const usePublishedTracklist = !!document.getElementById('settings-use-published')?.checked;
    const confidenceRaw = parseInt(document.getElementById('settings-recognizer-confidence')?.value, 10);
    const recognizerMinConfidence = Math.min(100, Math.max(0, Number.isFinite(confidenceRaw) ? confidenceRaw : 60));

    const settings = {
      audioQuality,
      filenameTemplate,
      usePublishedTracklist,
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
