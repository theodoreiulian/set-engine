import { showToast } from '../components/toast.js';
import { showSearchPicker } from '../components/search-picker.js';

const SOURCE_META = {
  'youtube-music': {
    id: 'youtube-music',
    label: 'YouTube Music',
    domain: 'music.youtube.com',
    pageTitle: 'YouTube Music',
  },
  spotify: {
    id: 'spotify',
    label: 'Spotify',
    domain: 'open.spotify.com',
    pageTitle: 'Spotify',
  },
};

/**
 * Pull the `q` parameter out of a YouTube Music or Spotify search URL.
 * Returns the trimmed query string, or null if the URL isn't a search page.
 */
function extractSearchQuery(url) {
  try {
    const u = new URL(url);
    if (!/\/search\b/.test(u.pathname)) return null;
    const q = u.searchParams.get('q');
    return q ? q.trim() : null;
  } catch {
    return null;
  }
}

export class BrowserPage {
  constructor(app) {
    this.app = app;
    this.container = null;
    this.titleEl = null;
    this.urlDisplay = null;
    this.placeholder = null;
    this.fallbackEl = null;
    this.toggleButtons = new Map();
    this.activeSource = 'youtube-music';
    this._unsubNavigate = null;
    this._unsubLoadFailed = null;
    this.resizeObserver = null;
    this._spotifyFallbackActive = false;
    this._lastSpotifyResults = [];
  }

  async render(container) {
    this.container = container;

    // Resolve initial source from settings (defaults to YouTube Music).
    try {
      const settings = window.setengine && window.setengine.getSettings
        ? await window.setengine.getSettings()
        : null;
      if (settings && settings.preferredSource && SOURCE_META[settings.preferredSource]) {
        this.activeSource = settings.preferredSource;
      }
    } catch (_) { /* keep default */ }

    // Page header
    const header = document.createElement('div');
    header.className = 'page-header flex justify-between items-center';

    this.titleEl = document.createElement('h1');
    this.titleEl.className = 'page-title';
    this.titleEl.textContent = SOURCE_META[this.activeSource].pageTitle;
    header.appendChild(this.titleEl);

    // Source toggle pills
    const toggle = document.createElement('div');
    toggle.className = 'browser-source-toggle';
    toggle.style.display = 'flex';
    toggle.style.gap = '4px';
    Object.values(SOURCE_META).forEach((meta) => {
      const btn = document.createElement('button');
      btn.className = 'btn-secondary btn-sm';
      btn.id = `browser-source-${meta.id}`;
      btn.dataset.sourceId = meta.id;
      btn.textContent = meta.label.toUpperCase();
      btn.style.opacity = meta.id === this.activeSource ? '1' : '0.5';
      btn.addEventListener('click', () => this.switchSource(meta.id));
      this.toggleButtons.set(meta.id, btn);
      toggle.appendChild(btn);
    });
    header.appendChild(toggle);
    container.appendChild(header);

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'browser-toolbar';
    toolbar.id = 'browser-toolbar';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn-secondary btn-sm';
    backBtn.id = 'browser-back-btn';
    backBtn.textContent = '←';
    backBtn.title = 'Back';
    backBtn.addEventListener('click', () => window.setengine && window.setengine.browserBack && window.setengine.browserBack());
    toolbar.appendChild(backBtn);

    const fwdBtn = document.createElement('button');
    fwdBtn.className = 'btn-secondary btn-sm';
    fwdBtn.id = 'browser-forward-btn';
    fwdBtn.textContent = '→';
    fwdBtn.title = 'Forward';
    fwdBtn.addEventListener('click', () => window.setengine && window.setengine.browserForward && window.setengine.browserForward());
    toolbar.appendChild(fwdBtn);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn-secondary btn-sm';
    refreshBtn.id = 'browser-refresh-btn';
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'Refresh';
    refreshBtn.addEventListener('click', () => window.setengine && window.setengine.browserRefresh && window.setengine.browserRefresh());
    toolbar.appendChild(refreshBtn);

    this.urlDisplay = document.createElement('div');
    this.urlDisplay.className = 'browser-url';
    this.urlDisplay.id = 'browser-url-display';
    this.urlDisplay.textContent = SOURCE_META[this.activeSource].domain;
    toolbar.appendChild(this.urlDisplay);

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn btn-sm';
    downloadBtn.id = 'browser-download-btn';
    downloadBtn.textContent = 'DOWNLOAD';
    downloadBtn.style.marginRight = '8px';
    downloadBtn.addEventListener('click', () => this.handleDownload());
    toolbar.appendChild(downloadBtn);

    container.appendChild(toolbar);

    // Placeholder area (browser view is overlaid by Electron)
    this.placeholder = document.createElement('div');
    this.placeholder.className = 'browser-placeholder';
    this.placeholder.id = 'browser-view-placeholder';
    this.placeholder.textContent = 'BROWSER VIEW';
    container.appendChild(this.placeholder);

    await this.openBrowser();
    this.setupListeners();
  }

  async switchSource(sourceId) {
    if (!SOURCE_META[sourceId]) return;
    if (sourceId === this.activeSource) return;

    this.activeSource = sourceId;

    // Persist preference (best effort; do not block UI)
    if (window.setengine && window.setengine.saveSettings) {
      window.setengine.saveSettings({ preferredSource: sourceId }).catch(() => {});
    }

    // Update visual state
    this.toggleButtons.forEach((btn, id) => {
      btn.style.opacity = id === sourceId ? '1' : '0.5';
    });
    if (this.titleEl) this.titleEl.textContent = SOURCE_META[sourceId].pageTitle;
    if (this.urlDisplay) this.urlDisplay.textContent = SOURCE_META[sourceId].domain;

    // Tear down any active fallback for the previous source
    this._removeSpotifyFallback();

    // Tell main to attach the matching view at the current placeholder bounds.
    if (window.setengine && window.setengine.setBrowserSource) {
      try {
        await window.setengine.setBrowserSource(sourceId, this._getPlaceholderBounds());
      } catch (_) { /* ignore */ }
    }

    // Resync URL bar from whatever the now-active view is showing.
    await this._syncUrlBar();
  }

  async openBrowser() {
    if (!window.setengine || !window.setengine.openBrowser) return;
    try {
      if (!this.placeholder) return;

      const bounds = this._getPlaceholderBounds();
      await window.setengine.openBrowser(bounds, this.activeSource);

      if (window.setengine.resizeBrowser) {
        this.resizeObserver = new ResizeObserver(() => {
          window.setengine.resizeBrowser(this._getPlaceholderBounds());
        });
        this.resizeObserver.observe(this.placeholder);
      }

      await this._syncUrlBar();
    } catch (err) {
      showToast('Failed to open browser view', 'error');
    }
  }

  _getPlaceholderBounds() {
    if (!this.placeholder) return null;
    const rect = this.placeholder.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  async _syncUrlBar() {
    if (!window.setengine || !window.setengine.getBrowserUrl || !this.urlDisplay) return;
    try {
      const url = await window.setengine.getBrowserUrl();
      if (url) this.urlDisplay.textContent = url;
    } catch (_) { /* ignore */ }
  }

  setupListeners() {
    if (!window.setengine) return;

    if (window.setengine.onBrowserNavigate) {
      this._unsubNavigate = window.setengine.onBrowserNavigate((url) => {
        if (this.urlDisplay) this.urlDisplay.textContent = url || '';
      });
    }

    if (window.setengine.onBrowserLoadFailed) {
      this._unsubLoadFailed = window.setengine.onBrowserLoadFailed((data) => {
        // Spotify's SPA fires spurious did-fail-load events during its boot
        // redirects (the eventual page renders fine). We used to auto-mount
        // a fallback search UI here, but that mounted under the WebContentsView
        // — which composites above DOM — producing a dark "Spotify failed"
        // panel hidden behind a successfully-rendered Spotify page. With the
        // desktop Chrome UA spoof in place Spotify embeds reliably, so we
        // just log and trust the user to see a blank view if the embed is
        // truly broken. The fallback UI is still reachable via the public
        // method below for future manual triggers.
        if (data && data.errorDescription) {
          // eslint-disable-next-line no-console
          console.warn(`[SetEngine] ${data.source} load-failed: ${data.errorDescription} (${data.errorCode}) @ ${data.url}`);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Spotify fallback UI — used when open.spotify.com can't be embedded
  // ---------------------------------------------------------------------------

  _enableSpotifyFallback(reason) {
    if (this._spotifyFallbackActive) return;
    this._spotifyFallbackActive = true;

    // Collapse the WebContentsView so it stops trying to render the failed
    // page. Restored if/when the user switches back to YT Music.
    if (window.setengine && window.setengine.resizeBrowser) {
      window.setengine.resizeBrowser({ x: 0, y: 0, width: 0, height: 0 });
    }

    if (!this.placeholder) return;
    if (this.fallbackEl) this.fallbackEl.remove();

    this.fallbackEl = document.createElement('div');
    this.fallbackEl.className = 'browser-spotify-fallback';
    this.fallbackEl.style.position = 'absolute';
    this.fallbackEl.style.inset = '0';
    this.fallbackEl.style.padding = '24px';
    this.fallbackEl.style.background = 'var(--bg-secondary, #111)';
    this.fallbackEl.style.color = 'var(--text-primary, #eee)';
    this.fallbackEl.style.overflowY = 'auto';
    this.fallbackEl.style.display = 'flex';
    this.fallbackEl.style.flexDirection = 'column';
    this.fallbackEl.style.gap = '12px';

    const heading = document.createElement('h2');
    heading.textContent = 'Spotify Search';
    heading.style.margin = '0';
    this.fallbackEl.appendChild(heading);

    const subtitle = document.createElement('div');
    subtitle.className = 'form-helper';
    subtitle.textContent = `Couldn't embed open.spotify.com (${reason || 'blocked'}). Searching directly via spotdl instead.`;
    this.fallbackEl.appendChild(subtitle);

    const inputRow = document.createElement('div');
    inputRow.style.display = 'flex';
    inputRow.style.gap = '8px';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.placeholder = 'Search Spotify (e.g. "Daft Punk Get Lucky")';
    input.style.flex = '1';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._runSpotifySearch(input.value);
    });

    const searchBtn = document.createElement('button');
    searchBtn.className = 'btn btn-sm';
    searchBtn.textContent = 'SEARCH';
    searchBtn.addEventListener('click', () => this._runSpotifySearch(input.value));

    inputRow.appendChild(input);
    inputRow.appendChild(searchBtn);
    this.fallbackEl.appendChild(inputRow);

    const results = document.createElement('div');
    results.id = 'spotify-fallback-results';
    results.style.display = 'flex';
    results.style.flexDirection = 'column';
    results.style.gap = '6px';
    this.fallbackEl.appendChild(results);

    // The placeholder is the natural anchor for an overlay since it already
    // sits where the browser view would live. Position the fallback relative
    // to its parent (the page container).
    this.placeholder.style.position = 'relative';
    this.placeholder.appendChild(this.fallbackEl);

    setTimeout(() => input.focus(), 50);
  }

  _removeSpotifyFallback() {
    this._spotifyFallbackActive = false;
    if (this.fallbackEl) {
      this.fallbackEl.remove();
      this.fallbackEl = null;
    }
    this._lastSpotifyResults = [];
  }

  async _runSpotifySearch(query) {
    if (!window.setengine || !window.setengine.searchSpotify) {
      showToast('Spotify search IPC not available', 'error');
      return;
    }
    const q = (query || '').trim();
    if (!q) return;

    const resultsEl = this.fallbackEl && this.fallbackEl.querySelector('#spotify-fallback-results');
    if (resultsEl) resultsEl.innerHTML = '<div class="form-helper">Searching…</div>';

    let payload;
    try {
      payload = await window.setengine.searchSpotify(q);
    } catch (err) {
      if (resultsEl) resultsEl.innerHTML = `<div class="form-helper">${this._escape(err.message || 'Search failed')}</div>`;
      return;
    }

    if (!payload || !payload.success) {
      if (resultsEl) resultsEl.innerHTML = `<div class="form-helper">${this._escape((payload && payload.error) || 'Search failed')}</div>`;
      return;
    }

    this._lastSpotifyResults = payload.results || [];
    if (!resultsEl) return;

    if (this._lastSpotifyResults.length === 0) {
      resultsEl.innerHTML = '<div class="form-helper">No matches.</div>';
      return;
    }

    resultsEl.innerHTML = '';
    this._lastSpotifyResults.forEach((r) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-picker-item';
      row.style.textAlign = 'left';
      row.innerHTML = `
        <div class="search-picker-meta">
          <div class="search-picker-title">${this._escape(r.title || 'Unknown')}</div>
          <div class="search-picker-sub">${this._escape(r.artists || r.channel || '')}</div>
        </div>
      `;
      row.addEventListener('click', () => {
        if (r.url) this.startDownload(r.url, r.title);
      });
      resultsEl.appendChild(row);
    });
  }

  _escape(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  async handleDownload() {
    const url = this.urlDisplay ? this.urlDisplay.textContent : '';
    if (!url || url === SOURCE_META[this.activeSource].domain) {
      showToast('Navigate to something to download', 'warning');
      return;
    }
    if (!window.setengine || !window.setengine.downloadURL) {
      showToast('IPC not available', 'error');
      return;
    }

    // Ask main to classify — this is the renderer-side equivalent of the
    // download-manager's classifyUrl(). A direct match means we can skip
    // scraping and download immediately.
    let cls = null;
    if (window.setengine.classifyURL) {
      try { cls = await window.setengine.classifyURL(url); } catch (_) { /* ignore */ }
    }
    if (cls && cls.kind) {
      await this.startDownload(url);
      return;
    }

    await this.handlePagePickDownload(url);
  }

  async handlePagePickDownload(url) {
    const results = await this.scrapeVisibleResults();

    if (results.length === 0) {
      const query = extractSearchQuery(url);
      if (query) {
        const picked = await this.pickFromSearch(query);
        if (picked) await this.startDownload(picked.url, picked.title);
        return;
      }
      showToast('No songs found on this page', 'warning');
      return;
    }

    if (results.length === 1) {
      await this.startDownload(results[0].url, results[0].title);
      return;
    }

    const picked = await showSearchPicker(`${results.length} songs on this page`, results);
    if (!picked) return;
    await this.startDownload(picked.url, picked.title);
  }

  async scrapeVisibleResults() {
    if (!window.setengine.scrapePageResults) return [];
    const dismiss = showToast('Reading page…', 'info', 0);
    try {
      const scraped = await window.setengine.scrapePageResults();
      return (scraped && scraped.success && Array.isArray(scraped.results))
        ? scraped.results
        : [];
    } catch (_) {
      return [];
    } finally {
      dismiss();
    }
  }

  async pickFromSearch(query) {
    // Route the search through whichever source is active. spotify uses
    // searchSpotify (spotdl-backed); youtube-music keeps the existing yt-dlp
    // search path.
    const searchFn = this.activeSource === 'spotify'
      ? (window.setengine && window.setengine.searchSpotify)
      : (window.setengine && window.setengine.searchVideos);
    if (!searchFn) {
      showToast('Search IPC not available', 'error');
      return null;
    }
    const dismiss = showToast(`Searching: "${query}"…`, 'info', 0);
    let result;
    try {
      result = await searchFn(query);
    } catch (err) {
      dismiss();
      showToast(err.message || 'Search failed', 'error');
      return null;
    }
    dismiss();

    if (!result || !result.success) {
      showToast((result && result.error) || 'Search failed', 'error');
      return null;
    }
    if (!result.results || result.results.length === 0) {
      showToast('No results found', 'warning');
      return null;
    }
    return showSearchPicker(`"${query}"`, result.results);
  }

  async startDownload(url, title = null) {
    try {
      const result = await window.setengine.downloadURL(url);
      if (result && !result.success) {
        showToast(result.error || 'Failed to start download', 'error');
        return;
      }
      showToast(title ? `Added: ${title}` : 'Added to queue', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to start download', 'error');
    }
  }

  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this._unsubNavigate) { this._unsubNavigate(); this._unsubNavigate = null; }
    if (this._unsubLoadFailed) { this._unsubLoadFailed(); this._unsubLoadFailed = null; }
    this._removeSpotifyFallback();
    if (window.setengine && window.setengine.closeBrowser) {
      window.setengine.closeBrowser();
    }
  }
}
