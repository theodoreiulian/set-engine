// =============================================================================
// sources.js — Music-source registry + URL classification
// One entry per supported source (YouTube Music, Spotify, SoundCloud, Deezer,
// Tidal). Other modules consult this registry instead of branching on hardcoded
// strings. Adding a new source means adding an entry here, a wrapper module,
// and wiring in the download manager.
// =============================================================================

export const SOURCE_IDS = ['youtube-music', 'spotify', 'soundcloud', 'deezer', 'tidal'];

// -----------------------------------------------------------------------------
// URL classification
// -----------------------------------------------------------------------------

const SPOTIFY_URL_RE = /^https?:\/\/open\.spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]{22})/i;

function classifySpotify(url) {
  const m = SPOTIFY_URL_RE.exec(url);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  // album/playlist/artist all behave like playlists for download UX — spotdl
  // expands them into a series of tracks. Only /track is a single-item.
  return { source: 'spotify', kind: kind === 'track' ? 'track' : 'playlist', id: m[2] };
}

function classifyYouTube(url) {
  if (!/(^https?:\/\/)?([\w-]+\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/i.test(url)) return null;
  if (/\/playlist\b/i.test(url)) return { source: 'youtube-music', kind: 'playlist' };
  if (/\/watch\b/i.test(url)) return { source: 'youtube-music', kind: 'track' };
  if (/youtu\.be\//i.test(url)) return { source: 'youtube-music', kind: 'track' };
  if (/[?&]list=/.test(url)) return { source: 'youtube-music', kind: 'playlist' };
  return null;
}

/** Host + non-empty path segments, or null when `url` isn't an http(s) URL. */
function parseHttpUrl(url) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  return {
    host: u.hostname.toLowerCase().replace(/^www\./, ''),
    segments: u.pathname.split('/').filter(Boolean),
  };
}

// soundcloud.com/<first segment> pages that are the site itself, not a user.
const SOUNDCLOUD_SITE_PAGES = new Set([
  'discover', 'search', 'stream', 'you', 'feed', 'charts', 'upload', 'settings',
  'pages', 'terms-of-use', 'messages', 'notifications', 'people', 'tags',
  'stations', 'jobs', 'mobile', 'pro', 'popular', 'imprint', 'signin', 'logout',
  'library', 'checkout', 'connect', 'download',
]);
// soundcloud.com/<user>/<tab> — collections yt-dlp expands into tracks.
const SOUNDCLOUD_USER_COLLECTIONS = new Set([
  'tracks', 'albums', 'sets', 'reposts', 'likes', 'popular-tracks', 'spotlight',
]);
// …and the tabs that aren't music at all.
const SOUNDCLOUD_USER_OTHER = new Set(['comments', 'following', 'followers']);

function classifySoundCloud(url) {
  const p = parseHttpUrl(url);
  if (!p) return null;
  if (p.host === 'api.soundcloud.com' || p.host === 'api-v2.soundcloud.com') {
    if (p.segments[0] === 'tracks' && p.segments[1]) return { source: 'soundcloud', kind: 'track' };
    if (p.segments[0] === 'playlists' && p.segments[1]) return { source: 'soundcloud', kind: 'playlist' };
    return null;
  }
  if (p.host !== 'soundcloud.com' && p.host !== 'm.soundcloud.com') return null;
  const [user, second] = p.segments;
  if (!user || SOUNDCLOUD_SITE_PAGES.has(user.toLowerCase())) return null;
  // A bare profile is that user's uploads.
  if (!second) return { source: 'soundcloud', kind: 'playlist' };
  const tab = second.toLowerCase();
  if (SOUNDCLOUD_USER_OTHER.has(tab)) return null;
  // /<user>/sets/<set> is one playlist; /<user>/sets is all of them.
  if (SOUNDCLOUD_USER_COLLECTIONS.has(tab)) return { source: 'soundcloud', kind: 'playlist' };
  // /<user>/<track>, optionally followed by a private-share token (/s-XXXX).
  return { source: 'soundcloud', kind: 'track' };
}

// deezer.com/track/123, with an optional locale prefix (/fr/, /en/, /us/).
function classifyDeezer(url) {
  const p = parseHttpUrl(url);
  if (!p || p.host !== 'deezer.com') return null;
  const seg = p.segments[0] && /^[a-z]{2}(-[a-z]{2})?$/i.test(p.segments[0]) ? p.segments.slice(1) : p.segments;
  const type = (seg[0] || '').toLowerCase();
  const id = seg[1];
  if (!id || !/^\d+$/.test(id)) return null;
  if (type === 'track') return { source: 'deezer', kind: 'track', id };
  if (type === 'album' || type === 'playlist') return { source: 'deezer', kind: 'playlist', id };
  return null;
}

// tidal.com/browse/track/123, tidal.com/track/123, listen.tidal.com/album/123,
// and the album-scoped track form /album/123/track/456. A trailing /u (the
// "universal link" suffix TIDAL's share sheet adds) is ignored.
function classifyTidal(url) {
  const p = parseHttpUrl(url);
  if (!p || !/^(listen\.|embed\.)?tidal\.com$/.test(p.host)) return null;
  const seg = p.segments[0] === 'browse' ? p.segments.slice(1) : p.segments;
  const trackAt = seg.findIndex((s) => /^tracks?$/i.test(s));
  if (trackAt >= 0 && /^\d+$/.test(seg[trackAt + 1] || '')) {
    return { source: 'tidal', kind: 'track', id: seg[trackAt + 1] };
  }
  const type = (seg[0] || '').toLowerCase().replace(/s$/, '');
  const id = seg[1] || '';
  if (type === 'album' && /^\d+$/.test(id)) return { source: 'tidal', kind: 'playlist', id };
  if (type === 'playlist' && /^[0-9a-f-]{36}$/i.test(id)) return { source: 'tidal', kind: 'playlist', id };
  return null;
}

/**
 * Identify which source a URL belongs to and whether it's a single track or a
 * playlist-shaped resource. Returns null when the URL doesn't match any known
 * source.
 * @param {string} url
 * @returns {{ source: 'youtube-music'|'spotify'|'soundcloud'|'deezer'|'tidal', kind: 'track'|'playlist', id?: string } | null}
 */
export function classifyUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  return classifySpotify(u) || classifyYouTube(u) || classifySoundCloud(u)
    || classifyDeezer(u) || classifyTidal(u) || null;
}

// -----------------------------------------------------------------------------
// Share-sheet short links
// -----------------------------------------------------------------------------

// The mobile apps' share sheets hand out redirectors, not the real address, and
// the redirector says nothing about what it points at — track or playlist — so
// it has to be followed before it can be classified.
const SHORT_LINK_HOSTS = new Set(['on.soundcloud.com', 'link.deezer.com', 'deezer.page.link', 'dzr.page.link']);

export function isShortLink(url) {
  const p = parseHttpUrl(String(url || '').trim());
  return !!p && SHORT_LINK_HOSTS.has(p.host);
}

/**
 * Follow a share-sheet short link to the address it stands for. Anything that
 * isn't a known short link is returned untouched (no request is made), and so
 * is a short link that can't be followed — the caller then fails to classify it
 * and says so, rather than queueing something unknown.
 */
export async function expandShortLink(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const raw = String(url || '').trim();
  if (!isShortLink(raw)) return raw;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
    });
    if (res.url && classifyUrl(res.url)) return res.url;
    // Some redirectors answer with a page rather than a 30x; the destination is
    // then in the page's canonical / og:url.
    const body = await res.text();
    const m = body.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
      || body.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
    if (m && classifyUrl(m[1])) return m[1];
    return raw;
  } catch (_) {
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Source registry
// -----------------------------------------------------------------------------

// `downloader` names the engine DownloadManager hands the link to:
//   yt-dlp  — the link itself is downloadable.
//   spotdl  — spotdl resolves the link to a YouTube match and downloads that.
//   match   — the service is subscription-only, so nothing can be downloaded
//             from it. The link is read for what it names (catalog-sources.js)
//             and the same recording is found, verified and downloaded from
//             YouTube / SoundCloud (catalog-wrapper.js).
export const SOURCES = {
  'youtube-music': {
    id: 'youtube-music',
    label: 'YouTube Music',
    downloader: 'yt-dlp',
  },
  spotify: {
    id: 'spotify',
    label: 'Spotify',
    downloader: 'spotdl',
  },
  soundcloud: {
    id: 'soundcloud',
    label: 'SoundCloud',
    downloader: 'yt-dlp',
  },
  deezer: {
    id: 'deezer',
    label: 'Deezer',
    downloader: 'match',
  },
  tidal: {
    id: 'tidal',
    label: 'Tidal',
    downloader: 'match',
  },
};

export function getSource(sourceId) {
  return SOURCES[sourceId] || null;
}

export function isKnownSource(sourceId) {
  return Object.prototype.hasOwnProperty.call(SOURCES, sourceId);
}
