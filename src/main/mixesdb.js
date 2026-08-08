// SetEngine — MixesDB tracklist lookup
//
// MixesDB is a community-curated wiki of DJ-set tracklists. It matters here
// because it covers exactly the gap the rest of the pipeline can't:
//
//   • Sets whose uploader published nothing — no chapters, no description
//     tracklist, no tracklist comment. Those are the sets audio recognition
//     does worst on, so they're where a tracklist is most valuable.
//   • Sets whose audio simply isn't in Shazam's catalog. Measured over five
//     full sets, ~15% of tracks return nothing at any probe (unreleased promos,
//     white labels, and artists playing their own live re-edits). No amount of
//     probing recovers those — tripling density recovered none — but a human who
//     was there often knows what they were.
//
// It exposes a standard MediaWiki API, and — the part that makes this reliable —
// set pages embed the source media links, so a set can be found by **exact
// YouTube video id** rather than by fuzzy title matching. Titles like
// "2018-05-24 - Solomun @ Cercle, Théâtre Antique d'Orange" would be miserable
// to match against a YouTube title; an id search is exact or nothing.
//
// Measured on the evaluation corpus: found 3 of 5 sets by id, and 86% of the
// entries it returned were independently corroborated by another source.
//
// Fail-soft throughout: any network/parse/timeout problem yields null and the
// caller falls through to the next source. Uses the global fetch available in
// the Electron main process (same as bpm-sources.js) — this host, unlike
// Shazam's, answers Node's client fine.

const API = 'https://www.mixesdb.com/w/api.php';
const USER_AGENT = 'SetEngine/1.0 (+https://github.com/setengine)';
const TIMEOUT_MS = 12000;

async function apiJson(params, signal) {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`;
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  return res.json();
}

// Run `fn(signal)` with a timeout; any failure becomes null.
function withTimeout(fn, ms, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  return Promise.resolve()
    .then(() => fn(controller.signal))
    .catch(() => null)
    .finally(() => {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
    });
}

/**
 * Parse a MixesDB `== Tracklist ==` section.
 *
 * Three timestamp conventions appear in the wild and all three are in the
 * corpus: `[0:12:34]`, `[12]` (bare minutes), and no timestamp at all. Entries
 * carry a trailing `[Label - CATNO]` which must come off — note the label uses
 * square brackets while remix markers use parentheses, so stripping only a
 * trailing `[...]` keeps "(Moonwalk Remix)" intact.
 *
 * `?` is the wiki's convention for a track nobody has identified; those are real
 * plays but name nothing, so they're dropped rather than turned into a garbage
 * search (same rule tracklist-sources.js applies to "ID - ID").
 */
export function parseTracklist(wikitext, splitArtistTitle) {
  const section = String(wikitext || '').split(/==\s*Tracklist\s*==/)[1] || '';
  const out = [];
  for (const raw of section.split('\n')) {
    if (!/^#/.test(raw)) continue;
    // `#w/ …` marks a track mixed over the previous one — a real entry.
    let line = raw.replace(/^#+\s*/, '').replace(/^w\/\s*/, '').trim();
    let offsetSec = 0;
    const hms = line.match(/^\[\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*\]\s*/);
    const mins = line.match(/^\[\s*(\d{1,3})\s*\]\s*/);
    if (hms) {
      line = line.slice(hms[0].length).trim();
      offsetSec = (Number(hms[1] || 0) * 3600) + (Number(hms[2]) * 60) + Number(hms[3]);
    } else if (mins) {
      line = line.slice(mins[0].length).trim();
      offsetSec = Number(mins[1]) * 60;
    }
    line = line.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    line = line.replace(/'''?/g, '').trim();          // wiki bold/italic markup
    if (!line || /^\?+$/.test(line)) continue;
    const parts = splitArtistTitle(line);
    if (!parts || !parts.title) continue;
    out.push({ ...parts, offsetSec });
  }
  return out;
}

/**
 * Find a MixesDB tracklist for a YouTube video id.
 *
 * @param {string} videoId
 * @param {(raw: string) => ({artist,title}|null)} splitArtistTitle — injected from
 *        tracklist-sources.js so both sources split names identically.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ title: string, entries: Array<{artist,title,offsetSec}> }|null>}
 */
export async function lookupByVideoId(videoId, splitArtistTitle, { signal } = {}) {
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) return null;

  const found = await withTimeout(
    (sig) => apiJson({ action: 'query', list: 'search', srsearch: `insource:"${videoId}"`, srlimit: '3' }, sig),
    TIMEOUT_MS, signal,
  );
  const hit = found && found.query && Array.isArray(found.query.search) && found.query.search[0];
  if (!hit || !hit.title) return null;

  const page = await withTimeout(
    (sig) => apiJson({
      action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: hit.title,
    }, sig),
    TIMEOUT_MS, signal,
  );
  if (!page || !page.query || !page.query.pages) return null;
  const first = Object.values(page.query.pages)[0];
  const wikitext = first && first.revisions && first.revisions[0]
    && first.revisions[0].slots && first.revisions[0].slots.main
    && first.revisions[0].slots.main['*'];
  if (!wikitext) return null;

  const entries = parseTracklist(wikitext, splitArtistTitle);
  if (entries.length < 3) return null;
  return { title: hit.title, entries };
}
