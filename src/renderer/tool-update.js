import { showModal } from './components/modal.js';
import { showToast } from './components/toast.js';
import { escapeHtml } from './utils/escape-html.js';

/**
 * Run an auto-update flow for one of our system-tool dependencies. Mirrors the
 * UI flow the yt-dlp updater always had — toast while running, success or
 * failure modal at the end — but parameterised so the same code drives both
 * yt-dlp and spotdl (and any future tools).
 *
 * @param {object} opts
 * @param {string} opts.label — e.g. 'yt-dlp', 'spotdl'
 * @param {() => Promise<{ success, error?, version?, output? }>} opts.invoke
 * @param {string[]} [opts.manualInstall] — fallback commands listed in the failure modal
 * @returns {Promise<{ success: boolean, error?: string, version?: string, output?: string }>}
 */
export async function runToolUpdateFlow({ label, invoke, manualInstall = [] }) {
  if (typeof invoke !== 'function') {
    await showModal('Update Unavailable', `<p>The ${escapeHtml(label)} update IPC channel is not available.</p>`, ['OK']);
    return { success: false, error: 'IPC unavailable' };
  }

  const dismissToast = showToast(`Updating ${label}… this may take a minute.`, 'info', 0);
  let result;
  try {
    result = await invoke();
  } catch (err) {
    result = { success: false, error: err.message };
  } finally {
    dismissToast();
  }

  if (result && result.success) {
    const versionLine = result.version
      ? `<p>Now on version <strong>${escapeHtml(result.version)}</strong>.</p>`
      : '';
    const output = result.output
      ? `<pre style="white-space: pre-wrap; font-size: 12px; opacity: 0.8;">${escapeHtml(result.output)}</pre>`
      : '';
    await showModal(`${label} Updated`, `${versionLine}${output}`, ['OK']);
  } else {
    const manual = manualInstall.length
      ? `<p>You can try updating manually:</p><ul>${manualInstall.map((l) => `<li><code>${escapeHtml(l)}</code></li>`).join('')}</ul>`
      : '';
    await showModal(
      'Update Failed',
      `<p>${escapeHtml((result && result.error) || 'Unknown error.')}</p>${manual}`,
      ['OK']
    );
  }
  return result || { success: false, error: 'No result' };
}

export function runYtdlpUpdateFlow() {
  return runToolUpdateFlow({
    label: 'yt-dlp',
    invoke: () => window.setengine && window.setengine.updateYtdlp(),
    manualInstall: ['brew upgrade yt-dlp', 'pipx upgrade yt-dlp', 'pip install -U yt-dlp'],
  });
}

export function runSpotdlUpdateFlow() {
  return runToolUpdateFlow({
    label: 'spotdl',
    invoke: () => window.setengine && window.setengine.updateSpotdl(),
    manualInstall: ['brew upgrade spotdl', 'pipx upgrade spotdl', 'pip install -U spotdl'],
  });
}
