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
  showDisclaimer: true, // Show first-launch disclaimer
  // Set Extraction is still a beta feature (recognition is imperfect). Show a
  // one-time accuracy/in-development warning the first time the page is opened;
  // flipped to true once the user acknowledges it.
  extractionBetaAck: false,

  // ── Set Extraction (DJ-set tracklist identification) ──────────────────
  // There is deliberately no engine setting. SetEngine once offered AudD and
  // ACRCloud alongside Shazam; both were removed because they required an
  // account, an API key and per-request payment. Recognition is now Shazam only
  // (no key, no account, audio never uploaded), so there is nothing to choose
  // and no credentials to store.

  // Before recognizing anything, check whether the uploader already published a
  // tracklist as chapters or timestamped description lines. When they have, it's
  // exact and free and the audio never needs downloading. Off = always recognize.
  usePublishedTracklist: true,

  // Minimum match confidence (0–100) a recognized track must clear to be kept.
  // Shazam reports no score of its own, so the recognizer derives one from
  // corroboration: 70 for a track heard at one point in the set, 95 for one
  // heard at two independent points. Raising this above 80 therefore keeps only
  // corroborated tracks. Higher = fewer wrong tracks, more genuine misses.
  recognizerMinConfidence: 60,
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
        showDisclaimer: { type: 'boolean' },
        extractionBetaAck: { type: 'boolean' },
        usePublishedTracklist: { type: 'boolean' },
        recognizerMinConfidence: { type: 'number', minimum: 0, maximum: 100 },
      },
    });

    this.defaults = defaults;

    // One-time cleanup for anyone upgrading from a build that had the AudD /
    // ACRCloud engines. Two of these are *user credentials* sitting in a
    // plaintext JSON file; now that no code path can use them, leaving them on
    // disk would be a stale secret and nothing else. `recognizer` goes too —
    // there is only one engine, so a persisted choice could only ever name one
    // that no longer exists.
    for (const key of ['recognizer', 'auddApiToken', 'acrHost', 'acrAccessKey', 'acrAccessSecret']) {
      if (this.store.has(key)) this.store.delete(key);
    }
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
