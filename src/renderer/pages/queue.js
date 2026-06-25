import { showToast } from '../components/toast.js';
import { escapeHtml } from '../utils/escape-html.js';

const STATUS_CONFIG = {
  queued: { label: 'QUEUED', badgeClass: 'badge-muted' },
  downloading: { label: 'DOWNLOADING', badgeClass: 'badge-accent' },
  complete: { label: 'COMPLETE', badgeClass: 'badge-success' },
  error: { label: 'ERROR', badgeClass: 'badge-error' },
  cancelled: { label: 'CANCELLED', badgeClass: 'badge-muted' },
};

// Tiny source badge shown next to the title so a mixed queue is readable at a
// glance. Items missing `source` (legacy / unknown) default to youtube-music.
const SOURCE_BADGE = {
  'youtube-music': { label: 'YT', title: 'YouTube Music' },
  spotify: { label: 'SPOTIFY', title: 'Spotify (via spotdl)' },
};

function sourceBadgeHtml(source) {
  const meta = SOURCE_BADGE[source] || SOURCE_BADGE['youtube-music'];
  return `<span class="badge badge-muted" title="${meta.title}" style="font-size: 10px; letter-spacing: 1px;">${meta.label}</span>`;
}

export class QueuePage {
  constructor(app) {
    this.app = app;
    this.container = null;
    this.queueList = null;
    this.items = new Map();
    this.expandedPlaylists = new Set();
  }

  render(container) {
    this.container = container;
    container.classList.add('page-host');

    // Page shell: dark-gray topbar (title + CLEAR action) over a scrolling body,
    // matching the Match Maker / Set Maker layout.
    const shell = document.createElement('div');
    shell.className = 'page-shell';

    const topbar = document.createElement('div');
    topbar.className = 'page-topbar';

    const title = document.createElement('h1');
    title.className = 'page-title';
    title.textContent = 'Download Queue';
    topbar.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'page-topbar-actions';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-secondary btn-sm';
    clearBtn.id = 'queue-clear-completed-btn';
    clearBtn.textContent = 'CLEAR';
    clearBtn.addEventListener('click', () => this.handleClearAll());
    actions.appendChild(clearBtn);
    topbar.appendChild(actions);

    shell.appendChild(topbar);

    const scroll = document.createElement('div');
    scroll.className = 'page-body';
    const body = document.createElement('div');
    body.className = 'page-content';
    scroll.appendChild(body);
    shell.appendChild(scroll);
    container.appendChild(shell);

    // Queue list
    this.queueList = document.createElement('div');
    this.queueList.className = 'flex flex-col';
    this.queueList.id = 'queue-list';
    body.appendChild(this.queueList);

    // Load current queue
    this.loadQueue();
  }

  destroy() {
    if (this.container) this.container.classList.remove('page-host');
  }

  async loadQueue() {
    if (!window.setengine || !window.setengine.getQueue) return;

    try {
      const queue = await window.setengine.getQueue();
      this._rebuild(Array.isArray(queue) ? queue : []);
    } catch (err) {
      showToast('Failed to load queue', 'error');
    }
  }

  // Full teardown + rebuild from a queue snapshot, preserving which playlists
  // the user had expanded so a rebuild doesn't silently collapse them.
  _rebuild(queue) {
    this.queueList.innerHTML = '';
    this.items.clear();
    if (!queue.length) {
      this.showEmptyState();
      return;
    }
    queue.forEach((item) => this.addItem(item));
    this.expandedPlaylists.forEach((id) => {
      const childrenContainer = document.getElementById(`queue-children-${id}`);
      const toggleBtn = document.getElementById(`queue-toggle-${id}`);
      if (childrenContainer && toggleBtn) {
        childrenContainer.classList.remove('hidden');
        toggleBtn.textContent = toggleBtn.textContent.replace('▸', '▾');
      }
    });
  }

  // Live handler for download:queue-update (structural changes: add / cancel /
  // retry / clear, and playlist children that appear after metadata loads).
  // Rebuilds only when the set of rendered items/children actually changed;
  // otherwise refreshes existing rows in place so we don't tear down the DOM on
  // every status transition.
  syncQueue(queue) {
    if (!Array.isArray(queue)) return;

    const seen = new Set();
    let structuralChange = false;
    for (const item of queue) {
      seen.add(item.id);
      if (!this.items.has(item.id)) structuralChange = true;
      if (Array.isArray(item.children)) {
        for (const child of item.children) {
          seen.add(child.id);
          if (!this.items.has(child.id)) structuralChange = true;
        }
      }
    }
    if (!structuralChange) {
      for (const id of this.items.keys()) {
        if (!seen.has(id)) { structuralChange = true; break; }
      }
    }

    if (structuralChange) {
      this._rebuild(queue);
    } else {
      for (const item of queue) {
        this.updateItem(item);
        if (Array.isArray(item.children)) item.children.forEach((c) => this.updateItem(c));
      }
    }
  }

  showEmptyState() {
    this.queueList.innerHTML = `
      <div style="text-align: center; padding: 64px 0; color: var(--text-muted);">
        <div style="font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">NO ITEMS IN QUEUE</div>
        <div style="font-size: 12px; margin-top: 8px;">Download something to see it here</div>
      </div>
    `;
  }

  addItem(item) {
    const el = this.createItemElement(item);
    this.items.set(item.id, { element: el, data: item });
    this.queueList.appendChild(el);

    // If it's a playlist with children, add children container
    if (item.type === 'playlist' && item.children && item.children.length > 0) {
      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'queue-children hidden';
      childrenContainer.id = `queue-children-${item.id}`;

      item.children.forEach((child) => {
        const childEl = this.createItemElement(child, true);
        this.items.set(child.id, { element: childEl, data: child });
        childrenContainer.appendChild(childEl);
      });

      this.queueList.appendChild(childrenContainer);
    }
  }

  createItemElement(item, isChild = false) {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.id = `queue-item-${item.id}`;
    el.dataset.itemId = item.id;

    const status = STATUS_CONFIG[item.status] || STATUS_CONFIG.queued;

    el.innerHTML = `
      <div class="queue-item-details">
        <div class="queue-item-row">
          ${sourceBadgeHtml(item.source)}
          <span class="queue-item-title" id="queue-title-${item.id}">${escapeHtml(item.title || 'Unknown')}</span>
          <span class="badge ${status.badgeClass}" id="queue-status-${item.id}">${status.label}</span>
          ${!isChild && item.type === 'playlist' ? `<button class="queue-toggle" id="queue-toggle-${item.id}" data-id="${item.id}">▸ ${item.children ? item.children.length : 0} TRACKS</button>` : ''}
          <div class="queue-item-actions" id="queue-actions-${item.id}">
            ${this.renderActions(item)}
          </div>
        </div>
        ${item.status === 'downloading' ? `
          <div class="queue-item-progress mt-4">
            <div class="progress-bar">
              <div class="progress-fill" id="queue-progress-${item.id}" style="width: ${item.progress || 0}%"></div>
            </div>
            <div class="queue-item-meta mt-4" id="queue-meta-${item.id}">
              ${item.speed ? item.speed : ''} ${item.eta ? '· ETA ' + item.eta : ''}
            </div>
          </div>
        ` : ''}
        ${item.status === 'error' && item.error ? `
          <div class="queue-item-error mt-4" id="queue-error-${item.id}">${escapeHtml(item.error)}</div>
        ` : ''}
        ${!isChild && item.type === 'playlist' ? `
          <div class="queue-item-meta mt-4" id="queue-playlist-progress-${item.id}">
            ${item.childrenProgress ? `${item.childrenProgress.complete || 0}/${item.childrenProgress.total || 0} songs` : ''}
          </div>
        ` : ''}
      </div>
    `;

    // Attach toggle listener for playlists
    if (!isChild && item.type === 'playlist') {
      const toggleBtn = el.querySelector(`#queue-toggle-${item.id}`);
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => this.togglePlaylist(item.id));
      }
    }

    // Attach action listeners
    this.attachActionListeners(el, item);

    return el;
  }

  renderActions(item) {
    const actions = [];

    if (item.status === 'downloading' || item.status === 'queued') {
      actions.push(`<button class="btn-secondary btn-sm" id="queue-cancel-${item.id}" data-action="cancel" data-id="${item.id}">CANCEL</button>`);
    }

    if (item.status === 'error' || item.status === 'cancelled') {
      actions.push(`<button class="btn-secondary btn-sm" id="queue-retry-${item.id}" data-action="retry" data-id="${item.id}">RETRY</button>`);
    }

    return actions.join('');
  }

  attachActionListeners(el, item) {
    el.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.action;
        const id = e.currentTarget.dataset.id;

        if (action === 'cancel' && window.setengine && window.setengine.cancelDownload) {
          window.setengine.cancelDownload(id);
          showToast('Download cancelled', 'info');
        }

        if (action === 'retry' && window.setengine && window.setengine.retryDownload) {
          window.setengine.retryDownload(id);
          showToast('Retrying download', 'info');
        }
      });
    });
  }

  togglePlaylist(id) {
    const childrenContainer = document.getElementById(`queue-children-${id}`);
    const toggleBtn = document.getElementById(`queue-toggle-${id}`);

    if (!childrenContainer || !toggleBtn) return;

    if (this.expandedPlaylists.has(id)) {
      this.expandedPlaylists.delete(id);
      childrenContainer.classList.add('hidden');
      toggleBtn.textContent = toggleBtn.textContent.replace('▾', '▸');
    } else {
      this.expandedPlaylists.add(id);
      childrenContainer.classList.remove('hidden');
      toggleBtn.textContent = toggleBtn.textContent.replace('▸', '▾');
    }
  }

  updateItem(data) {
    if (!data || !data.id) return;

    const entry = this.items.get(data.id);
    if (!entry) {
      // Item doesn't exist yet — reload the queue
      this.loadQueue();
      return;
    }

    // Update stored data
    entry.data = { ...entry.data, ...data };

    // Update title if it changed (playlists start as "Fetching info..." and get
    // a real title after metadata loads)
    if (data.title) {
      const titleEl = document.getElementById(`queue-title-${data.id}`);
      if (titleEl && titleEl.textContent !== data.title) {
        titleEl.textContent = data.title;
      }
    }

    // Update status badge
    const statusEl = document.getElementById(`queue-status-${data.id}`);
    if (statusEl && data.status) {
      const config = STATUS_CONFIG[data.status] || STATUS_CONFIG.queued;
      statusEl.className = `badge ${config.badgeClass}`;
      statusEl.textContent = config.label;
    }

    // Update progress bar. Toggle the state classes (don't just add them) so a
    // retried download clears its previous state: a failed item that's retried
    // and succeeds must drop the red 'error' class and gain 'complete', or both
    // classes linger and the CSS rule declared later (.error) keeps the bar red.
    const progressEl = document.getElementById(`queue-progress-${data.id}`);
    if (progressEl) {
      if (data.progress !== undefined) {
        progressEl.style.width = `${data.progress}%`;
      }
      if (data.status) {
        progressEl.classList.toggle('complete', data.status === 'complete');
        progressEl.classList.toggle('error', data.status === 'error');
      }
    }

    // Update meta (speed + ETA)
    const metaEl = document.getElementById(`queue-meta-${data.id}`);
    if (metaEl) {
      const parts = [];
      if (data.speed) parts.push(data.speed);
      if (data.eta) parts.push(`ETA ${data.eta}`);
      metaEl.textContent = parts.join(' · ');
    }

    // Update playlist progress
    if (data.childrenProgress) {
      const playlistProgressEl = document.getElementById(`queue-playlist-progress-${data.id}`);
      if (playlistProgressEl) {
        playlistProgressEl.textContent = `${data.childrenProgress.complete || 0}/${data.childrenProgress.total || 0} songs`;
      }
    }

    // Update actions if status changed
    if (data.status) {
      const actionsEl = document.getElementById(`queue-actions-${data.id}`);
      if (actionsEl) {
        actionsEl.innerHTML = this.renderActions(entry.data);
        this.attachActionListeners(entry.element, entry.data);
      }

      // If status changed to downloading, add progress bar if not present
      if (data.status === 'downloading' && !progressEl) {
        const detailsEl = entry.element.querySelector('.queue-item-details');
        if (detailsEl) {
          const progressSection = document.createElement('div');
          progressSection.className = 'queue-item-progress mt-4';
          progressSection.innerHTML = `
            <div class="progress-bar">
              <div class="progress-fill" id="queue-progress-${data.id}" style="width: ${data.progress || 0}%"></div>
            </div>
            <div class="queue-item-meta mt-4" id="queue-meta-${data.id}"></div>
          `;
          detailsEl.appendChild(progressSection);
        }
      }

      // Show / clear error message inline
      const detailsEl = entry.element.querySelector('.queue-item-details');
      const existingErrorEl = document.getElementById(`queue-error-${data.id}`);
      if (data.status === 'error' && entry.data.error) {
        if (existingErrorEl) {
          existingErrorEl.textContent = entry.data.error;
        } else if (detailsEl) {
          const errorEl = document.createElement('div');
          errorEl.className = 'queue-item-error mt-4';
          errorEl.id = `queue-error-${data.id}`;
          errorEl.textContent = entry.data.error;
          detailsEl.appendChild(errorEl);
        }
      } else if (existingErrorEl) {
        existingErrorEl.remove();
      }
    }
  }

  async handleClearAll() {
    if (!window.setengine || !window.setengine.clearAll) {
      showToast('IPC not available', 'error');
      return;
    }

    try {
      await window.setengine.clearAll();
      this.loadQueue();
      showToast('Queue cleared', 'info');
    } catch (err) {
      showToast('Failed to clear queue', 'error');
    }
  }
}
