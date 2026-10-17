// =============================================================================
// app-updater.js — SetEngine replaces itself with the newest release
//
// Every merge to master publishes a release (.github/workflows/release.yml)
// carrying three files: SetEngine.dmg for new users, SetEngine-mac.zip (the
// same app, zipped by ditto) and latest-mac.json, the manifest read here. The
// app checks the manifest at launch and then hourly. When it names a newer
// version the renderer asks the user, and NOTHING is downloaded until they
// click UPDATE & RESTART — then the zip is fetched, checked, unpacked and
// verified, the app quits, and a small shell script swaps the bundle and
// starts the new version.
//
// Why not Electron's autoUpdater (or electron-updater, which drives the same
// thing): on macOS both go through Squirrel.Mac, which only installs an update
// whose code signature satisfies the running app's designated requirement.
// This build is ad-hoc signed, and an ad-hoc designated requirement is the
// bundle's own cdhash (`codesign -d -r-` on a packaged build prints
// `designated => cdhash H"…"`), which no other build can ever match. So
// until there is a Developer ID, the app swaps its own bundle.
//
// That the swap needs no "Open Anyway" is the point of doing it this way: the
// zip is fetched by this process, not a browser, so nothing in it is
// quarantined and Gatekeeper never assesses the new copy. The user approves
// SetEngine once, on first install, and never again.
//
// A merge that ships a build which cannot start is the failure that matters
// most here: an app that crashes at launch cannot update itself to the fix. So
// the new version proves it started (markLaunched(), once its first page has
// rendered) and the install script puts the previous version back if that
// proof does not arrive.
//
// Deliberately imports nothing from `electron`, like bundled-tools.js: main.js
// passes in paths, its net.fetch and a quit callback, so this stays loadable
// from a plain Node test.
// =============================================================================

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions, parseManifest, changesSince, parseVersion } from './update-feed.js';

const CHECK_DELAY_MS = 4_000;              // first check, shortly after launch
const CHECK_INTERVAL_MS = 60 * 60 * 1000;  // then hourly: a merge reaches a running app within the hour
const MANIFEST_TIMEOUT_MS = 20_000;
const STALL_TIMEOUT_MS = 60_000;           // a download that sends nothing for this long is abandoned
const LAUNCH_TIMEOUT_SEC = 120;            // how long the new version has to prove it started
const ASIDE_MAX_AGE_MS = 10 * 60 * 1000;   // a previous copy younger than this may still be in use by the script
const PROGRESS_EVERY_MS = 250;

// Written next to the staged update and run with /bin/sh once the app has
// quit. Arguments: pid target staged aside marker failed version log timeout,
// then the arguments the app was started with, which the relaunched copy gets too
// (--user-data-dir in particular — without it a test profile would update and
// then reopen on the real one).
//
// Only ever renames whole bundles. Two renames on one volume are as close to
// atomic as a shell gets, and nothing inside either bundle is written.
const INSTALL_SCRIPT = `#!/bin/sh
pid=$1 target=$2 staged=$3 aside=$4 marker=$5 failed=$6 version=$7 log=$8 timeout=$9
shift 9
exec >>"$log" 2>&1
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
# Tells the copy that comes back what went wrong (read by _readFailure()).
fail() { printf '{"version":"%s","at":"%s","reason":"%s"}\\n' "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" > "$failed"; }
relaunch() {
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target" >/dev/null 2>&1
  if [ $# -gt 0 ]; then /usr/bin/open "$target" --args "$@"; else /usr/bin/open "$target"; fi
}
# PIDs of the copy at $target. comm is the executable's full path; read keeps
# any spaces in it, so a path with spaces still compares exactly.
pids() { /bin/ps -axo pid=,comm= | while read -r p c; do [ "$c" = "$target/Contents/MacOS/SetEngine" ] && echo "$p"; done; }

say "Installing SetEngine $version over $target"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 600 ]; then say "SetEngine (pid $pid) did not quit within 60 s; update abandoned."; exit 1; fi
  sleep 0.1
done

rm -f "$marker"
if ! /bin/mv "$target" "$aside"; then
  say "Could not move the current copy aside; nothing was changed."
  fail could-not-replace; relaunch "$@"; exit 1
fi
if ! /bin/mv "$staged" "$target"; then
  say "Could not move the new copy into place; restoring the current one."
  /bin/mv "$aside" "$target"
  fail could-not-replace; relaunch "$@"; exit 1
fi
/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null
say "Swapped; starting SetEngine $version"
relaunch "$@"

n=0
while [ ! -e "$marker" ] && [ "$n" -lt "$timeout" ]; do sleep 1; n=$((n + 1)); done
if [ -e "$marker" ]; then
  say "SetEngine $version is running."
  /bin/rm -rf "$aside"
  exit 0
fi
# Running but silent is not started: a main-process error waits behind a dialog,
# and a renderer that throws leaves a blank window. Either way it is stopped.
say "SetEngine $version did not start within $timeout s; putting the previous version back."
running=$(pids)
if [ -n "$running" ]; then
  kill $running 2>/dev/null
  sleep 3
  kill -9 $(pids) 2>/dev/null
fi
/bin/mv "$target" "$aside-failed" && /bin/mv "$aside" "$target"
fail did-not-start
/bin/rm -rf "$aside-failed"
relaunch "$@"
`;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message || '').toString().trim() || `${cmd} failed`));
      else resolve(stdout.toString());
    });
  });
}

async function plistValue(appPath, key) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  return (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).trim();
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function rmQuiet(p) {
  return fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}

/** The .app containing `execPath` (…/SetEngine.app/Contents/MacOS/SetEngine), or null. */
export function bundleFromExecPath(execPath) {
  if (!execPath) return null;
  const bundle = path.resolve(execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/**
 * Why this copy cannot replace itself, or null when it can. The update needs
 * to rename the bundle, so it needs write access to the bundle and the folder
 * it sits in.
 */
export function installBlocker(bundlePath, access = fs.accessSync) {
  if (!bundlePath) {
    return { reason: 'unknown', message: 'SetEngine could not find its own app bundle, so it cannot update itself.' };
  }
  // Opened straight from Downloads without being moved: macOS runs it from a
  // randomised read-only copy, and renaming that would achieve nothing.
  if (bundlePath.includes('/AppTranslocation/')) {
    return {
      reason: 'translocated',
      message: 'SetEngine is running from a temporary copy macOS makes for apps opened straight from Downloads. Move SetEngine into your Applications folder and open it from there, and it will update itself from then on.',
    };
  }
  try {
    access(path.dirname(bundlePath), fs.constants.W_OK);
    access(bundlePath, fs.constants.W_OK);
    return null;
  } catch {
    if (bundlePath.startsWith('/Volumes/')) {
      return {
        reason: 'read-only',
        message: 'SetEngine is running from its disk image (or another read-only disk). Drag it into your Applications folder and open it from there, and it will update itself from then on.',
      };
    }
    return {
      reason: 'permission',
      message: `SetEngine doesn't have permission to replace itself in ${path.dirname(bundlePath)}. Download the new version and install it by hand — your settings are kept.`,
    };
  }
}

export default class AppUpdater {
  /**
   * @param {object} o
   * @param {string} o.feedUrl          latest-mac.json; '' turns updates off (local builds)
   * @param {boolean} o.supported       a packaged macOS build — the only kind that can swap itself
   * @param {string} o.currentVersion
   * @param {string|null} o.bundlePath  the running .app
   * @param {string} o.userDataPath
   * @param {typeof fetch} o.fetch      Electron's net.fetch (see bundled-tools.js for why not Node's)
   * @param {() => { downloads: number, extractions: number }} o.busy  work a restart would stop
   * @param {() => void} o.quit
   * @param {string[]} [o.relaunchArgs]
   * @param {(state: object) => void} [o.onState]
   */
  constructor(o) {
    this.feedUrl = o.feedUrl || '';
    this.supported = !!o.supported;
    this.enabled = this.supported && !!this.feedUrl;
    this.currentVersion = o.currentVersion;
    this.bundlePath = o.bundlePath;
    try { if (this.bundlePath) this.bundlePath = fs.realpathSync(this.bundlePath); } catch { /* keep as given */ }
    this.root = path.join(o.userDataPath, 'updates');
    this.fetch = o.fetch;
    this.busy = o.busy || (() => ({ downloads: 0, extractions: 0 }));
    this.quit = o.quit;
    this.relaunchArgs = (o.relaunchArgs || []).filter((a) => !a.startsWith('-psn_'));
    this.onState = o.onState || (() => {});
    this.pid = o.pid ?? process.pid;
    this.launchTimeoutSec = o.launchTimeoutSec ?? LAUNCH_TIMEOUT_SEC;

    this.manifest = null;
    this.staged = null;        // { app, workDir } once an update is unpacked and verified
    this.timer = null;
    this.inFlight = null;      // the running check, so overlapping callers share it
    this.lastProgressAt = 0;
    this.state = {
      enabled: this.enabled,
      status: this.enabled ? 'idle' : 'disabled',
      currentVersion: this.currentVersion,
      version: null,
      releases: [],
      page: null,
      percent: 0,
      blocker: null,
      busy: null,
      error: null,
      checkError: null,
      checkedAt: null,
      failedVersion: null,
      failedReason: null,      // 'did-not-start' | 'could-not-replace'
      failureNotice: false,
    };
  }

  getState() {
    return { ...this.state, releases: this.state.releases.map((r) => ({ ...r, changes: [...r.changes] })) };
  }

  _set(patch) {
    Object.assign(this.state, patch);
    this.onState(this.getState());
  }

  /** Begin checking: shortly after launch, then hourly. A no-op when updates are off. */
  start() {
    if (!this.enabled) return;
    this._cleanup().finally(() => {
      // A rollback record found by the cleanup has to reach the renderer.
      this._set({});
      this.timer = setTimeout(() => {
        this.check().catch(() => {});
        this.timer = setInterval(() => this.check().catch(() => {}), CHECK_INTERVAL_MS);
      }, CHECK_DELAY_MS);
    });
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Record that this version started properly — the install script waits for
   * this file before it deletes the previous copy. The renderer asks for it
   * (`update:launched`) once it has drawn its first page, so it vouches for
   * main, preload and renderer together: a window that loads and then throws
   * is a broken build too, and one that could not show the next update prompt.
   * Written by every packaged macOS build, feed or not: a build that couldn't
   * write it would be rolled back for no reason.
   */
  markLaunched() {
    if (!this.supported) return;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      fs.writeFileSync(path.join(this.root, `launched-${this.currentVersion}`), `${this.pid}\n`);
    } catch (err) {
      console.warn('[SetEngine] Could not record a successful launch:', err.message);
    }
  }

  /**
   * Fetch the manifest and work out whether there is anything newer. Automatic
   * checks fail quietly (being offline is not news); `manual` checks report it.
   */
  check({ manual = false } = {}) {
    if (!this.enabled) return Promise.resolve(this.getState());
    // Once an update is on its way in, the manifest no longer matters.
    if (['downloading', 'verifying', 'ready', 'installing'].includes(this.state.status)) {
      return Promise.resolve(this.getState());
    }
    if (!this.inFlight) {
      this.inFlight = this._check(manual).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async _check(manual) {
    const previous = this.state.status;
    this._set({ status: 'checking', checkError: null });
    try {
      const res = await this.fetch(this.feedUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`The update server answered HTTP ${res.status}.`);
      const manifest = parseManifest(await res.json());
      // The user clicked UPDATE & RESTART while this was in flight (it uses the
      // manifest already in hand); its progress must not be overwritten.
      if (this.state.status !== 'checking') return this.getState();
      const newer = compareVersions(manifest.version, this.currentVersion) > 0;
      this.manifest = newer ? manifest : null;
      // macOS refused the rename last time; doing the same thing again would
      // only restart the app onto the same version a second time.
      const refused = newer && this.state.failedReason === 'could-not-replace'
        && this.state.failedVersion === manifest.version
        ? { reason: 'permission', message: 'Last time macOS didn\'t let SetEngine replace itself. Download the new version and drag it into Applications — your settings are kept.' }
        : null;
      this._set({
        status: newer ? 'available' : 'idle',
        version: newer ? manifest.version : null,
        releases: newer ? changesSince(manifest, this.currentVersion) : [],
        page: manifest.page,
        blocker: newer ? installBlocker(this.bundlePath) || refused : null,
        checkedAt: Date.now(),
        error: null,
      });
    } catch (err) {
      const message = err.name === 'TimeoutError' ? 'The update server did not answer.' : err.message;
      if (!manual) console.warn('[SetEngine] Update check failed:', message);
      if (this.state.status !== 'checking') return this.getState();
      this._set({ status: previous, checkError: message, checkedAt: Date.now() });
    }
    return this.getState();
  }

  /**
   * The user clicked UPDATE & RESTART: download, verify, then restart — or,
   * when downloads or extractions are running, stop at `ready` and let the
   * renderer ask before throwing that work away (restartNow()).
   */
  async update() {
    if (!this.enabled || !this.manifest) return this.getState();
    if (this.state.blocker) return this.getState();
    if (['downloading', 'verifying', 'installing'].includes(this.state.status)) return this.getState();
    if (this.state.status === 'ready' && this.staged) return this._finish(false);

    const manifest = this.manifest;
    this._set({ status: 'downloading', percent: 0, error: null, busy: null });
    try {
      const zip = await this._download(manifest);
      this._set({ status: 'verifying', percent: 100 });
      this.staged = await this._stage(manifest, zip);
      return this._finish(false);
    } catch (err) {
      console.error('[SetEngine] Update failed:', err.message);
      if (this.staged) await rmQuiet(path.dirname(this.staged.app));
      this.staged = null;
      this._set({ status: 'error', error: err.message, percent: 0 });
      return this.getState();
    }
  }

  /** The user chose to restart even though work is running. */
  restartNow() {
    if (this.state.status !== 'ready' || !this.staged) return this.getState();
    return this._finish(true);
  }

  _finish(force) {
    const busy = this.busy();
    if (!force && (busy.downloads > 0 || busy.extractions > 0)) {
      this._set({ status: 'ready', busy });
      return this.getState();
    }
    try {
      this._install();
    } catch (err) {
      this._set({ status: 'error', error: `Could not start the installer: ${err.message}` });
    }
    return this.getState();
  }

  // Everything the update writes lives in userData/updates — unless the app
  // sits on a different volume from it, because the final step is a rename and
  // a rename cannot cross volumes. Then the bundle is unpacked beside the app.
  _workDirFor(target) {
    fs.mkdirSync(this.root, { recursive: true });
    const parent = path.dirname(target);
    if (fs.statSync(this.root).dev === fs.statSync(parent).dev) return this.root;
    const beside = path.join(parent, '.SetEngine-update');
    fs.mkdirSync(beside, { recursive: true });
    return beside;
  }

  async _download(manifest) {
    await fs.promises.mkdir(this.root, { recursive: true });
    const zip = path.join(this.root, `SetEngine-${manifest.version}.zip`);
    // Downloaded earlier (the user said "later" at the restart prompt last time).
    if (fs.existsSync(zip) && await sha256File(zip) === manifest.zip.sha256) return zip;

    const partial = `${zip}.partial`;
    const abort = new AbortController();
    let stall = setTimeout(() => abort.abort(), STALL_TIMEOUT_MS);
    try {
      const res = await this.fetch(manifest.zip.url, { cache: 'no-store', signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`The update download failed (HTTP ${res.status}).`);
      const hash = crypto.createHash('sha256');
      const total = manifest.zip.size;
      let received = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        clearTimeout(stall);
        stall = setTimeout(() => abort.abort(), STALL_TIMEOUT_MS);
        const now = Date.now();
        if (now - this.lastProgressAt >= PROGRESS_EVERY_MS) {
          this.lastProgressAt = now;
          this._set({ percent: Math.min(99, Math.floor((received / total) * 100)) });
        }
      });
      await pipeline(body, fs.createWriteStream(partial));
      if (received !== total) {
        throw new Error(`The update download was incomplete (${received} of ${total} bytes).`);
      }
      if (hash.digest('hex') !== manifest.zip.sha256) {
        throw new Error('The update download failed its checksum and was discarded.');
      }
      await fs.promises.rename(partial, zip);
      return zip;
    } catch (err) {
      await rmQuiet(partial);
      if (abort.signal.aborted) throw new Error('The update download stalled. Check your connection and try again.');
      // A dropped connection surfaces as Chromium's code, e.g.
      // "net::ERR_CONTENT_LENGTH_MISMATCH" (measured, cutting the server off
      // mid-download) — accurate, and meaningless to the person reading it.
      if (/^net::|fetch failed|terminated|ECONNRESET/i.test(err.message)) {
        throw new Error(`The update download was interrupted (${err.message}). Check your connection and try again.`);
      }
      throw err;
    } finally {
      clearTimeout(stall);
    }
  }

  // Unpack and prove the new bundle is whole before anything depends on it:
  // its seal must verify (a copy that lost a symlink or a permission will not
  // launch on Apple Silicon) and it must be the version and app it claims.
  async _stage(manifest, zip) {
    const workDir = this._workDirFor(this.bundlePath);
    const stageDir = path.join(workDir, `stage-${manifest.version}`);
    await rmQuiet(stageDir);
    await fs.promises.mkdir(stageDir, { recursive: true });
    // ditto, not unzip: it restores Electron's framework symlinks and the
    // bundle's extended attributes exactly as they were zipped.
    await run('/usr/bin/ditto', ['-x', '-k', zip, stageDir]);
    const app = path.join(stageDir, 'SetEngine.app');
    if (!fs.existsSync(path.join(app, 'Contents', 'MacOS', 'SetEngine'))) {
      throw new Error('The update does not contain SetEngine.app.');
    }
    try {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    } catch (err) {
      throw new Error(`The downloaded app failed its signature check: ${err.message}`);
    }
    const [version, id, currentId] = await Promise.all([
      plistValue(app, 'CFBundleShortVersionString'),
      plistValue(app, 'CFBundleIdentifier'),
      plistValue(this.bundlePath, 'CFBundleIdentifier'),
    ]);
    if (version !== manifest.version) {
      throw new Error(`The downloaded app is version ${version}, not ${manifest.version}.`);
    }
    if (id !== currentId) throw new Error(`The downloaded app is ${id}, not ${currentId}.`);
    // Never set on a file this process wrote, but cheap to make certain: a
    // quarantined copy would stop at Gatekeeper on relaunch.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
    return { app, workDir, version };
  }

  _install() {
    const { app, workDir, version } = this.staged;
    const script = path.join(workDir, 'install.sh');
    fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
    const args = [
      script,
      String(this.pid),
      this.bundlePath,
      app,
      path.join(workDir, `previous-${Date.now()}`),
      path.join(this.root, `launched-${version}`),
      path.join(this.root, `failed-${version}.json`),
      version,
      path.join(this.root, 'update.log'),
      String(this.launchTimeoutSec),
      ...this.relaunchArgs,
    ];
    // Detached into its own session, so quitting the app doesn't take it along.
    const child = spawn('/bin/sh', args, { detached: true, stdio: 'ignore' });
    child.unref();
    this._set({ status: 'installing', busy: null });
    console.log(`[SetEngine] Installing ${version}; restarting.`);
    setTimeout(() => this.quit(), 200);
  }

  // Housekeeping at launch: partial downloads, unpacked copies, previous
  // versions the script did not get to delete, and anything about versions
  // this one has caught up with. A verified zip of a version still ahead is
  // kept, so the next UPDATE & RESTART does not download it twice. A rollback
  // record is read here, to tell the user once and to stop offering that
  // version automatically.
  async _cleanup() {
    const roots = [this.root];
    if (this.bundlePath) roots.push(path.join(path.dirname(this.bundlePath), '.SetEngine-update'));
    for (const root of roots) {
      let names = [];
      try { names = await fs.promises.readdir(root); } catch { continue; }
      for (const name of names) {
        const full = path.join(root, name);
        let m;
        if (name === 'update.log') {
          try { if ((await fs.promises.stat(full)).size > 1024 * 1024) await fs.promises.truncate(full, 0); } catch { /* ignore */ }
        } else if ((m = name.match(/^SetEngine-(\d+\.\d+\.\d+)\.zip$/))) {
          if (compareVersions(m[1], this.currentVersion) <= 0) await rmQuiet(full);
        } else if ((m = name.match(/^failed-(\d+\.\d+\.\d+)\.json$/))) {
          if (compareVersions(m[1], this.currentVersion) <= 0) { await rmQuiet(full); continue; }
          await this._readFailure(full, m[1]);
        } else if ((m = name.match(/^launched-(\d+\.\d+\.\d+)$/))) {
          if (m[1] !== this.currentVersion) await rmQuiet(full);
        } else if (name.startsWith('previous-')) {
          try {
            const age = Date.now() - (await fs.promises.stat(full)).mtimeMs;
            if (age > ASIDE_MAX_AGE_MS) await rmQuiet(full);
          } catch { /* already gone */ }
        } else {
          // stage-*, *.partial, install.sh, and anything unrecognised.
          await rmQuiet(full);
        }
      }
      if (root !== this.root) await fs.promises.rmdir(root).catch(() => {}); // only if now empty
    }
  }

  async _readFailure(file, version) {
    try {
      const record = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      const failedVersion = parseVersion(version) ? version : null;
      if (!failedVersion) return;
      if (!this.state.failedVersion || compareVersions(failedVersion, this.state.failedVersion) > 0) {
        this.state.failedVersion = failedVersion;
        this.state.failedReason = record.reason === 'could-not-replace' ? 'could-not-replace' : 'did-not-start';
      }
      if (!record.noticed) {
        this.state.failureNotice = true;
        await fs.promises.writeFile(file, JSON.stringify({ ...record, noticed: true }));
      }
    } catch { /* unreadable: ignore it */ }
  }
}
