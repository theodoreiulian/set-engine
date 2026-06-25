// SetEngine — External BPM sources + consensus reconciliation
//
// The local DSP detector (key-bpm-detector.js) always runs and is the system of
// record for *analysis*. This module adds a free external cross-check so we can
// be confident a tempo is right (and catch the octave/metrical errors a pure
// onset analysis occasionally makes).
//
// Source (free, keyless):
//   • Deezer  — public API. /search → best match → /track/{id}.bpm
//
// `lookupBpm()` is fail-soft: any network/parse/timeout error yields no result
// for that source, never throws into the tagging pipeline. `reconcileBpm()`
// combines the local estimate with whatever externals came back:
//   - local level agrees with an external      → consensus (confident)
//   - local level is an octave/half of external → external resolves the octave
//   - neither agrees                            → trust external, flag review
//   - no external at all                        → local, flagged if low-confidence
//
// Uses the global fetch + AbortController available in the Electron main process
// (Node ≥ 18). No new dependencies.

const USER_AGENT = 'SetEngine/1.0 (+https://github.com/setengine)';
const DEEZER_TIMEOUT_MS = 6000;   // budget covers a few /track fetches when probing versions
const MATCH_THRESHOLD = 0.5;     // minimum match score to trust a DB hit

// Metrical relationships treated as "the same tempo, different counting level".
const OCTAVE_RATIOS = [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3];

// ── Text normalization / matching ───────────────────────────────────────

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokens(s) {
  return stripDiacritics(String(s || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Blend of Jaccard + containment over word sets — forgiving of extra words
// (one title being a superset of the other) without rewarding total mismatch.
function tokenSim(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  const jaccard = inter / union;
  const containment = inter / Math.min(A.size, B.size);
  return 0.5 * jaccard + 0.5 * containment;
}

// Strip the video-platform noise that pollutes YouTube/YT-Music titles, but keep
// remix/edit/mix/version words — those denote a different cut with a different BPM.
export function cleanTitle(title) {
  let t = String(title || '');
  t = t.replace(/\((?:official\s*)?(?:music\s*)?(?:video|audio|lyric|lyrics|visualizer|mv|hd|4k)[^)]*\)/gi, ' ');
  t = t.replace(/\[(?:official\s*)?(?:music\s*)?(?:video|audio|lyric|lyrics|visualizer|mv|hd|4k)[^\]]*\]/gi, ' ');
  t = t.replace(/\((?:feat|ft|with|prod)\.?[^)]*\)/gi, ' ');
  t = t.replace(/\[(?:feat|ft|with|prod)\.?[^\]]*\]/gi, ' ');
  t = t.replace(/\s(?:feat|ft)\.?\s.*$/i, ' ');
  t = t.replace(/\s*-\s*topic\s*$/i, ' ');
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, '').trim();
  return t || String(title || '').trim();
}

// First/primary performer, dropping "- Topic", VEVO, and featured artists.
export function primaryArtist(artist) {
  let a = String(artist || '');
  a = a.replace(/\s*-\s*topic\s*$/i, '');
  a = a.replace(/\bvevo\b/gi, '');
  a = a.split(/\s*(?:,|&|;|\bfeat\.?\b|\bft\.?\b|\bx\b|\bvs\.?\b|\bwith\b)\s*/i)[0];
  return a.replace(/\s{2,}/g, ' ').trim();
}

// 0..1 confidence that a DB result is the track we asked about.
export function matchScore(qTitle, qArtist, qDurSec, cTitle, cArtist, cDurSec) {
  const ts = tokenSim(qTitle, cTitle);
  const as = qArtist ? tokenSim(qArtist, cArtist || '') : 0.5;
  let ds = 0.5;
  if (qDurSec > 0 && cDurSec > 0) {
    const diff = Math.abs(qDurSec - cDurSec);
    ds = Math.max(0, 1 - diff / Math.max(8, 0.08 * qDurSec));
  }
  return 0.5 * ts + 0.35 * as + 0.15 * ds;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function fetchJson(url, signal) {
  try {
    const res = await fetch(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Run `fn(signal)` with an abort timeout; swallow any error → null.
function withTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.resolve()
    .then(() => fn(controller.signal))
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

// ── Deezer (keyless) ───────────────────────────────────────────────────

async function deezerLookup(title, artist, durSec, signal) {
  // Free-text first — Deezer's advanced `artist:"" track:""` syntax often returns
  // irrelevant fuzzy hits, whereas plain free text ranks the real track on top.
  // Accumulate candidates across queries and score the pool (a junk hit just
  // scores low), stopping early once we have a confident match.
  const queries = [`${artist} ${title}`.trim()];
  if (artist) queries.push(`artist:"${artist}" track:"${title}"`);

  const pool = [];
  const seen = new Set();
  const scoreOf = (t) => matchScore(title, artist, durSec, t.title, t.artist && t.artist.name, t.duration);
  for (const q of queries) {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`;
    const res = await fetchJson(url, signal);
    if (res && Array.isArray(res.data)) {
      for (const t of res.data) {
        if (t && t.id != null && !seen.has(t.id)) { seen.add(t.id); pool.push(t); }
      }
    }
    if (pool.length && pool.some((t) => scoreOf(t) >= 0.7)) break;
  }
  if (!pool.length) return null;

  // The search payload omits bpm; the full track resource carries it (decimal).
  // Deezer often has bpm=0 on the primary version but a valid value on an
  // alternate cut (radio edit, etc.), so walk the best matches until one has a
  // real tempo rather than giving up on the single top hit.
  const ranked = pool
    .map((t) => ({ t, sc: scoreOf(t) }))
    .filter((x) => x.sc >= MATCH_THRESHOLD)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 4);
  if (!ranked.length) return null;

  for (const { t, sc } of ranked) {
    const full = await fetchJson(`https://api.deezer.com/track/${t.id}`, signal);
    const bpm = full && Number(full.bpm);
    if (bpm && bpm > 0) return { source: 'deezer', bpm, matchScore: sc };
  }
  return null;
}

// ── Public: lookup ───────────────────────────────────────────────────────

// Per-session cache so repeated tracks (and concurrent batch items) hit the
// network once. BPM is immutable per track, so caching across batches is safe.
const lookupCache = new Map();

// Returns Array<{ source, bpm, matchScore }> (possibly empty). Never throws.
export async function lookupBpm({ title, artist, durationSec } = {}) {
  const ct = cleanTitle(title);
  const ca = primaryArtist(artist);
  if (!ct) return [];

  const cacheKey = `${ca.toLowerCase()} ${ct.toLowerCase()}`;
  if (lookupCache.has(cacheKey)) return lookupCache.get(cacheKey);

  const p = doLookup(ct, ca, durationSec);
  lookupCache.set(cacheKey, p);
  return p;
}

async function doLookup(title, artist, durSec) {
  const results = [];
  const dz = await withTimeout((sig) => deezerLookup(title, artist, durSec, sig), DEEZER_TIMEOUT_MS);
  if (dz) results.push(dz);
  return results;
}

// Exposed for tests / manual cache clearing.
export function _clearLookupCache() { lookupCache.clear(); }

// ── Public: reconcile ──────────────────────────────────────────────────

// Two tempos count as the same level if within 1 BPM or 2%.
function agree(a, b) {
  return Math.abs(a - b) <= Math.max(1.0, 0.02 * b);
}
// k such that a ≈ k·b for a metrical k (else 0).
function octaveRel(a, b) {
  for (const k of OCTAVE_RATIOS) if (agree(a, k * b)) return k;
  return 0;
}
// Deezer is the only external source; rank by match quality.
function trust(e) {
  return 1 + Math.min(1, e.matchScore || 0);
}

// local: { bpm, bpmConfidence|confidence, candidates: [{bpm,...}] }
// externals: Array<{ source, bpm, matchScore }>
// → { bpm, source, needsReview, localBpm, externalBpm, externalSource?, localConfidence }
export function reconcileBpm({ local, externals = [], confidenceThreshold = 0.35 } = {}) {
  const localBpm = local && local.bpm > 0 ? local.bpm : 0;
  const localConf = local ? (local.bpmConfidence ?? local.confidence ?? 0) : 0;

  // All plausible local metrical levels (primary + candidate octaves).
  const cands = [];
  if (localBpm) cands.push(localBpm);
  if (local && Array.isArray(local.candidates)) {
    for (const c of local.candidates) if (c && c.bpm > 0) cands.push(c.bpm);
  }

  const ext = (externals || []).filter((e) => e && e.bpm > 0).sort((a, b) => trust(b) - trust(a));

  if (ext.length === 0) {
    return {
      bpm: localBpm,
      source: localBpm ? 'local' : 'none',
      needsReview: !localBpm || localConf < confidenceThreshold,
      localBpm, externalBpm: 0, localConfidence: localConf,
    };
  }

  // Prefer an external the local analysis corroborates — direct match first.
  for (const e of ext) {
    if (localBpm && agree(localBpm, e.bpm)) {
      // Local decimal is confirmed by the DB → keep the precise local value.
      return mk(localBpm, 'consensus', false, localBpm, e, localConf);
    }
    if (cands.some((c) => agree(c, e.bpm))) {
      return mk(e.bpm, 'consensus', false, localBpm, e, localConf);
    }
  }
  // Then octave/half corroboration — the DB resolves which counting level is right.
  for (const e of ext) {
    if (cands.some((c) => octaveRel(c, e.bpm))) {
      return mk(e.bpm, 'consensus-octave', false, localBpm, e, localConf);
    }
  }
  // No agreement anywhere → trust the most-credible external, flag for review.
  return mk(ext[0].bpm, 'external-conflict', true, localBpm, ext[0], localConf);
}

function mk(bpm, source, needsReview, localBpm, ext, localConf) {
  return {
    bpm,
    source,
    needsReview,
    localBpm,
    externalBpm: ext ? ext.bpm : 0,
    externalSource: ext ? ext.source : '',
    localConfidence: localConf,
  };
}
