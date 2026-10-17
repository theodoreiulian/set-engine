#!/usr/bin/env node
// Turn a packaged SetEngine.app into the two files installed apps update from.
//
//   node scripts/release/make-update.mjs --version 1.0.41 --repo owner/name
//        [--app path/to/SetEngine.app] [--base-url http://127.0.0.1:8765]
//
// Writes into out/make/, beside the DMG:
//   SetEngine-mac.zip   the app, zipped by ditto (what src/main/app-updater.js downloads)
//   latest-mac.json     the manifest it checks: version, the zip's URL, size and
//                       SHA-256, and the release notes of the last 20 releases
//   release-notes.md    the GitHub release's description
//
// The release notes are the commit subjects since the previous release's tag —
// on master that is one squash-merged PR title per line — so whoever merges a
// PR is writing the "What's new" users see.
//
// --base-url points the manifest's download at a local server instead of the
// GitHub release, which is how an update is tested end to end without
// publishing anything.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, notesFromSubjects, parseVersion } from './release-lib.mjs';

if (process.platform !== 'darwin') {
  console.error('make-update.mjs zips a macOS app with ditto and only runs on macOS.');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'out', 'make');
const ZIP_NAME = 'SetEngine-mac.zip';
const MANIFEST_NAME = 'latest-mac.json';
const HISTORY = 20;

const { values: args } = parseArgs({
  options: {
    version: { type: 'string' },
    repo: { type: 'string' },
    app: { type: 'string' },
    'base-url': { type: 'string' },
  },
});
const version = args.version;
const repo = args.repo;
if (!parseVersion(version) || !/^[\w.-]+\/[\w.-]+$/.test(repo || '')) {
  console.error('Usage: make-update.mjs --version X.Y.Z --repo owner/name [--app SetEngine.app] [--base-url URL]');
  process.exit(1);
}

const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const git = (...a) => run('git', a, { cwd: ROOT });

// Same choice make-dmg.mjs makes: the universal build, else the newest.
function findApp() {
  if (args.app) return path.resolve(args.app);
  const out = path.join(ROOT, 'out');
  const builds = fs.existsSync(out)
    ? fs.readdirSync(out)
      .filter((d) => d.startsWith('SetEngine-darwin-'))
      .map((d) => path.join(out, d, 'SetEngine.app'))
      .filter((p) => fs.existsSync(p))
    : [];
  return builds.find((p) => p.includes('darwin-universal'))
    || builds.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

const app = findApp();
if (!app || !fs.existsSync(app)) {
  console.error('No packaged SetEngine.app found. Run `npm run dist:mac` first, or pass --app.');
  process.exit(1);
}

const base = args['base-url']
  ? args['base-url'].replace(/\/+$/, '')
  : `https://github.com/${repo}/releases/download/v${version}`;
const feed = args['base-url']
  ? `${base}/${MANIFEST_NAME}`
  : `https://github.com/${repo}/releases/latest/download/${MANIFEST_NAME}`;

// 1. The app has to be the release it claims to be, and it has to know where
//    to look for the next one. A build missing the feed would install fine and
//    then never update again — every user of it stranded on that version — so
//    that is refused here rather than discovered later. The main bundle sits
//    uncompressed in app.asar, so a byte search finds the URL.
const plistVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents', 'Info.plist')]);
if (plistVersion !== version) {
  console.error(`${path.relative(ROOT, app)} is version ${plistVersion}, not ${version}. Stamp package.json before packaging.`);
  process.exit(1);
}
const asar = fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'));
if (!asar.includes(Buffer.from(feed))) {
  console.error(`The app does not check ${feed} for updates. Build it with SETENGINE_UPDATE_FEED=${feed}.`);
  process.exit(1);
}
run('codesign', ['--verify', '--deep', '--strict', app]);

// 2. Zip it the way it will be unpacked. ditto keeps the framework symlinks and
//    extended attributes a plain zip would lose (and a bundle missing those
//    fails its seal). Then unpack the result and check the seal again, which is
//    exactly what the updater on a user's Mac will do.
fs.mkdirSync(OUT_DIR, { recursive: true });
const zip = path.join(OUT_DIR, ZIP_NAME);
fs.rmSync(zip, { force: true });
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);

const check = fs.mkdtempSync(path.join(os.tmpdir(), 'setengine-update-check-'));
try {
  run('/usr/bin/ditto', ['-x', '-k', zip, check]);
  run('codesign', ['--verify', '--deep', '--strict', path.join(check, 'SetEngine.app')]);
} finally {
  fs.rmSync(check, { recursive: true, force: true });
}

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
const size = fs.statSync(zip).size;

// 3. Release notes. This release covers the commits since the newest tag; the
//    manifest also carries the releases before it, so an app several versions
//    behind can show everything it is about to get.
const tags = git('tag', '--list', 'v*').split('\n')
  .map((t) => t.trim()).filter((t) => parseVersion(t) && compareVersions(t, version) < 0)
  .sort((a, b) => compareVersions(b, a));
const subjects = (range) => {
  const out = git('log', '--no-merges', '--format=%s', range);
  return out ? out.split('\n') : [];
};
const tagDate = (tag) => git('log', '-1', '--format=%cI', tag);

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const thisRelease = notesFromSubjects(subjects(tags[0] ? `${tags[0]}..HEAD` : 'HEAD').slice(0, 40));
const releases = [{ version, date: now, notes: thisRelease }];
for (let i = 0; i < Math.min(tags.length, HISTORY - 1); i++) {
  // The oldest tag has nothing to diff against; it is listed without notes.
  const notes = tags[i + 1] ? notesFromSubjects(subjects(`${tags[i + 1]}..${tags[i]}`)) : [];
  releases.push({ version: tags[i].replace(/^v/, ''), date: tagDate(tags[i]), notes });
}

const manifest = {
  schema: 1,
  version,
  date: now,
  commit: git('rev-parse', 'HEAD'),
  page: `https://github.com/${repo}/releases/tag/v${version}`,
  zip: { url: `${base}/${ZIP_NAME}`, sha256, size },
  releases: releases.map((r) => ({
    version: r.version,
    date: r.date,
    changes: r.notes.map((n) => n.text),
  })),
};
fs.writeFileSync(path.join(OUT_DIR, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

const bullets = thisRelease.length
  ? thisRelease.map((n) => `- ${n.text}${n.pr ? ` (#${n.pr})` : ''}`).join('\n')
  : '- Fixes and improvements';
fs.writeFileSync(path.join(OUT_DIR, 'release-notes.md'), `## What's new

${bullets}

**Already using SetEngine?** It offers this update by itself — click **Update & Restart** when it asks. (1.0.1 and earlier can't update themselves; download the DMG below once more.)

**New to SetEngine?** Download **SetEngine.dmg**, open it and drag SetEngine into Applications. The first launch needs the one-time "Open Anyway" step described in the [README](https://github.com/${repo}#the-first-time-you-open-it).
`);

const mb = (size / 1024 / 1024).toFixed(0);
console.log(`Wrote out/make/${ZIP_NAME} (${mb} MB, sha256 ${sha256.slice(0, 12)}…), ${MANIFEST_NAME} and release-notes.md for ${version}`);
console.log(`What's new in ${version}:\n${bullets}`);
