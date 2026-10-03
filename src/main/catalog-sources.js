// =============================================================================
// catalog-sources.js — what a Deezer or Tidal link NAMES.
//
// Neither service can be downloaded from: both are subscription-only and
// DRM-protected, and yt-dlp has no extractor for either. What a link does carry
// is an exact description of a recording — title, artist, album, length — and
// that is all `track-match.js` needs to find the same recording on YouTube or
// SoundCloud and verify it. This module only reads that description; it never
// touches audio. `catalog-wrapper.js` does the matching and the download.
//
// No key and no account on either side, and both were measured, not assumed:
//
//   Deezer — the public JSON API (api.deezer.com), the same one bpm-sources.js
//            already uses. Albums and playlists page at 100 tracks a request.
//   Tidal  — has no keyless API (api.tidal.com wants a client token, and
//            borrowing another app's is not an option). Its public web pages
//            are enough: a track page carries a schema.org MusicRecording
//            (name, artists, album, ISO-8601 duration, cover), and the embed
//            player at embed.tidal.com server-renders an album's or playlist's
//            rows. The embed page stops at 50 rows and ignores any offset, so a
//            longer Tidal playlist comes back as its first 50 — reported via
//            `total`, never silently.
//
// Every lookup returns the same shape:
//   { title, total, tracks: [{ url, title, artist, album, durationSec,
//                              trackNumber, coverUrl }] }
// =============================================================================

import { classifyUrl } from './sources.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15000;
const DEEZER_PAGE = 100;
const DEEZER_MAX_TRACKS = 2000;

async function request(url, fetchImpl, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    return res;
  } catch (err) {
    throw new Error(err && err.name === 'AbortError' ? 'the request timed out' : `the request failed (${(err && err.message) || err})`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Deezer ───────────────────────────────────────────────────────────────

async function deezerJson(pathAndQuery, fetchImpl) {
  const res = await request(`https://api.deezer.com/${pathAndQuery}`, fetchImpl, 'application/json');
  if (!res.ok) throw new Error(`Deezer answered HTTP ${res.status}`);
  const data = await res.json();
  // Deezer reports failures as 200 + { error }.
  if (data && data.error) {
    const e = data.error;
    if (e.code === 800) throw new Error('Deezer has nothing at that link (removed, or not public)');
    if (e.code === 4) throw new Error('Deezer is rate-limiting requests — try again in a moment');
    throw new Error(`Deezer: ${e.message || e.type || 'unknown error'}`);
  }
  return data;
}

function deezerTrack(t, album) {
  const alb = t.album || album || {};
  // `contributors` (track endpoint only) lists every credited artist; list
  // endpoints give just the main one.
  const names = Array.isArray(t.contributors) && t.contributors.length
    ? t.contributors.filter((c) => !c.role || c.role === 'Main').map((c) => c.name)
    : [];
  const artist = (names.length ? names : [t.artist && t.artist.name]).filter(Boolean).join(', ');
  return {
    url: `https://www.deezer.com/track/${t.id}`,
    title: String(t.title || t.title_short || '').trim(),
    artist,
    album: String(alb.title || '').trim(),
    durationSec: Number(t.duration) || 0,
    trackNumber: Number(t.track_position) || 0,
    coverUrl: alb.cover_xl || alb.cover_big || alb.cover_medium || '',
  };
}

async function deezerPagedTracks(base, fetchImpl) {
  const out = [];
  for (let index = 0; index < DEEZER_MAX_TRACKS; index += DEEZER_PAGE) {
    const page = await deezerJson(`${base}/tracks?limit=${DEEZER_PAGE}&index=${index}`, fetchImpl);
    const rows = Array.isArray(page.data) ? page.data : [];
    out.push(...rows);
    if (!page.next || rows.length === 0) break;
  }
  return out;
}

async function fetchDeezer(cls, url, fetchImpl) {
  if (cls.kind === 'track') {
    const t = await deezerJson(`track/${cls.id}`, fetchImpl);
    const track = deezerTrack(t);
    return { title: track.title, total: 1, tracks: [track] };
  }
  const isAlbum = /\/album\//i.test(url);
  const head = await deezerJson(`${isAlbum ? 'album' : 'playlist'}/${cls.id}`, fetchImpl);
  const rows = await deezerPagedTracks(`${isAlbum ? 'album' : 'playlist'}/${cls.id}`, fetchImpl);
  // Album track rows carry no album of their own; playlist rows do.
  const tracks = rows.map((t) => deezerTrack(t, isAlbum ? head : null)).filter((t) => t.title);
  const by = isAlbum && head.artist && head.artist.name ? `${head.artist.name} - ` : '';
  return {
    title: `${by}${head.title || (isAlbum ? 'Album' : 'Playlist')}`,
    // nb_tracks counts entries Deezer won't list here (unavailable in this
    // region, or withdrawn) — measured: a playlist of 60 listed 50.
    total: Math.max(Number(head.nb_tracks) || 0, tracks.length),
    tracks,
  };
}

// ── Tidal ────────────────────────────────────────────────────────────────

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeHtml(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in HTML_ENTITIES ? HTML_ENTITIES[n.toLowerCase()] : m));
}

const stripTags = (s) => decodeHtml(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** "PT2M9S" / "PT1H2M3S" → seconds. */
function isoDurationSec(s) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(String(s || ''));
  if (!m) return 0;
  return Math.round((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0));
}

/** "3:28" / "1:02:03" → seconds. */
function clockSec(s) {
  const parts = String(s || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Tidal's image host serves any listed size from the same path.
const tidalCover = (u) => String(u || '').replace(/\/\d+x\d+(\.\w+)$/, '/1280x1280$1');

async function tidalHtml(url, fetchImpl) {
  const res = await request(url, fetchImpl, 'text/html');
  if (res.status === 404) throw new Error('Tidal has nothing at that link (removed, or not public)');
  if (!res.ok) throw new Error(`Tidal answered HTTP ${res.status}`);
  return res.text();
}

/** The schema.org object of the wanted @type from a page's JSON-LD blocks. */
function jsonLd(html, type) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      if (data && data['@type'] === type) return data;
    } catch (_) { /* not ours */ }
  }
  return null;
}

async function fetchTidalTrack(id, fetchImpl) {
  const html = await tidalHtml(`https://tidal.com/browse/track/${id}`, fetchImpl);
  const ld = jsonLd(html, 'MusicRecording');
  if (!ld || !ld.name) throw new Error("Tidal's page for that track couldn't be read");
  const artists = (Array.isArray(ld.byArtist) ? ld.byArtist : [ld.byArtist]).map((a) => a && a.name).filter(Boolean);
  return {
    url: `https://tidal.com/browse/track/${id}`,
    title: String(ld.name).trim(),
    artist: artists.join(', '),
    album: String((ld.inAlbum && ld.inAlbum.name) || '').trim(),
    durationSec: isoDurationSec(ld.duration),
    trackNumber: 0,
    coverUrl: tidalCover(ld.image),
  };
}

/**
 * Rows of an album / playlist, from the embed player's server-rendered markup:
 *   <list-item product-id="123" product-type="track">
 *     <span slot="title">…</span><span slot="artist"><a>…</a><a>…</a></span>
 *     <time slot="duration">3:28</time>
 *
 * An album row's artist slot lists only the artists a track has BEYOND the
 * album's own (it is empty on most rows), so the album artist is put first.
 */
function parseTidalEmbed(html, { albumArtist = '', album = '', coverUrl = '' } = {}) {
  const tracks = [];
  const re = /<list-item\b([^>]*)>([\s\S]*?)<\/list-item>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    if (!/product-type=["']track["']/i.test(attrs)) continue;    // videos have no place here
    const id = (/product-id=["'](\d+)["']/i.exec(attrs) || [])[1];
    const slot = (name, tag) => (new RegExp(`<${tag}[^>]*slot=["']${name}["'][^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(body) || [])[1] || '';
    const title = stripTags(slot('title', 'span'));
    if (!id || !title) continue;
    const rowArtists = [...slot('artist', 'span').matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((a) => stripTags(a[1])).filter(Boolean);
    const artists = [albumArtist, ...rowArtists].filter(Boolean);
    tracks.push({
      url: `https://tidal.com/browse/track/${id}`,
      title,
      artist: [...new Set(artists)].join(', '),
      album,
      durationSec: clockSec(stripTags(slot('duration', 'time'))),
      trackNumber: album ? (Number(stripTags(slot('index', 'span'))) || 0) : 0,
      coverUrl,
    });
  }
  return tracks;
}

async function fetchTidalCollection(cls, url, fetchImpl) {
  const isAlbum = !/playlist/i.test(url);
  const kind = isAlbum ? 'album' : 'playlist';
  // The browse page names the collection (and, for a playlist, says how many
  // tracks it really has); the embed page lists the rows.
  const [page, embed] = await Promise.all([
    tidalHtml(`https://tidal.com/browse/${kind}/${cls.id}`, fetchImpl),
    tidalHtml(`https://embed.tidal.com/${kind}s/${cls.id}`, fetchImpl),
  ]);
  const ld = jsonLd(page, isAlbum ? 'MusicAlbum' : 'MusicPlaylist') || {};
  const name = String(ld.name || '').trim() || (isAlbum ? 'Album' : 'Playlist');
  const albumArtist = isAlbum
    ? (Array.isArray(ld.byArtist) ? ld.byArtist : [ld.byArtist]).map((a) => a && a.name).filter(Boolean).join(', ')
    : '';
  const tracks = parseTidalEmbed(embed, isAlbum
    ? { albumArtist, album: name, coverUrl: tidalCover(ld.image) }
    : {});
  if (!tracks.length) throw new Error(`Tidal's page for that ${kind} listed no tracks`);
  return {
    title: albumArtist ? `${albumArtist} - ${name}` : name,
    total: Math.max(Number(ld.numTracks) || 0, tracks.length),
    tracks,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Read what a Deezer / Tidal link names.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ title: string, total: number, tracks: Array<{ url: string, title: string, artist: string, album: string, durationSec: number, trackNumber: number, coverUrl: string }> }>}
 *   `total` exceeds `tracks.length` when the service wouldn't list every track.
 */
export async function fetchCatalog(url, { fetchImpl = fetch } = {}) {
  const cls = classifyUrl(url);
  if (!cls || (cls.source !== 'deezer' && cls.source !== 'tidal')) {
    throw new Error('Not a Deezer or Tidal link');
  }
  try {
    if (cls.source === 'deezer') return await fetchDeezer(cls, url, fetchImpl);
    if (cls.kind === 'track') {
      const track = await fetchTidalTrack(cls.id, fetchImpl);
      return { title: track.title, total: 1, tracks: [track] };
    }
    return await fetchTidalCollection(cls, url, fetchImpl);
  } catch (err) {
    const label = cls.source === 'deezer' ? 'Deezer' : 'Tidal';
    const msg = (err && err.message) || String(err);
    throw new Error(msg.startsWith(label) ? msg : `Couldn't read that ${label} link: ${msg}`);
  }
}
