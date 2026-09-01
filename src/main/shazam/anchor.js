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
// ── Why two tiers of LINKING ──────────────────────────────────────────
// PROOF (anchor essentially constant across a pair) is what the adaptive scan
// uses to decide a gap needs no further probing. It is deliberately no longer
// what decides whether a track is real — see below; on its own it is far weaker
// than it looks.
//
// LINK (rate merely plausible) is looser, and it is needed because repetitive
// club records are LOOP-AMBIGUOUS: every bar resembles every other, so Shazam
// locks onto a different one each time. Measured on "ARTBAT — Upperground",
// probes 38 s apart returned offsets 121.0, 116.6, 173.8, 380.8 — the anchor
// scatters by 73 s, yet the aggregate rate is still +1.24 and the junk case is
// still negative. Grouping on PROOF alone tore that real play into four
// single-sighting fragments and then discarded all of them.

// ── What a 55-minute set returning 9 tracks actually taught us ───────
// The investigation that produced the current design started from a complaint
// that Set Extraction found about half of a DJ set. Three separate things were
// wrong, and they did NOT all point the same way.
//
// 1. THE PAIRWISE PROOF WAS MANUFACTURING EVIDENCE. `proves()` scans every pair
//    of sightings against every reference id the two share, taking whichever
//    looks closest to rate 1. A response carries a median of 3 and up to 20
//    reference recordings — the same audio is in Shazam's catalog many times
//    over — so across dozens of pairs it finds agreement by chance routinely.
//    Measured: a play whose TOP-ranked position never advanced at all (rate
//    −0.05, correlation −0.19, across 5.9 minutes and 17 sightings) was
//    certified proven, and `dropContradicted` then used it to delete 43 of 125
//    sightings on that set. Junk was deleting real tracks.
//
// 2. THE PROOF ALSO COULD NOT FIRE FOR REAL RECORDS. Demanding rate ≈ 1 assumes
//    the pressing Shazam matched lines up 1:1 with what the DJ played, and
//    plenty don't. Measured: a chapter-confirmed track ran its chain at slope
//    0.55 with correlation 0.99 — unmistakably playing — and, being unable to
//    prove anything, was unable to CONTRADICT anything either, so a false play
//    sitting inside it shipped as that set's only wrong row.
//
// 3. GROUPING WAS TOO STRICT. `links()` refused to group two sightings of the
//    same record unless they shared a reference id, and Shazam re-orders and
//    re-indexes `matches` between requests, so a record heard five times could
//    become five one-sighting plays and be discarded wholesale.
//
// The resolution is to stop reasoning across the whole match list and judge each
// play by ONE chain — the best-supported rank-0 reference — asking whether its
// position advances STEADILY (correlation), not whether it advances at exactly
// real speed (slope). See playChain / isLinear below. Measured, rank is what
// separates signal from noise: on unambiguously real plays the correct reference
// sits at rank 0 in every response, while the only id that resembled rate 1 on a
// doubtful play sat at rank 15, in 4 sightings of 17.
//
// ── Three tiers, because "reject" was doing too much damage ───────────
//   proven    — the chain is linear across ≥3 sightings.
//   likely    — the chain advances steadily, or a short play dominates its own
//               window with the pairwise anchor agreeing.
//   uncertain — grouped, not pinned, but thin.
//
// A PINNED chain is rejected however many sightings back it: that is the
// measured impostor signature (−0.31, −0.07, +0.05 — the reference standing
// still or running backwards while the mix moves on) and it is the one case
// where repetition means less rather than more. `uncertain` rows are reported
// and badged in the UI, and excluded from DOWNLOAD WHOLE SET, rather than
// silently deleted — deleting them is what made a half-empty tracklist look
// finished.
//
// ── And the honest part: most of the shortfall is not ours to fix ─────
// After all of the above, recall on a set with a published chapter tracklist did
// not move, because it could not: 4 of that set's 9 named tracks were returned
// by ZERO probes out of 426, all of them the host's own label promos. Baseline,
// current and an all-probes ceiling scored identically there. What changed is
// that the wrong rows went away and the doubtful ones are now labelled. Before
// tuning anything here for recall, check whether the missing tracks are in the
// catalog at all — usually they are not.

// Anchor slack for a hard proof, plus a fraction of the gap. A DJ nudging the
// jog or riding the pitch fader makes the anchor creep slowly; measured worst
// case on a real set was ~1.4% of the gap.
export const PROOF_TOL = 4;
export const PROOF_DRIFT = 0.02;

// A proof also has to be tight RELATIVE TO THE GAP it spans, and this is not
// cosmetic: PROOF_TOL is an absolute 4 s, so across a 300 s gap it pins the rate
// to [0.98, 1.02], but across an 8 s gap it accepts anything in [0.5, 1.5]. That
// went unnoticed while probes were ~40 s apart and became a live precision hole
// the moment the scan started probing every 8 s — measured on a real set, two
// adjacent probes "proved" a record at rate −0.05, the textbook impostor
// signature this module exists to reject. Requiring the anchor to hold to a
// fifth of the gap keeps short-gap proofs available but makes them mean
// something; above ~20 s PROOF_TOL is the binding constraint again, so nothing
// about the original behaviour changes where it was already sound.
export const PROOF_SHARE = 0.2;

// Rate band for grouping sightings into one play (loop ambiguity lives here).
export const LINK_RATE_MIN = 0.55;
export const LINK_RATE_MAX = 1.8;

// ── The reference chain, and why it replaced "the most common id" ─────
// A response carries a whole list of reference recordings, not one: measured on
// three real sets, a median of 3 and up to 20 per probe, because the same audio
// is in Shazam's catalog many times over (original, re-uploads, compilations,
// DJ mixes). Reasoning across all of them was quietly disastrous. `proves()`
// picks, per PAIR, whichever shared id lands closest to rate 1 — with ~20 ids
// and dozens of pairs that is hundreds of chances to find agreement by accident,
// and it duly found it: a 17-sighting play whose top-ranked position never
// advanced at all (rate −0.05) was certified as proven, and then used by
// dropContradicted to delete 43 of 125 sightings on one set.
//
// Measured, the top-ranked match is the one that means something. On plays that
// are unambiguously real the correct reference sits at rank 0 in EVERY response;
// on the doubtful ones the only id that looked like rate 1 sat at rank 15 and
// appeared in 4 sightings of 17. So all rate reasoning now runs on a single
// chain: the best-supported rank-0 reference across the play.
const CHAIN_RANK = 1;

// Chain length before the chain can be believed at all. At two points any pair
// of numbers defines a line, and with a catalogue this dense that line lands
// near rate 1 by chance constantly — measured, every single 2-sighting play in a
// set scored ~1.0 that way. Three is where the claim starts costing something.
export const CHAIN_MIN = 3;

// ── Linearity, not unit slope, is what proves a record is playing ─────
// The slope only says how this pressing lines up with the mix, and a different
// master, a compilation edit or a pitched deck legitimately shifts it: measured,
// a chapter-confirmed track (Because of Art — "Circle of Light") runs its chain
// at slope 0.55 with correlation 0.99. It is unmistakably playing. Demanding
// slope ≈ 1 not only refused to call it proven, it left it unable to CONTRADICT
// anything — so a false 3-sighting play sitting inside it survived, and was the
// one precision error in that set's output.
//
// The correlation is the claim that actually matters: is the position inside the
// reference advancing steadily as the mix advances? An impostor pinned to one
// section cannot fake that, and neither can loop scatter.
export const LINEAR_CORR = 0.9;
export const LINEAR_RATE_MIN = 0.3;
export const LINEAR_RATE_MAX = 2.0;

// Weaker than linear, but still advancing steadily enough to report plainly.
export const ADVANCING_CORR = 0.75;
export const ADVANCING_RATE_MIN = 0.35;

// ── Reporting what we listened to and could NOT name ──────────────────
// Measured, most of what a scan misses is missing from Shazam's catalog rather
// than from the sampling, and from the outside those look identical: the user
// gets a short tracklist and no way to tell whether the app gave up or the
// record simply isn't findable. Naming the stretches makes the difference
// visible, and it costs nothing — it is read straight off probes already paid
// for.
//
// A stretch is only reported when it is long enough to hold a track (a shorter
// hole is a transition or an unrecognised intro, not a missing record) and when
// enough probes actually landed in it — "we listened here and couldn't name it"
// is a claim, and it must not be made about audio nothing ever listened to.
export const UNIDENTIFIED_MIN_SEC = 150;
export const UNIDENTIFIED_MIN_PROBES = 3;

// A blend is not a contradiction. DJs overlap records for 30-odd seconds, and
// during that overlap BOTH are genuinely audible, so a sighting near the edge of
// a stretch another record owns is exactly what a real transition looks like.
// Only the interior of an owned stretch contradicts.
export const BLEND_SEC = 30;

// Same record, no shared reference id, but close enough in the mix that it can
// only be one play. This is the grouping fallback for the case where Shazam's
// `matches` arrays simply don't intersect between two requests. It is longer
// than any plausible single play so a real play is never torn in two, and short
// enough that a genuine second spin later in the set stays a separate play.
export const LINK_MAX_GAP_SEC = 420;

// A reference position that barely moves while the mix does is the measured
// signature of an impostor (−0.31, −0.07, +0.05). Below this a play is rejected
// outright, however many times it was seen — repetition is exactly what a
// section-locked misread does best.
export const PINNED_RATE_MAX = 0.25;

// Of the probes in this play's window that heard ANYTHING, what share heard this
// record? A real play dominates its own stretch of the mix; a misread is one
// voice among several. No-match probes are excluded from the denominator on
// purpose — a region Shazam mostly can't hear says nothing either way, and
// counting its silence against a real play is how quiet sets lose their
// tracklist.
export const DOMINANT_SHARE = 0.5;

// Sightings before a play is reported at all. Two, not three: a single sighting
// is measured junk 11 times in 12 — and on a corpus set with a published
// tracklist, single sightings added ZERO recall, every one being an alias of a
// track already found. The third sighting, though, was costing real plays and
// buying nothing; repetition is not what makes the evidence good here, the chain
// tests are. (Named for hits rather than "unproven hits": it now gates every
// play, not just the ones that failed a proof.)
export const MIN_PLAY_HITS = 2;

// Confidence tiers, weakest first. Exported as an ordered list so callers can
// compare tiers without hard-coding the ordering.
export const TIERS = ['uncertain', 'likely', 'proven'];

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
  if (best) return best;

  // No shared reference id — which happens more than the maths above assumes,
  // because Shazam indexes the same audio several times over and returns a
  // different subset of those pressings from one request to the next. Two
  // sightings of the same record this close together are still one play; they
  // just carry no rate evidence, so the link is marked `weak` and every
  // downstream test that needs a rate (proves, the chain, the pinned check)
  // ignores it. Without this a record heard five times became five one-sighting
  // plays and was discarded entirely.
  if (Math.abs(dt) > LINK_MAX_GAP_SEC) return null;
  return { id: null, rate: null, dAnchor: null, anchor: null, weak: true };
}

/** Hard evidence that this record played continuously from a.t to b.t. */
export function proves(a, b) {
  const l = pairLink(a, b);
  if (!l || l.weak) return null;              // a weak link carries no anchor to prove with
  const dt = Math.abs(b.t - a.t);
  if (l.dAnchor > PROOF_SHARE * dt) return null;
  return l.dAnchor <= Math.max(PROOF_TOL, PROOF_DRIFT * dt) ? l : null;
}

/** Same record, position advancing plausibly — enough to group, not to assert. */
export function links(a, b) {
  const l = pairLink(a, b);
  if (!l) return null;
  if (l.weak) return l;                       // proximity alone, already bounded by LINK_MAX_GAP_SEC
  if (proves(a, b)) return l;
  return (l.rate >= LINK_RATE_MIN && l.rate <= LINK_RATE_MAX) ? l : null;
}

/**
 * The play's reference chain: the best-supported top-ranked reference recording,
 * with how fast its position advances and how steadily.
 *
 * `rate` is Theil–Sen (the median of all pairwise slopes), not least squares.
 * That is not a stylistic preference: loop-ambiguous records make Shazam lock
 * onto a different bar each probe, so one sighting's offset can sit hundreds of
 * seconds from its neighbours', and least squares is dragged bodily to that
 * outlier — on the ARTBAT offsets in this file's header it returns ≈ 2.2, far
 * outside any sane band, and it was rejecting real plays for it.
 *
 * `corr` is the plain correlation of reference position against mix time, and it
 * is the load-bearing number (see LINEAR_CORR above).
 */
function playChain(play) {
  const ids = new Map();
  for (const o of play.obs) {
    if (!o || !Array.isArray(o.matches)) continue;
    for (const m of o.matches.slice(0, CHAIN_RANK)) {
      if (!m || m.id == null || typeof m.offset !== 'number') continue;
      const id = String(m.id);
      if (!ids.has(id)) ids.set(id, []);
      ids.get(id).push([o.t, m.offset / (1 + (Number(m.timeskew) || 0) || 1)]);
    }
  }
  let pts = [];
  for (const v of ids.values()) if (v.length > pts.length) pts = v;
  if (pts.length < 2) return { n: pts.length, rate: null, corr: null };

  const rates = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dt = pts[j][0] - pts[i][0];
      if (dt) rates.push((pts[j][1] - pts[i][1]) / dt);
    }
  }
  rates.sort((a, b) => a - b);
  const mid = rates.length >> 1;
  const rate = rates.length ? (rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2) : null;

  let corr = null;
  if (pts.length >= CHAIN_MIN) {
    const n = pts.length;
    const mt = pts.reduce((acc, q) => acc + q[0], 0) / n;
    const mo = pts.reduce((acc, q) => acc + q[1], 0) / n;
    let sxy = 0; let sxx = 0; let syy = 0;
    for (const [t, o] of pts) { sxy += (t - mt) * (o - mo); sxx += (t - mt) ** 2; syy += (o - mo) ** 2; }
    corr = (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : null;
  }
  return { n: pts.length, rate, corr };
}

/**
 * Is this record demonstrably progressing across its whole span?
 *
 * This is the strong claim in the module now — it replaced "the anchor is
 * constant" for everything except pairwise gap-skipping, because a constant
 * anchor is only meaningful when the pressing lines up 1:1 with the mix, and
 * plenty of real ones don't.
 */
export function isLinear(p) {
  const c = p.chain || { n: 0 };
  return c.n >= CHAIN_MIN && c.corr != null && c.corr >= LINEAR_CORR
    && c.rate >= LINEAR_RATE_MIN && c.rate <= LINEAR_RATE_MAX;
}

/**
 * Of the probes inside this play's window that heard ANYTHING, what share heard
 * this record?
 *
 * A record that really is playing dominates its own stretch of the mix. A
 * section-locked misread turns up among sightings of whatever is actually
 * playing, so it doesn't. This is the evidence that lets a loop-ambiguous play —
 * whose rate is honest but scattered — be believed without loosening the rate
 * band for everyone.
 *
 * No-match probes are deliberately NOT in the denominator: a stretch Shazam
 * mostly can't hear (an unreleased dub over a live re-edit) says nothing about
 * whether this record is the one playing, and counting its silence as evidence
 * against would penalise exactly the underground sets that need help most.
 */
function playDominance(play, observations) {
  const lo = play.firstAt;
  const hi = play.lastAt;
  let heard = 0;
  for (const o of observations) {
    if (!o || !o.trackKey) continue;
    if (o.t < lo || o.t > hi) continue;
    heard++;
  }
  return heard > 0 ? play.hits / heard : 1;
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
    p.chain = playChain(p);
    p.rate = p.chain.rate;
    p.dominance = playDominance(p, observations);
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
 * Delete sightings that fall inside a stretch another record demonstrably owns.
 *
 * Ownership is `isLinear` — the record's position inside its own reference
 * advances steadily right across the stretch — not the old pairwise anchor
 * proof. Two things forced that change, in opposite directions:
 *
 *   • The pairwise test fired far too easily. It scans every pair of sightings
 *     against every shared reference id, and a response carries up to 20 ids, so
 *     it finds an agreeing pair by accident constantly. Measured, two junk plays
 *     armed that way deleted 43 of 125 sightings on one set.
 *   • And it could not fire at all for a large class of real records — anything
 *     whose pressing doesn't line up 1:1 with the mix. Measured, a
 *     chapter-confirmed track running at slope 0.55 was unable to contradict a
 *     false play sitting inside it, which then shipped as the set's only wrong
 *     row.
 *
 * The BLEND_SEC margin at each end is not a fudge factor. A DJ overlaps two
 * records for half a minute and both are genuinely playing; a sighting there is
 * a transition, not a contradiction, and deleting it throws away the incoming
 * track's earliest — sometimes only — evidence.
 */
export function dropContradicted(observations, plays) {
  const owners = plays.filter(isLinear);
  const dropped = [];
  for (const o of observations) {
    if (!o || !o.trackKey) continue;
    for (const p of owners) {
      if (p.trackKey === o.trackKey) continue;
      if (p.firstAt + BLEND_SEC < o.t && o.t < p.lastAt - BLEND_SEC) { dropped.push({ o, by: p }); break; }
    }
  }
  const bad = new Set(dropped.map((d) => d.o));
  return { kept: observations.filter((o) => !bad.has(o)), dropped };
}

/**
 * How much this play should be believed: 'proven' | 'likely' | 'uncertain', or
 * null for "don't report it at all".
 *
 * Everything here is a statement about the play's reference chain (see
 * playChain), because that is the only evidence that survived measurement:
 *
 *   • Advancing steadily across three or more sightings — the record is playing.
 *     Nothing else in this module is as reliable, and it is deliberately
 *     indifferent to the exact slope.
 *   • A pinned chain is REJECTED however many sightings back it. That is the
 *     measured impostor signature (−0.31, −0.07, +0.05: the reference standing
 *     still or running backwards while the mix moves on) and it is the one case
 *     where repetition means less rather than more, because a section-locked
 *     misread repeats by nature. One set returned the same wrong title at 17
 *     consecutive probes.
 *   • A single sighting is still dropped: measured, 11 of 12 were junk.
 *   • What is left is `uncertain` — real enough to show, thin enough to badge.
 *     It is reported and marked rather than silently deleted, because deleting
 *     it is what let a half-empty tracklist pass for a finished one.
 */
export function confidenceOf(p, { minHits = MIN_PLAY_HITS } = {}) {
  if (p.hits < minHits) return null;
  const c = p.chain || { n: 0 };

  if (c.n >= CHAIN_MIN && c.corr != null) {
    if (isLinear(p)) return 'proven';
    if (c.corr >= ADVANCING_CORR && c.rate >= ADVANCING_RATE_MIN) return 'likely';
    if (c.rate != null && c.rate < PINNED_RATE_MAX) return null;
    return 'uncertain';
  }

  // Too few points in the chain to test it. There is still evidence here — a
  // pairwise anchor that agreed, or a play that dominates its own window — but
  // it CANNOT earn an unbadged row, and that ceiling is the whole point. The
  // pairwise anchor is exactly the test that was shown above to find agreement
  // by accident across ~20 reference ids, so treating it as strong here while
  // distrusting it everywhere else would be incoherent. Measured on a techno
  // set, promoting these to `likely` put three two-sighting rows into the
  // tracklist unbadged, one of them a title that also turned up as junk in an
  // unrelated set.
  if (p.proven || p.dominance >= DOMINANT_SHARE) return 'uncertain';
  return null;
}

/** Rank of a tier, for "at least this confident" comparisons. */
export function tierRank(tier) {
  const i = TIERS.indexOf(tier);
  return i < 0 ? -1 : i;
}

/**
 * The stretches of the set that were listened to and could not be named.
 *
 * Coverage comes from the ACCEPTED plays, each spanning from its start estimate
 * (the anchor — earlier than the first sighting, since a DJ cues in mid-record)
 * to its last sighting. That deliberately over-states coverage at the edges:
 * over-stating means fewer stretches reported, and a spurious "nothing here"
 * would be worse than staying quiet about a real one.
 *
 * `heard` distinguishes the two failure modes, which mean different things to a
 * DJ: probes that returned *nothing at all* are unrecognisable audio (an
 * unreleased dub, a live re-edit), while probes that returned names none of
 * which held together are the catalog guessing — Shazam had an answer, it just
 * never agreed with itself.
 */
export function unidentifiedStretches(observations, plays, totalSec) {
  const spans = plays
    .map((p) => [Math.min(p.startSec, p.firstAt), p.lastAt])
    .sort((a, b) => a[0] - b[0]);

  const covered = [];
  for (const span of spans) {
    const last = covered[covered.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else covered.push([span[0], span[1]]);
  }

  const out = [];
  const consider = (fromSec, toSec) => {
    if (toSec - fromSec < UNIDENTIFIED_MIN_SEC) return;
    const probes = observations.filter((o) => o && o.t >= fromSec && o.t <= toSec);
    if (probes.length < UNIDENTIFIED_MIN_PROBES) return;
    out.push({
      fromSec: Math.max(0, Math.round(fromSec)),
      toSec: Math.round(toSec),
      probes: probes.length,
      heard: probes.filter((o) => o.trackKey).length,
    });
  };

  let cursor = 0;
  for (const [a, b] of covered) { consider(cursor, a); cursor = Math.max(cursor, b); }
  consider(cursor, totalSec);
  return out;
}

/** Full aggregation: sightings → play-ordered tracklist. */
export function tracklistFrom(observations, opts = {}) {
  const { minTier = 'uncertain' } = opts;
  const first = buildPlays(observations);
  const { kept, dropped } = dropContradicted(observations, first);
  const plays = [];
  for (const p of buildPlays(kept)) {
    const confidence = confidenceOf(p, opts);
    if (!confidence || tierRank(confidence) < tierRank(minTier)) continue;
    plays.push(Object.assign(p, { confidence }));
  }

  // One row per record, at its earliest play — but carrying the BEST confidence
  // any of its plays earned. A record spun twice, proven the second time and
  // only glimpsed the first, is a proven track that started early; reporting it
  // as uncertain because the earliest play was thin would badge a certainty.
  const byTrack = new Map();
  for (const p of plays) {
    const prev = byTrack.get(p.trackKey);
    if (!prev) { byTrack.set(p.trackKey, p); continue; }
    const best = tierRank(p.confidence) > tierRank(prev.confidence) ? p.confidence : prev.confidence;
    const earliest = p.startSec < prev.startSec ? p : prev;
    byTrack.set(p.trackKey, Object.assign(earliest, { confidence: best }));
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
      confidence: p.confidence,
    }));
  return { tracks, plays, dropped };
}
