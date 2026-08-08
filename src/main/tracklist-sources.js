// SetEngine — Published tracklist parsing
//
// The cheapest, most accurate tracklist is the one the uploader already wrote.
// A large share of DJ sets on YouTube ship a complete tracklist as chapter
// markers or as timestamped lines in the description, and yt-dlp already hands
// both to us in the JSON `getVideoInfo()` returns — so when it's there we can
// skip the audio download *and* recognition entirely and still get a better
// answer than any fingerprinter: correct remix names, correct spelling, correct
// order, exact start times, no requests, no cost.
//
// This module is pure (info object in, tracklist out) so it can be exercised
// against real `--dump-json` payloads without touching the network.
//
// Deliberately NOT parsed here: top comments. They very often hold a tracklist
// too, but they need a second yt-dlp pass (`--write-comments`, slow on big
// videos) and they're far noisier — a v2 idea, not a v1 one.

// "Artist - Title", with any dash and whitespace on AT LEAST ONE side.
//
// Requiring whitespace on *both* sides was too strict: real uploaders routinely
// write "Janice STFU- Drake (Hills Remix)" with the space only after the dash,
// and a whole 24-chapter tracklist then parsed as title-only and got thrown out
// by the artist-ratio gate below. One-sided whitespace still keeps hyphenated
// names intact, because in "Jay-Z" and "A-Ha" the dash has whitespace on neither
// side — it is only ever the " - " (or "- ") form that splits.
//
// Only the FIRST separator splits, so "Artist - Title - Extended Mix" keeps the
// mix suffix on the title.
const SEPARATOR = /(?:\s+[-–—]\s*|\s*[-–—]\s+)/;

// Leading track numbering: "01. ", "1) ", "1 - " is handled by SEPARATOR.
// Stripped BEFORE the timestamp too, because "1. 00:00 Artist - Title" is a
// common real-world layout and a timestamp anchored to the start of the line
// never sees it. (Safe against clock-like text: the terminator must be . ) or ],
// never ":", so "00:00" itself can't be eaten as a track number.)
const LEADING_NUMBER = /^\s*\d{1,3}\s*[.)\]]\s+/;
const LEADING_NUMBER_LOOSE = /^\s*\d{1,3}\s*[.)\]]\s*/;

// A timestamp at the start of a line: "1:23:45", "12:34", "[12:34]", "(12:34)".
const LEADING_TIMESTAMP = /^\s*[[(]?\s*(\d{1,2}:)?(\d{1,2}):(\d{2})\s*[\])]?\s*[-–—.)]?\s*/;

// ...and the same thing written at the END of the line, which plenty of
// uploaders do: "Artist - Title [12:34]".
const TRAILING_TIMESTAMP = /[\s\-–—]*[[(]?\s*(\d{1,2}:)?(\d{1,2}):(\d{2})\s*[\])]?\s*$/;

// DJ tracklists conventionally write an unreleased/unknown track as "ID - ID"
// (or "?"). Those are real entries but they name nothing, so carrying them
// forward would just send a garbage search to YouTube.
const UNKNOWN = /^(id|\?+|unknown|unreleased|untitled)$/i;

// Chapter titles that are navigation, not tracks.
const NON_TRACK = /^(intro|outro|start|end|credits|tracklist|subscribe|follow|links?|social|merch|thanks?|q\s*&\s*a)\b/i;

// Acceptance thresholds — see parsePublishedTracklist for why each exists.
const MIN_ENTRIES = 3;          // fewer than this is a marker, not a tracklist
const MIN_ARTIST_RATIO = 0.6;   // share of entries that must name an artist
const MIN_TITLE_ONLY_ENTRIES = 6; // bar for accepting a tracklist with no artists

// ── Completeness ──────────────────────────────────────────────────────
//
// A tracklist can be entirely real and still describe only a fraction of the
// set. That case used to be invisible: the old gate asked only where the LAST
// entry sat (`last.offsetSec / duration >= 0.4`), which a partial list passes
// trivially — a "my favourites for my own reference" comment on a 2-hour set
// scored 0.97 on it while naming 7 of ~40 tracks, and because a published list
// short-circuits recognition entirely, those 7 were the whole answer.
//
// So measure what the list actually accounts for. Each entry covers the run up
// to the next one, capped at a plausible maximum track length; everything before
// the first entry is uncovered. The result is the fraction of runtime the list
// claims to describe, which is the thing that was actually being asserted.
const MAX_TRACK_SEC = 720;              // 12 min — generous; long-form does exist
const COMPLETE_MIN_ACCOUNTED = 0.65;    // below this the list plainly has holes
const COMPLETE_MAX_HEAD_GAP = 480;      // 8 min — sets open with music, not silence
const COMPLETE_SOFT_ACCOUNTED = 0.90;   // above this a single long gap is forgiven

// Below this the "tracklist" is a couple of markers, not a partial tracklist.
// Kept low on purpose: a genuinely partial list is worth keeping and
// supplementing, and the artist-ratio gate above is what filters actual junk.
const MIN_ANY_ACCOUNTED = 0.10;

// Merging several comment tracklists: how far apart two entries must be before
// they're treated as different tracks rather than two people timing the same one.
const MERGE_MIN_SEPARATION_SEC = 60;
const MAX_MERGE_COMMENTS = 5;

function toSeconds(h, m, s) {
  return (parseInt(h || '0', 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10);
}

// "Artist - Title" → { artist, title }. With no separator the whole string is
// the title, which is still useful (a search for it usually resolves).
export function splitArtistTitle(raw) {
  const cleaned = String(raw || '').replace(LEADING_NUMBER, '').trim();
  if (!cleaned) return null;
  const m = cleaned.match(SEPARATOR);
  if (!m) return { artist: '', title: cleaned };
  const idx = cleaned.indexOf(m[0]);
  return {
    artist: cleaned.slice(0, idx).trim(),
    title: cleaned.slice(idx + m[0].length).trim(),
  };
}

// A bracketed mix/edit marker is an unambiguous *title* signal — an artist is
// never called "(Extended Mix)". Nothing equivalent marks an artist, so this is
// the one side of the pair we can identify with confidence. Square brackets
// count too: "[KMB Dance Edit]" and "[mashup]" are just as common as parens.
const TITLE_MARKER = /[([][^)\]]*\b(remix|edit|mix|version|bootleg|mashup|dub|instrumental|acapella|cover|rework|vip|blend)\b[^)\]]*[)\]]/i;

/**
 * Fix entries written "Title - Artist" instead of "Artist - Title".
 *
 * `Artist - Title` and `Title - Artist` are indistinguishable from the text
 * alone, so this only corrects the entries that carry actual evidence: a
 * mix/edit marker on the left means the left side is the title, so the pair is
 * reversed. Everything else is left exactly as parsed.
 *
 * Applied per entry, **not** per list. The obvious approach — decide the
 * orientation once from a majority vote and apply it to the whole tracklist —
 * was tried and is wrong: real uploaders mix both conventions inside a single
 * tracklist ("Snooze (SpydaTEK 'Throwback' Edit) - SpydaT.E.K-XTRA" two rows
 * above "SOLANGE - CRANES IN THE SKY (KAYTRANADA Remix)"), so a list-wide vote
 * flips the rows that were already right.
 *
 * Entries with no marker on either side stay untouched. Guessing there would be
 * a coin flip, and a wrong guess weakens the title-containment check that
 * `resolveBestVideoUrl` uses to refuse a bad download.
 */
function orientEntries(entries) {
  return entries.map((e) => {
    const leftIsTitle = TITLE_MARKER.test(e.artist || '');
    const rightIsTitle = TITLE_MARKER.test(e.title || '');
    if (leftIsTitle && !rightIsTitle) return { ...e, artist: e.title, title: e.artist };
    return e;
  });
}

function isUsable(entry) {
  if (!entry || !entry.title) return false;
  if (NON_TRACK.test(entry.title) && !entry.artist) return false;
  // "ID - ID" and friends name nothing.
  if (UNKNOWN.test(entry.title) && (!entry.artist || UNKNOWN.test(entry.artist))) return false;
  return true;
}

// ── Sources ───────────────────────────────────────────────────────────

function fromChapters(info) {
  const chapters = Array.isArray(info && info.chapters) ? info.chapters : [];
  const out = [];
  for (const c of chapters) {
    if (!c || typeof c.title !== 'string') continue;
    // Some uploaders repeat the timestamp inside the chapter title.
    const parts = splitArtistTitle(c.title.replace(LEADING_TIMESTAMP, ''));
    if (!parts) continue;
    out.push({ ...parts, offsetSec: Math.max(0, Math.round(Number(c.start_time) || 0)) });
  }
  return out;
}

// Pull timestamped "Artist - Title" entries out of any block of free text —
// shared by the description and the comment sources, which use identical
// layouts.
function fromText(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    // Strip "1." / "01)" numbering first so a timestamp behind it is still
    // anchored to the start of what remains.
    const line = raw.replace(LEADING_NUMBER_LOOSE, '');
    const lead = line.match(LEADING_TIMESTAMP);
    let rest;
    let offsetSec;
    if (lead) {
      rest = line.slice(lead[0].length).trim();
      offsetSec = toSeconds(lead[1] && lead[1].slice(0, -1), lead[2], lead[3]);
    } else {
      const tail = line.match(TRAILING_TIMESTAMP);
      if (!tail) continue;
      rest = line.slice(0, line.length - tail[0].length).trim();
      offsetSec = toSeconds(tail[1] && tail[1].slice(0, -1), tail[2], tail[3]);
    }
    if (!rest) continue;
    const parts = splitArtistTitle(rest);
    if (!parts) continue;
    out.push({ ...parts, offsetSec });
  }
  return out;
}

function fromDescription(info) {
  return fromText((info && info.description) || '');
}

/**
 * Drop a trailing bracket group that is a commenter talking rather than part of
 * the title — "(unreleased, been waiting since 2021)" on the end of a real track
 * name. Comments carry this constantly and descriptions basically never do.
 *
 * Narrow on purpose, because the same brackets carry load-bearing version
 * markers: anything naming a remix/edit/mix/feat is kept, and so is anything
 * under three words ("(Bailalo Remake)"). What's left is prose, and prose in the
 * title goes straight into the download search and breaks the match.
 */
const KEEP_BRACKET = /\b(remix|edit|mix|version|bootleg|mashup|dub|instrumental|acapella|acappella|cover|rework|vip|blend|flip|feat|ft|with|vs|live)\b/i;

function stripCommentary(entry) {
  const t = String(entry.title || '');
  const m = t.match(/\s*[([]([^)\]]*)[)\]]\s*$/);
  if (!m) return entry;
  const inner = m[1].trim();
  if (KEEP_BRACKET.test(inner)) return entry;
  if (inner.split(/\s+/).filter(Boolean).length < 3) return entry;
  const stripped = t.slice(0, t.length - m[0].length).trim();
  return stripped ? { ...entry, title: stripped } : entry;
}

/**
 * Tracklists posted in the comments.
 *
 * For DJ sets this is a large, previously untapped source. Of six 1-hour-plus
 * sets checked that published NO chapters and NO description tracklist, all six
 * had a complete tracklist in a comment. Those are exactly the sets audio
 * recognition struggles most with, so this is the cheapest accuracy anywhere in
 * the pipeline — and the most reliable: on every one of those six, a *second,
 * independently written* comment tracklist confirmed the chosen one entry for
 * entry (23/23, 19/19, 19/19, 18/18, 18/18, 17/17).
 *
 * Comments are noisy, so each candidate comment is parsed independently and the
 * strongest one wins — a tracklist comment is long, densely timestamped and
 * heavily upvoted, none of which is true of ordinary chatter. yt-dlp only
 * populates `info.comments` when asked (see ytdlp-wrapper's getVideoInfo
 * `withComments`), and that pass is slow, so recognise it as a last resort.
 *
 * The best comment is the base, but the runners-up are folded in rather than
 * discarded. Different listeners ID different tracks: on one measured set the
 * winning comment covered 43:00 onwards while a second comment supplied
 * "25:00 MPH - LA NYC" from the unlisted first half, and a third named a track
 * the winner had written as "ID". An entry is only added where the base list has
 * nothing within a minute, so two people timing the same track can't double it.
 */
function fromComments(info) {
  const comments = Array.isArray(info && info.comments) ? info.comments : [];
  const candidates = [];
  for (const c of comments) {
    if (!c || typeof c.text !== 'string') continue;
    const entries = fromText(c.text).map(stripCommentary).filter(isUsable);
    if (entries.length < MIN_ENTRIES) continue;
    // Prefer the longest tracklist; break ties on community endorsement.
    const rank = entries.length * 1000
      + Math.min(999, Math.log10(Math.max(1, Number(c.like_count) || 0)) * 200)
      + (c.is_pinned ? 500 : 0)
      + (c.author_is_uploader ? 800 : 0);
    candidates.push({ rank, entries });
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => b.rank - a.rank);

  const merged = candidates[0].entries.slice();
  for (const cand of candidates.slice(1, MAX_MERGE_COMMENTS)) {
    for (const e of cand.entries) {
      let nearest = null;
      for (const held of merged) {
        const d = Math.abs(held.offsetSec - e.offsetSec);
        if (!nearest || d < nearest.d) nearest = { d, held };
      }
      if (!nearest || nearest.d > MERGE_MIN_SEPARATION_SEC) { merged.push(e); continue; }
      // Same moment, and the base list left it unnamed ("ID", "?"). Another
      // listener naming it is strictly better than carrying the placeholder.
      if (UNKNOWN.test(nearest.held.title) && !UNKNOWN.test(e.title)) {
        nearest.held.title = e.title;
        if (e.artist) nearest.held.artist = e.artist;
      }
    }
  }
  return merged.sort((a, b) => a.offsetSec - b.offsetSec);
}

/**
 * How much of the runtime a tracklist actually accounts for, plus the shape of
 * what it leaves out. See MAX_TRACK_SEC above for why this replaced the old
 * "where does the last entry sit" check.
 */
export function coverageOf(entries, durationSec) {
  const d = Number(durationSec) || 0;
  if (!entries.length || d <= 0) {
    return { accountedFraction: 0, headGapSec: 0, maxGapSec: 0, medianGapSec: 0, minutesPerTrack: 0 };
  }
  let accounted = 0;
  const gaps = [];
  for (let i = 0; i < entries.length; i++) {
    const next = (i + 1 < entries.length) ? entries[i + 1].offsetSec : d;
    accounted += Math.min(Math.max(0, next - entries[i].offsetSec), MAX_TRACK_SEC);
    if (i + 1 < entries.length) gaps.push(entries[i + 1].offsetSec - entries[i].offsetSec);
  }
  gaps.sort((a, b) => a - b);
  return {
    accountedFraction: accounted / d,
    headGapSec: entries[0].offsetSec,
    maxGapSec: gaps.length ? gaps[gaps.length - 1] : 0,
    medianGapSec: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0,
    minutesPerTrack: (d / 60) / entries.length,
  };
}

/**
 * Is this list complete enough to stand alone, or does it need supplementing?
 *
 * Max-gap is deliberately the weakest of the three signals: one long track or an
 * interlude is completely normal, and a measured set (Disclosure/Plitvice) has a
 * 15-minute gap while accounting for 93% of its runtime. So a big gap only
 * condemns a list that is *also* missing a lot elsewhere.
 */
function isComplete(cov) {
  if (cov.accountedFraction < COMPLETE_MIN_ACCOUNTED) return false;
  if (cov.headGapSec > COMPLETE_MAX_HEAD_GAP) return false;
  if (cov.maxGapSec > MAX_TRACK_SEC && cov.accountedFraction < COMPLETE_SOFT_ACCOUNTED) return false;
  return true;
}

/**
 * Coverage + verdict for a tracklist that didn't come through
 * parsePublishedTracklist — MixesDB, which arrives pre-parsed from its own API
 * but is exactly as capable of being partial.
 */
export function completenessOf(entries, durationSec) {
  const coverage = coverageOf(entries || [], durationSec);
  return { coverage, complete: Number(durationSec) > 0 ? isComplete(coverage) : true };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Extract a published tracklist from a yt-dlp info object.
 *
 * Returns `null` whenever the result doesn't look like a real tracklist, so the
 * caller falls back to audio recognition. The checks exist because plenty of
 * videos carry chapters that aren't tracklists at all ("Intro", "Part 1") or a
 * couple of navigation markers on a two-hour set — accepting those would
 * silently replace a good recognition run with three junk rows.
 *
 * A returned tracklist carries `complete`. **False does not mean bad** — the
 * entries are still real and still better-named than anything a fingerprinter
 * produces; it means they don't describe the whole set, so the caller should
 * scan the audio as well and merge (see set-extractor.js). Treating "parsed" as
 * "finished" is what let 7 hand-picked comment entries stand in for a 2-hour
 * tracklist.
 *
 * @param {object} info yt-dlp `--dump-json` payload
 * @returns {{ source: 'chapters'|'description'|'comments', entries: Array<{artist,title,offsetSec}>,
 *            complete: boolean, coverage: object }|null}
 */
/**
 * Name of the act performing, inferred from the video title.
 *
 * Needed for artist-less tracklists (below): when a live set is one artist
 * playing their own catalogue, the chapters are bare song titles. Without an
 * artist those searches are far too generic to resolve, but the performer is
 * almost always the first thing in the title — "Kiasmos live for Cercle at …",
 * "Armand Van Helden | Boiler Room: Miami", "BELLE - Live Dj Set | …".
 */
function inferPerformer(info) {
  let t = String((info && info.title) || '').trim();
  if (!t) return '';
  const cut = t.search(/\s+(?:\||@|-|–|—|:)\s+|\s+(?:live|b2b|presents|plays|at\s)/i);
  if (cut > 0) t = t.slice(0, cut);
  t = t.replace(/\s{2,}/g, ' ').trim();
  // A whole sentence isn't an artist name.
  return (t && t.split(/\s+/).length <= 5) ? t : '';
}

export function parsePublishedTracklist(info) {
  const durationSec = Number(info && info.duration) || 0;
  const performer = inferPerformer(info);

  const sources = [
    ['chapters', fromChapters(info)],
    ['description', fromDescription(info)],
    ['comments', fromComments(info)],
  ];

  for (const [source, entries] of sources) {
    const usable = entries.filter(isUsable);
    if (usable.length < MIN_ENTRIES) continue;

    // Most entries should carry an artist. Generic chapter sets ("Part 1",
    // "Warm up", "Peak time") pass the count check but almost never have one,
    // and that's the signal that separates a tracklist from a table of contents.
    //
    // The exception is a one-artist live set, where every chapter is a bare song
    // title ("Grown", "Looped", "Laced" for a Kiasmos set). Rejecting those threw
    // away complete, correct tracklists, so they are accepted when the video
    // title names a performer we can attribute them to and the entries are spaced
    // like tracks rather than like section markers.
    const withArtist = usable.filter((e) => e.artist).length;
    let attributed = usable;
    if (withArtist / usable.length < MIN_ARTIST_RATIO) {
      if (!performer || usable.length < MIN_TITLE_ONLY_ENTRIES) continue;
      if (!looksTrackSpaced(usable, durationSec)) continue;
      attributed = usable.map((e) => (e.artist ? e : { ...e, artist: performer }));
    }

    // Ascending order, and drop anything past the end of the video.
    const sorted = orientEntries(attributed)
      .filter((e) => durationSec === 0 || e.offsetSec < durationSec)
      .sort((a, b) => a.offsetSec - b.offsetSec);
    if (sorted.length < MIN_ENTRIES) continue;

    const coverage = coverageOf(sorted, durationSec);
    // A handful of markers at the top of a long set isn't even a partial
    // tracklist — that's a table of contents.
    if (durationSec > 0 && coverage.accountedFraction < MIN_ANY_ACCOUNTED) continue;

    // With no runtime there is nothing to measure against, so don't invent a
    // verdict — treat it as complete, exactly as this did before.
    return {
      source,
      entries: sorted,
      coverage,
      complete: durationSec === 0 ? true : isComplete(coverage),
    };
  }

  return null;
}

// Entries spaced like tracks (roughly 1–12 minutes apart) rather than like a
// table of contents. Used only for the artist-less path above, where the usual
// "does it name an artist" signal isn't available.
function looksTrackSpaced(entries, durationSec) {
  if (entries.length < 2) return false;
  const gaps = [];
  for (let i = 1; i < entries.length; i++) gaps.push(entries[i].offsetSec - entries[i - 1].offsetSec);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (!(median >= 45 && median <= 720)) return false;
  // And they should account for most of the runtime, not just cluster early.
  if (durationSec > 0) {
    const span = entries[entries.length - 1].offsetSec - entries[0].offsetSec;
    if (span / durationSec < 0.5) return false;
  }
  return true;
}
