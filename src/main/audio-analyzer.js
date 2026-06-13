// SetEngine — Audio Analyzer
//
// Extracts the transition-relevant features the Set Maker needs that ID3 tags
// can't provide: frequency-band balance (bass/mid/high), spectral brightness,
// and intro/outro length from an RMS-envelope walk.
//
// Pipeline:
//   1. Spawn ffmpeg to decode the source file to mono Float32 PCM at 22.05 kHz.
//   2. Compute the band-power spectrum via a windowed STFT (Hann, 2048/1024).
//   3. Compute the global RMS envelope (1 frame ≈ 46 ms) and walk it from
//      both ends to find the sustained-energy region.
//
// We deliberately avoid pulling in a heavy WASM analysis library (essentia.js
// etc.) — the features we need are simple, the math is well-trodden, and
// Electron+Vite+WASM has its own integration tax. The interface here is the
// same shape essentia would produce, so swapping is straightforward later.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import pLimit from 'p-limit';

const SAMPLE_RATE = 22050;
const FRAME_SIZE = 2048;          // power of two, ~93 ms at 22.05 kHz
const HOP_SIZE = 1024;            // 50% overlap
const HOP_MS = (HOP_SIZE / SAMPLE_RATE) * 1000;

// Frequency band cutoffs in Hz.
const BAND_LOW = 250;
const BAND_MID = 4000;

// Cap concurrency so we never have more than two ffmpeg + FFT pipelines
// running at once. The CPU cost is dominated by the FFTs, not ffmpeg.
const analyzerLimit = pLimit(2);

// ── Public API ────────────────────────────────────────────────────────

export async function analyzeTrack(filePath) {
  return analyzerLimit(() => doAnalyze(filePath));
}

// ── Decode ────────────────────────────────────────────────────────────

// Decode any ffmpeg-readable file to mono Float32 PCM at SAMPLE_RATE. Exported
// so the BPM/key detector reuses the exact same decode path (one source of truth).
export function decodePcm(filePath, sampleRate = SAMPLE_RATE) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-i', filePath,
      '-f', 'f32le',
      '-ac', '1',
      '-ar', String(sampleRate),
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);
    const chunks = [];
    let totalLen = 0;
    let stderr = '';
    proc.stdout.on('data', (c) => { chunks.push(c); totalLen += c.length; });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400).trim()}`));
        return;
      }
      const buf = Buffer.concat(chunks, totalLen);
      // Make a copy so we own the underlying memory.
      const out = new Float32Array(totalLen / 4);
      const view = new Float32Array(buf.buffer, buf.byteOffset, totalLen / 4);
      out.set(view);
      resolve(out);
    });
  });
}

// ── FFT (radix-2, in-place Cooley–Tukey) ──────────────────────────────

const HANN = (() => {
  const w = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1)));
  }
  return w;
})();

// Precomputed bit-reversal indices and twiddle factors for FRAME_SIZE.
const FFT_BITS = Math.log2(FRAME_SIZE) | 0;
const FFT_REV = (() => {
  const r = new Uint32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    let x = i, y = 0;
    for (let j = 0; j < FFT_BITS; j++) { y = (y << 1) | (x & 1); x >>= 1; }
    r[i] = y;
  }
  return r;
})();

function fftInPlace(re, im) {
  // Bit-reverse permutation.
  for (let i = 0; i < FRAME_SIZE; i++) {
    const j = FFT_REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Cooley–Tukey butterflies.
  for (let size = 2; size <= FRAME_SIZE; size <<= 1) {
    const half = size >> 1;
    const phaseStep = (-2 * Math.PI) / size;
    for (let k = 0; k < FRAME_SIZE; k += size) {
      for (let j = 0; j < half; j++) {
        const phase = phaseStep * j;
        const cos = Math.cos(phase);
        const sin = Math.sin(phase);
        const aRe = re[k + j];
        const aIm = im[k + j];
        const bRe = re[k + j + half];
        const bIm = im[k + j + half];
        const tRe = bRe * cos - bIm * sin;
        const tIm = bRe * sin + bIm * cos;
        re[k + j] = aRe + tRe;
        im[k + j] = aIm + tIm;
        re[k + j + half] = aRe - tRe;
        im[k + j + half] = aIm - tIm;
      }
    }
  }
}

// ── Feature extraction ────────────────────────────────────────────────

function binForHz(hz) {
  return Math.round((hz * FRAME_SIZE) / SAMPLE_RATE);
}

function computeFeatures(samples) {
  const numFrames = Math.max(0, Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1);
  if (numFrames < 4) throw new Error('Audio too short to analyze');

  const re = new Float32Array(FRAME_SIZE);
  const im = new Float32Array(FRAME_SIZE);

  const lowEnd = binForHz(BAND_LOW);
  const midEnd = binForHz(BAND_MID);
  const nyquistBin = FRAME_SIZE >> 1;

  let lowSum = 0, midSum = 0, highSum = 0;
  const envelope = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * HOP_SIZE;
    let rms = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const s = samples[offset + i];
      rms += s * s;
      re[i] = s * HANN[i];
      im[i] = 0;
    }
    envelope[f] = Math.sqrt(rms / FRAME_SIZE);

    fftInPlace(re, im);

    let low = 0, mid = 0, high = 0;
    for (let k = 1; k < nyquistBin; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      if (k < lowEnd) low += power;
      else if (k < midEnd) mid += power;
      else high += power;
    }
    lowSum += low;
    midSum += mid;
    highSum += high;
  }

  const total = lowSum + midSum + highSum;
  const bandRms = total > 0
    ? { low: lowSum / total, mid: midSum / total, high: highSum / total }
    : { low: 0, mid: 0, high: 0 };
  const brightness = total > 0 ? highSum / total : 0;

  return { envelope, bandRms, brightness };
}

// Walk the RMS envelope from both ends to find the "sustained-energy"
// region. We define sustained as >= 0.6 × median(envelope) for ≥ ~1.5s of
// consecutive frames. introMs/outroMs are the lengths of the lower-energy
// regions on either side — i.e. how long DJs have room to blend.
function findActiveRegion(envelope) {
  if (envelope.length < 4) return { introFrames: 0, outroFrames: 0 };
  const sorted = Array.from(envelope).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const threshold = 0.6 * median;
  const runFrames = Math.max(4, Math.round(1500 / HOP_MS));

  // From start: first run of length >= runFrames where every frame >= threshold.
  let introFrames = 0;
  for (let i = 0; i <= envelope.length - runFrames; i++) {
    let ok = true;
    for (let j = 0; j < runFrames; j++) {
      if (envelope[i + j] < threshold) { ok = false; i = i + j; break; }
    }
    if (ok) { introFrames = i; break; }
    if (i === envelope.length - runFrames) introFrames = i;
  }

  // From end: mirror.
  let outroFrames = 0;
  for (let i = envelope.length - 1; i >= runFrames - 1; i--) {
    let ok = true;
    for (let j = 0; j < runFrames; j++) {
      if (envelope[i - j] < threshold) { ok = false; i = i - j; break; }
    }
    if (ok) { outroFrames = envelope.length - 1 - i; break; }
    if (i === runFrames - 1) outroFrames = envelope.length - 1 - i;
  }

  return { introFrames, outroFrames };
}

// ── Orchestration ─────────────────────────────────────────────────────

async function doAnalyze(filePath) {
  const fileStat = await stat(filePath);
  const samples = await decodePcm(filePath);
  if (samples.length < SAMPLE_RATE) {
    throw new Error('Audio too short to analyze');
  }

  const { envelope, bandRms, brightness } = computeFeatures(samples);
  const { introFrames, outroFrames } = findActiveRegion(envelope);

  return {
    mtime: fileStat.mtimeMs,
    bandRms,
    brightness,
    introMs: Math.round(introFrames * HOP_MS),
    outroMs: Math.round(outroFrames * HOP_MS),
    durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
  };
}
