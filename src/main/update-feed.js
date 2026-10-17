// =============================================================================
// update-feed.js — what a release manifest says, and what it means for this copy
//
// Pure: no I/O. Every release publishes latest-mac.json beside its DMG (written
// by scripts/release/make-update.mjs); app-updater.js fetches it and asks this
// module whether it describes something newer, and what changed since.
// =============================================================================

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// Release notes are shown to the user verbatim; a manifest that carries an
// essay instead of a changelog is cut down rather than rendered.
const MAX_RELEASES = 30;
const MAX_CHANGES = 40;
const MAX_CHANGE_LENGTH = 300;

/** [major, minor, patch] for "1.0.41", or null for anything else. */
export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a < b, 0 when equal, positive when a > b. Throws on a malformed version. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Cannot compare versions "${a}" and "${b}".`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// The download has to come over HTTPS. Plain HTTP is accepted from this machine
// only, which is what testing an update against a local server needs.
function isAcceptableUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

function cleanReleases(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list.slice(0, MAX_RELEASES)) {
    if (!r || !parseVersion(r.version)) continue;
    const changes = (Array.isArray(r.changes) ? r.changes : [])
      .filter((c) => typeof c === 'string' && c.trim())
      .slice(0, MAX_CHANGES)
      .map((c) => c.trim().slice(0, MAX_CHANGE_LENGTH));
    out.push({ version: r.version, date: typeof r.date === 'string' ? r.date : null, changes });
  }
  return out;
}

/**
 * Validate a parsed latest-mac.json. Returns the fields the updater uses, or
 * throws with a reason — a manifest that is wrong in any way is never acted on.
 */
export function parseManifest(data) {
  if (!data || typeof data !== 'object') throw new Error('The update manifest is not a JSON object.');
  if (data.schema !== 1) throw new Error(`Unsupported update manifest schema ${data.schema}.`);
  if (!parseVersion(data.version)) throw new Error(`The update manifest names an invalid version "${data.version}".`);
  const zip = data.zip || {};
  if (!isAcceptableUrl(zip.url)) throw new Error('The update manifest has no usable download URL.');
  if (!SHA256_RE.test(String(zip.sha256 || ''))) throw new Error('The update manifest has no valid SHA-256.');
  if (!Number.isSafeInteger(zip.size) || zip.size <= 0) throw new Error('The update manifest has no valid size.');
  const page = isAcceptableUrl(data.page) ? data.page : null;
  return {
    version: data.version,
    date: typeof data.date === 'string' ? data.date : null,
    page,
    zip: { url: zip.url, sha256: zip.sha256, size: zip.size },
    releases: cleanReleases(data.releases),
  };
}

/**
 * The releases newer than `currentVersion`, newest first — what the user gets
 * by updating, including every release they skipped, not just the latest.
 */
export function changesSince(manifest, currentVersion) {
  if (!parseVersion(currentVersion)) return manifest.releases.slice(0, 1);
  return manifest.releases
    .filter((r) => compareVersions(r.version, currentVersion) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}
