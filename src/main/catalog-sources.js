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
//   Spotify — only read when spotdl isn't installed (it isn't bundled). The
//            Web API wants a client token; the embed player at
//            open.spotify.com/embed/<type>/<id> server-renders a __NEXT_DATA__
//            blob with the title, artists, length and cover, and the rows of
//            an album / playlist / artist's top tracks. It lists at most 100
//            rows (measured: a 150-track playlist listed 100), so the real
//            count is read from the page's music:song_count — which Spotify
//            only server-renders for link-preview crawlers — and a longer
//            playlist reports `total`, never silently stopping short.
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

// ── Spotify ──────────────────────────────────────────────────────────────

// The user agent link previews are fetched with. Spotify's own pages render
// their metadata client-side for browsers and server-side for this.
const PREVIEW_AGENT = 'facebookexternalhit/1.1';

async function spotifyEmbed(type, id, fetchImpl) {
  const res = await request(`https://open.spotify.com/embed/${type}/${id}`, fetchImpl, 'text/html');
  if (res.status === 404) throw new Error('Spotify has nothing at that link (removed, or not public)');
  if (!res.ok) throw new Error(`Spotify answered HTTP ${res.status}`);
  const html = await res.text();
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  let data = null;
  try { data = m && JSON.parse(m[1]); } catch (_) { /* handled below */ }
  const props = data && data.props && data.props.pageProps;
  // A missing id answers 200 with a "Page not found" payload instead of an entity.
  if (props && props.status === 404) throw new Error('Spotify has nothing at that link (removed, or not public)');
  const entity = props && props.state && props.state.data && props.state.data.entity;
  if (!entity) throw new Error("Spotify's page for that link couldn't be read");
  return entity;
}

/** The largest image Spotify lists for an entity. */
function spotifyCover(entity) {
  const vi = entity.visualIdentity && entity.visualIdentity.image;
  const ca = entity.coverArt && entity.coverArt.sources;
  const imgs = (Array.isArray(vi) ? vi : Array.isArray(ca) ? ca : []).filter((i) => i && i.url);
  imgs.sort((a, b) => (Number(b.maxWidth || b.width) || 0) - (Number(a.maxWidth || a.width) || 0));
  return imgs.length ? imgs[0].url : '';
}

/**
 * Spotify names a version after a dash — "Body On Me - ADULT Remix",
 * "Never Gonna Give You Up - 2022 Remaster" — where every other catalogue and
 * nearly every upload brackets it. The matcher reads versions from brackets, so
 * the dash form made it refuse the right upload as "wrong version" (measured:
 * every "(Cake Mix)" upload for "… - Cake Mix"). Spotify always uses the LAST
 * " - " for this, so that one is rewritten.
 */
function spotifyTitle(s) {
  const t = String(s || '').trim();
  const at = t.lastIndexOf(' - ');
  if (at <= 0) return t;
  const version = t.slice(at + 3).trim();
  return version ? `${t.slice(0, at).trim()} (${version})` : t;
}

/** "spotify:track:<id>" → "https://open.spotify.com/track/<id>". */
const spotifyTrackUrl = (uri) => {
  const id = String(uri || '').split(':').pop();
  return /^[A-Za-z0-9]{22}$/.test(id) ? `https://open.spotify.com/track/${id}` : '';
};

// Row subtitles join artists with ",\u00a0".
const spotifyArtists = (s) => String(s || '').split(',').map((a) => a.replace(/\u00a0/g, ' ').trim()).filter(Boolean).join(', ');

/** How many tracks the playlist really has, or 0 if the page won't say. */
async function spotifySongCount(type, id, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://open.spotify.com/${type}/${id}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': PREVIEW_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) return 0;
    const m = /<meta[^>]+name=["']music:song_count["'][^>]+content=["'](\d+)["']/i.exec(await res.text());
    return m ? Number(m[1]) : 0;
  } catch (_) {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSpotify(cls, fetchImpl) {
  const type = cls.type || 'track';
  if (type === 'track') {
    const e = await spotifyEmbed('track', cls.id, fetchImpl);
    const artists = (Array.isArray(e.artists) ? e.artists : []).map((a) => a && a.name).filter(Boolean);
    const track = {
      url: `https://open.spotify.com/track/${cls.id}`,
      title: spotifyTitle(e.name || e.title),
      artist: artists.join(', ') || spotifyArtists(e.subtitle),
      // The embed doesn't name a single track's album.
      album: '',
      durationSec: Math.round((Number(e.duration) || 0) / 1000),
      trackNumber: 0,
      coverUrl: spotifyCover(e),
    };
    if (!track.title) throw new Error("Spotify's page for that track couldn't be read");
    return { title: track.title, total: 1, tracks: [track] };
  }
  const [e, count] = await Promise.all([
    spotifyEmbed(type, cls.id, fetchImpl),
    type === 'playlist' ? spotifySongCount(type, cls.id, fetchImpl) : Promise.resolve(0),
  ]);
  const isAlbum = type === 'album';
  const name = String(e.name || e.title || '').trim() || (isAlbum ? 'Album' : 'Playlist');
  const cover = isAlbum ? spotifyCover(e) : '';
  const rows = Array.isArray(e.trackList) ? e.trackList : [];
  const tracks = rows
    .filter((r) => r && (!r.entityType || r.entityType === 'track'))
    .map((r, i) => ({
      url: spotifyTrackUrl(r.uri),
      title: spotifyTitle(r.title),
      artist: spotifyArtists(r.subtitle),
      album: isAlbum ? name : '',
      durationSec: Math.round((Number(r.duration) || 0) / 1000),
      trackNumber: isAlbum ? i + 1 : 0,
      coverUrl: cover,
    }))
    .filter((t) => t.url && t.title);
  if (!tracks.length) throw new Error(`Spotify's page for that ${type} listed no tracks`);
  // An artist link means their top tracks, which is what the embed lists.
  const title = type === 'artist' ? `${name} - Top tracks`
    : isAlbum && e.subtitle ? `${spotifyArtists(e.subtitle)} - ${name}`
      : name;
  return { title, total: Math.max(count, tracks.length), tracks };
}

// ── Entry point ──────────────────────────────────────────────────────────

const CATALOG_LABELS = { spotify: 'Spotify', deezer: 'Deezer', tidal: 'Tidal' };

/**
 * Read what a Spotify / Deezer / Tidal link names.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ title: string, total: number, tracks: Array<{ url: string, title: string, artist: string, album: string, durationSec: number, trackNumber: number, coverUrl: string }> }>}
 *   `total` exceeds `tracks.length` when the service wouldn't list every track.
 */
export async function fetchCatalog(url, { fetchImpl = fetch } = {}) {
  const cls = classifyUrl(url);
  if (!cls || !CATALOG_LABELS[cls.source]) {
    throw new Error('Not a Spotify, Deezer or Tidal link');
  }
  try {
    if (cls.source === 'spotify') return await fetchSpotify(cls, fetchImpl);
    if (cls.source === 'deezer') return await fetchDeezer(cls, url, fetchImpl);
    if (cls.kind === 'track') {
      const track = await fetchTidalTrack(cls.id, fetchImpl);
      return { title: track.title, total: 1, tracks: [track] };
    }
    return await fetchTidalCollection(cls, url, fetchImpl);
  } catch (err) {
    const label = CATALOG_LABELS[cls.source];
    const msg = (err && err.message) || String(err);
    throw new Error(msg.startsWith(label) ? msg : `Couldn't read that ${label} link: ${msg}`);
  }
}
