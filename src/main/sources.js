// =============================================================================
// sources.js — Music-source registry
// One entry per supported source (YouTube Music, Spotify). Other modules consult
// this registry instead of branching on hardcoded strings. Adding a new source
// means adding an entry here, a wrapper module, and an entry in main.js wiring.
// =============================================================================

export const SOURCE_IDS = ['youtube-music', 'spotify'];

// -----------------------------------------------------------------------------
// DOM scrape scripts
// -----------------------------------------------------------------------------

// Injected into the YT Music WebContentsView via executeJavaScript. Walks the
// rendered DOM for song rows and returns a normalized array. Polymer custom
// elements + structural class names are stable enough for this to work for now;
// expect to revisit when YT Music ships a redesign. Multiple selector fallbacks
// per field guard against minor restructures.
export const YTMUSIC_SCRAPE_SCRIPT = `
(function() {
  function parseDuration(str) {
    if (!str) return null;
    var parts = String(str).trim().split(':').map(function(p) { return parseInt(p, 10); });
    if (parts.some(function(n) { return isNaN(n); })) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function textOf(el) { return el ? (el.textContent || '').trim() : ''; }

  function extractVideoId(href) {
    if (!href) return null;
    var m = href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  var rows = document.querySelectorAll('ytmusic-responsive-list-item-renderer');
  var seen = new Set();
  var results = [];

  rows.forEach(function(row) {
    var links = row.querySelectorAll('a[href*="watch?v="]');
    var videoId = null;
    for (var i = 0; i < links.length; i++) {
      videoId = extractVideoId(links[i].getAttribute('href'));
      if (videoId) break;
    }
    if (!videoId || seen.has(videoId)) return;
    seen.add(videoId);

    var titleEl = row.querySelector('.title-column .title yt-formatted-string')
               || row.querySelector('.title yt-formatted-string')
               || row.querySelector('yt-formatted-string.title');
    var title = textOf(titleEl);

    var channel = '';
    var secondary = row.querySelectorAll('.secondary-flex-columns yt-formatted-string');
    if (secondary.length > 0) {
      channel = textOf(secondary[0]);
    } else {
      var flex = row.querySelectorAll('.flex-columns yt-formatted-string');
      if (flex.length >= 2) channel = textOf(flex[1]);
    }

    var durEl = row.querySelector('.fixed-columns yt-formatted-string')
             || row.querySelector('[class*="duration"]');
    var duration = durEl ? parseDuration(durEl.textContent) : null;

    var img = row.querySelector('img');
    var thumbnail = img ? (img.src || img.getAttribute('src')) : null;

    results.push({
      id: videoId,
      url: 'https://music.youtube.com/watch?v=' + videoId,
      title: title,
      channel: channel,
      duration: duration,
      thumbnail: thumbnail,
      source: 'youtube-music'
    });
  });

  return results;
})()
`;

// Injected into the Spotify WebContentsView. Spotify is a React SPA where rows
// surface under stable `data-testid` attributes — track rows in lists and
// search results both use `tracklist-row`. We extract a Spotify track ID from
// the first `/track/<id>` link in the row, the row's title, the artist line,
// and the thumbnail image. Spotify doesn't render duration in compact search
// rows, so duration is best-effort (often null).
export const SPOTIFY_SCRAPE_SCRIPT = `
(function() {
  function textOf(el) { return el ? (el.textContent || '').trim() : ''; }

  function parseDuration(str) {
    if (!str) return null;
    var m = String(str).trim().match(/^(\\d+):(\\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function extractTrackId(href) {
    if (!href) return null;
    var m = href.match(/\\/track\\/([A-Za-z0-9]{22})/);
    return m ? m[1] : null;
  }

  var rows = document.querySelectorAll('[data-testid="tracklist-row"], [data-testid="track-row"]');
  var seen = new Set();
  var results = [];

  rows.forEach(function(row) {
    var links = row.querySelectorAll('a[href*="/track/"]');
    var trackId = null;
    for (var i = 0; i < links.length; i++) {
      trackId = extractTrackId(links[i].getAttribute('href'));
      if (trackId) break;
    }
    if (!trackId || seen.has(trackId)) return;
    seen.add(trackId);

    // Title: first /track/ link's text content is the most reliable
    var title = '';
    for (var j = 0; j < links.length; j++) {
      var t = textOf(links[j]);
      if (t) { title = t; break; }
    }

    // Artists: every /artist/ link in the row, joined
    var artistLinks = row.querySelectorAll('a[href*="/artist/"]');
    var artists = [];
    artistLinks.forEach(function(a) {
      var name = textOf(a);
      if (name && artists.indexOf(name) === -1) artists.push(name);
    });
    var artistStr = artists.join(', ');

    // Duration: Spotify sometimes labels the cell with aria-colindex=5 or a
    // dedicated class. Best-effort parse of any M:SS text in the row.
    var duration = null;
    var durCandidates = row.querySelectorAll('div, span');
    for (var k = 0; k < durCandidates.length; k++) {
      var txt = textOf(durCandidates[k]);
      if (/^\\d{1,2}:\\d{2}$/.test(txt)) {
        duration = parseDuration(txt);
        if (duration) break;
      }
    }

    var img = row.querySelector('img');
    var thumbnail = img ? (img.src || img.getAttribute('src')) : null;

    results.push({
      id: trackId,
      url: 'https://open.spotify.com/track/' + trackId,
      title: title,
      channel: artistStr,
      artists: artistStr,
      duration: duration,
      thumbnail: thumbnail,
      source: 'spotify'
    });
  });

  return results;
})()
`;

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

// A current desktop Chrome UA. Spotify's web player sniffs the user-agent and
// silently serves a degraded layout (oversized icons, missing controls, "your
// browser is not supported" banner) to anything that looks like a non-mainstream
// browser — including stock Electron. Spoofing a recent Chrome UA is the single
// fix that makes the embedded player render correctly. YouTube Music historically
// hasn't cared but we apply the same UA to both for consistency.
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const SOURCES = {
  'youtube-music': {
    id: 'youtube-music',
    label: 'YouTube Music',
    entryUrl: 'https://music.youtube.com',
    partition: 'persist:youtube-music',
    cookieDomain: '.youtube.com',
    cookieFileName: 'youtube-cookies.txt',
    authCookieNames: ['SID', 'HSID', 'SSID'],
    scrapeScript: YTMUSIC_SCRAPE_SCRIPT,
    downloader: 'yt-dlp',
    userAgent: DESKTOP_CHROME_UA,
  },
  spotify: {
    id: 'spotify',
    label: 'Spotify',
    entryUrl: 'https://open.spotify.com',
    partition: 'persist:spotify',
    cookieDomain: '.spotify.com',
    cookieFileName: 'spotify-cookies.txt',
    authCookieNames: ['sp_dc', 'sp_key'],
    scrapeScript: SPOTIFY_SCRAPE_SCRIPT,
    downloader: 'spotdl',
    userAgent: DESKTOP_CHROME_UA,
  },
};

export function getSource(sourceId) {
  return SOURCES[sourceId] || null;
}

export function isKnownSource(sourceId) {
  return Object.prototype.hasOwnProperty.call(SOURCES, sourceId);
}
