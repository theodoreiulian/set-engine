// SetEngine — AudD recognizer
//
// Uses AudD's enterprise endpoint (https://enterprise.audd.io/), which accepts a
// whole audio file and returns every recognized track with a timestamp — exactly
// the shape a DJ set needs. We upload the downloaded set and AudD scans it
// server-side; `every=1, skip=0` means a continuous (non-sampled) scan so no
// track is skipped. Robust to the pitch/tempo shifts common in DJ mixes.
//
// Billing is 1 request per 12 s of audio (first 300 free); the caller has
// already confirmed a token exists.

import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { backoff, parseRetryAfter } from './retry.js';
import { minConfidenceOf } from './util.js';

const ENDPOINT = 'https://enterprise.audd.io/';
const MAX_ATTEMPTS = 3;   // whole-file upload attempts on transient failure

// AudD timestamps appear as either seconds ("123") or "m:ss" / "h:mm:ss".
function parseOffset(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.max(0, Math.round(v));
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.round(parseFloat(s)));
  const parts = s.split(':').map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return 0;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Math.max(0, sec);
}

function artistOf(song) {
  return (song && (song.artist || (song.apple_music && song.apple_music.artistName) || '')) || '';
}
function albumOf(song) {
  return (song && (song.album || (song.apple_music && song.apple_music.albumName) || '')) || '';
}

// AudD's enterprise response does not reliably carry a per-match confidence
// score, but some plans/fields do. When a numeric score is present (a number, or
// a "NN%" string) we return it 0–100; otherwise null so the caller doesn't
// filter blind. With no score, AudD precision rests on the YouTube validation.
function scoreOf(song) {
  if (song == null || song.score == null) return null;
  const n = parseFloat(String(song.score));
  return Number.isFinite(n) ? n : null;
}

// The enterprise payload is an array; each element carries an `offset` plus a
// `songs` array (occasionally a single song inline). Flatten to our shape,
// dropping any song below the confidence floor and keeping each surviving song
// with its timestamp — the orchestrator merges duplicates.
function flatten(result, minConfidence) {
  const out = [];
  const list = Array.isArray(result) ? result : (result ? [result] : []);
  for (const entry of list) {
    if (!entry) continue;
    const offsetSec = parseOffset(entry.offset != null ? entry.offset : entry.time);
    const songs = Array.isArray(entry.songs) ? entry.songs : (entry.title ? [entry] : []);
    for (const song of songs) {
      const title = (song && song.title) ? String(song.title).trim() : '';
      if (!title) continue;
      const score = scoreOf(song);
      if (score != null && score < minConfidence) continue;
      out.push({
        title,
        artist: String(artistOf(song)).trim(),
        album: String(albumOf(song)).trim(),
        // A per-song timecode (offset within the matched segment) is more precise
        // than the segment offset when present.
        offsetSec: song.timecode != null ? parseOffset(song.timecode) : offsetSec,
        score: score != null ? score : undefined,
      });
    }
  }
  return out;
}

export async function recognize(audioPath, { settings, signal, onProgress } = {}) {
  if (onProgress) onProgress({ done: 0, total: 1 });

  // Prefer a file-backed Blob so the whole set isn't read into a JS Buffer and
  // then copied again into a Blob (~2× peak memory). Fall back to readFile on
  // older runtimes without openAsBlob.
  let fileBlob;
  try {
    fileBlob = await openAsBlob(audioPath);
  } catch (_) {
    fileBlob = new Blob([await readFile(audioPath)]);
  }

  // One whole-file upload, retried on transient failure (HTTP 429/5xx, network
  // error, or AudD's in-body 901 "too many requests"). A transient blip must not
  // throw away a multi-minute download + scan.
  let json = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    const last = attempt === MAX_ATTEMPTS - 1;

    const form = new FormData();
    form.append('api_token', settings.auddApiToken);
    // AudD samples in 12 s chunks: `every` = how many chunks to scan in a row,
    // `skip` = how many to skip after them (verified against docs.audd.io). So
    // every=1 / skip=0 scans every chunk back-to-back — a continuous, non-sampled
    // scan (~1 request per 12 s of audio), with nothing skipped.
    form.append('every', '1');
    form.append('skip', '0');
    form.append('return', 'apple_music,spotify');
    form.append('file', fileBlob, 'set.mp3');

    let res;
    try {
      res = await fetch(ENDPOINT, { method: 'POST', body: form, signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('Extraction cancelled.');
      if (last) throw new Error(`AudD request failed: ${err.message}`);
      await backoff(attempt, null, signal);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (last) throw new Error(`AudD request failed (HTTP ${res.status}).`);
      await backoff(attempt, parseRetryAfter(res.headers.get('retry-after')), signal);
      continue;
    }
    if (!res.ok) throw new Error(`AudD request failed (HTTP ${res.status}).`);

    json = await res.json();
    if (json && json.status === 'error') {
      const code = json.error && json.error.error_code;
      const msg = (json.error && json.error.error_message) || 'unknown error';
      if (code === 901 && !last) {   // rate-limited — back off and retry
        await backoff(attempt, null, signal);
        json = null;
        continue;
      }
      throw new Error(`AudD: ${msg}`);
    }
    break;   // success
  }

  const tracks = flatten(json && json.result, minConfidenceOf(settings));
  if (onProgress) onProgress({ done: 1, total: 1 });
  return { tracks };
}
