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

import { readFile } from 'node:fs/promises';

const ENDPOINT = 'https://enterprise.audd.io/';

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

// The enterprise payload is an array; each element carries an `offset` plus a
// `songs` array (occasionally a single song inline). Flatten to our shape,
// keeping every song with its timestamp — the orchestrator merges duplicates.
function flatten(result) {
  const out = [];
  const list = Array.isArray(result) ? result : (result ? [result] : []);
  for (const entry of list) {
    if (!entry) continue;
    const offsetSec = parseOffset(entry.offset != null ? entry.offset : entry.time);
    const songs = Array.isArray(entry.songs) ? entry.songs : (entry.title ? [entry] : []);
    for (const song of songs) {
      const title = (song && song.title) ? String(song.title).trim() : '';
      if (!title) continue;
      out.push({
        title,
        artist: String(artistOf(song)).trim(),
        album: String(albumOf(song)).trim(),
        // A per-song timecode (offset within the matched segment) is more precise
        // than the segment offset when present.
        offsetSec: song.timecode != null ? parseOffset(song.timecode) : offsetSec,
      });
    }
  }
  return out;
}

export async function recognize(audioPath, { settings, signal, onProgress } = {}) {
  if (onProgress) onProgress({ done: 0, total: 1 });

  const buf = await readFile(audioPath);
  const form = new FormData();
  form.append('api_token', settings.auddApiToken);
  form.append('every', '1');   // scan every 12 s window — continuous, nothing skipped
  form.append('skip', '0');
  form.append('return', 'apple_music,spotify');
  form.append('file', new Blob([buf]), 'set.mp3');

  const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal });
  if (!res.ok) {
    throw new Error(`AudD request failed (HTTP ${res.status}).`);
  }
  const json = await res.json();
  if (json && json.status === 'error') {
    const msg = (json.error && json.error.error_message) || 'unknown error';
    throw new Error(`AudD: ${msg}`);
  }

  const tracks = flatten(json && json.result);
  if (onProgress) onProgress({ done: 1, total: 1 });
  return { tracks };
}
