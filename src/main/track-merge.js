// SetEngine — Merging a published tracklist with recognition results
//
// Pure (no I/O) so it can be exercised against stored payloads.
//
// This exists because a published tracklist is often real but incomplete, and
// the two failure modes pull in opposite directions:
//
//   • Trusting the published list alone loses everything it didn't mention. A
//     "my favourites for my own reference" comment named 8 tracks of a 2-hour
//     set and, because a published list short-circuited recognition, those 8
//     were the entire answer.
//   • Trusting recognition alone loses the things only a human writes down —
//     correct remix credits, correct spelling, `w/` blends, and the unreleased
//     IDs that no fingerprinter has in its catalog at all.
//
// So keep both, and let the published entry win wherever they describe the same
// record. Recognition then only ever *adds*.

import { cleanTitle, primaryArtist } from './bpm-sources.js';

// Two hits are the same track if their normalized artist+title agree. Shared
// with set-extractor's dedupe (it imports this) so the two can't drift apart —
// a merge that disagreed with the dedupe would emit the same song twice.
export function identityKey(artist, title) {
  const a = primaryArtist(artist || '').toLowerCase();
  const t = cleanTitle(title || '').toLowerCase();
  return `${a} ${t}`.replace(/\s+/g, ' ').trim();
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/\p{Diacritic}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Containment rather than edit distance: the same record is routinely written
// long by one source and short by the other ("Silver Screen Shower Scene ADULT
// Remix" vs "Silver Screen"), and containment scores that 1.0 where a symmetric
// similarity would score it low.
function titleSimilarity(a, b) {
  const A = new Set(norm(cleanTitle(a)).split(' ').filter((w) => w.length > 1));
  const B = new Set(norm(cleanTitle(b)).split(' ').filter((w) => w.length > 1));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

// A recognized hit this close to a published entry, with a title that broadly
// agrees, is that entry under Shazam's name for it — not a second track. Kept
// tight because DJ sets really do change track every 2–3 minutes.
const NEAR_SEC = 45;
const NEAR_TITLE_SIM = 0.6;

// Agreement is measured by title containment, NOT by identity. Measured on five
// real sets: exact identity scored a correct, complete Anjunadeep chapter list at
// only 44%, because Shazam names the original release where the chapters name the
// "Anjunadeep 13 Edit" — close enough to the failing set (10%) to be useless as a
// signal. Containment scores that same list 78% and leaves the failure untouched.
const SPOT_TITLE_SIM = 0.6;

/**
 * How much of what was actually playing does a published tracklist mention?
 *
 * Input is spot-check observations (see shazam/recognize.js) and the list's
 * entries. Only probes that matched something count — a probe that heard nothing
 * says nothing about the list.
 *
 * Measured over five corpus sets with complete lists: 73%, 78%, 82%, 100%, 100%.
 * The set that triggered this work scored 10%.
 *
 * @returns {{matched:number, agree:number, fraction:number|null}} fraction is
 *   null when nothing matched, meaning "inconclusive", not "bad".
 */
export function spotCheckAgreement(observations, entries) {
  const matched = (observations || []).filter((o) => o && o.title);
  if (!matched.length) return { matched: 0, agree: 0, fraction: null };
  const agree = matched.filter((o) => (entries || [])
    .some((e) => titleSimilarity(o.title, e.title) >= SPOT_TITLE_SIM)).length;
  return { matched: matched.length, agree, fraction: agree / matched.length };
}

/**
 * Merge a published tracklist with recognition output.
 *
 * @param {Array<{artist,title,offsetSec}>} published entries from tracklist-sources
 * @param {Array<{artist,title,album,offsetSec}>} recognized output of the Shazam scan
 * @returns {Array<{artist,title,album,offsetSec,source:'published'|'shazam'}>}
 */
export function mergeTracklists(published, recognized, { nearSec = NEAR_SEC } = {}) {
  const base = (published || []).map((e) => ({
    artist: (e.artist || '').trim(),
    title: (e.title || '').trim(),
    album: (e.album || '').trim(),
    offsetSec: Math.max(0, Math.round(e.offsetSec || 0)),
    source: 'published',
  }));

  const seen = new Set();
  for (const e of base) {
    const k = identityKey(e.artist, e.title);
    if (k) seen.add(k);
  }

  const added = [];
  for (const r of (recognized || [])) {
    if (!r || !r.title) continue;
    const key = identityKey(r.artist, r.title);
    if (key && seen.has(key)) continue;                 // already named by a human

    // Shazam's catalog indexes the same audio under several names (bootleg
    // re-uploads, "…- Single" editions), so identity alone misses aliases of a
    // track the published list already has. Position plus a loose title match
    // catches those without merging genuinely adjacent tracks.
    const at = Math.max(0, Math.round(r.offsetSec || 0));
    const alias = base.some((b) => Math.abs(b.offsetSec - at) <= nearSec
      && titleSimilarity(r.title, b.title) >= NEAR_TITLE_SIM);
    if (alias) continue;

    if (key) seen.add(key);
    added.push({
      artist: (r.artist || '').trim(),
      title: (r.title || '').trim(),
      album: (r.album || '').trim(),
      offsetSec: at,
      source: 'shazam',
    });
  }

  return base.concat(added).sort((a, b) => a.offsetSec - b.offsetSec);
}
