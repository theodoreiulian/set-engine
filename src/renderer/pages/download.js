import { showToast } from '../components/toast.js';
import { showModal } from '../components/modal.js';

// Simple URL-paste download page. The user pastes a YouTube / YouTube Music or
// Spotify link (song, playlist, or album) and the download starts. The
// destination folder lives right here so there's no need to dig into Settings.
// Source (YouTube vs Spotify) and shape (song vs playlist/album) are
// auto-detected from the URL via the main-process classifier — the same one the
// download manager uses — so a single box handles everything.
export class DownloadPage {
  constructor(app) {
    this.app = app;
    this.container = null;
    this.urlInput = null;
    this.folderPathEl = null;
    this.downloadBtn = null;
  }

  destroy() {
    if (this.container) this.container.classList.remove('page-host');
  }

  async render(container) {
    this.container = container;
    container.classList.add('page-host');

    // Page shell: dark-gray topbar with a green title over a scrolling body,
    // matching the Match Maker / Set Maker layout.
    const shell = document.createElement('div');
    shell.className = 'page-shell';
    shell.innerHTML = '<div class="page-topbar"><h1 class="page-title">Download</h1></div>';
    const scroll = document.createElement('div');
    scroll.className = 'page-body';
    const body = document.createElement('div');
    body.className = 'page-content page-content-narrow';
    scroll.appendChild(body);
    shell.appendChild(scroll);
    container.appendChild(shell);

    // --- URL input ---
    const urlGroup = document.createElement('div');
    urlGroup.className = 'form-group';
    urlGroup.innerHTML = `
      <label class="form-label" for="download-url-input">Paste a link</label>
      <div class="url-download-row">
        <input type="text" class="input-lg" id="download-url-input"
               placeholder="YouTube or Spotify link — song, playlist, or album"
               spellcheck="false" autocomplete="off">
        <button class="btn" id="download-start-btn">DOWNLOAD</button>
      </div>
      <div class="form-helper">Works with YouTube / YouTube Music and Spotify. Press Enter or click DOWNLOAD — it figures out song vs. playlist/album automatically.</div>
    `;
    body.appendChild(urlGroup);

    // --- Destination folder ---
    const folderGroup = document.createElement('div');
    folderGroup.className = 'form-group';
    folderGroup.innerHTML = `
      <label class="form-label">Destination folder</label>
      <div class="folder-display">
        <span class="folder-path" id="download-folder-path">~/Music</span>
        <button class="btn-secondary btn-sm" id="download-browse-btn">BROWSE</button>
      </div>
      <div class="form-helper">Where downloads are saved. Changing it here is remembered for next time.</div>
    `;
    body.appendChild(folderGroup);

    // --- Jump to queue ---
    const queueRow = document.createElement('div');
    queueRow.className = 'mt-16';
    const queueBtn = document.createElement('button');
    queueBtn.className = 'btn-secondary btn-sm';
    queueBtn.id = 'download-view-queue-btn';
    queueBtn.textContent = 'VIEW DOWNLOAD QUEUE';
    queueBtn.addEventListener('click', () => this.app.navigateTo('queue'));
    queueRow.appendChild(queueBtn);
    body.appendChild(queueRow);

    // Refs + listeners
    this.urlInput = container.querySelector('#download-url-input');
    this.folderPathEl = container.querySelector('#download-folder-path');
    this.downloadBtn = container.querySelector('#download-start-btn');

    this.downloadBtn.addEventListener('click', () => this.handleDownload());
    this.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleDownload();
      }
    });
    container.querySelector('#download-browse-btn').addEventListener('click', () => this.handleBrowse());

    await this.loadFolder();
    this.urlInput.focus();
  }

  async loadFolder() {
    if (!window.setengine || !window.setengine.getSettings) return;
    try {
      const settings = await window.setengine.getSettings();
      if (settings && settings.downloadFolder && this.folderPathEl) {
        this.folderPathEl.textContent = settings.downloadFolder;
      }
    } catch (_) { /* keep placeholder */ }
  }

  async handleBrowse() {
    if (!window.setengine || !window.setengine.selectFolder) {
      showToast('IPC not available', 'error');
      return;
    }
    try {
      const folder = await window.setengine.selectFolder();
      if (!folder) return;
      if (this.folderPathEl) this.folderPathEl.textContent = folder;
      if (window.setengine.saveSettings) {
        await window.setengine.saveSettings({ downloadFolder: folder });
        showToast('Destination folder updated', 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to select folder', 'error');
    }
  }

  async handleDownload() {
    const url = (this.urlInput.value || '').trim();
    if (!url) {
      showToast('Paste a link first', 'warning');
      this.urlInput.focus();
      return;
    }
    if (!window.setengine || !window.setengine.downloadURL) {
      showToast('IPC not available', 'error');
      return;
    }

    // Classify first so we can (a) reject junk before queueing and (b) give the
    // user a meaningful "added X" message + a just-in-time spotdl check.
    let cls = null;
    if (window.setengine.classifyURL) {
      try { cls = await window.setengine.classifyURL(url); } catch (_) { /* fall through */ }
    }
    if (!cls || !cls.source) {
      showToast('Not a recognized link — paste a YouTube or Spotify URL', 'error');
      return;
    }

    // Spotify routes through spotdl; surface a clear message if it's missing
    // rather than letting the queue item fail with a cryptic spawn error.
    if (cls.source === 'spotify') {
      const ready = await this.ensureSpotdl();
      if (!ready) return;
    }

    this.downloadBtn.disabled = true;
    try {
      const result = await window.setengine.downloadURL(url);
      if (result && result.success === false) {
        showToast(result.error || 'Failed to start download', 'error');
        return;
      }
      const label = cls.kind === 'playlist'
        ? (cls.source === 'spotify' ? 'album / playlist' : 'playlist')
        : 'song';
      showToast(`Added ${label} to queue`, 'success');
      this.urlInput.value = '';
      this.urlInput.focus();
    } catch (err) {
      showToast(err.message || 'Failed to start download', 'error');
    } finally {
      this.downloadBtn.disabled = false;
    }
  }

  // Returns true if spotdl is available (or we couldn't check, so let the
  // download attempt proceed). Returns false after showing an install prompt.
  async ensureSpotdl() {
    if (!window.setengine.getSpotdlHealth) return true;
    let health = null;
    try { health = await window.setengine.getSpotdlHealth(); } catch (_) { return true; }
    if (health && health.version) return true;

    await showModal(
      'spotdl Required for Spotify',
      `<p>Downloading from Spotify needs <code>spotdl</code>, which SetEngine couldn't find on your PATH.</p>
      <p>Install it, then try the link again:</p>
      <ul>
        <li>Homebrew: <code>brew install spotdl</code></li>
        <li>pipx: <code>pipx install spotdl</code></li>
        <li>pip: <code>pip install -U spotdl</code></li>
      </ul>
      <p style="color: var(--text-secondary); font-size: 12px; margin-top: 12px;">YouTube links download without spotdl.</p>`,
      ['OK']
    );
    return false;
  }
}
