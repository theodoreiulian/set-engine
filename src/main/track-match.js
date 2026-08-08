// SetEngine — Track → YouTube match selection
//
// Turns a recognized (or published) "Artist — Title" into a concrete YouTube
// watch URL to download. Getting this wrong is worse than getting nothing: the
// caller writes the *expected* tags onto whatever file comes back, so a bad
// match produces a file that is correctly labelled and completely wrong — right
// title, right artist, wrong audio and wrong cover art. That is the single
// failure this module exists to prevent, so every path here fails closed.
//
// ── Why the old version got it wrong ──────────────────────────────────
// Measured over 55 real tracks from verified DJ-set tracklists: 6 (10.9%) came
// back as a different recording. Two independent defects combined:
//
//   1. Title normalisation destroyed the RIGHT candidate. The feat-stripping
//      regex ran to end-of-string, so the extremely common upload format
//      "Silva Bumpa FT. EVA - Body On Me" normalised to just "silva bumpa" —
//      the song title was deleted and the correct result failed the gate.
//   2. The artist was never actually checked. Search runs with
//      `--flat-playlist`, which returns ONLY a title — no artist, channel,
//      album or duration — so the artist test ("is the artist's name inside the
//      candidate's title?") could essentially never fire on a YouTube Music
//      result, whose title is a bare song name. The code then fell through to
//      "accept the first title-passing candidate", i.e. whatever YouTube ranked
//      first. For "Body on Me" that was a different artist's song entirely.
//
// So the correct candidate was rejected and an unverified one accepted.
//
// ── How this version works ────────────────────────────────────────────
// Two stages, cheap first:
//
//   1. PRE-FILTER on the flat search titles. Free, and it usually settles the
//      question: an upload titled "Artist - Title" carries both facts already.
//   2. VERIFY the shortlist against real metadata (`getVideoInfo`), in
//      confidence order, accepting the first candidate that passes every gate:
//      title, artist, version/remix, and duration. A candidate that cannot be
//      verified is never accepted — if nothing verifies we return null and the
//      caller skips the track.
//
// The common case costs one extra metadata fetch; a contested one costs a few.

// Words that appear in version markers but don't distinguish one version from
// another — "(Extended Mix)" is still the same record, "(ADULT Remix)" is not.
const GENERIC_VERSION_WORDS = new Set([
  'original', 'mix', 'edit', 'version', 'extended', 'radio', 'club', 'official',
  'audio', 'video', 'music', 'hd', 'hq', '4k', 'full', 'track', 'song', 'remaster',
  'remastered', 'master', 'stereo', 'mono', 'lyrics', 'lyric', 'visualizer', 'cut',
]);

// Bracketed markers that name a different *recording* of the same composition.
const VERSION_MARKER = /[([][^)\]]*\b(remix|edit|mix|version|bootleg|mashup|dub|instrumental|acapella|acappella|cover|rework|vip|blend|flip|refix)\b[^)\]]*[)\]]/gi;

// A track a DJ plays is minutes long. Below the floor is a snippet or a preview
// (measured: one match was a 32-second clip); above the ceiling is a mix, a
// radio show or a full set (a track query returned "Boiler Room: Sheffield").
const MIN_TRACK_SEC = 45;
const MAX_TRACK_SEC = 900;

// How many candidates we're willing to pay a metadata fetch for, per track, and
// how long the whole verification phase may take. Both matter: a set can be 60
// tracks, and without a wall-clock bound a few slow lookups would stall the
// caching phase. Running out of budget means "unverified", which means skip —
// never "accept the next one and hope".
const MAX_VERIFICATIONS = 5;
const VERIFY_BUDGET_MS = 60000;
const VERIFY_TIMEOUT_MS = 20000;

/** Unicode-aware reduction to space-separated lowercase words. */
function words(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const toks = (s) => words(s).split(' ').filter(Boolean);

/** Every token of `want` present in `hay`. Uploaders pad titles freely. */
function containsAll(hay, want) {
  const H = new Set(toks(hay));
  const W = toks(want);
  return W.length > 0 && W.every((t) => H.has(t));
}

/** Bounded edit distance — returns > max as soon as it's certain, no further. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Same word, allowing for a typo.
 *
 * Tracklists are typed by hand and misspell things — a real ground-truth entry
 * read "Indestructable" for Andy C's "Indestructible", and an exact-token gate
 * skipped the track entirely. Only long words are fuzzed, and only slightly, so
 * short generic words can't drift into each other.
 */
function tokenNear(a, b) {
  if (a === b) return true;
  const n = Math.max(a.length, b.length);
  if (n < 6) return false;
  const allowed = n >= 9 ? 2 : 1;
  return editDistance(a, b, allowed) <= allowed;
}

function containsAllFuzzy(hay, want) {
  const H = toks(hay);
  const W = toks(want);
  return W.length > 0 && W.every((w) => H.some((h) => tokenNear(h, w)));
}

/** Acts abbreviate: "TEED" is Totally Enormous Extinct Dinosaurs. */
function acronymMatch(a, b) {
  const A = toks(a); const B = toks(b);
  const acro = (x) => x.map((w) => w[0]).join('');
  if (A.length >= 2 && B.length === 1 && B[0] === acro(A)) return true;
  if (B.length >= 2 && A.length === 1 && A[0] === acro(B)) return true;
  return false;
}

/** Split "Artist - Title" on the first separator that has whitespace around it. */
export function splitOnDash(raw) {
  const s = String(raw || '');
  const m = s.match(/\s+[-–—]\s+/);
  if (!m) return null;
  const i = s.indexOf(m[0]);
  return { left: s.slice(0, i).trim(), right: s.slice(i + m[0].length).trim() };
}

/**
 * The song's identity with all variable packaging removed: bracketed groups,
 * featured artists, platform noise.
 *
 * Unlike the old normalizeForMatch this NEVER runs past a dash separator, which
 * is what deleted real titles in "Artist ft. Guest - Title" uploads.
 */
export function coreTitle(raw) {
  let t = String(raw || '').toLowerCase();
  let prev;
  do { prev = t; t = t.replace(/[([{][^()[\]{}]*[)\]}]/g, ' '); } while (t !== prev);
  t = t.replace(/\s*[-–—]?\s*\b(?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyrics?)\b\s*$/g, ' ');
  // Featured artists only ever trail the title, so stop at a dash: in
  // "Silva Bumpa FT. EVA - Body On Me" the title is what follows, not what dies.
  t = t.replace(/\s(?:feat|ft)\.?\s[^-–—]*$/, ' ');
  t = t.replace(/\s*-\s*topic\s*$/, ' ');
  return words(t);
}

/**
 * The distinguishing part of a version marker, or '' when this is just the
 * ordinary release. "(Extended Mix)" → '' (same record); "(ADULT Remix)" →
 * "adult" (a different record that must not be substituted).
 */
export function versionKey(raw) {
  const out = [];
  const s = String(raw || '');
  for (const m of s.matchAll(VERSION_MARKER)) {
    for (const t of toks(m[0])) if (!GENERIC_VERSION_WORDS.has(t)) out.push(t);
  }
  // Tracklists also write the cut without brackets — "Candy Shop Bootleg",
  // "Agenou Y.M.O. Remix". Without this the request looks like a plain record
  // and the correctly-bracketed upload gets rejected for "having a remix
  // marker". Only the bare keyword is taken here: guessing which of the
  // preceding words qualify it would eat real title words.
  if (!out.length) {
    for (const m of s.matchAll(/\b(remix|bootleg|mashup|rework|flip|refix|acapella|acappella|instrumental|dub|vip)\b/gi)) {
      out.push(m[1].toLowerCase());
    }
  }
  return [...new Set(out)].sort().join(' ');
}

/**
 * The title with version wording removed entirely.
 *
 * Used as an additional acceptance path so "Candy Shop Bootleg" can match an
 * upload titled "CANDY SHOP (MADDOS X FALENTIN BOOTLEG)": one side carries the
 * cut in the title text, the other inside brackets that coreTitle strips. The
 * cut itself is still enforced — separately, by versionAgrees — so dropping it
 * from the *identity* comparison loses nothing.
 */
function stripVersionWords(core) {
  const drop = new Set([...GENERIC_VERSION_WORDS,
    'remix', 'bootleg', 'mashup', 'rework', 'flip', 'refix',
    'acapella', 'acappella', 'instrumental', 'dub', 'vip']);
  return toks(core).filter((t) => !drop.has(t)).join(' ');
}

/** Primary performer: drop "- Topic", VEVO, and everything after a co-credit. */
export function primaryArtist(raw) {
  let a = String(raw || '');
  a = a.replace(/\s*-\s*topic\s*$/i, '').replace(/\bvevo\b/gi, '');
  a = a.split(/\s*(?:,|&|;|\bfeat\.?\b|\bft\.?\b|\bx\b|\bvs\.?\b|\bwith\b|\band\b)\s*/i)[0];
  return words(a);
}

// ── Gates ─────────────────────────────────────────────────────────────

/**
 * Does this candidate claim to be the song we asked for?
 *
 * `fuzzy` is the last-resort tier, used only after every provider has failed a
 * strict pass. It tolerates a typo in the requested title; the artist gate stays
 * strict either way, which is what keeps it from letting a wrong song through.
 */
function titleAgrees(candidateTitles, wantCore, fuzzy = false) {
  if (!wantCore) return false;
  const has = fuzzy ? containsAllFuzzy : containsAll;
  const wantBare = stripVersionWords(wantCore);
  return candidateTitles.some((c) => {
    const cc = coreTitle(c);
    if (!cc) return false;
    if (has(cc, wantCore)) return true;
    // Same song with the cut written on the other side of the brackets.
    const ccBare = stripVersionWords(cc);
    if (wantBare && ccBare && has(ccBare, wantBare)) return true;
    // ...and against the untouched title, which still holds whatever was inside
    // those brackets. Needed when the request names the remixer without
    // brackets ("Agenou Y.M.O. Remix") while the upload brackets it. Safe to be
    // generous here: the artist, version and duration gates are unchanged, and
    // they are what actually prevent a wrong recording.
    const rawWords = words(c);
    if (has(rawWords, wantCore) || (wantBare && has(rawWords, wantBare))) return true;
    // The reverse (candidate is a subset of what we asked for) only when the
    // candidate is specific enough that it can't match by accident.
    return toks(cc).length >= 2 && has(wantCore, cc);
  });
}

/**
 * Is this the right artist?
 *
 * Any one source agreeing is enough, because the two upload shapes carry the
 * artist in different places: an official "art track" has structured
 * artist/album fields and a bare title, while a fan upload has no structured
 * metadata at all and puts the artist in the title. Requiring a specific one
 * would reject whichever shape the correct result happens to be — measured, the
 * right answer for the reported bug was a fan upload with no artist field, and
 * the wrong answer was an art track with a perfect one.
 */
function artistAgrees(candidateArtists, wantArtist) {
  if (!wantArtist) return true;                 // nothing to check against
  const primary = primaryArtist(wantArtist);
  return candidateArtists.some((c) => {
    const cc = words(c);
    if (!cc) return false;
    return containsAll(cc, wantArtist) || containsAll(cc, primary) || acronymMatch(cc, primary);
  });
}

/**
 * A named remix must never be swapped — not for a different remix, and not for
 * the original. Both directions matter: asking for "(ADULT Remix)" and getting
 * "(Laurent Garnier Remix)" is a wrong file, and so is asking for the plain
 * record and getting somebody's remix of it.
 *
 * Generic packaging ("Extended Mix", "Radio Edit", "Original Mix") produces an
 * empty key, so the ordinary case of an upload being labelled a bit differently
 * from the detection still matches.
 */
function versionAgrees(candidateTitle, wantTitle) {
  const want = versionKey(wantTitle);
  if (!want) {
    // We asked for the plain record. Refuse anything that announces itself as a
    // different cut — bracketed or not, since plenty of uploads drop the
    // brackets entirely. Only the unambiguous words count: "mix" and "edit" are
    // far too common in ordinary titles to treat as evidence.
    return !versionKey(candidateTitle)
      && !/\b(remix|bootleg|mashup|rework|flip|refix|acapella|acappella|instrumental)\b/i.test(String(candidateTitle || ''));
  }
  // The candidate must carry every distinguishing token, wherever it sits in the
  // title. Requiring them inside brackets rejected a correct match titled
  // "… Silver Screen Shower Scene ADULT Remix" with no brackets at all.
  return containsAll(words(candidateTitle), want);
}

/**
 * A live performance or a set recording is a different recording.
 *
 * The duration gate catches whole sets, but not a single track lifted out of a
 * live show — measured, "WhoMadeWho live at Forum, Copenhagen 2024 - Tell Me Are
 * We Feat Rampa" passed every other gate (right artists, right title, plausible
 * length) and would have been downloaded in place of the studio version.
 *
 * Only unambiguous phrases are used. A bare "live" is far too common in ordinary
 * titles ("Living Sound", "Alive") to treat as evidence.
 */
const LIVE_MARKER = /\b(live (?:at|from|in|@)|boiler room|dj[-\s]?set|full set|live set|live session|essential mix|@ [A-Z])/i;

function looksLive(candidateTitle, wantTitle) {
  // If the request itself asks for a live cut, a live upload is what we want.
  if (LIVE_MARKER.test(String(wantTitle || ''))) return false;
  return LIVE_MARKER.test(String(candidateTitle || ''));
}

function durationPlausible(sec) {
  const d = Number(sec) || 0;
  if (!d) return true;                          // unknown — don't fail on absence
  return d >= MIN_TRACK_SEC && d <= MAX_TRACK_SEC;
}

/**
 * Full verification against real metadata. Returns { ok, reason }.
 * Exported so it can be exercised directly from a scratch script.
 */
export function verifyCandidate(info, want, { fuzzy = false } = {}) {
  if (!info) return { ok: false, reason: 'no metadata' };
  const raw = String(info.title || '');
  const dash = splitOnDash(raw);

  const titleSources = [info.track, raw, dash && dash.right].filter(Boolean);
  const artistSources = [
    info.artist, info.album_artist, info.creator,
    ...(Array.isArray(info.artists) ? info.artists : []),
    info.channel, info.uploader, dash && dash.left,
    // Last resort: the whole title. A remix is credited to the remixer, so the
    // original artist we asked for often appears only in the title text.
    raw,
  ].filter(Boolean);

  if (!durationPlausible(info.duration)) {
    return { ok: false, reason: `implausible length (${Math.round(Number(info.duration) || 0)}s)` };
  }
  if (looksLive(raw, want.title) || looksLive(info.track, want.title)) {
    return { ok: false, reason: `live/set recording (got "${raw}")` };
  }
  if (!titleAgrees(titleSources, want.core, fuzzy)) {
    return { ok: false, reason: `title mismatch (got "${info.track || raw}")` };
  }
  if (!artistAgrees(artistSources, want.artist)) {
    return { ok: false, reason: `artist mismatch (got "${info.artist || info.channel || '?'}")` };
  }
  if (!versionAgrees(info.track || raw, want.title)) {
    return { ok: false, reason: `wrong version (got "${info.track || raw}")` };
  }
  return { ok: true, reason: '' };
}

/** Rank a flat search hit before we've paid for its metadata. */
function preScore(candidateTitle, want, fuzzy = false) {
  const cc = coreTitle(candidateTitle);
  if (!titleAgrees([candidateTitle], want.core, fuzzy)) return -1;   // can't be right
  let s = 1;
  // The upload names the artist too — the strongest signal available for free.
  if (want.artist && containsAll(words(candidateTitle), primaryArtist(want.artist))) s += 2;
  if (versionAgrees(candidateTitle, want.title)) s += 1;
  // Prefer a tight title over one padded with extra words.
  if (cc && toks(cc).length <= toks(want.core).length + 2) s += 1;
  return s;
}

/**
 * Resolve a query to a YouTube watch URL that has been VERIFIED to be the
 * requested recording, or null when no candidate can be verified.
 *
 * Returns the verified metadata alongside the URL so the caller can re-check
 * what it actually downloaded (see the duration check in set-extractor.js).
 *
 * @param {object} ytDlp — YtDlpWrapper (searchMusic / searchYouTube / searchSoundCloud / getVideoInfo)
 * @param {string} query — "Artist Title" search text
 * @param {string} title — the detected song title
 * @param {string} [artist] — the detected artist
 * @returns {Promise<{url:string, videoId:string, durationSec:number, title:string, artist:string}|null>}
 */
export async function resolveBestVideo(ytDlp, query, title, artist) {
  const want = {
    title: String(title || ''),
    core: coreTitle(title),
    artist: String(artist || ''),
  };
  if (!want.core) return null;                  // nothing to match against → skip

  const deadline = Date.now() + VERIFY_BUDGET_MS;
  const seen = new Set();
  const gathered = [];                          // every candidate we've seen, any provider
  const infoCache = new Map();                  // url → metadata, so a fuzzy retry is free

  // Metadata for a candidate. SoundCloud's flat search is already complete, so
  // those cost nothing; YouTube's gives only a title and must be fetched.
  const metadataFor = async (c) => {
    if (infoCache.has(c.url)) return infoCache.get(c.url);
    let info = null;
    if (c.prefetched) {
      info = { id: c.id, title: c.title, track: c.track, uploader: c.uploader, duration: c.duration };
    } else {
      try { info = await ytDlp.getVideoInfo(c.url, null, { timeoutMs: VERIFY_TIMEOUT_MS }); }
      catch (_) { info = null; }
    }
    infoCache.set(c.url, info);
    return info;
  };

  const tryCandidates = async (list, fuzzy) => {
    const shortlist = list
      .map((c, i) => ({ c, i, s: preScore(c.title, want, fuzzy) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .slice(0, MAX_VERIFICATIONS);
    for (const { c } of shortlist) {
      if (Date.now() > deadline) return null;   // out of budget → unverified → skip
      const info = await metadataFor(c);
      if (!info) continue;                      // unreachable/dead → try the next
      const v = verifyCandidate(info, want, { fuzzy });
      if (v.ok) {
        return {
          url: c.url,
          videoId: String(info.id || c.id || ''),
          durationSec: Number(info.duration) || 0,
          title: String(info.track || info.title || ''),
          artist: String(info.artist || info.channel || info.uploader || ''),
          provider: c.provider || 'youtube',
        };
      }
      console.log(`[SetEngine] rejected "${info.title}" for "${want.artist} — ${want.title}": ${v.reason}`);
    }
    return null;
  };

  // Run one provider's search, retrying a genuine FAILURE once.
  //
  // This distinction is the whole reason `_flatSearch` reports `ok`. A search
  // that timed out or got throttled is not the same as a search that found
  // nothing, and treating them alike is what makes a fallback dangerous: during
  // a heavy concurrent run, transient YouTube throttling pushed 56 of 159 tracks
  // onto SoundCloud — tracks YouTube had all along — costing both audio quality
  // and accuracy. Retrying breaks that cascade instead of feeding it.
  const gather = async (fetchList) => {
    const fresh = [];
    let res = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { res = await fetchList(); } catch (_) { res = null; }
      if (res && res.ok) break;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
    const list = (res && res.results) || [];
    for (const c of list) {
      if (!c || !c.url || seen.has(c.url)) continue;
      seen.add(c.url);
      fresh.push(c);
      gathered.push(c);
    }
    return fresh;
  };

  // Providers in quality order, stopping as soon as one verifies. YouTube Music
  // first (its catalog is songs, and the audio is a clean master), then general
  // YouTube, then SoundCloud — which is searched only when the first two fail,
  // because that is exactly the case it exists for: bootlegs, edits, white
  // labels and promos that were never released to a streaming catalogue and so
  // genuinely are not on YouTube at all.
  const stages = [
    () => ytDlp.searchMusic(query, 8),
    () => ytDlp.searchYouTube(query, 8),
    () => ytDlp.searchSoundCloud(query, 8),
  ];
  for (const stage of stages) {
    const fresh = await gather(stage);
    if (!fresh.length) continue;
    const hit = await tryCandidates(fresh, false);
    if (hit) return hit;
    if (Date.now() > deadline) break;
  }

  // Last resort: re-examine everything already gathered, tolerating a typo in
  // the requested title. Hand-typed tracklists misspell things, and the metadata
  // for these candidates is already cached, so this costs almost nothing. The
  // artist, version and duration gates stay exactly as strict.
  const hit = await tryCandidates(gathered, true);
  if (hit) return hit;

  return null;                                  // fail closed: skip, never guess
}

/** Backwards-compatible wrapper: the URL alone, or null. */
export async function resolveBestVideoUrl(ytDlp, query, title, artist) {
  const hit = await resolveBestVideo(ytDlp, query, title, artist);
  return hit ? hit.url : null;
}
