// SetEngine — Structural segmentation (where to listen)
//
// Decides *which moments* of a DJ set are worth sending to a recogniser. This
// exists because of a hard measured limit: Shazam's endpoint serves ~15 requests
// in a burst and then returns 429, and only sustains roughly one request every
// 4 seconds. Probing a 90-minute set every 30 s would be ~180 requests — twelve
// minutes of the run spent purely waiting on rate limits, for a set that only
// contains ~20 tracks.
//
// So instead of scanning blindly, find the transitions first, offline and free,
// and spend one or two requests per *track* rather than per time slice. A
// 20-track set costs ~40 requests instead of ~180.
//
// Method: a DJ transition is a change in timbre that persists. Frame-to-frame
// spectral flux is the wrong tool — it fires on every kick drum and says nothing
// about structure. Instead compare the *average* spectral profile of the ~20 s
// before a moment against the ~20 s after it (a coarse novelty curve, the same
// idea as Foote's checkerboard kernel). A crossfade shows up as a broad hump in
// that curve; a snare fill does not.
//
// Reuses the FFT/window helpers in dsp.js. No network, no state.

import { makeFft, hannWindow } from './dsp.js';

const FRAME = 2048;
const HOP = 1024;

// Log-spaced bands: timbre change is what we're after, so coarse bands that
// follow pitch perception beat raw bins, and they make the profile cheap to
// compare.
const BANDS = 24;
const BAND_MIN_HZ = 40;
const BAND_MAX_HZ = 7500;

// Half-width of the comparison window, in seconds. Sized to a DJ transition:
// long enough that a breakdown or a drum fill doesn't register, short enough to
// localise a 16–30 s crossfade.
const CONTEXT_SEC = 20;

// Two tracks rarely change inside this, so boundaries closer than this are the
// same transition detected twice.
const MIN_BOUNDARY_GAP_SEC = 50;

// Novelty peaks below (mean + this × stddev) aren't transitions.
const PEAK_SENSITIVITY = 0.8;

// If a segment runs longer than this, something was missed — probe inside it
// anyway so a long unsegmented stretch can't hide a track.
const MAX_SEGMENT_SEC = 240;

const fft = makeFft(FRAME);
const HANN = hannWindow(FRAME);

// Per-second, L2-normalised log-band profiles. Normalising is what makes this
// robust to a DJ riding the gain: we want timbre change, not level change.
function bandProfiles(pcm, sampleRate) {
  const half = FRAME >> 1;
  const binHz = sampleRate / FRAME;
  const edges = new Float64Array(BANDS + 1);
  for (let i = 0; i <= BANDS; i++) {
    edges[i] = BAND_MIN_HZ * Math.pow(BAND_MAX_HZ / BAND_MIN_HZ, i / BANDS);
  }
  const binBand = new Int16Array(half + 1).fill(-1);
  for (let b = 1; b <= half; b++) {
    const hz = b * binHz;
    if (hz < edges[0] || hz > edges[BANDS]) continue;
    let band = 0;
    while (band < BANDS - 1 && hz >= edges[band + 1]) band++;
    binBand[b] = band;
  }

  const frameCount = pcm.length > FRAME ? Math.floor((pcm.length - FRAME) / HOP) + 1 : 0;
  const totalSec = Math.max(1, Math.ceil(pcm.length / sampleRate));
  const acc = new Float64Array(totalSec * BANDS);
  const counts = new Float64Array(totalSec);

  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const frameBands = new Float64Array(BANDS);

  for (let k = 0; k < frameCount; k++) {
    const start = k * HOP;
    im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = pcm[start + i] * HANN[i];
    fft(re, im);

    frameBands.fill(0);
    for (let b = 1; b <= half; b++) {
      const band = binBand[b];
      if (band < 0) continue;
      frameBands[band] += re[b] * re[b] + im[b] * im[b];
    }
    const sec = Math.min(totalSec - 1, Math.floor((start + FRAME / 2) / sampleRate));
    for (let i = 0; i < BANDS; i++) acc[sec * BANDS + i] += Math.log1p(frameBands[i]);
    counts[sec]++;
  }

  for (let s = 0; s < totalSec; s++) {
    const n = counts[s] || 1;
    let norm = 0;
    for (let i = 0; i < BANDS; i++) {
      const v = acc[s * BANDS + i] / n;
      acc[s * BANDS + i] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < BANDS; i++) acc[s * BANDS + i] /= norm;
  }
  return { profiles: acc, totalSec };
}

// Cosine distance between the mean profile before and after each second.
function noveltyCurve(profiles, totalSec) {
  const novelty = new Float64Array(totalSec);
  const before = new Float64Array(BANDS);
  const after = new Float64Array(BANDS);
  for (let s = 0; s < totalSec; s++) {
    const aLo = Math.max(0, s - CONTEXT_SEC);
    const bHi = Math.min(totalSec - 1, s + CONTEXT_SEC);
    if (s - aLo < 5 || bHi - s < 5) continue;      // not enough context at the edges
    before.fill(0); after.fill(0);
    for (let t = aLo; t < s; t++) for (let i = 0; i < BANDS; i++) before[i] += profiles[t * BANDS + i];
    for (let t = s; t <= bHi; t++) for (let i = 0; i < BANDS; i++) after[i] += profiles[t * BANDS + i];
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < BANDS; i++) {
      dot += before[i] * after[i];
      na += before[i] * before[i];
      nb += after[i] * after[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    novelty[s] = denom > 0 ? 1 - dot / denom : 0;
  }
  return novelty;
}

function pickBoundaries(novelty, totalSec) {
  let sum = 0, n = 0;
  for (let s = 0; s < totalSec; s++) if (novelty[s] > 0) { sum += novelty[s]; n++; }
  if (n === 0) return [];
  const mean = sum / n;
  let varSum = 0;
  for (let s = 0; s < totalSec; s++) if (novelty[s] > 0) varSum += (novelty[s] - mean) ** 2;
  const threshold = mean + PEAK_SENSITIVITY * Math.sqrt(varSum / n);

  // Strongest-first selection with a minimum gap, so one broad crossfade hump
  // yields exactly one boundary instead of a cluster.
  const candidates = [];
  for (let s = 1; s < totalSec - 1; s++) {
    if (novelty[s] < threshold) continue;
    if (novelty[s] < novelty[s - 1] || novelty[s] < novelty[s + 1]) continue;
    candidates.push(s);
  }
  candidates.sort((a, b) => novelty[b] - novelty[a]);

  const chosen = [];
  for (const s of candidates) {
    if (chosen.every((c) => Math.abs(c - s) >= MIN_BOUNDARY_GAP_SEC)) chosen.push(s);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * Choose the moments to send to the recogniser.
 *
 * Two probes per segment, at ~1/3 and ~2/3 through. Two rather than one for two
 * reasons: a single probe can land in a breakdown or an a-cappella stretch that
 * won't match, and two independent hits are what lets the recogniser express
 * confidence in a track (see shazam/recognize.js).
 *
 * @param {Float32Array} pcm mono PCM
 * @param {number} sampleRate Hz
 * @param {{ maxProbes?: number }} opts
 * @returns {{ probes: number[], boundaries: number[], fallback: boolean }} seconds
 */
export function findProbePoints(pcm, sampleRate, { maxProbes = 80 } = {}) {
  const totalSec = Math.max(1, Math.floor(pcm.length / sampleRate));
  if (totalSec < 60) {
    return { probes: [Math.floor(totalSec / 2)], boundaries: [], fallback: true };
  }

  const { profiles, totalSec: n } = bandProfiles(pcm, sampleRate);
  const novelty = noveltyCurve(profiles, n);
  let boundaries = pickBoundaries(novelty, n);

  // Split any stretch that stayed suspiciously uniform — a long ambient or
  // beat-matched run can hide a transition from the novelty curve, and a missed
  // boundary means a missed track.
  const bounded = [0, ...boundaries, totalSec];
  const filled = [];
  for (let i = 0; i < bounded.length - 1; i++) {
    filled.push(bounded[i]);
    const span = bounded[i + 1] - bounded[i];
    if (span > MAX_SEGMENT_SEC) {
      const pieces = Math.ceil(span / MAX_SEGMENT_SEC);
      for (let p = 1; p < pieces; p++) filled.push(bounded[i] + Math.round((span * p) / pieces));
    }
  }
  filled.push(totalSec);

  const probes = [];
  for (let i = 0; i < filled.length - 1; i++) {
    const a = filled[i];
    const b = filled[i + 1];
    const span = b - a;
    if (span < 20) { probes.push(Math.floor(a + span / 2)); continue; }
    probes.push(Math.floor(a + span / 3));
    probes.push(Math.floor(a + (2 * span) / 3));
  }

  // Stay inside the request budget by thinning evenly rather than truncating —
  // dropping the tail would leave the end of the set unscanned entirely.
  let final = probes.filter((s) => s >= 0 && s < totalSec);
  if (final.length > maxProbes) {
    const step = final.length / maxProbes;
    const thinned = [];
    for (let i = 0; i < maxProbes; i++) thinned.push(final[Math.floor(i * step)]);
    final = thinned;
  }

  return { probes: [...new Set(final)].sort((a, b) => a - b), boundaries, fallback: boundaries.length === 0 };
}
