import { showToast } from '../components/toast.js';
import { escapeHtml } from '../utils/escape-html.js';

export class DownloadPage {
  constructor(app) {
    this.app = app;
    this.container = null;
    this.detectedResult = null;
  }

  render(container) {
    this.container = container;

    // Page header
    const header = document.createElement('div');
    header.className = 'page-header';
    header.innerHTML = '<h1 class="page-title">Download</h1>';
    container.appendChild(header);

    // URL input
    const inputSection = document.createElement('div');
    inputSection.className = 'section';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.id = 'download-url-input';
    urlInput.className = 'input-lg';
    urlInput.placeholder = 'PASTE YOUTUBE URL...';
    urlInput.spellcheck = false;
    inputSection.appendChild(urlInput);

    // Detect button
    const detectRow = document.createElement('div');
    detectRow.className = 'mt-12';

    const detectBtn = document.createElement('button');
    detectBtn.className = 'btn';
    detectBtn.id = 'download-detect-btn';
    detectBtn.textContent = 'DETECT';
    detectBtn.addEventListener('click', () => this.handleDetect());
    detectRow.appendChild(detectBtn);
    inputSection.appendChild(detectRow);

    container.appendChild(inputSection);

    // Result area
    this.resultArea = document.createElement('div');
    this.resultArea.id = 'download-result-area';
    container.appendChild(this.resultArea);

    // Output folder section
    const folderSection = document.createElement('div');
    folderSection.className = 'section mt-24';
    folderSection.innerHTML = `
      <div class="form-label">Output Folder</div>
    `;

    const folderRow = document.createElement('div');
    folderRow.className = 'folder-display';
    folderRow.id = 'download-folder-display';

    const folderPath = document.createElement('span');
    folderPath.className = 'folder-path';
    folderPath.id = 'download-folder-path';
    folderPath.textContent = '~/Music/SetEngine';
    folderRow.appendChild(folderPath);

    const changeBtn = document.createElement('button');
    changeBtn.className = 'btn-secondary btn-sm';
    changeBtn.id = 'download-change-folder-btn';
    changeBtn.textContent = 'CHANGE';
    changeBtn.addEventListener('click', () => this.handleChangeFolder());
    folderRow.appendChild(changeBtn);

    folderSection.appendChild(folderRow);
    container.appendChild(folderSection);

    // Load current folder from settings
    this.loadFolder();
  }

  async loadFolder() {
    if (!window.setengine) return;
    try {
      const settings = await window.setengine.getSettings();
      if (settings && settings.downloadFolder) {
        const pathEl = document.getElementById('download-folder-path');
        if (pathEl) pathEl.textContent = settings.downloadFolder;
      }
    } catch (_) { /* ignore */ }
  }

  async handleDetect() {
    const urlInput = document.getElementById('download-url-input');
    const url = urlInput ? urlInput.value.trim() : '';

    if (!url) {
      showToast('Please enter a URL', 'warning');
      return;
    }

    if (!window.setengine || !window.setengine.detectURL) {
      showToast('IPC not available', 'error');
      return;
    }

    const detectBtn = document.getElementById('download-detect-btn');
    if (detectBtn) {
      detectBtn.disabled = true;
      detectBtn.textContent = 'DETECTING...';
    }

    try {
      const result = await window.setengine.detectURL(url);
      if (!result || !result.success) {
        showToast((result && result.error) || 'Failed to detect URL', 'error');
        this.resultArea.innerHTML = '';
        this.detectedResult = null;
        return;
      }
      this.detectedResult = result;
      this.renderResult(result);
    } catch (err) {
      showToast(err.message || 'Failed to detect URL', 'error');
      this.resultArea.innerHTML = '';
      this.detectedResult = null;
    } finally {
      if (detectBtn) {
        detectBtn.disabled = false;
        detectBtn.textContent = 'DETECT';
      }
    }
  }

  renderResult(result) {
    this.resultArea.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'card mt-16';
    card.id = 'download-result-card';

    const typeLabel = result.type === 'playlist' ? 'PLAYLIST' : 'SONG';
    const typeBadgeClass = result.type === 'playlist' ? 'badge-warning' : 'badge-accent';

    let meta = '';
    if (result.type === 'playlist' && result.trackCount) {
      meta = `<span class="text-secondary" style="margin-left: 12px;">${result.trackCount} tracks</span>`;
    }

    card.innerHTML = `
      <div class="card-header">
        <span class="badge ${typeBadgeClass}">${typeLabel}</span>
      </div>
      <div class="card-title" style="font-size: 15px; margin-bottom: 8px;">${escapeHtml(result.title || 'Unknown Title')}</div>
      ${meta}
    `;

    this.resultArea.appendChild(card);

    // Download button
    const downloadRow = document.createElement('div');
    downloadRow.className = 'mt-16';

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn';
    downloadBtn.id = 'download-start-btn';
    downloadBtn.style.padding = '14px 32px';
    downloadBtn.style.fontSize = '14px';
    downloadBtn.textContent = 'DOWNLOAD';
    downloadBtn.addEventListener('click', () => this.handleDownload());
    downloadRow.appendChild(downloadBtn);

    this.resultArea.appendChild(downloadRow);
  }

  async handleDownload() {
    const urlInput = document.getElementById('download-url-input');
    const url = urlInput ? urlInput.value.trim() : '';

    if (!url) {
      showToast('No URL provided', 'warning');
      return;
    }

    if (!window.setengine || !window.setengine.downloadURL) {
      showToast('IPC not available', 'error');
      return;
    }

    try {
      const result = await window.setengine.downloadURL(url);
      if (result && !result.success) {
        showToast(result.error || 'Failed to start download', 'error');
        return;
      }
      showToast('Added to queue', 'success');
      this.app.navigateTo('queue');
    } catch (err) {
      showToast(err.message || 'Failed to start download', 'error');
    }
  }

  async handleChangeFolder() {
    if (!window.setengine || !window.setengine.selectFolder) {
      showToast('IPC not available', 'error');
      return;
    }

    try {
      const folder = await window.setengine.selectFolder();
      if (!folder) return;

      const pathEl = document.getElementById('download-folder-path');
      if (pathEl) pathEl.textContent = folder;

      if (window.setengine.saveSettings) {
        await window.setengine.saveSettings({ downloadFolder: folder });
        showToast('Folder updated', 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to select folder', 'error');
    }
  }
}
