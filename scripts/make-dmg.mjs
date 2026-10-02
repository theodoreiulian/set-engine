#!/usr/bin/env node
// Wrap the packaged SetEngine.app in the disk image users download.
//
//   node scripts/make-dmg.mjs [path/to/SetEngine.app]
//
// Output: out/make/SetEngine.dmg — the app next to an Applications shortcut, so
// installing is "open the file, drag the icon across". Without an argument it
// picks the universal build, falling back to the newest packaged app.
//
// The window is styled — matte background, an arrow from the app to
// Applications, a line of instruction — and laid out by dmgbuild, a pure-Python
// tool that writes Finder's .DS_Store itself. That matters twice over: it needs
// no Finder scripting (so it builds headless on a CI runner, with no permission
// prompts), and it has no native modules. @electron-forge/maker-dmg was tried
// first and dropped: it reaches appdmg through two layers of *optional* native
// dependencies, which npm skipped silently when they failed to compile.
//
// dmgbuild lives in its own virtualenv under vendor/ (gitignored), created on
// first use. Needs python3 and network access that once; nothing after.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('make-dmg.mjs builds a macOS disk image and only runs on macOS.');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'out', 'make');
const DMG = path.join(OUT_DIR, 'SetEngine.dmg');
const VOLUME = 'SetEngine';

// Pinned, with its two dependencies, so the layout file it writes can't change
// under us. All three are pure Python.
const DMGBUILD = ['dmgbuild==1.6.2', 'ds-store==1.3.1', 'mac-alias==2.2.2'];
const VENV = path.join(ROOT, 'vendor', 'dmgbuild');
const ASSETS = path.join(ROOT, 'assets', 'dmg');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function findApp() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const out = path.join(ROOT, 'out');
  const builds = fs.existsSync(out)
    ? fs.readdirSync(out)
      .filter((d) => d.startsWith('SetEngine-darwin-'))
      .map((d) => path.join(out, d, 'SetEngine.app'))
      .filter((p) => fs.existsSync(p))
    : [];
  const universal = builds.find((p) => p.includes('darwin-universal'));
  if (universal) return universal;
  return builds.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

const app = findApp();
if (!app || !fs.existsSync(app)) {
  console.error('No packaged SetEngine.app found. Run `npm run dist:mac`, or pass the path to the .app.');
  process.exit(1);
}

// A disk image of a bundle with a broken seal installs an app that will not
// launch on Apple Silicon, so refuse to build one.
run('codesign', ['--verify', '--deep', '--strict', app]);

function ensureDmgbuild() {
  const bin = path.join(VENV, 'bin', 'dmgbuild');
  const stamp = path.join(VENV, 'setengine-requirements.txt');
  const wanted = DMGBUILD.join('\n');
  if (fs.existsSync(bin) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === wanted) return bin;
  console.log('Setting up dmgbuild (first run only)');
  fs.rmSync(VENV, { recursive: true, force: true });
  run('python3', ['-m', 'venv', VENV]);
  run(path.join(VENV, 'bin', 'pip'), ['install', '--quiet', '--disable-pip-version-check', ...DMGBUILD]);
  fs.writeFileSync(stamp, wanted);
  return bin;
}

const dmgbuild = ensureDmgbuild();
const python = path.join(VENV, 'bin', 'python');
const fixBackground = path.join(ROOT, 'scripts', 'dmg-fix-background.py');

// Mount an image and return where it landed.
function attach(image, extra = []) {
  const out = run('hdiutil', ['attach', '-nobrowse', ...extra, image]);
  const m = out.match(/\t(\/.+)\s*$/m);
  if (!m) throw new Error(`Could not find the mount point in hdiutil's output:\n${out}`);
  return m[1].trim();
}

if (fs.existsSync(`/Volumes/${VOLUME}`)) {
  console.error(`A volume named "${VOLUME}" is already mounted. Eject it and run this again —`);
  console.error('the image has to be built at the path it will open at on a user\'s Mac.');
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'setengine-dmg-'));
try {
  // One TIFF holding the 1x and 2x artwork, so the background is sharp on
  // Retina and standard displays alike.
  const background = path.join(work, 'background.tiff');
  run('tiffutil', [
    '-cathidpicheck', path.join(ASSETS, 'background.png'), path.join(ASSETS, 'background@2x.png'),
    '-out', background,
  ]);

  // 1. dmgbuild lays the window out on a writable image.
  const writable = path.join(work, 'writable.dmg');
  run(dmgbuild, [
    '-s', path.join(ROOT, 'scripts', 'dmg-settings.py'),
    '-D', `app=${app}`,
    '-D', `background=${background}`,
    '-D', `layout=${path.join(ASSETS, 'layout.json')}`,
    VOLUME, writable,
  ]);

  // 2. Replace dmgbuild's reference to the background with one macOS made.
  //    Without this the picture never appears on macOS 26 — the layout applies
  //    and the window is blank behind the icons. See dmg-fix-background.py.
  const volume = attach(writable);
  try {
    if (volume !== `/Volumes/${VOLUME}`) throw new Error(`The image mounted at ${volume}, not /Volumes/${VOLUME}.`);
    run(python, [fixBackground, volume]);
  } finally {
    run('hdiutil', ['detach', volume]);
  }

  // 3. Compress. ULMO (LZMA) is the smallest format and is readable from
  //    10.15, well below the app's 12.0 floor.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(DMG, { force: true });
  run('hdiutil', ['convert', writable, '-format', 'ULMO', '-o', DMG]);

  // 4. The image is only as good as what is inside it. Mount the finished file
  //    somewhere *other* than where it was built and check that the app still
  //    carries a valid seal (a copy that drops symlinks or permissions breaks
  //    it, and such an app will not launch on Apple Silicon) and that the
  //    background still resolves from a different mount point.
  const mount = path.join(work, 'mnt');
  fs.mkdirSync(mount);
  attach(DMG, ['-readonly', '-mountpoint', mount]);
  try {
    run('codesign', ['--verify', '--deep', '--strict', path.join(mount, 'SetEngine.app')]);
    fs.lstatSync(path.join(mount, 'Applications'));
    run(python, [fixBackground, '--check', mount]);
  } finally {
    run('hdiutil', ['detach', mount]);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

// A Developer ID build signs the image too, so Gatekeeper can vouch for the
// download itself. Notarizing and stapling the image is a separate step — see
// the README.
if (process.env.APPLE_SIGNING_IDENTITY) {
  run('codesign', ['--force', '--sign', process.env.APPLE_SIGNING_IDENTITY, '--timestamp', DMG]);
}

run('hdiutil', ['verify', DMG]);
const mb = (fs.statSync(DMG).size / 1024 / 1024).toFixed(0);
console.log(`Wrote ${path.relative(ROOT, DMG)} (${mb} MB) from ${path.relative(ROOT, app)}`);
