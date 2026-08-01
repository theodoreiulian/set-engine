// SetEngine — Set Extractor
//
// Orchestrates DJ-set tracklist extraction end to end:
//   1. Read the link's info (title + duration) via yt-dlp.
//   2. If the uploader already published a tracklist (chapters / timestamped
//      description lines), use it and skip straight to step 5 — it's exact,
//      free, and means the set never has to be downloaded at all.
//   3. Otherwise download the audio to a temp dir (128 kbps mono-ish MP3 —
//      recognition doesn't need 320, and a smaller file scans faster).
//   4. Hand the file to the Shazam recognizer, then merge consecutive duplicate
//      hits into the play-order tracklist.
// The temp file is always cleaned up, and the whole flow is cancellable via an
// AbortSignal. Progress is reported through `onProgress` as { phase, percent }.
//
// Honest scope: no fingerprinter recognizes *every* track in a mix — unreleased
// IDs, bootlegs, mashups and heavily-effected sections defeat all of them. This
// scans continuously and merges duplicates to get as close as the engine allows.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { recognize } from './shazam/recognize.js';
import { parsePublishedTracklist } from './tracklist-sources.js';
import { cleanTitle, primaryArtist } from './bpm-sources.js';
import { resolveBestVideoUrl } from './track-match.js';

// Normalized identity used for adjacent-duplicate detection. Reuses the same
// title/artist cleaners the BPM lookup uses, so hits that differ only by
// platform noise (e.g. "Title (Official Video)") or a featured-artist suffix
// still register as the same track.
function identityKey(artist, title) {
  const a = primaryArtist(artist || '').toLowerCase();
  const t = cleanTitle(title || '').toLowerCase();
  return `${a} ${t}`.replace(/\s+/g, ' ').trim();
}

// Collapse all hits for the same track into a single entry, keeping the earliest
// offset. A DJ holds a track across many scan windows, and recognizers also
// re-report a track when it recurs later in the set or when an unrecognized
// window splits a run — every such duplicate is dropped, so each unique song
// appears exactly once (in first-played order).
function dedupeTracks(tracks) {
  const sorted = tracks.slice().sort((a, b) => (a.offsetSec || 0) - (b.offsetSec || 0));
  const out = [];
  const seen = new Set();
  for (const t of sorted) {
    if (!t || !t.title) continue;
    const key = identityKey(t.artist, t.title);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({
      artist: (t.artist || '').trim(),
      title: (t.title || '').trim(),
      album: (t.album || '').trim(),
      offsetSec: Math.max(0, Math.round(t.offsetSec || 0)),
    });
  }
  return out;
}

// Locate the downloaded audio. yt-dlp's --audio-format mp3 yields "<id>.mp3";
// fall back to any matching file in case the muxer chose another container.
async function findDownloaded(tmpDir, id) {
  try {
    const files = await readdir(tmpDir);
    const exact = files.find((f) => f === `${id}.mp3`);
    if (exact) return path.join(tmpDir, exact);
    const any = files.find((f) => f.startsWith(`${id}.`) && /\.(mp3|m4a|opus|ogg|webm|wav)$/i.test(f));
    if (any) return path.join(tmpDir, any);
  } catch (_) { /* fall through to the expected path */ }
  return path.join(tmpDir, `${id}.mp3`);
}

export async function extractSet(url, { ytDlp, settings, signal, onProgress, cacheDir } = {}) {
  const emit = (data) => { try { if (onProgress) onProgress(data); } catch (_) { /* ignore */ } };

  if (!cacheDir) throw new Error('extractSet requires a cacheDir.');

  emit({ phase: 'info', percent: 0 });
  let info = null;
  try {
    info = await ytDlp.getVideoInfo(url);
  } catch (err) {
    throw new Error(`Couldn't read that link: ${err.message}`);
  }

  // The cache dir is owned by this job (one private dir per extraction). It is
  // created fresh in the caching phase below and torn down when the job is
  // deleted — this orchestrator never wipes it, so parallel jobs can't clobber
  // each other's cached audio. Cache files are keyed by the track's normalized
  // identity.
  const durationSec = Number(info && info.duration) || 0;
  const meta = { title: (info && info.title) || '', durationSec };
  emit({ phase: 'info', percent: 5, info: meta });

  // ── Published tracklist ───────────────────────────────────────────────
  // Checked before anything expensive. When the uploader listed the tracks
  // themselves the answer is already exact — correct remix names, correct
  // order, exact start times — so there is nothing for a recognizer to improve
  // on, and the 90-minute audio download can be skipped outright.
  let published = null;
  if (settings.usePublishedTracklist !== false) {
    try { published = parsePublishedTracklist(info); }
    catch (_) { published = null; }               // never let parsing break an extraction
  }

  const engineLabel = published ? `youtube-${published.source}` : 'shazam';

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'setengine-extract-'));
  const id = crypto.randomUUID();

  try {
    let merged;
    if (published) {
      emit({ phase: 'scanning', percent: 100 });
      merged = dedupeTracks(published.entries);
      console.log(`[SetEngine] used the uploader's published tracklist (${published.source}): ${merged.length} track(s) — no download, no recognition.`);
    } else {
      merged = await downloadAndRecognize();
    }
    emit({ phase: 'merging', percent: 100 });

    // ── Caching ───────────────────────────────────────────────────────────
    return await cacheAndFinish(merged);
  } finally {
    // Only the scratch download/scan dir is cleaned here. The job's cacheDir is
    // owned by ExtractionJobManager and removed when the job is deleted (and the
    // whole ExtractionCache root is wiped at app boot), so a cancelled/failed run
    // leaves its partial cache in place until the user deletes the job.
    try { await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (_) { /* best-effort */ }
  }

  // ── Download + recognize (only when no tracklist was published) ───────
  async function downloadAndRecognize() {
    await new Promise((resolve, reject) => {
      const dl = ytDlp.download(url, tmpDir, { bitrate: 128, filenameTemplate: id });
      const onAbort = () => { try { dl.cancel(); } catch (_) { /* gone */ } reject(new Error('Extraction cancelled.')); };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      dl.on('progress', (p) => emit({ phase: 'downloading', percent: Math.min(99, p.percent || 0) }));
      dl.on('complete', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
      dl.on('error', (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
    });
    emit({ phase: 'downloading', percent: 100 });

    const audioPath = await findDownloaded(tmpDir, id);

    // ── Recognize ───────────────────────────────────────────────────────
    emit({ phase: 'scanning', percent: 0 });
    const { tracks } = await recognize(audioPath, {
      signal,
      durationSec,
      settings,
      onProgress: ({ done, total }) => emit({
        phase: 'scanning',
        percent: total ? Math.round((done / total) * 100) : 0,
      }),
    });

    if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    return dedupeTracks(tracks || []);
  }

  // ── Cache each track's audio, then report the finished tracklist ──────
  async function cacheAndFinish(merged) {
    emit({ phase: 'caching', percent: 0 });
    await mkdir(cacheDir, { recursive: true });   // this job's private cache dir

    let cachedTracksCount = 0;
    const concurrencyLimit = 5;
    const activeDownloads = new Set();
    // Per-track download quality follows the user's audio-quality setting (same
    // key the normal queue uses); these files are copied verbatim to the user's
    // folder by download:track / download:tracks.
    const downloadBitrate = settings.audioQuality || 320;

    const runCacheDownload = async (t) => {
      if (signal && signal.aborted) return;
      const query = t.artist ? `${t.artist} ${t.title}` : t.title;
      // Key the cache file by the track's *normalized* identity — the same key
      // dedupe uses — so two surviving tracks can never collide onto one file and
      // serve each other's audio (a raw query could).
      const fileId = crypto.createHash('md5').update(identityKey(t.artist, t.title) || query).digest('hex');
      const expectedFile = path.join(cacheDir, `${fileId}.mp3`);

      // Whole body is guarded: a single track can only ever fail to produce a
      // cachePath, never reject the batch. resolveBestVideoUrl is documented as
      // best-effort, but a stray throw here must not abort the whole extraction.
      try {
        try {
          await stat(expectedFile);
          t.cachePath = expectedFile;
        } catch (_) {
          // Cache miss → resolve to a YouTube URL whose title matches the detected
          // track. null = no confident match anywhere; leave this track without a
          // cached file rather than download something wrong.
          const target = await resolveBestVideoUrl(ytDlp, query, t.title, t.artist);
          if (target) {
            try {
              await new Promise((resolve, reject) => {
                const dl = ytDlp.download(target, cacheDir, { bitrate: downloadBitrate, filenameTemplate: fileId });
                const onAbort = () => { try { dl.cancel(); } catch (_) {} reject(new Error('Extraction cancelled.')); };
                if (signal) {
                  if (signal.aborted) { onAbort(); return; }
                  signal.addEventListener('abort', onAbort, { once: true });
                }
                dl.on('complete', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
                dl.on('error', (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
              });
              const actualPath = await findDownloaded(cacheDir, fileId);
              t.cachePath = actualPath;
            } catch (err) {
              // Remove any partial/`.part` file this failed download left behind.
              try { await unlink(expectedFile); } catch (_) { /* may not exist */ }
              console.error('Failed to cache track:', query, err.message);
            }
          }
        }
      } catch (err) {
        console.error('Cache step failed for track:', query, err && err.message);
      } finally {
        cachedTracksCount++;
        emit({ phase: 'caching', percent: Math.round((cachedTracksCount / merged.length) * 100) });
      }
    };

    const promises = [];
    for (const t of merged) {
      if (signal && signal.aborted) break;
      while (activeDownloads.size >= concurrencyLimit) {
        await Promise.race(activeDownloads);
      }
      const p = runCacheDownload(t).finally(() => activeDownloads.delete(p));
      activeDownloads.add(p);
      promises.push(p);
    }
    await Promise.all(promises);
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');

    emit({ phase: 'done', percent: 100, tracks: merged, engine: engineLabel, info: meta });
    return { success: true, tracks: merged, engine: engineLabel, info: meta };
  }
}
