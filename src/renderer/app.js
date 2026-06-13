import { BrowserPage } from './pages/browser.js';
import { QueuePage } from './pages/queue.js';
import { MatchPage } from './pages/match.js';
import { SetMakerPage } from './pages/setmaker.js';
import { SettingsPage } from './pages/settings.js';
import { showModal } from './components/modal.js';
import { runYtdlpUpdateFlow, runSpotdlUpdateFlow } from './tool-update.js';

const PAGES = {
  browser: BrowserPage,
  queue: QueuePage,
  match: MatchPage,
  setmaker: SetMakerPage,
  settings: SettingsPage,
};

const NAV_ITEMS = [
  {
    id: 'nav-browser',
    page: 'browser',
    label: 'Download',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  },
  {
    id: 'nav-queue',
    page: 'queue',
    label: 'Download Queue',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  },
  {
    id: 'nav-match',
    page: 'match',
    label: 'Match Maker',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>',
  },
  {
    id: 'nav-setmaker',
    page: 'setmaker',
    label: 'Set Maker',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h13M3 12h13M3 18h9"/><path d="M19 8v9"/><circle cx="17" cy="17" r="2"/></svg>',
  },
  {
    id: 'nav-settings',
    page: 'settings',
    label: 'Settings',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  },
];

export class App {
  constructor() {
    this.sidebar = document.getElementById('sidebar');
    this.mainContent = document.getElementById('main-content');

    this.currentPage = null;
    this.currentPageName = null;
  }

  async init() {
    this.renderSidebar();
    this.navigateTo('browser');

    this.setupIpcListeners();
    await this.checkDisclaimer();
    await this.checkYtDlpHealth();
    await this.checkSpotdlHealth();
  }

  renderSidebar() {
    this.sidebar.innerHTML = '';
    NAV_ITEMS.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'sidebar-btn';
      btn.id = item.id;
      btn.dataset.page = item.page;
      btn.title = item.label;
      btn.innerHTML = `
        <span class="sidebar-icon" style="display:flex; align-items:center;">${item.icon}</span>
        <span class="sidebar-label">${item.label}</span>
      `;

      if (item.id === 'nav-settings') {
        btn.style.marginTop = 'auto';
        btn.style.marginBottom = '24px';
      }

      btn.addEventListener('click', () => {
        this.navigateTo(item.page);
      });

      this.sidebar.appendChild(btn);
    });
  }

  navigateTo(pageName) {
    if (this.currentPageName === pageName) return;

    // Destroy current page if it has a destroy method (e.g. browser page)
    if (this.currentPage && typeof this.currentPage.destroy === 'function') {
      this.currentPage.destroy();
    }

    // Close browser view when leaving browser page
    if (this.currentPageName === 'browser' && pageName !== 'browser') {
      if (window.setengine && window.setengine.closeBrowser) {
        window.setengine.closeBrowser();
      }
    }

    // Clear main content
    this.mainContent.innerHTML = '';

    // Instantiate and render new page
    const PageClass = PAGES[pageName];
    if (PageClass) {
      this.currentPage = new PageClass(this);
      this.currentPage.render(this.mainContent);
    }

    this.currentPageName = pageName;

    // Update active sidebar button
    this.sidebar.querySelectorAll('.sidebar-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.page === pageName);
    });
  }



  setupIpcListeners() {
    if (!window.setengine) return;

    if (window.setengine.onDownloadProgress) {
      window.setengine.onDownloadProgress((data) => {
        if (this.currentPage && this.currentPageName === 'queue' && typeof this.currentPage.updateItem === 'function') {
          this.currentPage.updateItem(data);
        }
      });
    }

    if (window.setengine.onDownloadComplete) {
      window.setengine.onDownloadComplete((data) => {
        if (this.currentPage && this.currentPageName === 'queue' && typeof this.currentPage.updateItem === 'function') {
          this.currentPage.updateItem(data);
        }
      });
    }

    if (window.setengine.onDownloadError) {
      window.setengine.onDownloadError((data) => {
        if (this.currentPage && this.currentPageName === 'queue' && typeof this.currentPage.updateItem === 'function') {
          this.currentPage.updateItem(data);
        }
      });
    }
  }

  async checkYtDlpHealth() {
    if (!window.setengine || !window.setengine.getYtdlpHealth) return;

    try {
      const health = await window.setengine.getYtdlpHealth();
      if (!health) return;

      if (!health.version) {
        await showModal(
          'yt-dlp Not Found',
          `<p>SetEngine couldn't find <code>yt-dlp</code> on your PATH.</p>
          <p>Install it via your package manager:</p>
          <ul>
            <li>Homebrew: <code>brew install yt-dlp</code></li>
            <li>pip: <code>pip install -U yt-dlp</code></li>
          </ul>
          <p>Then restart SetEngine.</p>`,
          ['OK']
        );
        return;
      }

      if (health.outdated === true) {
        const choice = await showModal(
          'Update yt-dlp',
          `<p>Your yt-dlp is version <strong>${health.version}</strong>, older than the recommended minimum (<strong>${health.recommendedMin}</strong>).</p>
          <p>YouTube has changed its streaming protocol (SABR); older yt-dlp builds can't extract audio and every download will fail.</p>
          <p>SetEngine can update yt-dlp for you now. This usually takes under a minute.</p>`,
          ['UPDATE NOW', 'LATER']
        );
        if (choice === 'UPDATE NOW') {
          await runYtdlpUpdateFlow();
        }
      }
    } catch (_) { /* ignore */ }
  }

  async checkSpotdlHealth() {
    // Only nag the user when they actually prefer Spotify — YT-Music users
    // shouldn't be bothered about a tool they don't need.
    if (!window.setengine || !window.setengine.getSettings || !window.setengine.getSpotdlHealth) return;
    try {
      const settings = await window.setengine.getSettings();
      if (!settings || settings.preferredSource !== 'spotify') return;

      const health = await window.setengine.getSpotdlHealth();
      if (!health) return;

      if (!health.version) {
        await showModal(
          'spotdl Not Found',
          `<p>You've set Spotify as your preferred source, but SetEngine couldn't find <code>spotdl</code> on your PATH.</p>
          <p>Install it via your package manager:</p>
          <ul>
            <li>Homebrew: <code>brew install spotdl</code></li>
            <li>pipx: <code>pipx install spotdl</code></li>
            <li>pip: <code>pip install -U spotdl</code></li>
          </ul>
          <p>Then restart SetEngine. (Spotify downloads route through spotdl + yt-dlp under the hood.)</p>`,
          ['OK']
        );
        return;
      }

      if (health.outdated === true) {
        const choice = await showModal(
          'Update spotdl',
          `<p>Your spotdl is version <strong>${health.version}</strong>, older than the recommended minimum (<strong>${health.recommendedMin}</strong>).</p>
          <p>SetEngine can update spotdl for you now.</p>`,
          ['UPDATE NOW', 'LATER']
        );
        if (choice === 'UPDATE NOW') {
          await runSpotdlUpdateFlow();
        }
      }
    } catch (_) { /* ignore */ }
  }

  async checkDisclaimer() {
    if (!window.setengine) return;

    try {
      const settings = await window.setengine.getSettings();
      if (settings && settings.showDisclaimer !== false) {
        const result = await showModal(
          'Disclaimer',
          `<p>SetEngine is intended for downloading music you have the legal right to access. You are solely responsible for ensuring your use complies with applicable laws and YouTube's Terms of Service.</p>
          <p>This tool is provided as-is. The developer assumes no liability for misuse.</p>
          <p>By clicking ACCEPT, you acknowledge and agree to these terms.</p>`,
          ['ACCEPT']
        );

        if (result === 'ACCEPT') {
          await window.setengine.saveSettings({ showDisclaimer: false });
        }
      }
    } catch (_) { /* ignore */ }
  }
}
