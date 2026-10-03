// =============================================================================
// catalog-wrapper.js — the "engine" for Deezer and Tidal links.
//
// Same surface as YtDlpWrapper / SpotdlWrapper (`getTrackInfo`,
// `getPlaylistInfo`, `download` → EventEmitter with progress / complete / error
// and `cancel()`), so DownloadManager doesn't branch on it.
//
// Nothing is downloaded from Deezer or Tidal — both are subscription-only. The
// link is read for what it names (`catalog-sources.js`), that recording is
// found on YouTube Music → YouTube → SoundCloud and VERIFIED there
// (`resolveBestVideo`: title, artist, version, and — because a catalogue link
// states it exactly — length), and the verified match is what gets downloaded.
// It is the same thing spotdl does for a Spotify link, held to the stricter
// rule Set Extraction uses: a track whose recording can't be verified is
// refused, not approximated. The file is then tagged from the catalogue, so its
// title, artist, album and cover are the service's own rather than whatever the
// upload happened to carry.
// =============================================================================

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import pLimit from 'p-limit';
import { fetchCatalog } from './catalog-sources.js';
import { resolveBestVideo } from './track-match.js';
import { verifyDownloadedAudio } from './download-verify.js';
import { sanitizeFilenameTemplate } from './filename-template.js';

// Matching is searches plus metadata fetches against YouTube. The queue runs 5
// downloads at once, and 5 concurrent matchers is the load that got searches
// throttled during Set Extraction — which reads as "YouTube doesn't have it" and
// pushes tracks onto the lower-quality fallback. Same cap as set-extractor.js.
const MAX_CONCURRENT_MATCHES = 3;

const COVER_TIMEOUT_MS = 15000;

/**
 * Fill a yt-dlp-style filename template from catalogue metadata.
 *
 * yt-dlp would fill it from the matched upload instead, and a fan upload has no
 * artist field at all — "%(artist)s - %(title)s" would come out as "NA - …".
 * The catalogue's values are the ones the user asked for, so the template is
 * resolved here and handed to yt-dlp as a literal name.
 */
export function expandFilenameTemplate(template, meta) {
  const fields = {
    title: meta.title,
    track: meta.title,
    fulltitle: meta.title,
    artist: meta.artist,
    artists: meta.artist,
    creator: meta.artist,
    uploader: meta.artist,
    channel: meta.artist,
    album_artist: meta.artist,
    album: meta.album,
    track_number: meta.trackNumber ? String(meta.trackNumber) : '',
    playlist_index: meta.trackNumber ? String(meta.trackNumber) : '',
  };
  const expanded = String(template || '%(title)s').replace(
    /%\(([a-z_]+)[^)]*\)[-+ #0-9.]*[a-zA-Z]/g,
    (_, key) => {
      const v = fields[key];
      // "NA" is what yt-dlp itself writes for a field it doesn't have.
      return v ? String(v) : 'NA';
    },
  );
  return sanitizeFilenameTemplate(expanded);
}

export default class CatalogWrapper {
  /**
   * @param {object} ytDlp — YtDlpWrapper (search, metadata and the download itself)
   * @param {{ fetchImpl?: typeof fetch }} [opts]
   */
  constructor(ytDlp, { fetchImpl } = {}) {
    this.ytDlp = ytDlp;
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.matchLimit = pLimit(MAX_CONCURRENT_MATCHES);
    // Track metadata read while listing an album / playlist, keyed by track URL,
    // so each child download doesn't ask the service again.
    this.known = new Map();
  }

  async getTrackInfo(url) {
    const meta = await this._trackMeta(url);
    return { title: displayName(meta) };
  }

  async getPlaylistInfo(url) {
    const cat = await fetchCatalog(url, { fetchImpl: this.fetchImpl });
    for (const t of cat.tracks) this.known.set(t.url, t);
    // Tidal's public page lists only the first 50 rows of a playlist. Say so in
    // the one place the user will see it, rather than quietly stopping short.
    const title = cat.total > cat.tracks.length
      ? `${cat.title} (first ${cat.tracks.length} of ${cat.total} tracks)`
      : cat.title;
    return {
      title,
      entries: cat.tracks.map((t) => ({ url: t.url, title: displayName(t) })),
    };
  }

  async _trackMeta(url) {
    const cached = this.known.get(url);
    // A playlist row from Tidal has no album or cover; the track's own page
    // does, so it's worth the one request. Deezer rows are already complete.
    if (cached && cached.album) return cached;
    try {
      const cat = await fetchCatalog(url, { fetchImpl: this.fetchImpl });
      const meta = cat.tracks[0];
      if (!meta) throw new Error('That link names no track');
      const merged = cached ? { ...cached, ...meta, trackNumber: meta.trackNumber || cached.trackNumber } : meta;
      this.known.set(url, merged);
      return merged;
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  }

  /**
   * Match, download, verify and tag one track.
   * @returns {EventEmitter & { cancel: Function }}
   */
  download(url, outputFolder, options = {}) {
    const emitter = new EventEmitter();
    let cancelled = false;
    let inner = null;

    emitter.cancel = () => {
      cancelled = true;
      if (inner) inner.cancel();
    };
    const CANCELLED = new Error('Cancelled');

    const run = async () => {
      const meta = await this._trackMeta(url);
      if (cancelled) throw CANCELLED;
      const name = displayName(meta);

      const query = meta.artist ? `${meta.artist} ${meta.title}` : meta.title;
      const target = await this.matchLimit(() => (cancelled
        ? null
        : resolveBestVideo(this.ytDlp, query, meta.title, meta.artist, { expectedDurationSec: meta.durationSec })));
      if (cancelled) throw CANCELLED;
      if (!target) {
        throw new Error(`Couldn't verify a match for "${name}" on YouTube or SoundCloud — skipped to avoid downloading the wrong track.`);
      }

      const base = expandFilenameTemplate(options.filenameTemplate, meta);
      const file = path.join(outputFolder, `${base}.mp3`);

      await new Promise((resolve, reject) => {
        inner = this.ytDlp.download(target.url, outputFolder, {
          cookiePath: null,
          bitrate: options.bitrate,
          // A literal name now; yt-dlp still reads "%" as the start of a field.
          filenameTemplate: base.replace(/%/g, '%%'),
        });
        inner.on('progress', (p) => emitter.emit('progress', p));
        inner.on('error', reject);
        inner.on('complete', resolve);
      });
      if (cancelled) throw CANCELLED;

      // Same last line of defence as Set Extraction: the file on disk has to be
      // the length of the recording that was verified, or it isn't that
      // recording and must not sit there under the requested name.
      const check = await verifyDownloadedAudio(file, { expectedDurationSec: target.durationSec });
      if (!check.ok) {
        try { await unlink(file); } catch (_) { /* best-effort */ }
        console.error(`[SetEngine] discarded "${name}": ${check.reason} (${target.url})`);
        throw new Error(`Downloaded file didn't match the expected track (${check.reason}) — discarded.`);
      }

      await this._tag(file, meta);
      emitter.emit('complete', { code: 0, provider: target.provider });
    };

    run().catch((err) => {
      emitter.emit('error', cancelled ? CANCELLED : err);
    });

    return emitter;
  }

  // Replace the upload's tags with the catalogue's. Best-effort: the audio is
  // already verified, so a tagging problem must not fail the download.
  async _tag(file, meta) {
    try {
      const NodeID3 = (await import('node-id3')).default;
      const tags = { title: meta.title, artist: meta.artist };
      if (meta.album) tags.album = meta.album;
      if (meta.trackNumber) tags.trackNumber = String(meta.trackNumber);
      const cover = await this._cover(meta.coverUrl);
      if (cover) {
        tags.image = { mime: cover.mime, type: { id: 3, name: 'front cover' }, description: '', imageBuffer: cover.buffer };
      }
      // `update` would keep the upload's thumbnail alongside the real cover, so
      // merge by hand and write the frame set once.
      const existing = NodeID3.read(file) || {};
      delete existing.raw;
      NodeID3.write({ ...existing, ...tags }, file);
    } catch (err) {
      console.warn(`[SetEngine] couldn't tag "${meta.title}": ${err && err.message}`);
    }
  }

  async _cover(coverUrl) {
    if (!coverUrl) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), COVER_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(coverUrl, { signal: ctrl.signal });
      if (!res.ok) return null;
      const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      if (!/^image\/(jpeg|png)$/.test(mime)) return null;
      return { mime, buffer: Buffer.from(await res.arrayBuffer()) };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function displayName(meta) {
  return meta.artist ? `${meta.artist} - ${meta.title}` : meta.title;
}
