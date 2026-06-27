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
  // Which fingerprinting engine the Set Extraction page uses. Both need an API
  // key (set below); neither works offline — song identification requires a
  // reference database we don't ship.
  recognizer: 'audd',           // 'audd' | 'acrcloud'
  // AudD enterprise endpoint token (https://dashboard.audd.io). One request is
  // billed per 12 s of audio; the first 300 are free.
  auddApiToken: '',
  // ACRCloud project credentials (https://console.acrcloud.com). The host is the
  // project's identification endpoint, e.g. "identify-eu-west-1.acrcloud.com".
  acrHost: '',
  acrAccessKey: '',
  acrAccessSecret: '',
  // Minimum match confidence (0–100) a recognized track must clear to be kept.
  // ACRCloud reports a per-match `score` we threshold on directly, so this is
  // the main defense against false positives (the "old jazz song in a techno
  // set" problem). AudD doesn't always return a score; when it doesn't, this is
  // a no-op for AudD and the YouTube candidate validation in set-extractor.js
  // carries precision instead. Higher = fewer wrong tracks, more genuine misses.
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
        recognizer: { type: 'string', enum: ['audd', 'acrcloud'] },
        auddApiToken: { type: 'string' },
        acrHost: { type: 'string' },
        acrAccessKey: { type: 'string' },
        acrAccessSecret: { type: 'string' },
        recognizerMinConfidence: { type: 'number', minimum: 0, maximum: 100 },
      },
    });

    this.defaults = defaults;
  }

  // Credential fields are trimmed on the way in: a trailing space pasted into an
  // API token/key/secret/host would otherwise silently 401 every recognition with
  // no obvious cause.
  _normalize(key, value) {
    const CREDENTIAL_KEYS = new Set(['auddApiToken', 'acrHost', 'acrAccessKey', 'acrAccessSecret']);
    if (CREDENTIAL_KEYS.has(key) && typeof value === 'string') return value.trim();
    return value;
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
    this.store.set(key, this._normalize(key, value));
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
      this.store.set(key, this._normalize(key, value));
    }
  }

  /**
   * Reset all settings back to defaults.
   */
  reset() {
    this.store.clear();
  }
}
