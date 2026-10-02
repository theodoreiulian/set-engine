// =============================================================================
// bundled-tools.js — the command-line tools shipped inside the macOS .app
//
// The installer build carries yt-dlp, ffmpeg, ffprobe and QuickJS in
// Contents/Resources/bin (assembled by scripts/fetch-tools.mjs), so a new user
// installs nothing else. Every wrapper spawns its tool by bare name, so the
// whole integration is PATH: put the bundled directories first and the rest of
// the app is unchanged. With no bundle present — `npm start`, Windows, Linux —
// init is a no-op and the system-installed tools are used exactly as before.
//
// Deliberately imports nothing from `electron`: main.js passes in the two paths
// and its fetch, so this stays loadable from a plain Node script.
// =============================================================================

import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const QUARANTINE = 'com.apple.quarantine';
const YTDLP_RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases';
// The portable config yt-dlp reads from beside its binary. Mirrors the one
// scripts/fetch-tools.mjs writes: enable the bundled QuickJS as a JS runtime.
const YTDLP_CONF = '--js-runtimes quickjs\n';

const state = {
  binDir: null,        // directory holding ffmpeg / ffprobe / qjs
  ytDlpDir: null,      // directory holding the yt-dlp in use
  toolsRoot: null,     // userData/tools — everything this module writes
  bundledVersion: null,
  basePath: null,      // PATH as it was before the tool directories were added
  // main.js supplies Electron's net.fetch. Node's own fetch cannot be relied on
  // inside Electron's main process: measured on the dev machine it died with
  // UND_ERR_CONNECT_TIMEOUT against github.com while net.fetch, in the same
  // process, answered at once — the failure shazam/recognize.js documents for
  // Shazam. net.fetch also honours the system's proxy settings.
  fetch: (...args) => fetch(...args),
};

let updateInFlight = null;

function versionNumber(v) {
  const m = String(v || '').trim().match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}

function isQuarantined(file) {
  try {
    execFileSync('/usr/bin/xattr', ['-p', QUARANTINE, file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function stripQuarantine(dir) {
  try {
    execFileSync('/usr/bin/xattr', ['-dr', QUARANTINE, dir], { stdio: 'ignore' });
  } catch { /* read-only location: the caller re-checks and falls back */ }
}

/**
 * Return a directory the bundled tools can actually be executed from.
 *
 * An app downloaded in a browser carries the quarantine flag on every file in
 * it. macOS clears the app itself once the user approves it, but a bare helper
 * binary that is still flagged is killed on exec (measured: exit 137) — so the
 * app would launch and then fail at its first download. The user has already
 * approved running SetEngine by this point; these are its own helpers.
 *
 * Clearing the flag in place is free and is the normal case (an app dragged to
 * /Applications is writable by its owner). When the bundle is read-only — run
 * straight from the disk image, or translocated because it was launched from
 * Downloads — the tools are copied into userData instead, where files this
 * process writes are never quarantined.
 */
function executableBinDir(bundledDir) {
  const probe = path.join(bundledDir, 'qjs');
  if (!isQuarantined(probe)) return bundledDir;

  stripQuarantine(bundledDir);
  if (!isQuarantined(probe)) return bundledDir;

  const stamp = fs.readFileSync(path.join(bundledDir, 'versions.json'), 'utf8');
  const key = crypto.createHash('sha256').update(stamp).digest('hex').slice(0, 12);
  const copyDir = path.join(state.toolsRoot, `bin-${key}`);
  if (!fs.existsSync(path.join(copyDir, 'versions.json'))) {
    const partial = `${copyDir}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(state.toolsRoot, { recursive: true });
    execFileSync('/bin/cp', ['-R', bundledDir, partial]);
    stripQuarantine(partial);
    fs.rmSync(copyDir, { recursive: true, force: true });
    fs.renameSync(partial, copyDir);
  }
  return copyDir;
}

function applyPath() {
  process.env.PATH = [state.ytDlpDir, state.binDir, state.basePath].filter(Boolean).join(':');
}

// yt-dlp builds downloaded by updateBundledYtDlp() live in
// userData/tools/yt-dlp-<version>. Pick the newest that beats the bundled one,
// and delete the rest — including every one of them after an app update that
// ships something newer.
function newestUpdatedYtDlp() {
  let best = null;
  let entries = [];
  try { entries = fs.readdirSync(state.toolsRoot); } catch { return null; }
  const candidates = entries
    .map((name) => ({ name, m: name.match(/^yt-dlp-(\d{4}\.\d{2}\.\d{2})$/) }))
    .filter((e) => e.m)
    .map((e) => ({ dir: path.join(state.toolsRoot, e.name), version: e.m[1], n: versionNumber(e.m[1]) }));
  const floor = versionNumber(state.bundledVersion) ?? 0;
  for (const c of candidates) {
    if (c.n > floor && fs.existsSync(path.join(c.dir, 'yt-dlp')) && (!best || c.n > best.n)) best = c;
  }
  for (const c of candidates) {
    if (c !== best) fs.rm(c.dir, { recursive: true, force: true }, () => {});
  }
  return best;
}

/**
 * Put the bundled tools first on PATH. Call once, at startup, before anything
 * spawns a tool. Returns what is in use, or null when nothing is bundled.
 * @param {{ resourcesPath: string, userDataPath: string, fetch?: typeof fetch }} opts
 */
export function initBundledTools({ resourcesPath, userDataPath, fetch: fetchImpl }) {
  if (fetchImpl) state.fetch = fetchImpl;
  if (process.platform !== 'darwin' || !resourcesPath) return null;
  const bundledDir = path.join(resourcesPath, 'bin');
  let versions;
  try {
    versions = JSON.parse(fs.readFileSync(path.join(bundledDir, 'versions.json'), 'utf8'));
  } catch {
    return null; // not an installer build
  }

  state.toolsRoot = path.join(userDataPath, 'tools');
  state.bundledVersion = versions['yt-dlp'] || null;
  state.basePath = process.env.PATH || '';

  try {
    state.binDir = executableBinDir(bundledDir);
  } catch (err) {
    // Out of disk, unwritable profile: still better to try the bundle than to
    // fall through to "yt-dlp not found" on a machine that has nothing else.
    console.warn('[SetEngine] Could not prepare bundled tools:', err.message);
    state.binDir = bundledDir;
  }
  state.ytDlpDir = path.join(state.binDir, 'yt-dlp');

  // Leftovers from a failed update, and tool copies made for an older version.
  try {
    for (const name of fs.readdirSync(state.toolsRoot)) {
      const full = path.join(state.toolsRoot, name);
      const stale = name.startsWith('update-') || name.endsWith('.partial')
        || (name.startsWith('bin-') && full !== state.binDir);
      if (stale) fs.rm(full, { recursive: true, force: true }, () => {});
    }
  } catch { /* no tools dir yet */ }

  const updated = newestUpdatedYtDlp();
  if (updated) state.ytDlpDir = updated.dir;

  applyPath();
  return { binDir: state.binDir, ytDlpDir: state.ytDlpDir, versions };
}

/** True when the tools in use are the bundled ones. */
export function usingBundledTools() {
  return state.binDir !== null;
}

/** True when `file` is the bundled (or app-updated) copy of a tool. */
export function isBundledToolPath(file) {
  if (!file || !state.binDir) return false;
  let real = file;
  try { real = fs.realpathSync(file); } catch { /* compare as given */ }
  const under = (dir) => {
    if (!dir) return false;
    let d = dir;
    try { d = fs.realpathSync(dir); } catch { /* compare as given */ }
    return real === d || real.startsWith(d + path.sep);
  };
  return under(state.binDir) || under(state.ytDlpDir) || under(state.toolsRoot);
}

function currentYtDlpVersion() {
  const m = path.basename(state.ytDlpDir || '').match(/^yt-dlp-(\d{4}\.\d{2}\.\d{2})$/);
  return m ? m[1] : state.bundledVersion;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message || '').toString().trim() || `${cmd} failed`));
      else resolve(stdout.toString());
    });
  });
}

async function fetchOk(url, init) {
  const res = await state.fetch(url, init);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res;
}

async function latestYtDlpVersion() {
  // /releases/latest redirects to /releases/tag/<version>, which names the
  // release without the rate-limited API. The final URL would be enough, but
  // Electron's net.fetch reports an empty `url` after a redirect (measured), so
  // fall back to the same tag link in the page itself.
  const res = await fetchOk(`${YTDLP_RELEASES}/latest`);
  const tag = /\/yt-dlp\/yt-dlp\/releases\/tag\/([^/?#"'\s]+)/;
  const m = (res.url || '').match(tag) || (await res.text()).match(tag);
  if (!m) throw new Error('Could not work out the latest yt-dlp release.');
  return decodeURIComponent(m[1]);
}

async function downloadYtDlp(version) {
  const work = path.join(state.toolsRoot, `update-${process.pid}-${Date.now()}`);
  const zip = path.join(work, 'yt-dlp_macos.zip');
  const dir = path.join(work, 'yt-dlp');
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    const base = `${YTDLP_RELEASES}/download/${version}`;
    const sums = await (await fetchOk(`${base}/SHA2-256SUMS`)).text();
    const line = sums.split('\n').find((l) => /\syt-dlp_macos\.zip$/.test(l));
    if (!line) throw new Error('The yt-dlp release has no checksum for the macOS build.');
    const expected = line.trim().split(/\s+/)[0];

    const res = await fetchOk(`${base}/yt-dlp_macos.zip`);
    const hash = crypto.createHash('sha256');
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => hash.update(chunk));
    await pipeline(body, fs.createWriteStream(zip));
    if (hash.digest('hex') !== expected) {
      throw new Error('The downloaded yt-dlp failed its checksum and was discarded.');
    }

    // ditto, not unzip: it restores the layout of the bundled Python framework.
    await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
    await fs.promises.rename(path.join(dir, 'yt-dlp_macos'), path.join(dir, 'yt-dlp'));
    await fs.promises.chmod(path.join(dir, 'yt-dlp'), 0o755);
    await fs.promises.writeFile(path.join(dir, 'yt-dlp.conf'), YTDLP_CONF);

    // Prove it runs before anything depends on it. The first launch of a fresh
    // copy is slow (macOS scans it once), hence the generous timeout.
    const reported = (await run(path.join(dir, 'yt-dlp'), ['--version'], { timeout: 180_000 })).trim();
    if (reported !== version) throw new Error(`The downloaded yt-dlp reports ${reported}, expected ${version}.`);

    const finalDir = path.join(state.toolsRoot, `yt-dlp-${version}`);
    await fs.promises.rm(finalDir, { recursive: true, force: true });
    await fs.promises.rename(dir, finalDir);
    return finalDir;
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {});
  }
}

/**
 * Update the bundled yt-dlp to the latest release.
 *
 * yt-dlp's own `-U` refuses the onedir build ("not supported for unpackaged
 * executables"), and the single-file build that can self-update costs 11 s per
 * launch, so the app does it: download the release, verify it against the
 * release's SHA2-256SUMS, check that it runs, then switch PATH to it. Each
 * version gets its own directory, so a download already in flight keeps the
 * binary it started with; superseded directories are removed at next startup.
 *
 * @returns {Promise<string>} a one-line status for the UI
 */
export function updateBundledYtDlp() {
  if (!usingBundledTools()) return Promise.reject(new Error('This build does not bundle yt-dlp.'));
  if (!updateInFlight) {
    updateInFlight = (async () => {
      const current = currentYtDlpVersion();
      const latest = await latestYtDlpVersion();
      const latestN = versionNumber(latest);
      if (latestN === null) throw new Error(`Unrecognised yt-dlp release "${latest}".`);
      if (latestN <= (versionNumber(current) ?? 0)) return `yt-dlp is up to date (${current}).`;
      state.ytDlpDir = await downloadYtDlp(latest);
      applyPath();
      return `Updated yt-dlp ${current} → ${latest}.`;
    })().finally(() => { updateInFlight = null; });
  }
  return updateInFlight;
}
