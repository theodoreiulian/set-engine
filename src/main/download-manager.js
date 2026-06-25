import pLimit from 'p-limit';
import crypto from 'node:crypto';
import { classifyUrl } from './sources.js';

const TERMINAL_STATUSES = new Set(['complete', 'error', 'cancelled']);

// Hardcoded queue concurrency. Sized to YouTube's per-IP tolerance with an
// authenticated session: high enough to saturate bandwidth and ffmpeg cores,
// low enough to stay well below the soft threshold where 429s and bot-check
// challenges start appearing (~50–100 simultaneous TCP connections to
// googlevideo). Combined with --concurrent-fragments 4 this yields ~20
// active connections per IP, which is safe long-term.
const MAX_CONCURRENT_DOWNLOADS = 5;

/**
 * Decide if a URL should be downloaded as a playlist. Defers to the source
 * registry's URL classifier so YouTube and Spotify share one entry point.
 * Watch pages are songs even when the URL carries a `list=` parameter — that
 * list is usually the auto-generated mix/radio (RDAMVM…) which yt-dlp can't
 * enumerate and produces an empty playlist.
 */
export function isPlaylistUrl(url) {
  const cls = classifyUrl(url);
  if (cls) return cls.kind === 'playlist';
  // Fallback for the rare case classifyUrl returns null (unknown host).
  if (/\/playlist\b/i.test(url)) return true;
  if (/\/watch\b/i.test(url)) return false;
  return /[?&]list=/.test(url);
}

/**
 * Strip the `list=` query parameter from a /watch URL so yt-dlp treats it as a
 * single video rather than the start of a playlist/album. YouTube Music album
 * pages use /watch?v=…&list=OLAK5uy_… where the list param points to the full
 * album; without stripping it, yt-dlp enumerates and downloads every track.
 */
export function normalizeWatchUrl(url) {
  try {
    const u = new URL(url);
    if (!/\/watch\b/i.test(u.pathname)) return url;
    if (!u.searchParams.has('list')) return url;
    u.searchParams.delete('list');
    return u.toString();
  } catch {
    return url;
  }
}

export default class DownloadManager {
  constructor(mainWindow, ytDlpWrapper, spotdlWrapper) {
    this.mainWindow = mainWindow;
    this.ytDlp = ytDlpWrapper;
    this.spotdl = spotdlWrapper;
    this.queue = new Map();
    this.limit = pLimit(MAX_CONCURRENT_DOWNLOADS);
    this.outputDir = '';
    this.bitrate = 320;
    this.filenameTemplate = '%(title)s';
  }

  // Pick the engine matching the item's source. Falls back to yt-dlp so legacy
  // queue items without a source field keep working.
  _wrapperFor(source) {
    if (source === 'spotify') return this.spotdl;
    return this.ytDlp;
  }

  setOutputDir(dir) {
    this.outputDir = dir;
  }

  setBitrate(bitrate) {
    if (bitrate) this.bitrate = bitrate;
  }

  setFilenameTemplate(template) {
    if (template) this.filenameTemplate = template;
  }

  async addDownload(url, cookiePath) {
    const id = crypto.randomUUID();
    const classification = classifyUrl(url) || { source: 'youtube-music', kind: isPlaylistUrl(url) ? 'playlist' : 'track' };
    const source = classification.source;
    const isPlaylist = classification.kind === 'playlist';
    // Only YouTube /watch URLs need the list= strip; Spotify URLs pass through.
    const normalizedUrl = source === 'youtube-music' && !isPlaylist ? normalizeWatchUrl(url) : url;

    const item = {
      id,
      url: normalizedUrl,
      title: 'Fetching info...',
      type: isPlaylist ? 'playlist' : 'song',
      source,
      status: 'queued',
      progress: 0,
      speed: '',
      eta: '',
      error: null,
      children: []
    };

    this.queue.set(id, item);
    this._broadcast();

    // Kick off the work in the background — do not await so the IPC call
    // returns the id immediately and the UI can navigate to the queue.
    const work = isPlaylist
      ? this._handlePlaylist(item, cookiePath)
      : this._handleSingle(item, cookiePath);

    work.catch((err) => {
      item.status = 'error';
      item.error = err.message;
      this._emitError(item);
      this._broadcast();
    });

    return id;
  }

  _handleSingle(item, cookiePath) {
    // Run the metadata fetch AND the download inside a single concurrency slot.
    // Previously the info fetch ran outside the limiter (one unbounded yt-dlp
    // spawn per queued item — defeating MAX_CONCURRENT_DOWNLOADS) and the
    // download was scheduled fire-and-forget, so the metadata phase didn't count
    // against the cap. Returning the limiter promise also lets addDownload's
    // error handler observe a metadata-fetch rejection.
    return this.limit(async () => {
      const wrapper = this._wrapperFor(item.source);
      try {
        // YT and Spotify wrappers both expose getVideoInfo / getTrackInfo with a
        // { title } shape — call whichever exists.
        const info = wrapper.getVideoInfo
          ? await wrapper.getVideoInfo(item.url, cookiePath)
          : await wrapper.getTrackInfo(item.url, cookiePath);
        item.title = info.title || item.url;
        this._broadcast();
      } catch (_) {
        // title stays as URL
      }

      await this._runDownload(item, cookiePath, null);
    });
  }

  async _handlePlaylist(item, cookiePath) {
    const wrapper = this._wrapperFor(item.source);
    // Bound the playlist metadata fetch by the same concurrency cap so adding
    // many playlists at once doesn't spawn an unbounded burst of yt-dlp probes.
    // The fetch holds a slot only until it resolves; children are scheduled
    // afterwards (outside this slot), so there's no risk of slot-starvation.
    const info = await this.limit(() => wrapper.getPlaylistInfo(item.url, cookiePath));
    item.title = info.title || 'Unknown Playlist';
    const entries = info.entries || [];

    if (entries.length === 0) {
      throw new Error('Playlist is empty or private');
    }

    const fallbackUrl = (entry) => {
      if (entry.url) return entry.url;
      if (item.source === 'spotify') {
        return `https://open.spotify.com/track/${entry.id}`;
      }
      return `https://www.youtube.com/watch?v=${entry.id}`;
    };

    item.children = entries.map((entry) => ({
      id: crypto.randomUUID(),
      parentId: item.id,
      url: fallbackUrl(entry),
      title: entry.title || 'Unknown Track',
      type: 'song',
      source: item.source,
      status: 'queued',
      progress: 0,
      speed: '',
      eta: '',
      error: null,
    }));

    item.status = 'downloading';
    // Seed the "X/Y songs" counter so the queue UI can render it from the first
    // paint (before any child has emitted a progress event).
    item.childrenProgress = { complete: 0, total: item.children.length };
    this._broadcast();

    item.children.forEach((child) => {
      this.limit(() => this._runDownload(child, cookiePath, item));
    });
  }

  /**
   * Run yt-dlp for a single item (song or playlist child).
   * If `parent` is provided, playlist progress + finalization are updated.
   * Returns a promise that always resolves (errors are captured into item.error).
   */
  _runDownload(item, cookiePath, parent) {
    return new Promise((resolve) => {
      if (item.status === 'cancelled' || (parent && parent.status === 'cancelled')) {
        if (parent && parent.status === 'cancelled') item.status = 'cancelled';
        resolve();
        return;
      }

      item.status = 'downloading';
      if (parent) this._updatePlaylistProgress(parent);
      else this._broadcast();

      const wrapper = this._wrapperFor(item.source);
      const dl = wrapper.download(item.url, this.outputDir, {
        cookiePath,
        bitrate: this.bitrate,
        filenameTemplate: this.filenameTemplate,
      });
      item._cancel = dl.cancel;

      dl.on('progress', (data) => {
        item.progress = data.percent;
        item.speed = data.speed;
        item.eta = data.eta;
        this._emitProgress(item);
      });

      dl.on('error', (err) => {
        item.status = 'error';
        item.error = err.message;
        this._emitError(item);
        if (parent) {
          this._updatePlaylistProgress(parent);
          this._maybeFinalizePlaylist(parent);
        } else {
          this._broadcast();
        }
        resolve();
      });

      dl.on('complete', () => {
        item.status = 'complete';
        item.progress = 100;
        item.speed = '';
        item.eta = '';
        this._emitComplete(item);
        if (parent) {
          this._updatePlaylistProgress(parent);
          this._maybeFinalizePlaylist(parent);
        }
        resolve();
      });
    });
  }

  _maybeFinalizePlaylist(parent) {
    if (parent.status === 'cancelled') return;
    if (!parent.children || parent.children.length === 0) {
      parent.status = 'complete';
      parent.error = null;
      this._emitComplete(parent);
      return;
    }
    const allDone = parent.children.every((c) => TERMINAL_STATUSES.has(c.status));
    if (!allDone) return;

    const errored = parent.children.filter((c) => c.status === 'error');
    const hasErrors = errored.length > 0;
    parent.status = hasErrors ? 'error' : 'complete';

    if (hasErrors) {
      const sample = errored[0].error || 'Unknown error';
      const allFailed = errored.length === parent.children.length;
      parent.error = allFailed
        ? `All ${parent.children.length} tracks failed. First error:\n${sample}`
        : `${errored.length} of ${parent.children.length} tracks failed. First error:\n${sample}`;
      this._emitError(parent);
    } else {
      parent.error = null;
      this._emitComplete(parent);
    }
  }

  _updatePlaylistProgress(playlistItem) {
    if (playlistItem.status === 'cancelled') return;
    if (!playlistItem.children || playlistItem.children.length === 0) {
      playlistItem.progress = 0;
      playlistItem.childrenProgress = { complete: 0, total: 0 };
      this._emitProgress(playlistItem);
      return;
    }
    const total = playlistItem.children.length;
    // Progress bar tracks *terminal* children (complete/error/cancelled) so the
    // bar can reach 100% and the playlist can finalize even when some fail.
    const done = playlistItem.children.filter((c) => TERMINAL_STATUSES.has(c.status)).length;
    // The "X/Y songs" label counts only successfully downloaded tracks — that's
    // the count the user actually cares about ("how many songs did I get").
    const complete = playlistItem.children.filter((c) => c.status === 'complete').length;
    playlistItem.progress = Math.round((done / total) * 100);
    playlistItem.childrenProgress = { complete, total };
    this._emitProgress(playlistItem);
  }

  cancelDownload(id) {
    const item = this._findItem(id);
    if (!item) return;

    if (item.status === 'downloading' || item.status === 'queued') {
      item.status = 'cancelled';
      if (item._cancel) item._cancel();

      if (item.type === 'playlist' && item.children) {
        item.children.forEach((child) => {
          if (child.status === 'downloading' || child.status === 'queued') {
            child.status = 'cancelled';
            if (child._cancel) child._cancel();
          }
        });
      }

      // If cancelling a child, recompute parent progress and finalize if needed
      if (item.parentId) {
        const parent = this.queue.get(item.parentId);
        if (parent) {
          this._updatePlaylistProgress(parent);
          this._maybeFinalizePlaylist(parent);
        }
      }
    }
    this._broadcast();
  }

  retryDownload(id, cookiePath) {
    const item = this._findItem(id);
    if (!item) return;
    if (item.status === 'downloading' || item.status === 'queued') return;

    if (item.type === 'song') {
      this._resetItem(item);
      const parent = item.parentId ? this.queue.get(item.parentId) : null;
      if (parent) {
        parent.status = 'downloading';
        parent.error = null;
      }
      this._broadcast();
      this.limit(() => this._runDownload(item, cookiePath, parent));
      return;
    }

    // Playlist parent — retry every non-complete child
    if (!item.children || item.children.length === 0) return;
    const toRetry = item.children.filter((c) => c.status !== 'complete');
    if (toRetry.length === 0) return;

    toRetry.forEach((c) => this._resetItem(c));
    item.status = 'downloading';
    item.error = null;
    this._broadcast();

    toRetry.forEach((child) => {
      this.limit(() => this._runDownload(child, cookiePath, item));
    });
  }

  _resetItem(item) {
    item.status = 'queued';
    item.progress = 0;
    item.error = null;
    item.speed = '';
    item.eta = '';
    delete item._cancel;
  }

  _findItem(id) {
    if (this.queue.has(id)) return this.queue.get(id);
    for (const item of this.queue.values()) {
      if (item.children) {
        const child = item.children.find((c) => c.id === id);
        if (child) return child;
      }
    }
    return null;
  }

  _sanitizeItem(item) {
    const { _cancel, ...cleanItem } = item;
    if (cleanItem.children) {
      cleanItem.children = cleanItem.children.map((c) => {
        const { _cancel: childCancel, ...cleanChild } = c;
        return cleanChild;
      });
    }
    return cleanItem;
  }

  getQueue() {
    return Array.from(this.queue.values()).map((item) => this._sanitizeItem(item));
  }

  clearAll() {
    for (const [id, item] of this.queue.entries()) {
      if (item.status === 'downloading' || item.status === 'queued') {
        this.cancelDownload(id);
      }
    }
    this.queue.clear();
    this._broadcast();
  }

  _broadcast() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('download:queue-update', this.getQueue());
    }
  }

  _emitProgress(item) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('download:progress', this._sanitizeItem(item));
    }
  }

  _emitComplete(item) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('download:complete', this._sanitizeItem(item));
    }
  }

  _emitError(item) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('download:error', this._sanitizeItem(item));
    }
  }
}
