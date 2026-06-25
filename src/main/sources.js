// =============================================================================
// sources.js — Music-source registry + URL classification
// One entry per supported source (YouTube Music, Spotify). Other modules consult
// this registry instead of branching on hardcoded strings. Adding a new source
// means adding an entry here, a wrapper module, and wiring in the download
// manager.
// =============================================================================

export const SOURCE_IDS = ['youtube-music', 'spotify'];

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

/**
 * Identify which source a URL belongs to and whether it's a single track or a
 * playlist-shaped resource. Returns null when the URL doesn't match any known
 * source.
 * @param {string} url
 * @returns {{ source: 'youtube-music'|'spotify', kind: 'track'|'playlist', id?: string } | null}
 */
export function classifyUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return classifySpotify(url) || classifyYouTube(url) || null;
}

// -----------------------------------------------------------------------------
// Source registry
// -----------------------------------------------------------------------------

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
};

export function getSource(sourceId) {
  return SOURCES[sourceId] || null;
}

export function isKnownSource(sourceId) {
  return Object.prototype.hasOwnProperty.call(SOURCES, sourceId);
}
