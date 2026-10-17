import { escapeHtml } from './utils/escape-html.js';

// The "a new version is out" prompt, and the sidebar button that keeps the
// offer visible after LATER.
//
// Main is the source of truth (src/main/app-updater.js): it checks by itself
// and broadcasts `update:state`; this only mirrors it. Nothing downloads until
// the user clicks UPDATE & RESTART. The prompt opens by itself once per
// session, the first time a new version is seen — after that the sidebar
// button is the reminder, because a DJ preparing a set does not want the same
// dialog every hour.
//
// It is its own modal rather than showModal(): showModal() closes on the first
// click, and this one has to stay up and show the download's progress.

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v9M8 12.5l4 4 4-4"/></svg>';
const MAX_NOTES = 12;

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export class UpdatePrompt {
  constructor(app) {
    this.app = app;
    this.state = null;
    this.overlay = null;
    this.view = null;
    this.button = null;
    this.autoShown = false;     // the once-per-session automatic prompt
    this.noticeShown = false;
    this.showingNotice = false;
    this.userStarted = false;   // only then do errors and restart questions open the prompt
    this.waiting = null;        // a MutationObserver waiting for another modal to close
  }

  async init() {
    if (!window.setengine || !window.setengine.getUpdateState) return;
    window.setengine.onUpdateState((state) => this.onState(state));
    try {
      this.onState(await window.setengine.getUpdateState());
    } catch (_) { /* updates are a nicety; never block startup on them */ }
  }

  onState(state) {
    if (!state) return;
    const prev = this.state;
    this.state = state;
    this.renderButton();

    if (state.failureNotice && !this.noticeShown) {
      this.noticeShown = true;
      this.showingNotice = true;
      this.open();
      return;
    }
    const changed = !prev || prev.status !== state.status;
    if (state.status === 'available' && !this.autoShown && state.version !== state.failedVersion) {
      this.autoShown = true;
      this.open();
    } else if (changed && this.userStarted && ['ready', 'error', 'installing'].includes(state.status)) {
      // The user asked for this update, so its outcome — and a restart that
      // would stop their downloads — is worth interrupting them for.
      this.open();
    } else if (this.overlay) {
      this.render();
    }
  }

  // ── sidebar ───────────────────────────────────────────────────────

  renderButton() {
    const s = this.state;
    const label = s && s.version ? {
      available: 'Update available',
      checking: 'Update available',
      downloading: `Updating ${s.percent || 0}%`,
      verifying: 'Updating…',
      ready: 'Restart to update',
      installing: 'Restarting…',
      error: 'Update failed',
    }[s.status] : null;

    if (!label) {
      if (this.button) this.button.hidden = true;
      return;
    }
    if (!this.button || !this.button.isConnected) {
      const sidebar = document.getElementById('sidebar');
      if (!sidebar) return;
      this.button = document.createElement('button');
      this.button.className = 'sidebar-btn sidebar-update';
      this.button.id = 'nav-update';
      this.button.innerHTML = `<span class="sidebar-icon" style="display:flex; align-items:center;">${DOWNLOAD_ICON}</span><span class="sidebar-label"></span>`;
      this.button.addEventListener('click', () => this.onButtonClick());
      // Sits directly above the Download Queue + Settings pair at the bottom.
      sidebar.insertBefore(this.button, document.getElementById('nav-queue'));
    }
    this.button.hidden = false;
    this.button.title = `SetEngine ${s.version}`;
    this.button.querySelector('.sidebar-label').textContent = label;
  }

  onButtonClick() {
    // Ready and waiting on a decision: ask main again, since whatever was
    // running when it got ready may have finished by now.
    if (this.state && this.state.status === 'ready') {
      this.userStarted = true;
      this.install();
    }
    this.open();
  }

  // ── modal ─────────────────────────────────────────────────────────

  /** Show the prompt for the current state (after any other open modal closes). */
  open() {
    if (this.overlay) {
      this.render();
      return;
    }
    const container = document.getElementById('modal-container');
    if (!container) return;
    // The startup yt-dlp prompt, or anything else, gets to finish first.
    if (container.querySelector('.modal-overlay')) {
      if (this.waiting) return;
      this.waiting = new MutationObserver(() => {
        if (container.querySelector('.modal-overlay')) return;
        this.waiting.disconnect();
        this.waiting = null;
        this.open();
      });
      this.waiting.observe(container, { childList: true });
      return;
    }
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    container.appendChild(this.overlay);
    this.render();
  }

  close() {
    if (this.overlay) this.overlay.remove();
    this.overlay = null;
    this.view = null;
    this.showingNotice = false;
  }

  viewFor(s) {
    if (this.showingNotice) return 'notice';
    switch (s.status) {
      case 'downloading':
      case 'verifying': return 'progress';
      case 'ready': return 'ready';
      case 'installing': return 'installing';
      case 'error': return 'error';
      default: return s.version ? 'available' : null;
    }
  }

  render() {
    if (!this.overlay || !this.state) return;
    const s = this.state;
    const view = this.viewFor(s);
    if (!view) {
      this.close();
      return;
    }
    // Progress ticks only move the bar; rebuilding the dialog for each one
    // would steal focus from the HIDE button.
    if (view === 'progress' && this.view === 'progress') {
      this.updateProgress();
      return;
    }
    this.view = view;

    const current = escapeHtml(s.currentVersion || '');
    const version = escapeHtml(s.version || '');
    let title;
    let body;
    let buttons;

    if (view === 'notice' && s.failedReason === 'could-not-replace') {
      title = 'Update not installed';
      body = `<p>macOS didn't let SetEngine replace itself, so you're still on ${current}. Nothing was lost.</p>
        <p>To get ${escapeHtml(s.failedVersion || 'the new version')}, download it and drag it into Applications — your settings are kept.</p>`;
      buttons = [
        ['LATER', 'btn-secondary', () => { this.close(); this.onState(this.state); }],
        ...(s.page ? [['DOWNLOAD', 'btn', () => { this.openPage(); this.close(); }]] : []),
      ];
    } else if (view === 'notice') {
      title = 'Update didn\'t start';
      body = `<p>SetEngine ${escapeHtml(s.failedVersion || '')} didn't start on this Mac, so SetEngine put ${current} back. Nothing was lost.</p>
        <p>The next version will be offered as usual.</p>`;
      // Then anything newer that is waiting gets its turn.
      buttons = [['OK', 'btn', () => { this.close(); this.onState(this.state); }]];
    } else if (view === 'available') {
      title = 'Update available';
      const blocker = s.blocker;
      const retry = s.version === s.failedVersion && s.failedReason === 'did-not-start'
        ? `<p>Last time this version didn't start, so SetEngine kept ${current}. You can try it again.</p>`
        : '';
      body = `<p><strong>SetEngine ${version}</strong> is out. You have ${current}.</p>
        ${this.notesHtml(s.releases)}
        ${retry}
        ${blocker
          ? `<p>${escapeHtml(blocker.message)}</p>`
          : '<p class="update-fineprint">SetEngine downloads it, restarts, and keeps your settings. If the new version can\'t start, your current one is put back.</p>'}`;
      if (!blocker) {
        buttons = [
          ['LATER', 'btn-secondary', () => this.close()],
          ['UPDATE & RESTART', 'btn', () => { this.userStarted = true; this.install(); }],
        ];
      } else if (blocker.reason === 'permission' || blocker.reason === 'unknown') {
        buttons = [
          ['LATER', 'btn-secondary', () => this.close()],
          ['DOWNLOAD', 'btn', () => { this.openPage(); this.close(); }],
        ];
      } else {
        buttons = [['OK', 'btn', () => this.close()]];
      }
    } else if (view === 'progress') {
      title = 'Updating SetEngine';
      body = `<p class="update-progress-label"></p>
        <div class="progress-bar progress-lg"><div class="progress-fill update-progress-fill"></div></div>
        <p class="update-fineprint" style="margin-top: 12px;">You can keep working while it downloads. SetEngine restarts when it's ready.</p>`;
      buttons = [['HIDE', 'btn-secondary', () => this.close()]];
    } else if (view === 'ready') {
      title = 'Ready to restart';
      const busy = s.busy || { downloads: 0, extractions: 0 };
      const work = [
        busy.downloads ? plural(busy.downloads, 'download', 'downloads') : null,
        busy.extractions ? plural(busy.extractions, 'set extraction', 'set extractions') : null,
      ].filter(Boolean).join(' and ');
      body = `<p>SetEngine ${version} is downloaded and ready.</p>
        ${work ? `<p>Restarting now stops ${work} in progress. Choose LATER to let them finish, then click <strong>Restart to update</strong> in the sidebar.</p>` : ''}`;
      buttons = [
        ['LATER', 'btn-secondary', () => this.close()],
        ['RESTART NOW', 'btn', () => this.restart()],
      ];
    } else if (view === 'installing') {
      title = 'Restarting';
      body = `<p>SetEngine ${version} is installed and opens again in a moment.</p>`;
      buttons = [];
    } else {
      title = 'Update failed';
      body = `<p>${escapeHtml(s.error || 'The update could not be installed.')}</p>
        <p>Nothing was changed — you're still on ${current}.</p>`;
      buttons = [
        ['CLOSE', 'btn-secondary', () => this.close()],
        ...(s.page ? [['DOWNLOAD', 'btn-secondary', () => { this.openPage(); this.close(); }]] : []),
        ['TRY AGAIN', 'btn', () => { this.userStarted = true; this.install(); }],
      ];
    }

    const modal = document.createElement('div');
    modal.className = 'modal update-modal';
    modal.innerHTML = `<h2 class="modal-title">${escapeHtml(title)}</h2><div class="modal-content">${body}</div>`;
    if (buttons.length) {
      const row = document.createElement('div');
      row.className = 'modal-buttons';
      for (const [label, cls, onClick] of buttons) {
        const btn = document.createElement('button');
        btn.className = cls;
        btn.id = `update-btn-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        row.appendChild(btn);
      }
      modal.appendChild(row);
    }
    this.overlay.replaceChildren(modal);
    if (view === 'progress') this.updateProgress();
  }

  notesHtml(releases) {
    const list = (releases || []).filter((r) => r.changes && r.changes.length);
    if (!list.length) return '';
    const grouped = list.length > 1;
    let shown = 0;
    let hidden = 0;
    const parts = [];
    for (const r of list) {
      const items = [];
      for (const change of r.changes) {
        if (shown < MAX_NOTES) {
          items.push(`<li>${escapeHtml(change)}</li>`);
          shown++;
        } else {
          hidden++;
        }
      }
      if (items.length) {
        parts.push(`${grouped ? `<div class="update-notes-version">${escapeHtml(r.version)}</div>` : ''}<ul>${items.join('')}</ul>`);
      }
    }
    const more = hidden ? `<div class="update-notes-more">…and ${plural(hidden, 'more change', 'more changes')}.</div>` : '';
    return `<div class="update-notes"><div class="update-notes-title">What's new</div>${parts.join('')}${more}</div>`;
  }

  updateProgress() {
    if (!this.overlay) return;
    const s = this.state;
    const label = this.overlay.querySelector('.update-progress-label');
    const fill = this.overlay.querySelector('.update-progress-fill');
    const verifying = s.status === 'verifying';
    if (label) {
      label.textContent = verifying
        ? `Checking SetEngine ${s.version}…`
        : `Downloading SetEngine ${s.version}… ${s.percent || 0}%`;
    }
    if (fill) fill.style.width = `${verifying ? 100 : s.percent || 0}%`;
  }

  // ── actions ───────────────────────────────────────────────────────

  install() {
    // Resolves only once the download is done; progress arrives as state.
    window.setengine.installUpdate().catch(() => { /* reported through state */ });
  }

  restart() {
    window.setengine.restartToUpdate().catch(() => { /* reported through state */ });
  }

  openPage() {
    window.setengine.openUpdatePage().catch(() => {});
  }
}
