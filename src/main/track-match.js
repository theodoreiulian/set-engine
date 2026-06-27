// SetEngine — Track → YouTube match selection
//
// Turns a recognized track's "Artist Title" into a concrete YouTube watch URL to
// download. We search YouTube *Music* (not general youtube.com) first, because
// its catalog is songs — its top hits are reliably the right studio track, not
// reactions, mixes, or wrong-artist uploads.
//
// On top of that ranking we enforce a hard correctness gate: the detected song
// title (minus variable extra-info like "(Extended Mix)", "(feat. …)", remaster/
// year tags) MUST appear in the candidate's title. Whether a platform shows that
// extra info varies, so we strip it from both sides and require the detected core
// title to be contained in the candidate's core title. The first candidate that
// passes wins. If YouTube Music yields no passing title, we try general YouTube
// with the same gate; if nothing anywhere passes, we return null so the caller
// skips the track rather than download a wrong file.
//
// Used by every place that turns a query into a download: the Set Extraction
// cache, the single-track download, and the whole-set download.

// Normalize a title for comparison: lowercase, strip ALL bracketed/parenthetical
// extra info, strip trailing dash-separated mix/edit/feat suffixes, then reduce
// to space-separated alphanumeric words. Unlike bpm-sources' `cleanTitle` (which
// deliberately *keeps* remix/mix words because they change the BPM), this removes
// them — here those words are exactly the variable noise we must ignore.
//
// Examples:
//   "Voices in My Head (Amelie Lens Remix)" -> "voices in my head"
//   "Surgeon - Badger Bite (Techno 1995)"   -> "surgeon badger bite"
//   "Doppler (Edit)"                         -> "doppler"
function normalizeForMatch(title) {
  let t = String(title || '').toLowerCase();
  // Remove bracketed/parenthetical groups: (Extended Mix), [Remix], {…}. Repeat
  // until stable so nested groups like "(feat. (Lil) Wayne)" are fully removed
  // (a single pass would leave the outer "(feat. … )" stranded).
  let prev;
  do {
    prev = t;
    t = t.replace(/[([{][^()[\]{}]*[)\]}]/g, ' ');
  } while (t !== prev);
  // Remove a trailing dash-separated extra-info segment, but only when that
  // segment is dominated by mix/version *noise* (a multi-word "… Mix"/"… Edit"
  // phrase, or an unambiguous remix/remaster keyword). Matching bare words like
  // "club"/"radio"/"original" wrongly collapsed real titles ("Kasabian - Club
  // Foot" → "kasabian"), so those are intentionally excluded here.
  t = t.replace(
    /\s[-–—]\s[^-–—]*\b(?:(?:extended|original|club|radio|vip|instrumental|acoustic|dub)\s+(?:mix|edit|version)|radio edit|remix|rework|bootleg|remaster(?:ed)?)\b[^-–—]*$/,
    ' ',
  );
  // Remove inline "feat …" / "ft …" through end of string. (`t` is already
  // lowercased, so the regexes need no /i flag.)
  t = t.replace(/\s(?:feat|ft)\.?\s.*$/, ' ');
  // Strip auto-channel "- topic" suffix.
  t = t.replace(/\s*-\s*topic\s*$/, ' ');
  // Unicode-aware reduction: decompose + strip diacritics, then keep letters and
  // numbers of *any* script. A plain [^a-z0-9] would blank out CJK/Cyrillic/Greek
  // titles entirely (→ always skipped) and split accented Latin into fragments
  // ("café" → "caf e"), causing false-negative skips.
  t = t.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// True when the detected core title appears in the candidate's title as a whole-
// word run. Word-boundary-aware (via padded spaces) so a short detected title
// like "go" can't spuriously match inside "good times". Also accepts the reverse
// — a multi-word candidate that is itself a subset of the detected title (e.g.
// upload "Voices In My" for detected "Voices In My Head") — but only when the
// candidate has ≥2 words, so a bare generic word can't match loosely.
function titleMatches(candidateTitle, detectedCore) {
  if (!detectedCore) return false;
  const cand = normalizeForMatch(candidateTitle);
  if (!cand) return false;
  const padCand = ' ' + cand + ' ';
  const padDet = ' ' + detectedCore + ' ';
  if (padCand.includes(padDet)) return true;
  if (cand.split(' ').length >= 2 && padDet.includes(padCand)) return true;
  return false;
}

// First candidate (in rank order) whose title passes the gate, else null. When
// the artist is known, prefer a passing candidate whose title also reflects the
// artist — this guards generic one-word titles ("Closer", "Love") from latching
// onto a wrong-artist upload. Falls back to the first title-passing candidate
// when none mention the artist (YouTube Music titles frequently omit it).
function firstTitleMatch(candidates, detectedCore, artistCore) {
  let fallback = null;
  for (const c of candidates) {
    if (!c || !c.url) continue;
    if (!titleMatches(c.title, detectedCore)) continue;
    if (artistCore && titleMatches(c.title, artistCore)) return c.url;
    if (!fallback) fallback = c.url;
  }
  return fallback;
}

// Resolve a query to a YouTube watch URL whose title matches the detected song,
// or null when no confident match exists (caller should then skip the track).
//
// @param {object} ytDlp  — YtDlpWrapper (provides searchMusic / searchYouTube)
// @param {string} query  — "Artist Title" search text
// @param {string} title  — the detected song title, for the title-match gate
// @param {string} [artist] — the detected artist, used to break ties between
//                            multiple title-passing candidates
// @returns {Promise<string|null>}
export async function resolveBestVideoUrl(ytDlp, query, title, artist) {
  const detectedCore = normalizeForMatch(title);
  if (!detectedCore) return null;   // nothing to match against → skip
  const artistCore = normalizeForMatch(artist || '');

  // 1) YouTube Music, gated by the title match.
  let songs = [];
  try { songs = await ytDlp.searchMusic(query, 5); } catch (_) { /* best-effort */ }
  const fromMusic = firstTitleMatch(songs, detectedCore, artistCore);
  if (fromMusic) return fromMusic;

  // 2) General YouTube fallback, same title gate.
  let videos = [];
  try { videos = await ytDlp.searchYouTube(query, 5); } catch (_) { /* best-effort */ }
  const fromYouTube = firstTitleMatch(videos, detectedCore, artistCore);
  if (fromYouTube) return fromYouTube;

  // 3) Nothing passed the gate → skip rather than download a wrong file.
  return null;
}
