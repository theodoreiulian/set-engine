// SetEngine — anchor/rate reasoning over Shazam probe results
//
// Pure logic (probe results in, tracklist out), so it can be exercised from a
// scratch script without touching the network. All the network/timing concerns
// live in recognize.js.
//
// ── The idea this whole module rests on ───────────────────────────────
// Shazam's response includes `matches[].offset`: WHERE INSIDE THE REFERENCE
// RECORDING our sample matched. That single number is the strongest signal
// available here, and the previous design threw it away.
//
// While a record is playing, the position inside it advances at exactly the same
// rate as wall-clock time. So for two probes of the same record:
//
//     rate = (offset₂ − offset₁) / (t₂ − t₁)      must be ≈ 1
//     anchor = t − offset                          must be constant
//
// Measured on real sets: a genuine play holds its anchor to ~10 ms across a 30 s
// gap (probe at 60 s → offset 58.702; probe at 90 s → offset 88.7005). A false
// match cannot fake this, because it is pinned to whichever section of its own
// reference happens to resemble our audio — measured false runs came back at
// rate −0.31, −0.07 and +0.05, i.e. the reference position standing still or
// running backwards while the mix moved forward.
//
// This replaces score thresholds entirely. The old engine scored a track 70 for
// one sighting and 95 for two, then filtered on a number the user could tune —
// but corroboration endorses a *repeatable* error just as readily as a truth
// (measured: 11 of 12 single-sighting tracks on one set were junk, and a wrong
// track scored 95). Rate agreement is a physical claim about the audio, not a
// popularity count, so it does not have that failure mode.
//
// ── Why two tiers ─────────────────────────────────────────────────────
// PROOF (anchor essentially constant) is strong enough to assert a record played
// continuously across a gap — used for coverage decisions and for deleting
// contradicted sightings, where being wrong is expensive.
//
// LINK (rate merely plausible) is looser, and it is needed because repetitive
// club records are LOOP-AMBIGUOUS: every bar resembles every other, so Shazam
// locks onto a different one each time. Measured on "ARTBAT — Upperground",
// probes 38 s apart returned offsets 121.0, 116.6, 173.8, 380.8 — the anchor
// scatters by 73 s, yet the aggregate rate is still +1.24 and the junk case is
// still negative. Grouping on PROOF alone tore that real play into four
// single-sighting fragments and then discarded all of them.

// Anchor slack for a hard proof, plus a fraction of the gap. A DJ nudging the
// jog or riding the pitch fader makes the anchor creep slowly; measured worst
// case on a real set was ~1.4% of the gap.
export const PROOF_TOL = 4;
export const PROOF_DRIFT = 0.02;

// Rate band for grouping sightings into one play (loop ambiguity lives here).
export const LINK_RATE_MIN = 0.55;
export const LINK_RATE_MAX = 1.8;

// Tighter band for *accepting* a play we could not hard-prove. Centred on 1
// because a real record advances at exactly 1 and loop noise scatters
// symmetrically; impostors sit near 0.
export const PLAY_SLOPE_MIN = 0.75;
export const PLAY_SLOPE_MAX = 1.35;

// Sightings needed before an unproven play is believed at all.
export const MIN_UNPROVEN_HITS = 3;

/** reference id → position inside that recording, corrected for playback rate. */
function offsetsOf(obs) {
  const m = new Map();
  if (!obs || !Array.isArray(obs.matches)) return m;
  for (const x of obs.matches) {
    if (!x || x.id == null || typeof x.offset !== 'number') continue;
    const rate = 1 + (Number(x.timeskew) || 0);
    m.set(String(x.id), x.offset / (rate || 1));
  }
  return m;
}

/**
 * Compare two sightings of the same record, returning the shared reference
 * recording whose advance rate is closest to 1.
 *
 * Intersecting on reference id matters: the same audio is often indexed several
 * times over (original release plus bootleg re-uploads), and the order of
 * `matches` changes between requests — verified on the wire, where the top match
 * for one probe was the second match for the next.
 */
export function pairLink(a, b) {
  if (!a || !b || !a.trackKey || a.trackKey !== b.trackKey) return null;
  const dt = b.t - a.t;
  if (!dt) return null;
  const A = offsetsOf(a);
  const B = offsetsOf(b);
  let best = null;
  for (const [id, oa] of A) {
    if (!B.has(id)) continue;
    const ob = B.get(id);
    const cand = {
      id,
      rate: (ob - oa) / dt,
      dAnchor: Math.abs((b.t - ob) - (a.t - oa)),
      anchor: ((b.t - ob) + (a.t - oa)) / 2,
    };
    if (!best || Math.abs(cand.rate - 1) < Math.abs(best.rate - 1)) best = cand;
  }
  return best;
}

/** Hard evidence that this record played continuously from a.t to b.t. */
export function proves(a, b) {
  const l = pairLink(a, b);
  if (!l) return null;
  const dt = Math.abs(b.t - a.t);
  return l.dAnchor <= Math.max(PROOF_TOL, PROOF_DRIFT * dt) ? l : null;
}

/** Same record, position advancing plausibly — enough to group, not to assert. */
export function links(a, b) {
  const l = pairLink(a, b);
  if (!l) return null;
  if (proves(a, b)) return l;
  return (l.rate >= LINK_RATE_MIN && l.rate <= LINK_RATE_MAX) ? l : null;
}

/** Least-squares rate of reference position against mix time across a play. */
function playSlope(play) {
  const tally = new Map();
  for (const o of play.obs) for (const id of offsetsOf(o).keys()) tally.set(id, (tally.get(id) || 0) + 1);
  let bestId = null; let bestN = 0;
  for (const [id, n] of tally) if (n > bestN) { bestN = n; bestId = id; }
  if (!bestId || bestN < 2) return null;
  const pts = [];
  for (const o of play.obs) {
    const m = offsetsOf(o);
    if (m.has(bestId)) pts.push([o.t, m.get(bestId)]);
  }
  if (pts.length < 2) return null;
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p[0], 0) / n;
  const mo = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0; let den = 0;
  for (const [t, o] of pts) { num += (t - mt) * (o - mo); den += (t - mt) ** 2; }
  return den ? num / den : null;
}

/**
 * Group sightings into plays — maximal clusters of the same record whose
 * positions advance consistently. A record genuinely played twice in a set
 * yields two plays (different anchors), which is correct and is exactly what
 * separates a real reload from a misread.
 */
export function buildPlays(observations) {
  const plays = [];
  for (const o of observations.slice().sort((x, y) => x.t - y.t)) {
    if (!o || !o.trackKey) continue;
    let home = null;
    for (const p of plays) {
      if (p.trackKey !== o.trackKey) continue;
      if (p.obs.some((q) => links(q, o))) { home = p; break; }
    }
    if (home) home.obs.push(o);
    else plays.push({ trackKey: o.trackKey, title: o.title, artist: o.artist, album: o.album, isrc: o.isrc, obs: [o] });
  }
  for (const p of plays) {
    p.obs.sort((a, b) => a.t - b.t);
    p.hits = p.obs.length;
    p.firstAt = p.obs[0].t;
    p.lastAt = p.obs[p.obs.length - 1].t;
    p.slope = playSlope(p);
    p.proven = false;
    const anchors = [];
    for (let i = 0; i < p.obs.length; i++) {
      for (let j = i + 1; j < p.obs.length; j++) {
        const pr = proves(p.obs[i], p.obs[j]);
        if (pr) { p.proven = true; anchors.push(pr.anchor); }
      }
    }
    anchors.sort((a, b) => a - b);
    p.anchor = anchors.length ? anchors[Math.floor(anchors.length / 2)] : null;
    // The anchor is where the record's t=0 sits in the mix, which is the best
    // start estimate we have — but DJs cue in mid-record, so it can land well
    // before the track is audible. Never report earlier than a plausible lead-in
    // ahead of the first probe that actually heard it, and never after it.
    const est = p.anchor != null ? p.anchor : p.firstAt;
    p.startSec = Math.max(0, Math.round(Math.min(p.firstAt, Math.max(est, p.firstAt - 420))));
  }
  return plays.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Delete sightings that fall inside a stretch another record is PROVEN to have
 * played continuously across.
 *
 * This is the successor to the old dropEnclosed(). That version compared only a
 * candidate's first and last sighting, so a track spotted once early and once
 * late in a set spanned the whole thing and deleted every one-sighting track in
 * between — an unbounded blast radius. Here the encloser must have two sightings
 * that hard-prove against each other, one strictly on each side of the sighting
 * being judged: a local claim backed by evidence about that exact moment.
 */
export function dropContradicted(observations, plays) {
  const dropped = [];
  for (const o of observations) {
    if (!o || !o.trackKey) continue;
    for (const p of plays) {
      if (p.trackKey === o.trackKey) continue;
      const before = p.obs.filter((q) => q.t < o.t);
      const after = p.obs.filter((q) => q.t > o.t);
      let hit = null;
      for (const x of before) {
        for (const y of after) if (proves(x, y)) { hit = p; break; }
        if (hit) break;
      }
      if (hit) { dropped.push({ o, by: hit }); break; }
    }
  }
  const bad = new Set(dropped.map((d) => d.o));
  return { kept: observations.filter((o) => !bad.has(o)), dropped };
}

/** Is this play credible enough to report? */
export function accept(p, { minUnprovenHits = MIN_UNPROVEN_HITS } = {}) {
  if (p.proven) return true;
  return p.hits >= minUnprovenHits
    && p.slope != null && p.slope >= PLAY_SLOPE_MIN && p.slope <= PLAY_SLOPE_MAX;
}

/** Full aggregation: sightings → play-ordered tracklist. */
export function tracklistFrom(observations, opts = {}) {
  const first = buildPlays(observations);
  const { kept, dropped } = dropContradicted(observations, first);
  const plays = buildPlays(kept).filter((p) => accept(p, opts));

  // One row per record, at its earliest play.
  const byTrack = new Map();
  for (const p of plays) {
    const prev = byTrack.get(p.trackKey);
    if (!prev || p.startSec < prev.startSec) byTrack.set(p.trackKey, p);
  }
  const tracks = [...byTrack.values()]
    .sort((a, b) => a.startSec - b.startSec)
    .map((p) => ({
      artist: p.artist || '',
      title: p.title || '',
      album: p.album || '',
      isrc: p.isrc || '',
      offsetSec: p.startSec,
      hits: p.hits,
      proven: !!p.proven,
    }));
  return { tracks, plays, dropped };
}
