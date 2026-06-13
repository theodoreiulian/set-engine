// SetEngine — BPM & Key detector
//
// Estimates tempo and musical key directly from the audio when ID3/Vorbis tags
// don't carry them. Free, fully offline, no external services — just ffmpeg
// (already required) for decode plus pure-JS DSP.
//
// Tempo:  dual-band onset envelope (full-band log-flux + a low/kick band) →
//         TWO complementary saliences over the whole BPM range — weighted
//         autocorrelation AND a comb-filter tempogram — combined by product so a
//         lag must be periodic under both (kills spurious single-method peaks) →
//         metrical-level choice via a gentle perceptual prior plus harmonic
//         support → phase-locked comb refinement for a precise decimal BPM. Also
//         returns the candidate metrical levels so the consensus layer can match
//         an external reference BPM at any octave.
// Key:    tuned chromagram (tuning estimated per-track so off-A440 material still
//         bins correctly) → Krumhansl–Kessler profile correlation over all 24
//         major/minor keys → Camelot + musical-name output.
//
// Both share a single ffmpeg decode (reused from audio-analyzer.js) and the
// size-parameterized FFT in dsp.js.

import pLimit from 'p-limit';
import { decodePcm } from './audio-analyzer.js';
import { makeFft, hannWindow } from './dsp.js';

const SAMPLE_RATE = 22050;

// Don't chew on absurdly long files; the first several minutes are plenty for
// both tempo and key on DJ material.
const MAX_SECONDS = 8 * 60;

// Match the audio-analyzer concurrency cap — the cost is dominated by the FFTs.
const detectLimit = pLimit(2);

// ── Camelot mapping (mirrors tunematch/engine.js so main has no renderer dep) ──

const CAMELOT_TO_PITCH = {
  '1A': 8,  '2A': 3,  '3A': 10, '4A': 5,  '5A': 0,  '6A': 7,
  '7A': 2,  '8A': 9,  '9A': 4,  '10A': 11, '11A': 6, '12A': 1,
  '1B': 11, '2B': 6,  '3B': 1,  '4B': 8,  '5B': 3,  '6B': 10,
  '7B': 5,  '8B': 0,  '9B': 7,  '10B': 2, '11B': 9, '12B': 4,
};
const CAMELOT_TO_NAME = {
  '1A': 'Abm', '2A': 'Ebm', '3A': 'Bbm', '4A': 'Fm',
  '5A': 'Cm',  '6A': 'Gm',  '7A': 'Dm',  '8A': 'Am',
  '9A': 'Em',  '10A': 'Bm', '11A': 'F#m', '12A': 'C#m',
  '1B': 'B',   '2B': 'F#',  '3B': 'Db',  '4B': 'Ab',
  '5B': 'Eb',  '6B': 'Bb',  '7B': 'F',   '8B': 'C',
  '9B': 'G',   '10B': 'D',  '11B': 'A',  '12B': 'E',
};
// (pitchClass, mode) → Camelot code. 'A' codes are minor, 'B' codes major.
const PC_MODE_TO_CAMELOT = {};
for (const [code, pc] of Object.entries(CAMELOT_TO_PITCH)) {
  const mode = code.endsWith('A') ? 'minor' : 'major';
  PC_MODE_TO_CAMELOT[`${pc}:${mode}`] = code;
}

// ── Public API ────────────────────────────────────────────────────────

// Detect tempo and/or key for one file. `opts.needBpm`/`opts.needKey` default
// to true; set false to skip the half you already have (gap-fill).
// Returns { bpm, bpmConfidence, bpmCandidates, keyCamelot, keyName,
// keyConfidence, durationSec }. `bpmCandidates` lists the plausible metrical
// levels ({bpm, salience}) so the consensus layer can match an external BPM at
// any octave; `durationSec` is the true (uncapped) track length for matching.
export async function detectKeyBpm(filePath, opts = {}) {
  const needBpm = opts.needBpm !== false;
  const needKey = opts.needKey !== false;
  return detectLimit(() => doDetect(filePath, needBpm, needKey));
}

async function doDetect(filePath, needBpm, needKey) {
  let samples = await decodePcm(filePath, SAMPLE_RATE);
  if (samples.length < SAMPLE_RATE) throw new Error('Audio too short to analyze');
  const durationSec = samples.length / SAMPLE_RATE;   // true length, before the cap
  const cap = MAX_SECONDS * SAMPLE_RATE;
  if (samples.length > cap) samples = samples.subarray(0, cap);

  const result = {
    bpm: 0, bpmConfidence: 0, bpmCandidates: [],
    keyCamelot: '', keyName: '', keyConfidence: 0,
    durationSec,
  };

  if (needBpm) {
    const t = detectTempo(samples);
    result.bpm = t.bpm;
    result.bpmConfidence = t.confidence;
    result.bpmCandidates = t.candidates;
  }
  if (needKey) {
    const k = detectKey(samples);
    result.keyCamelot = k.camelot;
    result.keyName = k.name;
    result.keyConfidence = k.confidence;
  }
  return result;
}

// ── Tempo ─────────────────────────────────────────────────────────────

const ODF_FFT = 1024;
const ODF_HOP = 256;
const ODF_FPS = SAMPLE_RATE / ODF_HOP;   // ≈ 86.1 onset frames / sec
const ODF_WIN = hannWindow(ODF_FFT);
const odfFft = makeFft(ODF_FFT);

const MIN_BPM = 60;
const MAX_BPM = 200;
// Perceptual tempo prior (Ellis/Moelants): chooses the *octave* (counting level)
// among comb-verified candidates. Centered on the dance-music tactus this app
// targets — high enough that 128 beats its 64 subharmonic and 174 beats 87,
// without pulling typical 100–110 material up an octave.
const PRIOR_CENTER_BPM = 128;
const PRIOR_SIGMA_OCT = 0.70;            // width in octaves

// Log-compression of the magnitude before differencing — keeps loud and quiet
// passages on comparable footing so flux tracks onsets, not absolute level.
const FLUX_GAMMA = 100;
// Secondary "kick" band: a four-on-the-floor envelope locks onto the true beat
// period instead of a hi-hat subdivision. ~30–200 Hz covers kick fundamental +
// low harmonics.
const KICK_LO_HZ = 30;
const KICK_HI_HZ = 200;
const KICK_WEIGHT = 1.0;

// Flatten a raw flux track (subtract a ~0.4s moving average, half-wave rectify)
// then normalize to unit mean so two bands can be summed on equal footing.
function flattenNormalize(flux, numFrames) {
  const win = Math.max(1, Math.round(0.4 * ODF_FPS));
  const prefix = new Float64Array(numFrames + 1);
  for (let i = 0; i < numFrames; i++) prefix[i + 1] = prefix[i] + flux[i];
  const out = new Float32Array(numFrames);
  let sum = 0;
  for (let i = 0; i < numFrames; i++) {
    const a = Math.max(0, i - win);
    const b = Math.min(numFrames, i + win + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    const v = flux[i] - mean;
    out[i] = v > 0 ? v : 0;
    sum += out[i];
  }
  const m = sum / numFrames;
  if (m > 0) for (let i = 0; i < numFrames; i++) out[i] /= m;
  return out;
}

// Dual-band log-flux onset envelope: full-band (overall onsets) + a low/kick
// band, each flattened+normalized then summed.
function computeOnsetEnvelope(samples) {
  const n = ODF_FFT;
  const half = n >> 1;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const numFrames = Math.max(0, Math.floor((samples.length - n) / ODF_HOP) + 1);
  if (numFrames < 8) return new Float32Array(0);

  const kickLo = Math.max(1, Math.floor((KICK_LO_HZ * n) / SAMPLE_RATE));
  const kickHi = Math.min(half - 1, Math.ceil((KICK_HI_HZ * n) / SAMPLE_RATE));

  const fullFlux = new Float32Array(numFrames);
  const lowFlux = new Float32Array(numFrames);
  let prev = new Float32Array(half);
  let cur = new Float32Array(half);

  for (let f = 0; f < numFrames; f++) {
    const off = f * ODF_HOP;
    for (let i = 0; i < n; i++) { re[i] = samples[off + i] * ODF_WIN[i]; im[i] = 0; }
    odfFft(re, im);
    let sum = 0, lowSum = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.log1p(FLUX_GAMMA * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) {
        sum += d;
        if (k >= kickLo && k <= kickHi) lowSum += d;
      }
    }
    fullFlux[f] = sum;
    lowFlux[f] = lowSum;
    const tmp = prev; prev = cur; cur = tmp;
  }

  const a = flattenNormalize(fullFlux, numFrames);
  const b = flattenNormalize(lowFlux, numFrames);
  const out = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) out[i] = a[i] + KICK_WEIGHT * b[i];
  return out;
}

// True if ratio `r` is within `tol` of any value in `list` (multiplicatively).
function nearRatio(r, list, tol = 0.04) {
  for (const t of list) if (Math.abs(r / t - 1) < tol) return true;
  return false;
}

// The metrical relatives of `bpm` (half/double/triplet levels), each tagged with
// its salience from the combined curve, so the consensus step can match an
// external reference at whatever octave it reports. The chosen level is salience 1.
function buildCandidates(bpm, salAtBpm) {
  const mults = [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3];
  const out = [];
  const seen = new Set();
  for (const m of mults) {
    const b = Math.round(bpm * m * 10) / 10;
    if (b < 40 || b > 280) continue;
    const key = Math.round(b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ bpm: b, salience: m === 1 ? 1 : salAtBpm(b) });
  }
  out.sort((p, q) => q.salience - p.salience);
  return out;
}

// Best-phase comb energy for a (fractional) period, averaged per pulse so we can
// compare periods fairly. Linear-interpolates the envelope between frames.
function combAvgEnergy(env, period) {
  const n = env.length;
  const phaseSteps = Math.min(Math.max(8, Math.round(period)), 48);
  let best = 0;
  for (let s = 0; s < phaseSteps; s++) {
    const phase = (s / phaseSteps) * period;
    let sum = 0, count = 0;
    for (let m = phase; m < n - 1; m += period) {
      const i = m | 0;
      const frac = m - i;
      sum += env[i] * (1 - frac) + env[i + 1] * frac;
      count++;
    }
    const avg = count > 0 ? sum / count : 0;
    if (avg > best) best = avg;
  }
  return best;
}

function detectTempo(samples) {
  const env = computeOnsetEnvelope(samples);
  const n = env.length;
  if (n < 16) return { bpm: 0, confidence: 0, candidates: [] };

  const minLag = Math.max(2, Math.floor((60 * ODF_FPS) / MAX_BPM));
  const maxLag = Math.min(n - 2, Math.ceil((60 * ODF_FPS) / MIN_BPM));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0, candidates: [] };

  // Normalized autocorrelation over all candidate lags (cheap, O(lags·n)).
  // Divided by the overlap count so it's fair across lags — a biased estimator
  // favours short lags.
  const acf = new Float64Array(maxLag + 1);
  let acfMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    s /= (n - lag);
    acf[lag] = s;
    if (s > acfMax) acfMax = s;
  }
  if (acfMax <= 0) return { bpm: 0, confidence: 0, candidates: [] };

  const lagToBpm = (lag) => (60 * ODF_FPS) / lag;
  // ACF salience at an arbitrary BPM, normalized to [0,1] (0 outside range) —
  // a cheap proxy used only to tag candidate octaves for the consensus layer.
  const salAtBpm = (bpm) => {
    const lag = (60 * ODF_FPS) / bpm;
    if (lag < minLag || lag > maxLag - 1) return 0;
    const i = lag | 0, frac = lag - i;
    return (acf[i] * (1 - frac) + acf[i + 1] * frac) / acfMax;
  };

  // Verify each ACF peak with a comb filter. A real periodicity is strong in
  // BOTH the autocorrelation and the comb, so their product suppresses the
  // spurious single-method peaks that cause wild mis-reads. The comb is only
  // evaluated at ACF maxima (≤16), not every lag — same robustness, far cheaper.
  const acfPeakLags = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (acf[lag] >= acf[lag - 1] && acf[lag] > acf[lag + 1] && acf[lag] > 0.1 * acfMax) {
      acfPeakLags.push(lag);
    }
  }
  if (acfPeakLags.length === 0) {
    let argmax = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) if (acf[lag] > acf[argmax]) argmax = lag;
    acfPeakLags.push(argmax);
  }
  acfPeakLags.sort((a, b) => acf[b] - acf[a]);
  const candLags = acfPeakLags.slice(0, 16);

  let combMax = 0;
  const combByLag = new Map();
  for (const lag of candLags) {
    const c = combAvgEnergy(env, lag);
    combByLag.set(lag, c);
    if (c > combMax) combMax = c;
  }
  const peaks = candLags
    .map((lag) => ({
      lag,
      bpm: lagToBpm(lag),
      sal: (acf[lag] / acfMax) * (combMax > 0 ? combByLag.get(lag) / combMax : 0),
    }))
    .filter((p) => p.sal > 0);
  if (peaks.length === 0) peaks.push({ lag: candLags[0], bpm: lagToBpm(candLags[0]), sal: 1 });
  peaks.sort((p, q) => q.sal - p.sal);

  // Strongest salient periodicity — the right *period*, but its octave (counting
  // level) is still ambiguous: a pulse train at 128 is indistinguishable from
  // 64-with-offbeats by salience alone.
  const p0 = peaks[0];

  // Resolve the metrical octave. Among octave relatives of p0 that are genuinely
  // periodic (comb energy near the max), let the perceptual prior pick the
  // tactus. The prior — not raw integer-lag salience, which is noisy and can peak
  // at a subharmonic — decides the level; the comb gate stops it wandering to an
  // unsupported one. Genuinely ambiguous half/double cases are reported with low
  // confidence so the external cross-check breaks the tie.
  // Binary levels only: the genuine tactus ambiguity in 4/4 material is ×2/÷2/×4.
  // Allowing dotted/triplet ratios (3/2, 2/3, 3) lets the prior latch onto a
  // non-beat level that merely sits near its center. Compound/triplet octaves are
  // left to the external cross-check (and are still emitted in `candidates`).
  const ratios = [1 / 4, 1 / 2, 1, 2, 4];
  const priorOf = (b) => {
    const o = Math.log2(b / PRIOR_CENTER_BPM);
    return Math.exp(-0.5 * (o * o) / (PRIOR_SIGMA_OCT * PRIOR_SIGMA_OCT));
  };
  const octaves = [];
  let maxComb = 0;
  for (const r of ratios) {
    const b = p0.bpm * r;
    if (b < MIN_BPM - 0.5 || b > MAX_BPM + 0.5) continue;
    const period = (60 * ODF_FPS) / b;
    const cs = combAvgEnergy(env, period);
    octaves.push({ bpm: b, period, cs });
    if (cs > maxComb) maxComb = cs;
  }
  let best = { bpm: p0.bpm, period: p0.lag };
  let bestPriorScore = -1, salientOctaves = 0;
  for (const o of octaves) {
    if (maxComb > 0 && o.cs < 0.6 * maxComb) continue;        // not periodic here
    if (o.cs >= 0.85 * maxComb) salientOctaves++;             // a real octave rival
    const ps = priorOf(o.bpm);
    if (process.env.BPM_DEBUG) {
      console.error(`  octave ${o.bpm.toFixed(1)}bpm comb=${(o.cs / (maxComb || 1)).toFixed(3)} prior=${ps.toFixed(3)}`);
    }
    if (ps > bestPriorScore) { bestPriorScore = ps; best = o; }
  }

  // Phase-locked comb refinement around the chosen period for a precise decimal BPM.
  let bestPeriod = best.period, bestCombE = combAvgEnergy(env, best.period);
  const lo = best.period * 0.97, hi = best.period * 1.03;
  for (let p = lo; p <= hi; p += 0.02) {
    const sc = combAvgEnergy(env, p);
    if (sc > bestCombE) { bestCombE = sc; bestPeriod = p; }
  }
  let bpm = (60 * ODF_FPS) / bestPeriod;
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;
  bpm = Math.round(bpm * 10) / 10;

  // Confidence: dominance of the strongest periodicity over the next
  // metrically-unrelated peak (spurious-peak rejection), tempered when two
  // octaves are about equally strong (a true 1×/2× ambiguity → lean on external).
  let nextSal = 0;
  for (const p of peaks) {
    const ratio = p.bpm / p0.bpm;
    if (Math.abs(ratio - 1) < 0.05) continue;                          // same level
    if (nearRatio(ratio, [0.5, 2, 1 / 3, 3, 2 / 3, 1.5, 0.25, 4])) continue; // octave kin
    nextSal = p.sal;
    break;
  }
  const dominance = p0.sal > 0 ? (p0.sal - nextSal) / p0.sal : 0;
  let confidence = Math.max(0, Math.min(1, 0.5 * dominance + 0.5 * p0.sal));
  if (salientOctaves >= 2) confidence *= 0.65;

  const candidates = buildCandidates(bpm, salAtBpm);
  return { bpm, confidence, candidates };
}

// ── Key ───────────────────────────────────────────────────────────────

const CHROMA_FFT = 8192;                  // ~2.69 Hz bins at 22.05 kHz
const CHROMA_HOP = 4096;
const CHROMA_WIN = hannWindow(CHROMA_FFT);
const chromaFft = makeFft(CHROMA_FFT);
const A4 = 440;
const KEY_MIN_FREQ = 110;                 // A2 — skip sub-bass / kick energy
const KEY_MAX_FREQ = 3520;                // A7

// Krumhansl–Kessler key profiles (index 0 = tonic).
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const d = Math.sqrt(da * db);
  return d > 0 ? num / d : 0;
}

// 12-bin chromagram (index 0 = C), tuning-corrected per track.
//
// We accumulate only spectral *peaks* (local maxima, parabolically interpolated
// for precise frequency), not every FFT bin. Hard-assigning every bin to its
// nearest pitch class smears a tone's Hann main lobe (~4 bins wide) across the
// semitone boundary, leaking ~half its energy to the neighbouring pitch class.
// Peak-picking puts each tone's energy at its true frequency → one pitch class.
function computeChroma(samples) {
  const n = CHROMA_FFT;
  const half = n >> 1;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const numFrames = Math.max(0, Math.floor((samples.length - n) / CHROMA_HOP) + 1);
  if (numFrames < 1) return null;

  const binToFreq = SAMPLE_RATE / n;
  const minBin = Math.max(2, Math.floor((KEY_MIN_FREQ * n) / SAMPLE_RATE));
  const maxBin = Math.min(half - 2, Math.ceil((KEY_MAX_FREQ * n) / SAMPLE_RATE));

  const FINE = 120;                       // 10 sub-bins per semitone
  const fine = new Float64Array(FINE);
  const mag = new Float32Array(half);
  let sinSum = 0, cosSum = 0;             // circular tuning accumulator

  for (let fr = 0; fr < numFrames; fr++) {
    const off = fr * CHROMA_HOP;
    for (let i = 0; i < n; i++) { re[i] = samples[off + i] * CHROMA_WIN[i]; im[i] = 0; }
    chromaFft(re, im);

    let frameMax = 0;
    for (let k = minBin - 1; k <= maxBin + 1; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      if (m > frameMax) frameMax = m;
    }
    if (frameMax <= 0) continue;
    const thresh = frameMax * 0.05;       // ignore the noise floor / lobe skirts

    for (let k = minBin; k <= maxBin; k++) {
      const m = mag[k];
      if (m < thresh) continue;
      if (m <= mag[k - 1] || m < mag[k + 1]) continue;   // local maximum only

      // Parabolic interpolation of the peak's true bin/frequency.
      const a = mag[k - 1], c = mag[k + 1];
      const denom = a - 2 * m + c;
      let delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      if (delta <= -1 || delta >= 1) delta = 0;
      const freq = (k + delta) * binToFreq;

      const p = 12 * Math.log2(freq / A4);
      const dev = p - Math.round(p);      // tuning deviation in semitones
      const ang = 2 * Math.PI * dev;
      sinSum += m * Math.sin(ang);
      cosSum += m * Math.cos(ang);
      const pc = (((p + 9) % 12) + 12) % 12;
      const idx = Math.round(pc * 10) % FINE;
      fine[idx] += m;
    }
  }

  // Estimated tuning offset (semitones, [-0.5, 0.5]); rotate fine chroma to
  // re-center, then fold to 12 pitch classes.
  const tuning = Math.atan2(sinSum, cosSum) / (2 * Math.PI);
  const shift = Math.round(tuning * 10);
  const chroma = new Float32Array(12);
  for (let i = 0; i < FINE; i++) {
    const j = (((i - shift) % FINE) + FINE) % FINE;
    chroma[Math.floor(j / 10) % 12] += fine[i];
  }
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  return total > 0 ? chroma : null;
}

function detectKey(samples) {
  const chroma = computeChroma(samples);
  if (!chroma) return { camelot: '', name: '', confidence: 0 };

  let best = { corr: -Infinity, tonic: 0, mode: 'major' };
  let second = -Infinity;

  const aligned = new Float64Array(12);
  for (let tonic = 0; tonic < 12; tonic++) {
    // Major
    for (let p = 0; p < 12; p++) aligned[p] = KK_MAJOR[((p - tonic) % 12 + 12) % 12];
    let c = pearson(chroma, aligned);
    if (c > best.corr) { second = best.corr; best = { corr: c, tonic, mode: 'major' }; }
    else if (c > second) second = c;
    // Minor
    for (let p = 0; p < 12; p++) aligned[p] = KK_MINOR[((p - tonic) % 12 + 12) % 12];
    c = pearson(chroma, aligned);
    if (c > best.corr) { second = best.corr; best = { corr: c, tonic, mode: 'minor' }; }
    else if (c > second) second = c;
  }

  const camelot = PC_MODE_TO_CAMELOT[`${best.tonic}:${best.mode}`] || '';
  const name = camelot ? (CAMELOT_TO_NAME[camelot] || '') : '';
  const confidence = Math.max(0, best.corr - (second === -Infinity ? 0 : second));
  return { camelot, name, confidence };
}
