// SetEngine — ACRCloud recognizer
//
// ACRCloud's identification API matches a short audio sample against its
// 150M+ track database and is robust to the speed/pitch changes and remixes
// common in DJ sets. The API takes one ~12 s sample per request, so to scan a
// whole set we cut it into consecutive windows with ffmpeg (same spawn pattern
// as audio-analyzer.js) and identify each, then let the orchestrator merge
// adjacent duplicates into the play-order tracklist.
//
// Each request is authenticated with an HMAC-SHA1 signature over a fixed
// string-to-sign (per ACRCloud's v1 scheme). Per-segment failures are swallowed
// (fail-soft) so one bad window never aborts the whole scan.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import { backoff, parseRetryAfter } from './retry.js';
import { minConfidenceOf } from './util.js';

const SEGMENT_SEC = 12;   // sample length per identify request
// 50% overlap (6 s step over a 12 s window): a track that straddles a window
// boundary — exactly what happens at every mix transition, and for briefly
// played tracks — still lands cleanly inside an adjacent window. Costs ~2× the
// requests of non-overlapping scanning; the retry/backoff below absorbs the
// extra rate pressure. Raise back to 12 to halve requests at some recall cost.
const STEP_SEC = 6;
const MIN_SEGMENT_BYTES = 1024;
const MAX_ATTEMPTS = 5;    // per-window identify attempts before giving up

// ACRCloud returns HTTP 200 even when throttled, flagging it in status.code:
// 3003 = QPS limit exceeded, 3015 = service busy/limited — both transient, so
// retry. (0 = match and 1001 = no result are terminal; auth/signature errors
// aren't retryable.)
const RETRYABLE_ACR_CODES = new Set([3003, 3015]);

// status.code values that mean the credentials/config are wrong, not that the
// audio is unrecognizable. ACRCloud returns these with HTTP 200 on every window,
// so without special handling a bad key/secret looks identical to "no tracks
// found" — after a full download + scan. We surface them as a hard, immediate
// error instead. (3001 invalid access key, 3002 invalid content/signature, 3006
// invalid parameters, 3014 invalid signature.)
const ACR_AUTH_CODES = new Map([
  [3001, 'invalid access key'],
  [3002, 'invalid signature / content type'],
  [3006, 'invalid request parameters'],
  [3014, 'invalid signature'],
]);

// Thrown when ACRCloud rejects the credentials. Distinct class so the scan loop
// can tell it apart from a fail-soft per-window error and abort the whole run.
class AcrAuthError extends Error {}

// Cap concurrent in-flight identifications. ACRCloud rate-limits per project and
// we don't want to spawn dozens of ffmpeg cutters at once on long sets. Note the
// total cost: with 50% overlap a 1 h set is ~600 windows, i.e. ~600 short ffmpeg
// spawns + ~600 identify requests (capped at 4 at a time). If scan time ever
// becomes a complaint, cutting many windows in one pass via ffmpeg's `segment`
// muxer would cut the process churn.
const limit = pLimit(4);

// Cut [startSec, startSec+durSec) to mono 8 kHz WAV bytes — small and plenty for
// fingerprinting. Resolves to a Buffer; rejects only on a hard ffmpeg failure.
function extractSegment(filePath, startSec, durSec, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-ss', String(startSec),
      '-t', String(durSec),
      '-i', filePath,
      '-ac', '1',
      '-ar', '8000',
      '-f', 'wav',
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);
    const chunks = [];
    let stderr = '';
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch (_) { /* gone */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 200).trim()}`));
    });
  });
}

// Probe a media file's duration (seconds) with ffprobe. Best-effort: resolves 0
// on any failure. Used as a fallback when the caller couldn't read a duration
// up front — without it, an unknown duration would make the scan cover only the
// first window and silently miss the rest of the set.
function probeDurationSec(filePath) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
    } catch (_) { resolve(0); return; }
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.stderr.on('data', () => { /* ignore */ });
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}

function buildSignature(accessSecret, accessKey, timestamp) {
  const stringToSign = ['POST', '/v1/identify', accessKey, 'audio', '1', timestamp].join('\n');
  return crypto.createHmac('sha1', accessSecret).update(Buffer.from(stringToSign, 'utf-8')).digest('base64');
}

// Identify one sample, retrying transient failures (HTTP 429/5xx, network blips,
// and ACRCloud's in-body throttle codes) with jittered exponential backoff so a
// rate-limited window is never silently dropped. Returns the parsed JSON, or
// null when it genuinely can't be identified / was cancelled.
async function identifySegment(sampleBuf, settings, signal) {
  const host = String(settings.acrHost).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const url = `https://${host}/v1/identify`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) return null;
    const last = attempt === MAX_ATTEMPTS - 1;

    // Rebuild timestamp + signature + form every attempt: the signature is
    // timestamp-bound, so reusing a stale one after a backoff would be rejected.
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = buildSignature(settings.acrAccessSecret, settings.acrAccessKey, timestamp);
    const form = new FormData();
    form.append('access_key', settings.acrAccessKey);
    form.append('data_type', 'audio');
    form.append('signature_version', '1');
    form.append('signature', signature);
    form.append('timestamp', timestamp);
    form.append('sample_bytes', String(sampleBuf.length));
    form.append('sample', new Blob([sampleBuf]), 'sample.wav');

    let res;
    try {
      res = await fetch(url, { method: 'POST', body: form, signal });
    } catch (err) {
      if (err && err.name === 'AbortError') return null;   // cancelled — stop
      if (last) return null;
      await backoff(attempt, null, signal);                // network blip — retry
      continue;
    }

    // Transient HTTP: 429 (rate limit) / 5xx (server). Honour Retry-After.
    if (res.status === 429 || res.status >= 500) {
      if (last) return null;
      await backoff(attempt, parseRetryAfter(res.headers.get('retry-after')), signal);
      continue;
    }
    // 401/403 are credential rejections — fatal, not a fail-soft "no match".
    if (res.status === 401 || res.status === 403) {
      throw new AcrAuthError(`ACRCloud rejected the credentials (HTTP ${res.status}) — check the host, access key, and secret in Settings.`);
    }
    if (!res.ok) return null;   // other 4xx (bad request) — not retryable

    let json;
    try { json = await res.json(); } catch (_) { return null; }

    // In-body throttle codes arrive with HTTP 200 — retry those too.
    const code = (json && json.status && typeof json.status.code === 'number') ? json.status.code : null;
    // Auth/config errors also arrive with HTTP 200; they'd repeat on every
    // window, so surface them immediately instead of scanning to an empty result.
    if (code != null && ACR_AUTH_CODES.has(code)) {
      throw new AcrAuthError(`ACRCloud: ${ACR_AUTH_CODES.get(code)} — check the host, access key, and secret in Settings.`);
    }
    if (code != null && RETRYABLE_ACR_CODES.has(code) && !last) {
      await backoff(attempt, null, signal);
      continue;
    }
    return json;
  }
  return null;
}

function artistsToString(artists) {
  if (!Array.isArray(artists)) return '';
  return artists.map((a) => (a && a.name) ? a.name : '').filter(Boolean).join(', ');
}

// status.code 0 = success; 1001 = no result (a non-music window, normal). Map the
// top music match to our shape; return null for no/failed/low-confidence match.
function pickMatch(json, offsetSec, minConfidence) {
  const music = json && json.metadata && json.metadata.music;
  if (!Array.isArray(music) || music.length === 0) return null;
  const m = music[0];
  const title = (m && m.title) ? String(m.title).trim() : '';
  if (!title) return null;
  // ACRCloud's `score` (0–100) is its match confidence. On material it can't
  // fingerprint cleanly — heavily-effected, pitched, or beatmatched-overlap
  // windows, the norm in DJ sets — it returns a *low-score* spurious match
  // rather than nothing. Dropping those below the floor is what stops unrelated
  // tracks (e.g. an old jazz record in a techno set) from reaching download.
  const score = (m && typeof m.score === 'number') ? m.score : null;
  if (score != null && score < minConfidence) return null;
  return {
    title,
    artist: artistsToString(m.artists).trim(),
    album: (m.album && m.album.name) ? String(m.album.name).trim() : '',
    offsetSec,
    score: score != null ? score : undefined,
  };
}

export async function recognize(audioPath, { settings, signal, onProgress, durationSec } = {}) {
  // A missing/zero duration (livestream VODs, metadata-parse failures) would
  // otherwise collapse `total` to 1 and scan only the first 12 s of the set.
  // Probe the actual file length as a fallback before sizing the scan.
  let effectiveDuration = Number(durationSec) || 0;
  if (!effectiveDuration) effectiveDuration = await probeDurationSec(audioPath);

  const total = Math.max(1, Math.ceil(effectiveDuration / STEP_SEC));
  const minConfidence = minConfidenceOf(settings);
  const tracks = [];
  let done = 0;
  let authError = null;   // set if ACRCloud rejects the credentials → fatal

  const tasks = [];
  for (let i = 0; i < total; i++) {
    const offsetSec = i * STEP_SEC;
    tasks.push(limit(async () => {
      if (authError || (signal && signal.aborted)) return;
      try {
        const sample = await extractSegment(audioPath, offsetSec, SEGMENT_SEC, signal);
        if (sample && sample.length >= MIN_SEGMENT_BYTES && !(signal && signal.aborted)) {
          const json = await identifySegment(sample, settings, signal);
          const match = pickMatch(json, offsetSec, minConfidence);
          if (match) tracks.push(match);
        }
      } catch (err) {
        // A credential rejection is fatal — record it and let queued windows
        // early-return. Everything else is fail-soft: one bad window must not
        // abort the scan.
        if (err instanceof AcrAuthError && !authError) authError = err;
      } finally {
        done++;
        if (onProgress) onProgress({ done, total });
      }
    }));
  }
  await Promise.all(tasks);

  if (authError) throw authError;

  tracks.sort((a, b) => a.offsetSec - b.offsetSec);
  return { tracks };
}
