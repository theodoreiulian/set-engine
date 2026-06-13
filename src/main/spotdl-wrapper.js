// =============================================================================
// spotdl-wrapper.js — Manages the spotdl binary
// spotdl resolves Spotify URLs to YouTube matches and downloads via yt-dlp /
// ffmpeg under the hood. We treat it as an opaque sibling to YtDlpWrapper:
// same surface (download / getHealth / detectInstallMethod / runAutomaticUpdate
// / getTrackInfo / getPlaylistInfo) and the same EventEmitter shape on download
// so DownloadManager doesn't need to branch on engine.
// =============================================================================

import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Minimum spotdl version we trust. spotdl's older releases sometimes hardwire
// out-of-date yt-dlp expectations and fail across the board. Bump as needed.
const MIN_RECOMMENDED_SPOTDL = '4.2.0';

function parseSpotdlVersion(versionStr) {
  if (!versionStr) return null;
  const match = String(versionStr).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return parseInt(match[1], 10) * 1_000_000 + parseInt(match[2], 10) * 1000 + parseInt(match[3], 10);
}

/**
 * Translate raw spotdl stderr/stdout into a short, actionable message.
 */
function translateSpotdlError(code, output) {
  const text = (output || '').trim();

  if (/ffmpeg.+not\s+found/i.test(text) || /missing ffmpeg/i.test(text)) {
    return 'ffmpeg is not installed or not on PATH. Install it (`brew install ffmpeg` or `apt install ffmpeg`) and retry.';
  }
  if (/Invalid URL|could not parse/i.test(text)) {
    return 'spotdl did not recognise that URL. Make sure it points to an open.spotify.com track, album, or playlist.';
  }
  if (/Rate ?limit|429|Too Many Requests/i.test(text)) {
    return 'spotdl is being rate-limited by Spotify or YouTube. Wait a minute and retry.';
  }
  if (/No matches? found|Could not find/i.test(text)) {
    return 'spotdl could not find a YouTube match for that Spotify track. The track may be region-locked or too obscure.';
  }
  if (/Region|geo[- ]?block/i.test(text)) {
    return 'This track appears to be region-locked. Try with a VPN to a different country.';
  }

  // Generic ERROR: line surfacing
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.find((l) => /error/i.test(l));
  if (errorLine) {
    return `spotdl: ${errorLine.replace(/^[\[\(]?error[\]\):]?\s*/i, '')}`;
  }
  return `spotdl exited with code ${code}${text ? ': ' + text.slice(0, 400) : ''}`;
}

/**
 * Wraps the system-installed spotdl binary.
 */
export default class SpotdlWrapper {
  constructor() {
    this.activeProcesses = new Map();
  }

  // ---------------------------------------------------------------------------
  // Dependency detection
  // ---------------------------------------------------------------------------

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
   * Run `spotdl --version` and return the trimmed version string,
   * or null if spotdl isn't available or the call fails.
   */
  getVersion() {
    return new Promise((resolve) => {
      execFile('spotdl', ['--version'], { timeout: 8_000 }, (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          // spotdl may print extra setup lines on first run; pick the line that
          // looks like a version.
          const lines = (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
          const versionLine = lines.find((l) => /^\d+\.\d+\.\d+/.test(l));
          resolve(versionLine || lines[lines.length - 1] || null);
        }
      });
    });
  }

  /**
   * Health report. `outdated: true` means the version is older than
   * MIN_RECOMMENDED_SPOTDL; `null` when we couldn't determine the version.
   */
  async getHealth() {
    const version = await this.getVersion();
    const current = parseSpotdlVersion(version);
    const minimum = parseSpotdlVersion(MIN_RECOMMENDED_SPOTDL);
    let outdated = null;
    if (current !== null && minimum !== null) {
      outdated = current < minimum;
    }
    return {
      version,
      outdated,
      recommendedMin: MIN_RECOMMENDED_SPOTDL,
    };
  }

  // ---------------------------------------------------------------------------
  // Install method detection + automatic update
  // ---------------------------------------------------------------------------

  /**
   * Inspect the system to figure out how spotdl was installed.
   * Returns one of: 'missing', 'homebrew', 'pipx', 'pip', 'standalone'.
   * For 'pip' the resolved python interpreter is included.
   */
  async detectInstallMethod() {
    const { available, path: binPath } = await this.checkBinary('spotdl');
    if (!available) return { method: 'missing' };

    if (await this._brewOwnsSpotdl()) {
      return { method: 'homebrew', path: binPath };
    }

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
      // Not a readable text file — probably a frozen binary
    }

    return { method: 'standalone', path: binPath };
  }

  async runAutomaticUpdate() {
    const info = await this.detectInstallMethod();
    switch (info.method) {
      case 'missing':
        throw new Error('spotdl is not installed. Install it with `brew install spotdl` (or `pipx install spotdl`), then restart SetEngine.');
      case 'homebrew':
        return this._runCommand('brew', ['upgrade', 'spotdl'], 240_000);
      case 'pipx':
        return this._runCommand('pipx', ['upgrade', 'spotdl'], 240_000);
      case 'pip':
        return this._updateViaPip(info.python);
      case 'standalone':
        // No self-update path for frozen builds — point the user at the
        // appropriate package manager.
        throw new Error('This spotdl appears to be a standalone build with no self-update support. Reinstall via `brew install spotdl` or `pipx install spotdl` to get auto-update.');
      default:
        throw new Error('Could not determine spotdl install method.');
    }
  }

  _brewOwnsSpotdl() {
    return new Promise((resolve) => {
      execFile('brew', ['list', '--versions', 'spotdl'], { timeout: 3_000 }, (error, stdout) => {
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

  async _updateViaPip(python) {
    const base = ['-m', 'pip', 'install', '-U', 'spotdl'];
    try {
      return await this._runCommand(python, base, 240_000);
    } catch (err) {
      if (/externally-managed-environment|--break-system-packages/i.test(err.message)) {
        return this._runCommand(python, ['-m', 'pip', 'install', '-U', '--break-system-packages', 'spotdl'], 240_000);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Info queries
  // ---------------------------------------------------------------------------

  /**
   * Use `spotdl save <url> --save-file <tmp>.spotdl` to dump metadata as JSON.
   * We deliberately do NOT use `--save-file -` (stdout): spotdl interleaves
   * human-readable log chatter ("You might be blocked…", "Processing query…",
   * "Found N songs…") with the JSON on stdout, so parsing stdout directly
   * throws. Writing to a real .spotdl temp file gives us clean JSON, which we
   * read back and then delete.
   *
   * Spotdl writes a list of song objects (even for a single track URL).
   * Returns the parsed array or throws.
   * @param {string} url
   * @param {string} [cookiePath] — unused for spotdl public-content paths but
   *   accepted for parity with YtDlpWrapper
   * @returns {Promise<object[]>}
   */
  saveMetadata(url, cookiePath) { // eslint-disable-line no-unused-vars
    // spotdl requires the save file to end in .spotdl.
    const saveFile = path.join(os.tmpdir(), `setengine-${crypto.randomUUID()}.spotdl`);

    return new Promise((resolve, reject) => {
      const args = ['save', url, '--save-file', saveFile];
      const proc = spawn('spotdl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      proc.stdout.on('data', (chunk) => { stdoutBuffer += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderrBuffer += chunk.toString(); });

      const cleanup = () => fs.unlink(saveFile).catch(() => {});

      proc.on('close', async (code) => {
        if (code !== 0) {
          await cleanup();
          reject(new Error(translateSpotdlError(code, stderrBuffer || stdoutBuffer)));
          return;
        }
        try {
          const raw = await fs.readFile(saveFile, 'utf-8');
          const parsed = JSON.parse(raw);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (parseErr) {
          reject(new Error(`Failed to parse spotdl save JSON: ${parseErr.message}`));
        } finally {
          await cleanup();
        }
      });

      proc.on('error', async (err) => {
        await cleanup();
        reject(err);
      });
    });
  }

  /**
   * @returns {Promise<{ title: string, artists: string }>}
   */
  async getTrackInfo(url, cookiePath) {
    const entries = await this.saveMetadata(url, cookiePath);
    const first = entries[0] || {};
    const title = first.name || first.title || 'Unknown Track';
    const artists = Array.isArray(first.artists) ? first.artists.join(', ') : (first.artist || '');
    return { title: artists ? `${artists} — ${title}` : title, raw: first };
  }

  /**
   * Returns a yt-dlp-shaped { title, entries: [{ id, title, url }] } so
   * DownloadManager can treat YT and Spotify playlists symmetrically.
   */
  async getPlaylistInfo(url, cookiePath) {
    const entries = await this.saveMetadata(url, cookiePath);
    // spotdl save doesn't surface the playlist title separately — fall back to
    // the URL's last segment so the queue UI shows something meaningful.
    let title = 'Spotify Playlist';
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) title = `Spotify ${parts[0]} ${parts[1].slice(0, 8)}…`;
    } catch (_) { /* keep default */ }
    return {
      title,
      entries: entries.map((song) => {
        const artists = Array.isArray(song.artists) ? song.artists.join(', ') : (song.artist || '');
        const songTitle = song.name || song.title || 'Unknown Track';
        const trackUrl = song.url || (song.song_id ? `https://open.spotify.com/track/${song.song_id}` : url);
        return {
          id: song.song_id || song.id || trackUrl,
          title: artists ? `${artists} — ${songTitle}` : songTitle,
          url: trackUrl,
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  /**
   * Spawn `spotdl download` and return an EventEmitter that mirrors the
   * YtDlpWrapper shape:
   *   'progress' — { percent, size, speed, eta }
   *   'complete' — { code }
   *   'error'    — Error
   *
   * spotdl does not stream byte-accurate progress, so 'progress' fires at
   * milestones (Downloaded "…", Skipping "…") with percent computed from
   * completed tracks / total tracks. Single-track downloads emit one progress
   * event at 100% just before complete.
   *
   * @param {string} url
   * @param {string} outputFolder
   * @param {object} [options]
   * @param {number} [options.bitrate=320]
   * @param {string} [options.filenameTemplate='%(title)s']
   */
  download(url, outputFolder, options = {}) {
    const emitter = new EventEmitter();
    const bitrate = options.bitrate || 320;
    const outputTemplate = this._translateFilenameTemplate(
      options.filenameTemplate || '%(title)s',
      outputFolder
    );

    const args = [
      'download', url,
      '--output', outputTemplate,
      '--format', 'mp3',
      '--bitrate', `${bitrate}k`,
      '--print-errors',
      // Keep stdout chatter manageable for parsing.
      '--log-level', 'INFO',
    ];

    const proc = spawn('spotdl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const id = crypto.randomUUID();
    this.activeProcesses.set(id, proc);

    let stderrBuffer = '';
    let stdoutBuffer = '';
    let totalTracks = null;
    let completedTracks = 0;
    let lastTitle = null;

    const onLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // "Found N songs ..." — total tracks for percent math
      const found = trimmed.match(/Found\s+(\d+)\s+song/i);
      if (found) {
        totalTracks = parseInt(found[1], 10);
      }

      // "Downloaded \"<title>\"" — one track finished
      const done = trimmed.match(/Downloaded\s+"(.+?)"/i);
      if (done) {
        completedTracks += 1;
        lastTitle = done[1];
        const percent = totalTracks
          ? Math.min(100, Math.round((completedTracks / totalTracks) * 100))
          : Math.min(99, completedTracks * 10);
        emitter.emit('progress', { percent, size: '', speed: '', eta: '', title: lastTitle });
      }

      // "Skipping \"<title>\" (...)" — already exists; treat as completion
      const skip = trimmed.match(/Skipping\s+"(.+?)"/i);
      if (skip) {
        completedTracks += 1;
        const percent = totalTracks
          ? Math.min(100, Math.round((completedTracks / totalTracks) * 100))
          : Math.min(99, completedTracks * 10);
        emitter.emit('progress', { percent, size: '', speed: '', eta: '', title: skip[1] });
      }
    };

    const flushBuffered = (buf) => {
      const lines = buf.split('\n');
      const tail = lines.pop();
      for (const line of lines) onLine(line);
      return tail || '';
    };

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      stdoutBuffer = flushBuffered(stdoutBuffer);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      // spotdl writes progress to stderr in some versions, so process it too.
      let buf = text;
      buf = flushBuffered(buf);
    });

    proc.on('close', (code) => {
      this.activeProcesses.delete(id);
      if (code === 0) {
        // Guarantee a final 100% so the UI flips cleanly.
        emitter.emit('progress', { percent: 100, size: '', speed: '', eta: '' });
        emitter.emit('complete', { code });
      } else {
        emitter.emit('error', new Error(translateSpotdlError(code, stderrBuffer || stdoutBuffer)));
      }
    });

    proc.on('error', (err) => {
      this.activeProcesses.delete(id);
      emitter.emit('error', err);
    });

    emitter.cancel = () => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        this.activeProcesses.delete(id);
      }
    };

    return emitter;
  }

  /**
   * yt-dlp's filename template syntax (%(title)s, %(artist)s) is not what
   * spotdl uses ({title}, {artists}). Map the common tokens so the existing
   * SetEngine setting works for both engines without surprising the user.
   * Tokens we don't recognise are passed through unchanged.
   */
  _translateFilenameTemplate(template, outputFolder) {
    const mapped = template
      .replace(/%\(title\)s/gi, '{title}')
      .replace(/%\(artist\)s/gi, '{artists}')
      .replace(/%\(album\)s/gi, '{album}')
      .replace(/%\(track_number\)s/gi, '{track-number}')
      .replace(/%\(upload_date\)s/gi, '{year}');
    // spotdl appends the extension itself when --format is set, so we don't
    // need to add %(ext)s / {output-ext}.
    return path.join(outputFolder, `${mapped}.{output-ext}`);
  }

  cancel(id) {
    const proc = this.activeProcesses.get(id);
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      this.activeProcesses.delete(id);
      return true;
    }
    return false;
  }
}
