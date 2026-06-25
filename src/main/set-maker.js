// SetEngine — Set Maker algorithm
//
// Pure functions. No Electron / IPC concerns. Importable from a test script.
//
// Input track shape: { id, title?, artist?, bpm: number, key: string, popularity?: number|null }
//   - `key` must be Camelot notation: 1A..12B
//   - `popularity` is 0..5 or null/undefined
//
// Entry point: buildSet(tracks, { popularityEnabled, startKey })

// ── Camelot parsing & distance ──────────────────────────────────────

const VALID_KEYS = new Set();
for (let n = 1; n <= 12; n++) { VALID_KEYS.add(`${n}A`); VALID_KEYS.add(`${n}B`); }

export function parseCamelot(code) {
  if (typeof code !== 'string') return null;
  const m = code.toUpperCase().match(/^0?(\d{1,2})([AB])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > 12) return null;
  return { n, b: m[2] === 'B' ? 1 : 0 };
}

function wheelDist(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 12 - d);
}

export function keyDist(a, b) {
  const pa = typeof a === 'string' ? parseCamelot(a) : a;
  const pb = typeof b === 'string' ? parseCamelot(b) : b;
  if (!pa || !pb) return 7;
  return wheelDist(pa.n, pb.n) + (pa.b !== pb.b ? 1 : 0);
}

// ── BPM distance (half/double-time aware) ───────────────────────────

export function bpmDist(a, b) {
  return Math.min(
    Math.abs(a - b),
    Math.abs(a - 2 * b),
    Math.abs(2 * a - b),
  );
}

export function isHalfDoubleTransition(a, b) {
  const raw = Math.abs(a - b);
  const folded = bpmDist(a, b);
  return folded + 0.5 < raw;
}

// ── Harmonic motion (richer than flat Camelot distance) ─────────────
//
// Working DJs don't just go "shortest path on the wheel" — they think in
// move *types*. Energy-boost (+1 same letter) feels great; relative
// major/minor (A ↔ B same number) is a textbook transition; staying on the
// same key gets samey if repeated. We score the *type* of move, not the raw
// Euclidean distance, so the 2-opt optimizer prefers musical sequences over
// arithmetically-shortest ones.

const KEY_MOVES = {
  'static':       { score: 0.10, label: 'static' },
  'energy-boost': { score: 0.00, label: 'energy-boost' },
  'energy-drop':  { score: 0.00, label: 'energy-drop' },
  'relative':     { score: 0.08, label: 'relative' },
  'step-2':       { score: 0.25, label: 'step-2' },
  'step-3':       { score: 0.50, label: 'step-3' },
  'far':          { score: 0.80, label: 'far' },
  'unknown':      { score: 1.00, label: 'unknown' },
};

export function classifyKeyMove(camA, camB) {
  if (!camA || !camB) return 'unknown';
  const dn = wheelDist(camA.n, camB.n);
  const sameLetter = camA.b === camB.b;
  if (dn === 0 && sameLetter) return 'static';
  if (dn === 0 && !sameLetter) return 'relative';            // 8A ↔ 8B
  if (dn === 1 && sameLetter) {
    // Direction matters only as a label; cost is symmetric.
    const fwd = ((camB.n - camA.n + 12) % 12) === 1;
    return fwd ? 'energy-boost' : 'energy-drop';
  }
  if (dn === 2 && sameLetter) return 'step-2';
  if (dn === 3 && sameLetter) return 'step-3';
  return 'far';
}

export function keyHarmonyScore(camA, camB) {
  return KEY_MOVES[classifyKeyMove(camA, camB)].score;
}

// ── Frequency-content clash ─────────────────────────────────────────
//
// Two mix sins: both tracks have dominant low-end (bass fight), or a sudden
// jump in spectral brightness (dry → washed-out, or vice versa). Returns
// 0..1; 0 = no clash, 1 = bad.
//
// Inputs come from audio-analyzer.js features; if either track is missing
// features we return a neutral fallback so the algorithm degrades gracefully
// instead of refusing to order an unanalyzed library.

const NEUTRAL_FREQ = 0.3;

export function freqClashScore(a, b) {
  const fa = a && a.features;
  const fb = b && b.features;
  if (!fa || !fb || !fa.bandRms || !fb.bandRms) return NEUTRAL_FREQ;

  const bassClash = (fa.bandRms.low > 0.5 && fb.bandRms.low > 0.5)
    ? Math.min(fa.bandRms.low, fb.bandRms.low)
    : 0;
  const midClash = (fa.bandRms.mid > 0.5 && fb.bandRms.mid > 0.5)
    ? 0.5 * Math.min(fa.bandRms.mid, fb.bandRms.mid)
    : 0;
  const bDiff = Math.abs((fa.brightness || 0) - (fb.brightness || 0));
  const brightnessJump = Math.max(0, Math.min(0.4, bDiff - 0.3)) / 0.4;

  return Math.max(0, Math.min(1, bassClash + midClash + 0.3 * brightnessJump));
}

// ── Phrasing ────────────────────────────────────────────────────────
//
// The transition window is the overlap between A's outro and B's intro —
// i.e. how much room you have to blend without colliding with a vocal or a
// drop. 16s of mixable overlap is treated as ideal.

const PHRASING_IDEAL_MS = 16000;
const NEUTRAL_PHRASE = 0.3;

export function phrasingScore(a, b) {
  const fa = a && a.features;
  const fb = b && b.features;
  if (!fa || !fb) return NEUTRAL_PHRASE;
  const mixableMs = Math.min(fa.outroMs || 0, fb.introMs || 0);
  return 1 - Math.max(0, Math.min(1, mixableMs / PHRASING_IDEAL_MS));
}

// ── Combined transition cost ────────────────────────────────────────
//
// BPM is intentionally the dominant factor. The principle: a tight-BPM pair
// with mismatched keys is a better DJ transition than a perfectly-keyed
// pair with a 10+ BPM gap. We enforce that by giving BPM more weight than
// all other terms combined — at max BPM cost, no combination of key + freq
// + phrasing can outweigh it.
//
// We also soften the BPM-distance clamp from /8 to /10 so the 10–20 BPM
// range stays distinguishable instead of saturating at "max" immediately.
//
// Popularity ratings are intentionally NOT factored in. Ratings are user
// metadata for filtering / display / Serato workflow, not a sequencing
// signal — two great tracks at wildly different BPMs are still a bad mix.

const W_KEY = 0.5;
const W_BPM = 3.0;       // > W_KEY + W_FREQ + W_PHRASE  (0.5+0.2+0.25 = 0.95)
const W_FREQ = 0.2;
const W_PHRASE = 0.25;

const BPM_CLAMP = 10;

export function transitionCost(trackA, trackB) {
  const k = keyHarmonyScore(trackA._cam, trackB._cam);
  const t = Math.min(bpmDist(trackA.bpm, trackB.bpm) / BPM_CLAMP, 1);
  const f = freqClashScore(trackA, trackB);
  const p = phrasingScore(trackA, trackB);
  return W_KEY * k + W_BPM * t + W_FREQ * f + W_PHRASE * p;
}

// Cost range with the new weights: smooth (Δ<2 BPM, decent key) lands under
// ~0.8; rough mixes (Δ>5 BPM or far key) blow past 1.5. The thresholds are
// recalibrated against this.
function qualityFromCost(cost) {
  if (cost < 0.8) return 'green';
  if (cost < 1.8) return 'yellow';
  return 'red';
}

// ── Tour cost helpers ───────────────────────────────────────────────

function totalTourCost(tour) {
  let total = 0;
  for (let i = 0; i + 1 < tour.length; i++) {
    total += transitionCost(tour[i], tour[i + 1]);
  }
  return total;
}

// ── Phase 1: Camelot wheel walk seed ────────────────────────────────

const WHEEL_ORDER = (() => {
  // 1A → 2A → ... → 12A → 12B → 11B → ... → 1B (returns to 1A neighborhood)
  const out = [];
  for (let n = 1; n <= 12; n++) out.push(`${n}A`);
  for (let n = 12; n >= 1; n--) out.push(`${n}B`);
  return out;
})();

function wheelWalkSeed(tracks, startKey) {
  const buckets = new Map();
  for (const t of tracks) {
    const code = t._cam ? `${t._cam.n}${t._cam.b ? 'B' : 'A'}` : null;
    if (!code) continue;
    if (!buckets.has(code)) buckets.set(code, []);
    buckets.get(code).push(t);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => a.bpm - b.bpm);

  // Order keys per WHEEL_ORDER, filtered to present buckets
  let order = WHEEL_ORDER.filter((k) => buckets.has(k));

  // Rotate to user-specified start if present
  if (startKey && buckets.has(startKey)) {
    const idx = order.indexOf(startKey);
    if (idx > 0) order = order.slice(idx).concat(order.slice(0, idx));
  }

  const tour = [];
  for (const code of order) tour.push(...buckets.get(code));
  return tour;
}

// ── Phase 2: 2-opt polish ───────────────────────────────────────────
// Open path (no wrap). A single loop tries reversing every segment [i..j]
// (0 <= i < j <= n-1), which subsumes interior, prefix (i===0) and suffix
// (j===n-1) reversals.
//
// IMPORTANT: transitionCost is ASYMMETRIC — phrasingScore(a,b) blends a's outro
// into b's intro, so transitionCost(a,b) ≠ transitionCost(b,a) in general.
// Reversing a segment flips the direction of EVERY interior edge, not just the
// two boundary edges, so the classic symmetric-cost shortcut (compare only the
// boundary edges) is invalid here — it would accept moves that actually raise
// the true tour cost and skip genuinely improving ones.
//
// Instead we score the entire affected window — every edge from (i-1,i) through
// (j,j+1) — under the current order vs. the hypothetical reversed order, and
// only commit the reversal when it strictly lowers that window's total cost.
// This is correct for asymmetric (and symmetric) cost functions alike.

function reverseRange(tour, lo, hi) {
  while (lo < hi) { const tmp = tour[lo]; tour[lo] = tour[hi]; tour[hi] = tmp; lo++; hi--; }
}

// Sum of transitionCost over edges (k, k+1) for k in [lo, hi-1], reading each
// position through the accessor `at` so we can cost a hypothetical reversal
// without mutating the tour.
function windowCost(at, lo, hi) {
  let c = 0;
  for (let k = lo; k < hi; k++) c += transitionCost(at(k), at(k + 1));
  return c;
}

function twoOpt(tour, deadlineMs) {
  const n = tour.length;
  if (n < 3) return { tour, passes: 0 };

  let passes = 0;
  let improved = true;
  const start = Date.now();

  while (improved && passes < 50) {
    improved = false;
    passes++;
    if (Date.now() - start > deadlineMs) break;

    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        // Affected edge window: (i-1,i) … (j,j+1), clamped to the path ends.
        const lo = i > 0 ? i - 1 : 0;
        const hi = j < n - 1 ? j + 1 : n - 1;
        // Reversing [i..j] moves the element at position k (i<=k<=j) to i+j-k.
        const reversed = (k) => (k >= i && k <= j ? tour[i + j - k] : tour[k]);
        const before = windowCost((k) => tour[k], lo, hi);
        const after  = windowCost(reversed, lo, hi);
        if (after + 1e-9 < before) {
          reverseRange(tour, i, j);
          improved = true;
        }
      }
      if (Date.now() - start > deadlineMs) break;
    }
  }

  return { tour, passes };
}

// ── Transition diagnostics builder (shared by buildSet + rescoreTour) ───

function buildTransitions(tour) {
  const out = [];
  for (let i = 0; i + 1 < tour.length; i++) {
    const a = tour[i], b = tour[i + 1];
    const cost = transitionCost(a, b);
    const freq = freqClashScore(a, b);
    const phrase = phrasingScore(a, b);
    out.push({
      from: a.id,
      to: b.id,
      keyDist: keyDist(a._cam, b._cam),
      keyMove: KEY_MOVES[classifyKeyMove(a._cam, b._cam)].label,
      bpmDelta: Math.round((b.bpm - a.bpm) * 10) / 10,
      isHalfDouble: isHalfDoubleTransition(a.bpm, b.bpm),
      freqClash: Math.round(freq * 1000) / 1000,
      phrasing: Math.round(phrase * 1000) / 1000,
      mixableMs: (a.features && b.features)
        ? Math.min(a.features.outroMs || 0, b.features.introMs || 0)
        : null,
      cost: Math.round(cost * 1000) / 1000,
      quality: qualityFromCost(cost),
    });
  }
  return out;
}

// ── Rescore an existing (user-edited) tour without reordering ─────────
//
// Used after manual edits in the setlist view: deletes, moves, inserts.
// Returns fresh transitions + totalCost using the same cost function as
// buildSet, but keeps the caller-provided order intact.

export function rescoreTour(rawTracks) {
  const tracks = [];
  for (const t of rawTracks || []) {
    if (typeof t.bpm !== 'number' || !isFinite(t.bpm) || t.bpm <= 0) continue;
    const cam = parseCamelot(t.key);
    if (!cam) continue;
    tracks.push({ ...t, _cam: cam });
  }
  const transitions = buildTransitions(tracks);
  const totalCost = transitions.reduce((s, t) => s + t.cost, 0);
  return {
    transitions,
    totalCost: Math.round(totalCost * 1000) / 1000,
  };
}

// ── Main entry ──────────────────────────────────────────────────────

export function buildSet(rawTracks, opts) {
  const o = opts || {};
  const startKey = o.startKey || null;
  const warnings = [];
  const t0 = Date.now();

  // Validate + attach parsed Camelot
  const tracks = [];
  for (const t of rawTracks || []) {
    if (typeof t.bpm !== 'number' || !isFinite(t.bpm) || t.bpm <= 0) continue;
    const cam = parseCamelot(t.key);
    if (!cam) continue;
    tracks.push({ ...t, _cam: cam });
  }

  if (startKey && !VALID_KEYS.has(startKey)) {
    warnings.push(`Ignoring invalid start key "${startKey}".`);
  } else if (startKey && !tracks.some(t => `${t._cam.n}${t._cam.b ? 'B' : 'A'}` === startKey)) {
    warnings.push(`No tracks in start key "${startKey}"; using algorithm's pick.`);
  }

  if (tracks.length === 0) {
    return {
      tour: [],
      transitions: [],
      totalCost: 0,
      warnings: warnings.concat(['No tracks with valid BPM and key were provided.']),
      meta: { algorithm: 'wheel-walk+2opt', twoOptPasses: 0, elapsedMs: Date.now() - t0 },
    };
  }

  // Phase 1: seed
  let tour = wheelWalkSeed(tracks, startKey);

  // Phase 2: 2-opt polish.
  let passes = 0;
  if (tour.length >= 3) {
    const res = twoOpt(tour, 200);
    tour = res.tour;
    passes = res.passes;
  }

  const transitions = buildTransitions(tour);

  const cleanTour = tour.map(({ _cam, ...rest }) => rest);

  return {
    tour: cleanTour,
    transitions,
    totalCost: Math.round(totalTourCost(tour) * 1000) / 1000,
    warnings,
    meta: {
      algorithm: 'wheel-walk+2opt+freq+phrase',
      twoOptPasses: passes,
      elapsedMs: Date.now() - t0,
      analyzedTracks: tracks.filter(t => t.features).length,
      totalTracks: tracks.length,
    },
  };
}
