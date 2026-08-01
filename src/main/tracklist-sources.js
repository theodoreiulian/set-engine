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

// "Artist - Title", with any dash and required surrounding whitespace. The
// whitespace matters: it keeps hyphenated names ("A-Ha", "Jay-Z") intact while
// still splitting "Jay-Z - Song". Only the FIRST separator splits, so
// "Artist - Title - Extended Mix" keeps the mix suffix on the title.
const SEPARATOR = /\s+[-–—]\s+/;

// Leading track numbering: "01. ", "1) ", "1 - " is handled by SEPARATOR.
const LEADING_NUMBER = /^\s*\d{1,3}\s*[.)\]]\s+/;

// A timestamp at the start of a line: "1:23:45", "12:34", "[12:34]", "(12:34)".
const LEADING_TIMESTAMP = /^\s*[[(]?\s*(\d{1,2}:)?(\d{1,2}):(\d{2})\s*[\])]?\s*[-–—.)]?\s*/;

// DJ tracklists conventionally write an unreleased/unknown track as "ID - ID"
// (or "?"). Those are real entries but they name nothing, so carrying them
// forward would just send a garbage search to YouTube.
const UNKNOWN = /^(id|\?+|unknown|unreleased|untitled)$/i;

// Chapter titles that are navigation, not tracks.
const NON_TRACK = /^(intro|outro|start|end|credits|tracklist|subscribe|follow|links?|social|merch|thanks?|q\s*&\s*a)\b/i;

// Acceptance thresholds — see parsePublishedTracklist for why each exists.
const MIN_ENTRIES = 3;          // fewer than this is a marker, not a tracklist
const MIN_ARTIST_RATIO = 0.6;   // share of entries that must name an artist
const MIN_COVERAGE = 0.4;       // last entry must reach this fraction of the runtime

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

function fromDescription(info) {
  const desc = (info && info.description) || '';
  const out = [];
  for (const line of desc.split(/\r?\n/)) {
    const m = line.match(LEADING_TIMESTAMP);
    if (!m) continue;
    const rest = line.slice(m[0].length).trim();
    if (!rest) continue;
    const parts = splitArtistTitle(rest);
    if (!parts) continue;
    out.push({ ...parts, offsetSec: toSeconds(m[1] && m[1].slice(0, -1), m[2], m[3]) });
  }
  return out;
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
 * @param {object} info yt-dlp `--dump-json` payload
 * @returns {{ source: 'chapters'|'description', entries: Array<{artist,title,offsetSec}> }|null}
 */
export function parsePublishedTracklist(info) {
  const durationSec = Number(info && info.duration) || 0;

  for (const [source, entries] of [['chapters', fromChapters(info)], ['description', fromDescription(info)]]) {
    const usable = entries.filter(isUsable);
    if (usable.length < MIN_ENTRIES) continue;

    // Most entries should carry an artist. Generic chapter sets ("Part 1",
    // "Warm up", "Peak time") pass the count check but almost never have one,
    // and that's the signal that separates a tracklist from a table of contents.
    const withArtist = usable.filter((e) => e.artist).length;
    if (withArtist / usable.length < MIN_ARTIST_RATIO) continue;

    // A handful of markers at the top of a long set isn't a tracklist.
    if (durationSec > 0) {
      const last = usable[usable.length - 1].offsetSec;
      if (last / durationSec < MIN_COVERAGE) continue;
    }

    // Ascending order, and drop anything past the end of the video.
    const sorted = orientEntries(usable)
      .filter((e) => durationSec === 0 || e.offsetSec < durationSec)
      .sort((a, b) => a.offsetSec - b.offsetSec);
    if (sorted.length < MIN_ENTRIES) continue;

    return { source, entries: sorted };
  }

  return null;
}
