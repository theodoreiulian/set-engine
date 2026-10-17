// SetEngine's self-update: the manifest rules, the release scripts' numbering
// and notes, and — on macOS — a real download, checksum, unpack and signature
// check against a local server, using the production AppUpdater.
//
// What this does NOT cover is the bundle swap itself (the install script quits
// the app and relaunches through LaunchServices); that was verified end to end
// on packaged builds, see CLAUDE.md "Self-update".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nextVersion, cleanSubject, notesFromSubjects } from '../release/release-lib.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setengine-update-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const bundle = path.join(tmp, 'update.mjs');
await build({
  stdin: { contents: `export * from './src/main/update-feed.js';
    export { default as AppUpdater, installBlocker, bundleFromExecPath } from './src/main/app-updater.js';`, resolveDir: process.cwd() },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm',
});
const { compareVersions, parseManifest, changesSince, AppUpdater, installBlocker, bundleFromExecPath } = await import(pathToFileURL(bundle));

const SHA = 'a'.repeat(64);
const manifest = (over = {}) => ({
  schema: 1,
  version: '1.0.43',
  page: 'https://github.com/o/r/releases/tag/v1.0.43',
  zip: { url: 'https://github.com/o/r/releases/download/v1.0.43/SetEngine-mac.zip', sha256: SHA, size: 10 },
  releases: [
    { version: '1.0.43', changes: ['Newest'] },
    { version: '1.0.42', changes: ['Middle'] },
    { version: '1.0.41', changes: ['Installed already'] },
  ],
  ...over,
});

test('versions compare numerically, not as text', () => {
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
  assert.ok(compareVersions('1.1.0', '1.0.99') > 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'));
});

test('a manifest is only acted on when every field checks out', () => {
  assert.equal(parseManifest(manifest()).version, '1.0.43');
  assert.throws(() => parseManifest(manifest({ schema: 2 })), /schema/);
  assert.throws(() => parseManifest(manifest({ version: 'latest' })), /version/);
  assert.throws(() => parseManifest(manifest({ zip: { ...manifest().zip, sha256: 'abc' } })), /SHA-256/);
  assert.throws(() => parseManifest(manifest({ zip: { ...manifest().zip, size: 0 } })), /size/);
  // Downloads must be HTTPS — plain HTTP only from this machine, for testing.
  assert.throws(() => parseManifest(manifest({ zip: { ...manifest().zip, url: 'http://example.com/a.zip' } })), /URL/);
  assert.ok(parseManifest(manifest({ zip: { ...manifest().zip, url: 'http://127.0.0.1:9/a.zip' } })));
});

test('the notes cover every release the user skipped, newest first', () => {
  const m = parseManifest(manifest());
  assert.deepEqual(changesSince(m, '1.0.41').map((r) => r.version), ['1.0.43', '1.0.42']);
  assert.deepEqual(changesSince(m, '1.0.42').map((r) => r.version), ['1.0.43']);
});

test('the release number only goes up', () => {
  assert.equal(nextVersion({ packageVersion: '1.0.1', commitCount: 41, tags: ['v1.0.0', 'v1.0.1'] }), '1.0.41');
  // History rewritten to fewer commits than the last release: still newer.
  assert.equal(nextVersion({ packageVersion: '1.0.1', commitCount: 30, tags: ['v1.0.41'] }), '1.0.42');
  // A minor bump in package.json starts from the commit count again.
  assert.equal(nextVersion({ packageVersion: '1.1.0', commitCount: 50, tags: ['v1.0.49'] }), '1.1.50');
  assert.throws(() => nextVersion({ packageVersion: 'x', commitCount: 3, tags: [] }));
});

test('commit subjects become readable notes', () => {
  assert.deepEqual(cleanSubject('feat(download): accept SoundCloud links (#5)'), { text: 'Accept SoundCloud links', pr: 5 });
  assert.deepEqual(cleanSubject('Support SoundCloud set extraction (#10)'), { text: 'Support SoundCloud set extraction', pr: 10 });
  assert.equal(cleanSubject('docs(extraction): correct a comment'), null);
  assert.equal(cleanSubject('Merge pull request #3 from x/y'), null);
  assert.deepEqual(notesFromSubjects(['fix: a', 'Fix: A', 'ci: b']).map((n) => n.text), ['A']);
});

test('a copy that cannot rename itself says why instead of failing half-way', () => {
  const ok = () => {};
  const denied = () => { throw new Error('EACCES'); };
  assert.equal(installBlocker('/Applications/SetEngine.app', ok), null);
  assert.equal(installBlocker('/private/var/folders/x/AppTranslocation/ABC/d/SetEngine.app', ok).reason, 'translocated');
  assert.equal(installBlocker('/Volumes/SetEngine/SetEngine.app', denied).reason, 'read-only');
  assert.equal(installBlocker('/Applications/SetEngine.app', denied).reason, 'permission');
  assert.equal(bundleFromExecPath('/Applications/SetEngine.app/Contents/MacOS/SetEngine'), '/Applications/SetEngine.app');
  assert.equal(bundleFromExecPath('/usr/local/bin/electron'), null);
});

// ── a real download, on macOS ─────────────────────────────────────────

function fakeApp(dir, version, id = 'com.example.setengine-test') {
  const app = path.join(dir, 'SetEngine.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>SetEngine</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'SetEngine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

function zipOf(app, zip) {
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  const data = fs.readFileSync(zip);
  return { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
}

function serve(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = files[req.url];
      if (!body) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('downloads, verifies and stages an update, and stops to ask while work is running', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'e2e-'));
  const current = fakeApp(path.join(dir, 'Applications'), '1.0.41');
  const next = fakeApp(path.join(dir, 'build'), '1.0.43');
  const zip = path.join(dir, 'SetEngine-mac.zip');
  const { sha256, size } = zipOf(next, zip);

  const files = { '/SetEngine-mac.zip': fs.readFileSync(zip) };
  const server = await serve(files);
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const setManifest = (zipFields) => {
    files['/latest-mac.json'] = Buffer.from(JSON.stringify(manifest({
      zip: { url: `${base}/SetEngine-mac.zip`, sha256, size, ...zipFields },
    })));
  };
  setManifest({});

  const states = [];
  let quits = 0;
  const updater = new AppUpdater({
    feedUrl: `${base}/latest-mac.json`,
    supported: true,
    currentVersion: '1.0.41',
    bundlePath: current,
    userDataPath: path.join(dir, 'profile'),
    fetch: (...args) => fetch(...args),
    busy: () => ({ downloads: 2, extractions: 0 }),
    quit: () => { quits++; },
    onState: (s) => states.push(s.status),
  });

  const checked = await updater.check({ manual: true });
  assert.equal(checked.status, 'available');
  assert.equal(checked.version, '1.0.43');
  assert.deepEqual(checked.releases.map((r) => r.version), ['1.0.43', '1.0.42']);
  assert.equal(checked.blocker, null);

  // Two downloads running: it gets everything ready, then asks rather than
  // restarting over them.
  const ready = await updater.update();
  assert.equal(ready.status, 'ready', ready.error);
  assert.deepEqual(ready.busy, { downloads: 2, extractions: 0 });
  assert.equal(quits, 0);
  assert.ok(states.includes('downloading') && states.includes('verifying'));
  const staged = updater.staged.app;
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(staged, 'Contents', 'Info.plist')]).toString().trim(), '1.0.43');
  // The staged copy sits on the same volume as the app, so the swap is a rename.
  assert.equal(fs.statSync(path.dirname(staged)).dev, fs.statSync(path.dirname(current)).dev);
  // The running copy is untouched until the app quits.
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(current, 'Contents', 'Info.plist')]).toString().trim(), '1.0.41');
  updater.stop();
});

test('a corrupted download is discarded, and nothing is left half-installed', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'bad-'));
  const current = fakeApp(path.join(dir, 'Applications'), '1.0.41');
  const next = fakeApp(path.join(dir, 'build'), '1.0.43');
  const zip = path.join(dir, 'SetEngine-mac.zip');
  const { size } = zipOf(next, zip);
  const files = { '/SetEngine-mac.zip': fs.readFileSync(zip) };
  const server = await serve(files);
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  files['/latest-mac.json'] = Buffer.from(JSON.stringify(manifest({
    zip: { url: `${base}/SetEngine-mac.zip`, sha256: 'b'.repeat(64), size },
  })));

  const profile = path.join(dir, 'profile');
  const updater = new AppUpdater({
    feedUrl: `${base}/latest-mac.json`, supported: true, currentVersion: '1.0.41',
    bundlePath: current, userDataPath: profile, fetch: (...a) => fetch(...a), quit: () => assert.fail('must not quit'),
  });
  await updater.check();
  const failed = await updater.update();
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /checksum/);
  assert.deepEqual(fs.readdirSync(path.join(profile, 'updates')), []);
});

test('an update for a different app, or a different version than promised, is refused', { skip: process.platform !== 'darwin' }, async () => {
  for (const [version, id, expected] of [['1.0.42', undefined, /version 1\.0\.42, not 1\.0\.43/], ['1.0.43', 'com.example.other', /com\.example\.other/]]) {
    const dir = fs.mkdtempSync(path.join(tmp, 'wrong-'));
    const current = fakeApp(path.join(dir, 'Applications'), '1.0.41');
    const next = fakeApp(path.join(dir, 'build'), version, id);
    const zip = path.join(dir, 'SetEngine-mac.zip');
    const { sha256, size } = zipOf(next, zip);
    const files = { '/SetEngine-mac.zip': fs.readFileSync(zip) };
    const server = await serve(files);
    after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    files['/latest-mac.json'] = Buffer.from(JSON.stringify(manifest({ zip: { url: `${base}/SetEngine-mac.zip`, sha256, size } })));
    const updater = new AppUpdater({
      feedUrl: `${base}/latest-mac.json`, supported: true, currentVersion: '1.0.41',
      bundlePath: current, userDataPath: path.join(dir, 'profile'), fetch: (...a) => fetch(...a), quit: () => assert.fail('must not quit'),
    });
    await updater.check();
    const failed = await updater.update();
    assert.equal(failed.status, 'error');
    assert.match(failed.error, expected);
  }
});

test('nothing newer means nothing offered; a local build never checks', async () => {
  const files = { '/latest-mac.json': Buffer.from(JSON.stringify(manifest({ version: '1.0.41' }))) };
  const server = await serve(files);
  after(() => server.close());
  const feedUrl = `http://127.0.0.1:${server.address().port}/latest-mac.json`;
  const opts = { feedUrl, supported: true, currentVersion: '1.0.41', bundlePath: null, userDataPath: tmp, fetch: (...a) => fetch(...a) };
  assert.equal((await new AppUpdater(opts).check({ manual: true })).status, 'idle');
  const local = new AppUpdater({ ...opts, feedUrl: '' });
  assert.equal(local.getState().status, 'disabled');
  assert.equal((await local.check({ manual: true })).status, 'disabled');
});

test('after a failed install the app says what happened once, and does not repeat a refused swap', async () => {
  const files = { '/latest-mac.json': Buffer.from(JSON.stringify(manifest())) };
  const server = await serve(files);
  after(() => server.close());
  const feedUrl = `http://127.0.0.1:${server.address().port}/latest-mac.json`;
  for (const [reason, blocked] of [['did-not-start', false], ['could-not-replace', true]]) {
    const profile = fs.mkdtempSync(path.join(tmp, 'failed-'));
    fs.mkdirSync(path.join(profile, 'updates'));
    const record = path.join(profile, 'updates', 'failed-1.0.43.json');
    fs.writeFileSync(record, JSON.stringify({ version: '1.0.43', reason }));
    const bundlePath = path.join(profile, 'Applications', 'SetEngine.app');
    fs.mkdirSync(bundlePath, { recursive: true });
    const opts = { feedUrl, supported: true, currentVersion: '1.0.41', bundlePath, userDataPath: profile, fetch: (...a) => fetch(...a) };

    const first = new AppUpdater(opts);
    await first._cleanup();
    const s = await first.check();
    assert.equal(s.failedVersion, '1.0.43');
    assert.equal(s.failedReason, reason);
    assert.equal(s.failureNotice, true);
    // A refused rename offers the manual download instead of the same restart again.
    assert.equal(!!(s.blocker && s.blocker.reason === 'permission'), blocked);

    // Told once: the next launch remembers the version but not the notice.
    const second = new AppUpdater(opts);
    await second._cleanup();
    assert.equal(second.getState().failureNotice, false);
    assert.equal(second.getState().failedVersion, '1.0.43');
    // Once this version is installed some other way, the record goes.
    await new AppUpdater({ ...opts, currentVersion: '1.0.43' })._cleanup();
    assert.equal(fs.existsSync(record), false);
  }
});
