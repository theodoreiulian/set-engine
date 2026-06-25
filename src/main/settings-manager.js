// =============================================================================
// settings-manager.js — Persistent settings via electron-store
// electron-store v11+ is ESM-only, so we import it directly.
// =============================================================================

import Store from 'electron-store';
import { app } from 'electron';

// Default settings for the application.
// Note: queue concurrency is intentionally NOT a setting — it's hardcoded in
// DownloadManager (MAX_CONCURRENT_DOWNLOADS) and sized to YouTube's per-IP
// tolerance. Exposing it as a knob just lets users pick values that get them
// rate-limited.
const DEFAULTS = {
  downloadFolder: '',  // Populated at construction time with app.getPath('music')
  audioQuality: 320,   // kbps — one of 128, 192, 320
  filenameTemplate: '%(title)s',
  autoUpdateYtdlp: true,
  showDisclaimer: true, // Show first-launch disclaimer
  // Cross-check detected BPM against free external databases (Deezer +, if a key
  // is set, GetSongBPM). When off, BPM tagging is purely local/offline.
  bpmLookupOnline: true,
  // Optional free GetSongBPM API key. If set, GetSongBPM is queried alongside
  // Deezer. Their TOS requires a visible "Powered by GetSongBPM" attribution
  // backlink, which the Settings page shows whenever a key is present.
  getSongBpmApiKey: '',
};

export default class SettingsManager {
  constructor() {
    // Resolve the OS music folder at runtime (app must be ready)
    const defaults = {
      ...DEFAULTS,
      downloadFolder: app.getPath('music'),
    };

    this.store = new Store({
      name: 'setengine-settings',
      defaults,
      schema: {
        downloadFolder: { type: 'string' },
        audioQuality: {
          type: 'number',
          enum: [128, 192, 320],
        },
        filenameTemplate: { type: 'string' },
        autoUpdateYtdlp: { type: 'boolean' },
        showDisclaimer: { type: 'boolean' },
        bpmLookupOnline: { type: 'boolean' },
        getSongBpmApiKey: { type: 'string' },
      },
    });

    this.defaults = defaults;
  }

  /**
   * Get a single setting value.
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    return this.store.get(key);
  }

  /**
   * Set a single setting value.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.store.set(key, value);
  }

  /**
   * Get all settings as a plain object.
   * @returns {object}
   */
  getAll() {
    return this.store.store;
  }

  /**
   * Bulk-set multiple settings at once.
   * @param {object} settings — key-value pairs to save
   */
  setAll(settings) {
    for (const [key, value] of Object.entries(settings)) {
      this.store.set(key, value);
    }
  }

  /**
   * Reset all settings back to defaults.
   */
  reset() {
    this.store.clear();
  }
}
