// SetEngine — Set Extractor
//
// Orchestrates DJ-set tracklist extraction end to end:
//   1. Read the link's info (title + duration) via yt-dlp.
//   2. Download the audio to a temp dir (128 kbps mono-ish MP3 — recognition
//      doesn't need 320, and a smaller file uploads/scans faster).
//   3. Hand the file to the selected recognizer (AudD or ACRCloud).
//   4. Merge consecutive duplicate hits into the play-order tracklist.
// The temp file is always cleaned up, and the whole flow is cancellable via an
// AbortSignal. Progress is reported through `onProgress` as { phase, percent }.
//
// Honest scope: no fingerprinter recognizes *every* track in a mix — unreleased
// IDs, bootlegs, mashups and heavily-effected sections defeat all of them. This
// scans continuously and merges duplicates to get as close as the engine allows.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { getRecognizer } from './recognizers/index.js';
import { cleanTitle, primaryArtist } from './bpm-sources.js';

// Normalized identity used for adjacent-duplicate detection. Reuses the same
// title/artist cleaners the BPM lookup uses, so hits that differ only by
// platform noise (e.g. "Title (Official Video)") or a featured-artist suffix
// still register as the same track.
function identityKey(artist, title) {
  const a = primaryArtist(artist || '').toLowerCase();
  const t = cleanTitle(title || '').toLowerCase();
  return `${a} ${t}`.replace(/\s+/g, ' ').trim();
}

// Collapse runs of the same track (a DJ holds a track across many scan windows)
// into a single entry, keeping the earliest offset. Adjacent-only: a track that
// genuinely returns later in the set stays as a separate entry.
function mergeAdjacent(tracks) {
  const sorted = tracks.slice().sort((a, b) => (a.offsetSec || 0) - (b.offsetSec || 0));
  const out = [];
  let lastKey = null;
  for (const t of sorted) {
    if (!t || !t.title) continue;
    const key = identityKey(t.artist, t.title);
    if (key && key === lastKey) continue;
    lastKey = key;
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

export async function extractSet(url, { ytDlp, settings, signal, onProgress } = {}) {
  const emit = (data) => { try { if (onProgress) onProgress(data); } catch (_) { /* ignore */ } };

  // Validate engine + credentials before any heavy work so the error is instant.
  const recognizer = getRecognizer(settings);

  emit({ phase: 'info', percent: 0 });
  let info = null;
  try {
    info = await ytDlp.getVideoInfo(url);
  } catch (err) {
    throw new Error(`Couldn't read that link: ${err.message}`);
  }
  const durationSec = Number(info && info.duration) || 0;
  const meta = { title: (info && info.title) || '', durationSec };
  emit({ phase: 'info', percent: 5, info: meta });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'setengine-extract-'));
  const id = crypto.randomUUID();

  try {
    // ── Download audio ──────────────────────────────────────────────────
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
    const { tracks } = await recognizer.recognize(audioPath, {
      signal,
      durationSec,
      onProgress: ({ done, total }) => emit({
        phase: 'scanning',
        percent: total ? Math.round((done / total) * 100) : 0,
      }),
    });

    if (signal && signal.aborted) throw new Error('Extraction cancelled.');

    // ── Merge ───────────────────────────────────────────────────────────
    emit({ phase: 'merging', percent: 100 });
    const merged = mergeAdjacent(tracks || []);

    emit({ phase: 'done', percent: 100, tracks: merged, engine: recognizer.name, info: meta });
    return { success: true, tracks: merged, engine: recognizer.name, info: meta };
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}
