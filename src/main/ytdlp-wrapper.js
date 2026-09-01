// =============================================================================
// ytdlp-wrapper.js — Manages yt-dlp binary interaction
// Detects system-installed yt-dlp/ffmpeg, spawns child processes for downloads,
// parses progress output, and supports cancellation.
// =============================================================================

import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeFilenameTemplate } from './filename-template.js';

/**
 * Turn raw yt-dlp stderr into a short, actionable message when we recognize the
 * failure mode. SABR / "Requested format is not available" almost always means
 * the user's yt-dlp is too old for YouTube's current streaming protocol.
 * "Video unavailable" / "Private video" mean the video itself can't be fetched
 * by this account — not fixable from our side, but worth phrasing clearly.
 */
// yt-dlp reports an external-downloader failure as "aria2c exited with code N".
// 22 is aria2c's "bad or unexpected HTTP response header", which is what YouTube
// triggers, but any non-zero code means the accelerator is the problem.
const ARIA2C_FAILURE = /aria2c exited with code/i;

function translateYtDlpError(code, stderr) {
  const text = (stderr || '').trim();

  if (/Signature extraction failed|forcing SABR streaming|Requested format is not available|Only images are available/i.test(text)) {
    return 'YouTube changed their streaming protocol and your yt-dlp can\'t extract audio. Update it: `brew upgrade yt-dlp` or `pip install -U yt-dlp`, then retry.';
  }

  // Try to extract the video ID that yt-dlp namespaces its error lines with
  const idMatch = text.match(/\[youtube\][^\]]*?\s([A-Za-z0-9_-]{11}):/);
  const id = idMatch ? idMatch[1] : null;
  const label = id ? `${id}` : 'This video';

  if (/Sign in to confirm your age/i.test(text)) {
    return `${label} is age-restricted and can't be downloaded without an authenticated session.`;
  }
  if (/Private video/i.test(text)) {
    return `${label} is a private video and can't be downloaded.`;
  }
  if (/members[- ]only/i.test(text)) {
    return `${label} is members-only and can't be downloaded.`;
  }
  if (/Video unavailable|This video is not available/i.test(text)) {
    return `${label} is unavailable (removed, region-locked, or restricted).`;
  }
  if (/Sign in to confirm you[’']?re not a bot/i.test(text)) {
    return 'YouTube is challenging this request as a bot. Wait a minute and retry; if it persists, update yt-dlp.';
  }
  // download() retries without aria2c on this, so a user only reaches this text
  // if that retry failed too — meaning the accelerator wasn't the real problem.
  if (ARIA2C_FAILURE.test(text)) {
    return `${label} couldn't be downloaded — the download helper was rejected by the server. Retry in a moment; if it persists, update yt-dlp.`;
  }

  // A 403 on the media URL (as opposed to the metadata fetch, which succeeds) is
  // what a stale yt-dlp looks like now: it asks for a player client that can no
  // longer mint the GVS PO token YouTube requires, so the edge hands back a ~10 KB
  // preview and refuses everything beyond it. This is checked after the aria2c
  // branch on purpose — an aria2c 403 carries its own stderr shape and its own
  // retry, and should keep its own message. Left to fall through, this arrives as
  // the raw "unable to download video data: HTTP Error 403: Forbidden", which
  // reads like the video is broken and sends people hunting for another link.
  if (/HTTP Error 403|unable to download video data/i.test(text)) {
    return 'YouTube refused to serve the audio, which almost always means your yt-dlp is out of date. Update it: `brew upgrade yt-dlp` or `pip install -U yt-dlp`, then retry.';
  }

  // Fall through: strip warnings, surface the actual ERROR: line if there is one
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.find((l) => /^ERROR:/i.test(l));
  if (errorLine) {
    return `yt-dlp: ${errorLine.replace(/^ERROR:\s*/i, '')}`;
  }
  return `yt-dlp exited with code ${code}${text ? ': ' + text : ''}`;
}

// Minimum yt-dlp version we trust to handle YouTube's current streaming
// protocol (SABR, and now GVS PO tokens). Versions older than this fail on
// every YouTube video, in one of two ways: the older symptom is "Requested
// format is not available", the newer one is a 403 on the media URL itself.
// Measured 2026-08-24 on the same two videos: 2026.03.17 and 2026.07.04 both
// resolved a format fine and were then served only a ~10 KB preview, 403ing on
// any larger byte range; 2026.08.19 downloaded both in full. The 403 is the
// nastier symptom because extraction *looks* healthy right up until the bytes
// are requested, so keep this constant current — it is the only thing that
// tells the user their binary, not the video, is the problem.
const MIN_RECOMMENDED_YTDLP = '2026.08.19';

function parseYtdlpVersion(versionStr) {
  if (!versionStr) return null;
  const match = String(versionStr).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!match) return null;
  return parseInt(match[1], 10) * 10000 + parseInt(match[2], 10) * 100 + parseInt(match[3], 10);
}

/**
 * Wraps the system-installed yt-dlp binary.
 * The user is responsible for installing yt-dlp and ffmpeg on their own system.
 */
export default class YtDlpWrapper {
  constructor() {
    // Track active child processes for cancellation
    this.activeProcesses = new Map();
    // Populated by detectExternalDownloader(). When true, we route yt-dlp's
    // HTTP fetches through aria2c for multi-connection downloads.
    this.aria2cAvailable = false;
  }

  /**
   * One-shot check for aria2c on PATH. Called from main.js at startup so the
   * first download already knows whether to enable the external downloader.
   * @returns {Promise<boolean>}
   */
  async detectExternalDownloader() {
    const aria2c = await this.checkBinary('aria2c');
    this.aria2cAvailable = aria2c.available;
    return this.aria2cAvailable;
  }

  // ---------------------------------------------------------------------------
  // Dependency detection
  // ---------------------------------------------------------------------------

  /**
   * Check if a binary exists on the system PATH.
   * Uses `which` on macOS/Linux, `where` on Windows.
   * @param {string} binary — name of the binary (e.g. 'yt-dlp', 'ffmpeg')
   * @returns {Promise<{ available: boolean, path: string|null }>}
   */
  checkBinary(binary) {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, [binary], (error, stdout) => {
        if (error) {
          resolve({ available: false, path: null });
        } else {
          resolve({ available: true, path: stdout.trim().split('\n')[0] });
        }
      });
    });
  }

  /**
   * Check both yt-dlp and ffmpeg availability.
   * @returns {Promise<{ ytdlp: { available, path }, ffmpeg: { available, path } }>}
   */
  async checkDependencies() {
    const [ytdlp, ffmpeg] = await Promise.all([
      this.checkBinary('yt-dlp'),
      this.checkBinary('ffmpeg'),
    ]);
    return { ytdlp, ffmpeg };
  }

  /**
   * Run `yt-dlp --version` and return the trimmed version string (e.g. "2025.09.26"),
   * or null if yt-dlp isn't available or the call fails.
   * @returns {Promise<string|null>}
   */
  getVersion() {
    return new Promise((resolve) => {
      execFile('yt-dlp', ['--version'], { timeout: 5_000 }, (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /**
   * Return a health report for the installed yt-dlp.
   * `outdated: true` means the version is older than the SABR-safe baseline;
   * `outdated: null` means we couldn't determine the version (unparseable / missing).
   * @returns {Promise<{ version: string|null, outdated: boolean|null, recommendedMin: string }>}
   */
  async getHealth() {
    const version = await this.getVersion();
    const current = parseYtdlpVersion(version);
    const minimum = parseYtdlpVersion(MIN_RECOMMENDED_YTDLP);
    let outdated = null;
    if (current !== null && minimum !== null) {
      outdated = current < minimum;
    }
    return {
      version,
      outdated,
      recommendedMin: MIN_RECOMMENDED_YTDLP,
      aria2c: this.aria2cAvailable,
    };
  }

  // ---------------------------------------------------------------------------
  // yt-dlp self-update
  // ---------------------------------------------------------------------------

  /**
   * Run `yt-dlp --update` and return the output.
   * When yt-dlp was installed via a package manager (pip, Homebrew, source, etc.)
   * the binary refuses to self-update — we surface that as an Error with
   * `err.managedInstall === true` so callers can downgrade it to a notice.
   * @returns {Promise<string>} — stdout from the update command
   */
  update() {
    return new Promise((resolve, reject) => {
      execFile('yt-dlp', ['--update'], { timeout: 60_000 }, (error, stdout, stderr) => {
        if (error) {
          const output = `${stderr || ''}${stdout || ''}`;
          const err = new Error(`yt-dlp update failed: ${(stderr || error.message).trim()}`);
          if (/You installed yt-dlp|Can't update when running from source/i.test(output)) {
            err.managedInstall = true;
          }
          reject(err);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Automatic update — detects the install method and runs the right command
  // ---------------------------------------------------------------------------

  /**
   * Inspect the system to figure out how yt-dlp was installed.
   * Returns one of: 'missing', 'homebrew', 'pipx', 'pip', 'standalone'.
   * For 'pip' the resolved python interpreter is included.
   * @returns {Promise<{ method: string, path?: string, python?: string }>}
   */
  async detectInstallMethod() {
    const { ytdlp } = await this.checkDependencies();
    if (!ytdlp.available) return { method: 'missing' };

    const binPath = ytdlp.path;

    // Homebrew is the most authoritative signal on macOS — brew installs yt-dlp
    // as a Python wrapper script, so the shebang check below would otherwise
    // misclassify it as a plain pip install.
    if (await this._brewOwnsYtdlp()) {
      return { method: 'homebrew', path: binPath };
    }

    // Python-script install: pipx or plain pip
    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(binPath, 'utf-8');
      const firstLine = (content.split('\n')[0] || '').trim();
      const python = this._extractPythonFromShebang(firstLine);
      if (python) {
        if (/pipx/i.test(python) || /pipx/i.test(binPath)) {
          return { method: 'pipx', path: binPath };
        }
        return { method: 'pip', path: binPath, python };
      }
    } catch (_) {
      // Not a readable text file — probably the real standalone binary
    }

    return { method: 'standalone', path: binPath };
  }

  /**
   * Run whichever update command matches how yt-dlp was installed.
   * Resolves with the command's stdout (a short status string).
   * Rejects with an Error whose message is the command's stderr.
   * @returns {Promise<string>}
   */
  async runAutomaticUpdate() {
    const info = await this.detectInstallMethod();
    switch (info.method) {
      case 'missing':
        throw new Error('yt-dlp is not installed. Install it with `brew install yt-dlp` (or `pip install yt-dlp`), then restart SetEngine.');
      case 'homebrew':
        return this._runCommand('brew', ['upgrade', 'yt-dlp'], 180_000);
      case 'pipx':
        return this._runCommand('pipx', ['upgrade', 'yt-dlp'], 180_000);
      case 'pip':
        return this._updateViaPip(info.python);
      case 'standalone':
        return this._runCommand('yt-dlp', ['-U'], 180_000);
      default:
        throw new Error('Could not determine yt-dlp install method.');
    }
  }

  _brewOwnsYtdlp() {
    return new Promise((resolve) => {
      execFile('brew', ['list', '--versions', 'yt-dlp'], { timeout: 3_000 }, (error, stdout) => {
        resolve(!error && stdout.trim().length > 0);
      });
    });
  }

  _extractPythonFromShebang(firstLine) {
    if (!firstLine.startsWith('#!')) return null;
    const parts = firstLine.slice(2).trim().split(/\s+/);
    for (const part of parts) {
      if (/python/i.test(part)) return part;
    }
    return null;
  }

  /**
   * Run a command via execFile with a timeout. Throws on non-zero exit with the
   * stderr text as the message (or the OS-level error message if stderr is empty).
   * @returns {Promise<string>}
   */
  _runCommand(cmd, args, timeout) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || '').trim() || 'Command failed'));
        } else {
          resolve(stdout.trim() || 'Update complete.');
        }
      });
    });
  }

  /**
   * pip update with a PEP 668 retry. Newer Pythons reject pip writes into the
   * system environment unless --break-system-packages is passed.
   */
  async _updateViaPip(python) {
    const base = ['-m', 'pip', 'install', '-U', 'yt-dlp'];
    try {
      return await this._runCommand(python, base, 180_000);
    } catch (err) {
      if (/externally-managed-environment|--break-system-packages/i.test(err.message)) {
        return this._runCommand(python, ['-m', 'pip', 'install', '-U', '--break-system-packages', 'yt-dlp'], 180_000);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Command argument builders
  // ---------------------------------------------------------------------------

  /**
   * Build arguments for downloading a single song as MP3.
   * @param {object} opts
   * @param {string} opts.url            — YouTube URL
   * @param {string} opts.outputFolder   — destination folder
   * @param {number} opts.bitrate        — audio quality in kbps (128, 192, 320)
   * @param {string} [opts.cookiePath]   — path to Netscape cookie file
   * @param {string} [opts.filenameTemplate] — yt-dlp output template (default: %(title)s)
   * @returns {string[]}
   */
  buildSongArgs({ url, outputFolder, bitrate = 320, cookiePath, filenameTemplate = '%(title)s', useAria2c = this.aria2cAvailable }) {
    const args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', `${bitrate}K`,
      '--embed-metadata',
      '--embed-thumbnail',
      '--convert-thumbnails', 'jpg',
      '--newline',
      '--extractor-args', 'youtube:player_client=default,web_safari,tv,mweb',
      '--concurrent-fragments', '4',
    ];

    if (useAria2c) {
      args.push('--downloader', 'aria2c');
      args.push('--downloader-args', 'aria2c:-x 16 -s 16 -k 1M --console-log-level=warn --summary-interval=0');
    }

    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }

    const safeTemplate = sanitizeFilenameTemplate(filenameTemplate);
    const outputTemplate = path.join(outputFolder, `${safeTemplate}.%(ext)s`);
    args.push('-o', outputTemplate);

    args.push(url);
    return args;
  }

  /**
   * Build arguments for extracting playlist metadata (flat, no download).
   * @param {object} opts
   * @param {string} opts.url          — playlist URL
   * @param {string} [opts.cookiePath] — path to Netscape cookie file
   * @returns {string[]}
   */
  buildPlaylistInfoArgs({ url, cookiePath }) {
    const args = [
      '--flat-playlist',
      '--dump-single-json',
    ];

    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }

    args.push(url);
    return args;
  }

  /**
   * Build arguments for extracting info about a single URL (no download).
   * @param {object} opts
   * @param {string} opts.url          — YouTube URL
   * @param {string} [opts.cookiePath] — path to Netscape cookie file
   * @param {boolean} [opts.withComments] — also fetch top-level comments
   * @returns {string[]}
   */
  buildUrlInfoArgs({ url, cookiePath, withComments }) {
    const args = [
      '--dump-single-json',
      '--no-download',
    ];

    // Comments are a separate, much slower pass (a distinct paginated endpoint),
    // so they are opt-in: Set Extraction only asks once chapters and description
    // have both come up empty. Sorted by top and capped, because a tracklist
    // comment is invariably one of the most-upvoted ones and pulling thousands of
    // replies would cost minutes for nothing.
    if (withComments) {
      args.push('--write-comments');
      args.push('--extractor-args', 'youtube:comment_sort=top;max_comments=80,all,80,0');
    }

    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }

    args.push(url);
    return args;
  }

  async getVideoInfo(url, cookiePath, opts = {}) {
    const args = this.buildUrlInfoArgs({ url, cookiePath, withComments: opts.withComments });
    return this.executeJson(args, { timeoutMs: opts.timeoutMs || 0, signal: opts.signal || null });
  }

  async getPlaylistInfo(url, cookiePath) {
    const args = this.buildPlaylistInfoArgs({ url, cookiePath });
    return this.executeJson(args);
  }

  async getAudioStreamUrl(query, cookiePath = null) {
    const args = [
      '-f', 'bestaudio',
      '-g',
      '--no-playlist',
      '--no-warnings',
    ];
    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }
    args.push('ytsearch1:' + query);

    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let stderrBuf = '';

      proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          const streamUrl = stdoutBuf.trim().split('\n')[0];
          if (streamUrl) {
            resolve(streamUrl);
          } else {
            reject(new Error('yt-dlp returned no URL'));
          }
        } else {
          reject(new Error(('yt-dlp stream resolve failed (code ' + code + '): ' + stderrBuf.slice(0, 300)).trim()));
        }
      });

      proc.on('error', (err) => reject(new Error('Failed to start yt-dlp: ' + err.message)));
    });
  }

  /**
   * Run `yt-dlp <target> --flat-playlist --dump-json` and return the parsed
   * NDJSON entries.
   *
   * Returns `{ ok, entries }`, and the distinction is load-bearing: a search
   * that *failed* (timeout, throttling, yt-dlp missing) must not look identical
   * to a search that genuinely found nothing. It used to resolve `[]` for both,
   * which was harmless while YouTube was the only source — but once
   * `track-match.js` gained a SoundCloud fallback, a throttled YouTube search
   * silently became "YouTube doesn't have this track", and the fallback fired
   * for tracks YouTube had all along. Measured during a heavy concurrent run,
   * that pushed 56 of 159 tracks onto SoundCloud and wrecked both quality and
   * accuracy. The caller now retries instead.
   *
   * @param {string} target — a search URL or `ytsearchN:` expression
   * @returns {Promise<{ ok: boolean, entries: object[] }>}
   */
  _flatSearch(target, extraArgs = []) {
    const args = [target, '--flat-playlist', '--dump-json', '--no-warnings', ...extraArgs];
    return new Promise((resolve) => {
      let stdoutBuf = '';
      let proc = null;
      let settled = false;
      const finish = (val) => { if (settled) return; settled = true; clearTimeout(timer); resolve(val); };
      // A hung yt-dlp (network stall) would otherwise leave this promise pending
      // forever and block the track that's awaiting it (and a slot in the cache
      // download loop). Kill it after a bound; that counts as a failure, not as
      // an empty result.
      const timer = setTimeout(() => {
        try { if (proc) proc.kill('SIGKILL'); } catch (_) { /* gone */ }
        finish({ ok: false, entries: [] });
      }, 20000);
      try {
        proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (_) {
        finish({ ok: false, entries: [] });
        return;
      }
      proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
      proc.stderr.on('data', () => { /* search is best-effort; ignore stderr */ });
      proc.on('error', () => finish({ ok: false, entries: [] }));
      proc.on('close', (code) => {
        const out = [];
        for (const line of stdoutBuf.split('\n')) {
          const s = line.trim();
          if (!s) continue;
          try { out.push(JSON.parse(s)); } catch (_) { /* skip bad line */ }
        }
        // A clean exit with zero results is a real "nothing found". A non-zero
        // exit that produced nothing is a failure worth retrying.
        finish({ ok: code === 0 || out.length > 0, entries: out });
      });
    });
  }

  /**
   * Search YouTube *Music* and return the top song results in rank order, as
   * `{ id, url, title }`. YT Music's catalog is songs (not reactions, sped-up
   * edits, multi-hour mixes, or wrong-artist uploads that pollute general
   * youtube.com search), so its top hits are reliably the right track. Results
   * interleave playable songs (`ie_key: "Youtube"`) with album/artist/playlist
   * browse pages (`ie_key: "YoutubeTab"`) — we keep only the former. Flat
   * entries carry no duration/channel, so callers match on title, not metadata.
   * @param {string} query
   * @param {number} [limit=5]
   * @returns {Promise<Array<{ id, url, title }>>}
   */
  async searchMusic(query, limit = 5) {
    const n = Math.max(1, Math.min(20, Number(limit) || 5));
    // The music.youtube.com search URL carries no result cap, so bound it with
    // --playlist-end. We pull a few extra entries because YT Music interleaves
    // non-song `YoutubeTab` browse pages we filter out below. (Songs only.)
    const { ok, entries } = await this._flatSearch(
      `https://music.youtube.com/search?q=${encodeURIComponent(query)}`,
      ['--playlist-end', String(n * 3)],
    );
    const out = [];
    for (const e of entries) {
      if (!e || !e.id || e.ie_key !== 'Youtube') continue;   // songs only
      out.push({ id: e.id, url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title || '' });
      if (out.length >= n) break;
    }
    return { ok, results: out };
  }

  /**
   * Search SoundCloud (`scsearchN:`).
   *
   * This is the fallback that stops Set Extraction skipping tracks: SoundCloud
   * is where DJ culture actually lives — bootlegs, edits, white labels, promos
   * and remixes that were never released to a streaming catalogue and therefore
   * do not exist on YouTube at all. Measured, it carries tracks YouTube simply
   * doesn't have (e.g. "Traumer — Agenou (Y.M.O. Remix)").
   *
   * Unlike YouTube, SoundCloud's `--flat-playlist` output is FULLY populated —
   * title, track, uploader, duration, genre — so candidates can be verified
   * without paying for a second metadata fetch each.
   *
   * Returns the same `{ id, url, title }` shape as the YouTube searches, plus
   * the metadata fields, so `track-match.js` can treat every provider alike.
   * `webpage_url` is used rather than `url`, because the latter is an
   * api.soundcloud.com address that isn't a downloadable page.
   * @param {string} query
   * @param {number} [limit=5]
   * @returns {Promise<Array<{ id, url, title, uploader, duration }>>}
   */
  async searchSoundCloud(query, limit = 5) {
    const n = Math.max(1, Math.min(20, Number(limit) || 5));
    const { ok, entries } = await this._flatSearch(`scsearch${n}:${query}`);
    const out = [];
    for (const e of entries) {
      const url = e && (e.webpage_url || e.url);
      if (!e || !url || !/soundcloud\.com/.test(url)) continue;
      out.push({
        id: String(e.id || ''),
        url,
        title: e.title || e.track || '',
        track: e.track || '',
        uploader: e.uploader || '',
        duration: Number(e.duration) || 0,
        provider: 'soundcloud',
        // Flat SoundCloud results are complete enough to verify as-is.
        prefetched: true,
      });
      if (out.length >= n) break;
    }
    return { ok, results: out };
  }

  /**
   * Search general YouTube (`ytsearchN:`) and return the top results as
   * `{ id, url, title }`. Used as the fallback when YouTube Music has no
   * title-matching result.
   * @param {string} query
   * @param {number} [limit=5]
   * @returns {Promise<Array<{ id, url, title }>>}
   */
  async searchYouTube(query, limit = 5) {
    const n = Math.max(1, Math.min(20, Number(limit) || 5));
    const { ok, entries } = await this._flatSearch(`ytsearch${n}:${query}`);
    const out = [];
    for (const e of entries) {
      // Keep only playable videos. ytsearch normally returns videos, but guard
      // against the odd non-video entry (whose id wouldn't form a watch URL),
      // mirroring searchMusic's filter. ie_key may be absent on some yt-dlp
      // builds — accept those by id alone.
      if (!e || !e.id) continue;
      if (e.ie_key && e.ie_key !== 'Youtube') continue;
      out.push({ id: e.id, url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title || '' });
      if (out.length >= n) break;
    }
    return { ok, results: out };
  }

  /**
   * Download one track, transparently retrying without aria2c if the accelerator
   * is what failed.
   *
   * aria2c is *only* a speed optimization, so a download must never fail because
   * of it. YouTube periodically serves media URLs that aria2c can't handle — its
   * multi-connection range requests come back with a response aria2c refuses to
   * parse, and yt-dlp surfaces the opaque "aria2c exited with code 22" (its code
   * for a bad/unexpected HTTP response header). It's intermittent and
   * video-specific: the same args succeed on most videos and fail on others.
   *
   * Rather than try to predict which URLs are affected, fall back to yt-dlp's
   * own downloader on any aria2c-class failure. The user loses a little speed on
   * that track instead of losing the track.
   */
  download(url, outputFolder, options = {}) {
    const id = crypto.randomUUID();
    const emitter = new EventEmitter();
    let cancelled = false;
    let inner = null;

    const attempt = (useAria2c) => {
      const args = this.buildSongArgs({
        url,
        outputFolder,
        cookiePath: options.cookiePath,
        bitrate: options.bitrate || 320,
        filenameTemplate: options.filenameTemplate || '%(title)s',
        useAria2c,
      });
      inner = this.execute(args, id);
      inner.on('progress', (p) => emitter.emit('progress', p));
      inner.on('complete', (c) => emitter.emit('complete', c));
      inner.on('error', (err) => {
        // Only retry the accelerator's own failure, only once, and never after
        // the user cancelled.
        if (!cancelled && useAria2c && ARIA2C_FAILURE.test(err.stderr || '')) {
          this._noteAria2cFailure(url);
          attempt(false);
          return;
        }
        emitter.emit('error', err);
      });
    };

    attempt(this.aria2cAvailable);

    emitter.cancel = () => {
      cancelled = true;
      if (inner) inner.cancel();
    };
    return emitter;
  }

  // Two aria2c failures in a session means it isn't working here (a proxy, a
  // filtering network, an aria2c build YouTube dislikes). Stop paying the cost
  // of a doomed first attempt on every subsequent track.
  _noteAria2cFailure(url) {
    this._aria2cFailures = (this._aria2cFailures || 0) + 1;
    console.warn(`[SetEngine] aria2c failed on ${url} — retrying with yt-dlp's built-in downloader.`);
    if (this._aria2cFailures >= 2 && this.aria2cAvailable) {
      this.aria2cAvailable = false;
      console.warn('[SetEngine] aria2c has failed twice; disabling it for the rest of this session. Downloads continue at normal speed.');
    }
  }

  // ---------------------------------------------------------------------------
  // Process execution
  // ---------------------------------------------------------------------------

  /**
   * Spawn yt-dlp and return an EventEmitter that fires:
   *   'progress' — { percent, size, speed, eta }
   *   'complete' — { code }
   *   'error'    — Error
   *
   * The returned emitter also has a `cancel()` method to kill the process.
   *
   * @param {string[]} args — yt-dlp arguments
   * @param {string}   id   — unique download ID (for tracking / cancellation)
   * @returns {EventEmitter & { cancel: Function }}
   */
  execute(args, id) {
    const emitter = new EventEmitter();
    const proc = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Store for cancellation
    this.activeProcesses.set(id, proc);

    let stderrBuffer = '';

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const progress = this._parseProgressLine(line);
        if (progress) {
          emitter.emit('progress', progress);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
    });

    proc.on('close', (code) => {
      this.activeProcesses.delete(id);
      if (code === 0) {
        emitter.emit('complete', { code });
      } else {
        const err = new Error(translateYtDlpError(code, stderrBuffer));
        // The message is deliberately rewritten for humans, which destroys the
        // strings a caller would need to classify the failure. Keep the raw
        // output on the error so `download()` can still detect an aria2c
        // failure and retry without it.
        err.stderr = stderrBuffer;
        err.exitCode = code;
        emitter.emit('error', err);
      }
    });

    proc.on('error', (err) => {
      this.activeProcesses.delete(id);
      emitter.emit('error', err);
    });

    // Attach cancel helper
    emitter.cancel = () => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        this.activeProcesses.delete(id);
      }
    };

    return emitter;
  }

  /**
   * Execute yt-dlp and collect all stdout as a single string (for JSON output).
   * Used for --dump-single-json commands.
   * @param {string[]} args — yt-dlp arguments
   * @returns {Promise<object>} — parsed JSON from stdout
   */
  /**
   * Run yt-dlp and parse its JSON output.
   *
   * `timeoutMs` and `signal` are optional and exist for the slow optional passes
   * (notably `--write-comments`, which paginates a separate endpoint): without a
   * bound, a stalled fetch would hang an extraction job forever with no way to
   * cancel it.
   */
  executeJson(args, { timeoutMs = 0, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(arg);
      };
      const kill = () => { try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ } };
      const onAbort = () => { kill(); finish(reject, new Error('Cancelled.')); };
      const timer = timeoutMs
        ? setTimeout(() => { kill(); finish(reject, new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs)
        : null;
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            finish(resolve, JSON.parse(stdoutBuffer));
          } catch (parseErr) {
            finish(reject, new Error(`Failed to parse yt-dlp JSON output: ${parseErr.message}`));
          }
        } else {
          finish(reject, new Error(
            `yt-dlp exited with code ${code}${stderrBuffer ? ': ' + stderrBuffer.trim() : ''}`
          ));
        }
      });

      proc.on('error', (err) => finish(reject, err));
    });
  }

  /**
   * Cancel a running download by its ID.
   * @param {string} id — download ID
   * @returns {boolean} — true if the process was found and killed
   */
  cancel(id) {
    const proc = this.activeProcesses.get(id);
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      this.activeProcesses.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Kill every in-flight yt-dlp child immediately. Called on app quit, where a
   * hard process exit would otherwise orphan running yt-dlp (and its
   * ffmpeg/aria2c) children. Uses SIGKILL since the app is terminating and we
   * want a hard guarantee no downloader process survives.
   */
  killAll() {
    for (const proc of this.activeProcesses.values()) {
      try {
        if (proc && !proc.killed) proc.kill('SIGKILL');
      } catch (_) { /* already exited */ }
    }
    this.activeProcesses.clear();
  }

  // ---------------------------------------------------------------------------
  // Progress parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse a yt-dlp progress line.
   * Example: `[download]  45.2% of ~4.53MiB at 1.23MiB/s ETA 00:03`
   * @param {string} line
   * @returns {{ percent: number, size: string, speed: string, eta: string }|null}
   */
  _parseProgressLine(line) {
    // Match lines like: [download]  45.2% of ~4.53MiB at 1.23MiB/s ETA 00:03
    const match = line.match(
      /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\S+)\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/
    );
    if (match) {
      return {
        percent: parseFloat(match[1]),
        size: match[2],
        speed: match[3],
        eta: match[4],
      };
    }

    // Also match completion line: [download] 100% of 4.53MiB in 00:03
    const doneMatch = line.match(
      /\[download\]\s+100%\s+of\s+~?([\d.]+\S+)/
    );
    if (doneMatch) {
      return {
        percent: 100,
        size: doneMatch[1],
        speed: null,
        eta: null,
      };
    }

    return null;
  }
}
