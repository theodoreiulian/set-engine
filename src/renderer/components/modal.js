import { escapeHtml } from '../utils/escape-html.js';

export function showModal(title, content, buttons = ['OK']) {
  return new Promise((resolve) => {
    const container = document.getElementById('modal-container');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    // `content` is intentionally raw HTML (callers pass markup); `title` is
    // plain text and is escaped so a dynamic/user-derived title can't inject markup.
    modal.innerHTML = `<h2 class="modal-title">${escapeHtml(title)}</h2><div class="modal-content">${content}</div>`;

    const btnRow = document.createElement('div');
    btnRow.className = 'modal-buttons';

    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      overlay.remove();
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
