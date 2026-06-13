/**
 * Show a modal that lists results and resolves with the picked one
 * (or null if the user cancelled).
 *
 * @param {string} subtitle — caption under the title (caller controls quoting)
 * @param {Array<{id, url, title, channel, duration, thumbnail}>} results
 * @returns {Promise<object|null>}
 */
import { escapeHtml } from '../utils/escape-html.js';

export function showSearchPicker(subtitle, results) {
  // The embedded YT Music browser is a native WebContentsView and renders
  // above DOM modals regardless of z-index. Collapse it to 0×0 while the
  // picker is up, then restore its bounds when we close.
  const restoreBrowser = collapseBrowserView();

  return new Promise((resolve) => {
    const container = document.getElementById('modal-container');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal search-picker';

    modal.innerHTML = `
      <h2 class="modal-title">Pick a result</h2>
      <div class="search-picker-query">${escapeHtml(subtitle)}</div>
      <div class="search-picker-list" id="search-picker-list">
        ${results.map((r, i) => renderResultRow(r, i)).join('')}
      </div>
      <div class="modal-buttons">
        <button class="btn-secondary" id="search-picker-cancel">CANCEL</button>
      </div>
    `;

    overlay.appendChild(modal);
    container.appendChild(overlay);

    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      overlay.remove();
      restoreBrowser();
      resolve(value);
    };

    overlay.querySelector('#search-picker-cancel').addEventListener('click', () => finish(null));

    overlay.querySelectorAll('.search-picker-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx, 10);
        finish(results[idx] || null);
      });
    });

    // Click outside the modal cancels
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
  });
}

function renderResultRow(r, i) {
  const thumb = r.thumbnail
    ? `<img class="search-picker-thumb" src="${escapeAttr(r.thumbnail)}" alt="" referrerpolicy="no-referrer">`
    : `<div class="search-picker-thumb search-picker-thumb-placeholder"></div>`;
  // Spotify rows surface `artists`; YouTube rows use `channel`. Prefer the
  // richer field when present so cross-source pickers don't render blanks.
  const subtitle = r.artists || r.channel || '';
  const sub = [subtitle, r.duration ? formatDuration(r.duration) : null]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');
  return `
    <button class="search-picker-item" type="button" data-idx="${i}">
      ${thumb}
      <div class="search-picker-meta">
        <div class="search-picker-title">${escapeHtml(r.title)}</div>
        <div class="search-picker-sub">${sub}</div>
      </div>
    </button>
  `;
}

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}:${String(mm).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/**
 * Shrink the embedded YT Music WebContentsView to 0×0 so it stops occluding
 * the modal. Returns a function that restores the view to whatever the
 * browser-view-placeholder div currently measures to — measured at restore
 * time so window resizes during the modal are handled correctly.
 *
 * No-op when the browser view isn't mounted (e.g. user is on a different
 * page), since `resizeBrowser` in main checks for that.
 */
function collapseBrowserView() {
  if (!window.setengine || !window.setengine.resizeBrowser) {
    return () => {};
  }
  window.setengine.resizeBrowser({ x: 0, y: 0, width: 0, height: 0 });

  return () => {
    const placeholder = document.getElementById('browser-view-placeholder');
    if (!placeholder) return;
    const r = placeholder.getBoundingClientRect();
    window.setengine.resizeBrowser({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  };
}
