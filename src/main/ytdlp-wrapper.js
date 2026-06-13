// =============================================================================
// ytdlp-wrapper.js — Manages yt-dlp binary interaction
// Detects system-installed yt-dlp/ffmpeg, spawns child processes for downloads,
// parses progress output, and supports cancellation.
// =============================================================================

import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Turn raw yt-dlp stderr into a short, actionable message when we recognize the
 * failure mode. SABR / "Requested format is not available" almost always means
 * the user's yt-dlp is too old for YouTube's current streaming protocol.
 * "Video unavailable" / "Private video" mean the video itself can't be fetched
 * by this account — not fixable from our side, but worth phrasing clearly.
 */
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
    return `${label} is age-restricted. Sign in to YouTube Music in the browser tab and retry.`;
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
    return 'YouTube is challenging this request as a bot. Sign in to YouTube Music in the browser tab and retry.';
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
// protocol (SABR). Versions older than this almost certainly produce the
// "Requested format is not available" failure on every YouTube video.
// Update this constant as new yt-dlp baselines emerge.
const MIN_RECOMMENDED_YTDLP = '2025.09.05';

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  // Prefer a medium-resolution thumbnail. First is usually lowest res, last
  // highest; pick something around 1/3 to keep modal sharp without bloat.
  const idx = Math.min(thumbnails.length - 1, Math.floor(thumbnails.length / 3));
  return thumbnails[idx]?.url || thumbnails[0]?.url || null;
}

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
  buildSongArgs({ url, outputFolder, bitrate = 320, cookiePath, filenameTemplate = '%(title)s' }) {
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

    if (this.aria2cAvailable) {
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
   * @returns {string[]}
   */
  buildUrlInfoArgs({ url, cookiePath }) {
    const args = [
      '--dump-single-json',
      '--no-download',
    ];

    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }

    args.push(url);
    return args;
  }

  async getVideoInfo(url, cookiePath) {
    const args = this.buildUrlInfoArgs({ url, cookiePath });
    return this.executeJson(args);
  }

  /**
   * Search YouTube and return up to `count` results as a normalized list.
   * Uses yt-dlp's `ytsearchN:` virtual playlist with --flat-playlist so we get
   * fast metadata (title / duration / channel / thumbnail) without doing a
   * full per-video extract.
   * @param {string} query
   * @param {number} count — number of results to return (1–20)
   * @returns {Promise<Array<{id: string, url: string, title: string, channel: string, duration: number|null, thumbnail: string|null}>>}
   */
  async searchYouTube(query, count = 5) {
    const safeCount = Math.max(1, Math.min(20, parseInt(count, 10) || 5));
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      `ytsearch${safeCount}:${query}`,
    ];
    const result = await this.executeJson(args);
    const entries = (result && result.entries) || [];
    return entries
      .filter((e) => e && e.id)
      .map((entry) => ({
        id: entry.id,
        url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
        title: entry.title || 'Unknown',
        channel: entry.uploader || entry.channel || entry.uploader_id || '',
        duration: typeof entry.duration === 'number' ? entry.duration : null,
        thumbnail: pickThumbnail(entry.thumbnails) || (entry.thumbnail || null),
      }));
  }

  async getPlaylistInfo(url, cookiePath) {
    const args = this.buildPlaylistInfoArgs({ url, cookiePath });
    return this.executeJson(args);
  }

  download(url, outputFolder, options = {}) {
    const args = this.buildSongArgs({
      url,
      outputFolder,
      cookiePath: options.cookiePath,
      bitrate: options.bitrate || 320,
      filenameTemplate: options.filenameTemplate || '%(title)s'
    });
    const id = crypto.randomUUID();
    return this.execute(args, id);
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
        emitter.emit('error', new Error(translateYtDlpError(code, stderrBuffer)));
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
  executeJson(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(stdoutBuffer));
          } catch (parseErr) {
            reject(new Error(`Failed to parse yt-dlp JSON output: ${parseErr.message}`));
          }
        } else {
          reject(new Error(
            `yt-dlp exited with code ${code}${stderrBuffer ? ': ' + stderrBuffer.trim() : ''}`
          ));
        }
      });

      proc.on('error', (err) => reject(err));
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

function sanitizeFilenameTemplate(template) {
  let s = String(template || '%(title)s');
  s = s.replace(/[^a-zA-Z0-9_\-%\(\)s]/g, '');
  if (!s || s.length === 0) return '%(title)s';
  return s;
}
