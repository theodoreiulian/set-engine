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

const SEGMENT_SEC = 12;   // sample length ACRCloud expects
const STEP_SEC = 12;      // consecutive, non-overlapping → continuous coverage
const MIN_SEGMENT_BYTES = 1024;

// Cap concurrent in-flight identifications. ACRCloud rate-limits per project and
// we don't want to spawn dozens of ffmpeg cutters at once on long sets.
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

function buildSignature(accessSecret, accessKey, timestamp) {
  const stringToSign = ['POST', '/v1/identify', accessKey, 'audio', '1', timestamp].join('\n');
  return crypto.createHmac('sha1', accessSecret).update(Buffer.from(stringToSign, 'utf-8')).digest('base64');
}

async function identifySegment(sampleBuf, settings, signal) {
  const host = String(settings.acrHost).replace(/^https?:\/\//, '').replace(/\/+$/, '');
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

  const res = await fetch(`https://${host}/v1/identify`, { method: 'POST', body: form, signal });
  if (!res.ok) return null;
  return res.json();
}

function artistsToString(artists) {
  if (!Array.isArray(artists)) return '';
  return artists.map((a) => (a && a.name) ? a.name : '').filter(Boolean).join(', ');
}

// status.code 0 = success; 1001 = no result (a non-music window, normal). Map the
// top music match to our shape; return null for no/failed match.
function pickMatch(json, offsetSec) {
  const music = json && json.metadata && json.metadata.music;
  if (!Array.isArray(music) || music.length === 0) return null;
  const m = music[0];
  const title = (m && m.title) ? String(m.title).trim() : '';
  if (!title) return null;
  return {
    title,
    artist: artistsToString(m.artists).trim(),
    album: (m.album && m.album.name) ? String(m.album.name).trim() : '',
    offsetSec,
  };
}

export async function recognize(audioPath, { settings, signal, onProgress, durationSec } = {}) {
  const total = Math.max(1, Math.ceil((Number(durationSec) || 0) / STEP_SEC));
  const tracks = [];
  let done = 0;

  const tasks = [];
  for (let i = 0; i < total; i++) {
    const offsetSec = i * STEP_SEC;
    tasks.push(limit(async () => {
      if (signal && signal.aborted) return;
      try {
        const sample = await extractSegment(audioPath, offsetSec, SEGMENT_SEC, signal);
        if (sample && sample.length >= MIN_SEGMENT_BYTES && !(signal && signal.aborted)) {
          const json = await identifySegment(sample, settings, signal);
          const match = pickMatch(json, offsetSec);
          if (match) tracks.push(match);
        }
      } catch (_) {
        // Fail-soft: a single bad window must not abort the scan.
      } finally {
        done++;
        if (onProgress) onProgress({ done, total });
      }
    }));
  }
  await Promise.all(tasks);

  tracks.sort((a, b) => a.offsetSec - b.offsetSec);
  return { tracks };
}
