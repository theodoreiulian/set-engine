export function showModal(title, content, buttons = ['OK']) {
  // Any embedded WebContentsView (YT Music, Spotify) composites above DOM
  // regardless of z-index — that's the platform behavior, not a CSS bug. If
  // the user is on the Browser tab when a modal opens, the modal renders
  // behind the embedded site and is effectively invisible/unclickable while
  // the dark overlay paints around it. Mirror the search-picker trick: shrink
  // the active browser view to 0×0 while the modal is open, then restore.
  const restoreBrowser = collapseBrowserView();

  return new Promise((resolve) => {
    const container = document.getElementById('modal-container');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<h2 class="modal-title">${title}</h2><div class="modal-content">${content}</div>`;

    const btnRow = document.createElement('div');
    btnRow.className = 'modal-buttons';

    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      overlay.remove();
      restoreBrowser();
      resolve(value);
    };

    buttons.forEach((label) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.id = `modal-btn-${label.toLowerCase().replace(/\s+/g, '-')}`;
      btn.textContent = label;
      btn.onclick = () => finish(label);
      btnRow.appendChild(btn);
    });

    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    container.appendChild(overlay);
  });
}

/**
 * Shrink the embedded browser WebContentsView to 0×0 so it stops occluding
 * the modal. Returns a function that restores the view to whatever the
 * browser-view-placeholder div currently measures — measured at restore time
 * so window resizes during the modal are handled correctly.
 *
 * No-op when the browser view isn't mounted (e.g. user is on a different
 * page). Mirrors the helper in search-picker.js — kept here as a private
 * copy rather than imported so modal.js stays standalone.
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
