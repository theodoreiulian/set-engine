#!/usr/bin/env node
// Assemble the command-line tools the macOS installer ships inside the .app.
//
//   node scripts/fetch-tools.mjs            # reuse vendor/ if it is current
//   node scripts/fetch-tools.mjs --force    # rebuild from scratch
//   YTDLP_VERSION=2026.08.19 node scripts/fetch-tools.mjs   # pin yt-dlp
//
// Output: vendor/darwin/bin (gitignored), copied into the bundle as
// Contents/Resources/bin by `extraResource` in forge.config.js:
//
//   bin/ffmpeg, bin/ffprobe     universal (arm64 + x86_64), lipo'd from two builds
//   bin/qjs                     QuickJS, compiled here — see below
//   bin/yt-dlp/yt-dlp           yt-dlp's "onedir" build, plus bin/yt-dlp/_internal
//   bin/yt-dlp/yt-dlp.conf      portable config enabling QuickJS
//   bin/versions.json           what was bundled (read at runtime)
//
// Three choices here are measured, not stylistic:
//
// * yt-dlp is the ONEDIR build (yt-dlp_macos.zip), not the single-file
//   yt-dlp_macos. The single file unpacks itself into a fresh temp dir on every
//   launch, which macOS re-scans each time: 11–12 s per invocation, every
//   invocation. The onedir build pays that once and then starts in ~0.3 s. The
//   price is that `yt-dlp -U` refuses to update it ("not supported for unpackaged
//   executables"), so the app carries its own updater — src/main/bundled-tools.js.
//
// * QuickJS is compiled from source instead of downloaded. yt-dlp needs a
//   JavaScript runtime to solve YouTube's player challenges; without one it
//   still downloads today but warns that formats are missing, and that gap only
//   widens. quickjs-ng's prebuilt macOS binaries are built with minos 26.0, so
//   they would not launch on anything older than Tahoe. Built here with
//   -mmacosx-version-min=11.0 it is 3 MB, universal, and runs everywhere
//   Electron does. (deno, the default runtime, is ~100 MB per architecture.)
//
// * Everything is checksummed. ffmpeg and QuickJS are pinned to exact SHA-256s;
//   yt-dlp tracks its latest release by default (a stale yt-dlp is a broken
//   app — see MIN_RECOMMENDED_YTDLP) and is verified against that release's own
//   SHA2-256SUMS.
//
// Needs the Xcode Command Line Tools (cc, lipo, codesign) and curl. macOS only.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('fetch-tools.mjs assembles macOS binaries and only runs on macOS.');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vendor', 'darwin', 'bin');
const FORCE = process.argv.includes('--force');

// The oldest macOS Electron 42 itself supports is 12.0; every tool below is
// checked against this so a binary can never raise the app's real floor.
const MACOS_FLOOR = 12;

const FFMPEG = {
  version: '6.1.1',
  base: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1',
  files: {
    'ffmpeg-darwin-arm64': 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
    'ffmpeg-darwin-x64': 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
    'ffprobe-darwin-arm64': 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64',
    'ffprobe-darwin-x64': 'fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0',
  },
};

const QUICKJS = {
  version: '0.17.0',
  url: 'https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.17.0.tar.gz',
  sha256: '559bc4c420475e55c7ab4510adbc562f55d7524d75e8e89d79ce4bb02f5687d9',
  // The qjs executable's sources, as listed for `qjs_exe` in its CMakeLists.txt.
  sources: ['qjs.c', 'gen/repl.c', 'gen/standalone.c', 'quickjs.c', 'quickjs-libc.c', 'dtoa.c', 'libregexp.c', 'libunicode.c'],
};

const YTDLP_REPO = 'https://github.com/yt-dlp/yt-dlp/releases';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const log = (msg) => console.log(`  ${msg}`);

function download(url, dest) {
  run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '-o', dest, url]);
}

function verify(file, expected, label) {
  const actual = sha256(file);
  if (actual !== expected) {
    throw new Error(`${label}: checksum mismatch\n  expected ${expected}\n  got      ${actual}`);
  }
}

// Both slices must be present and neither may need a newer macOS than the app.
function assertUniversal(file, label) {
  const archs = run('lipo', ['-archs', file]).trim().split(/\s+/).sort().join(' ');
  if (archs !== 'arm64 x86_64') throw new Error(`${label}: expected arm64 + x86_64, got "${archs}"`);
  const load = run('otool', ['-l', file]);
  // LC_BUILD_VERSION carries `minos`; the older LC_VERSION_MIN_MACOSX carries
  // `version`. Other load commands have a `version` line too (LC_SOURCE_VERSION),
  // so match within the right command only.
  const floors = [
    ...load.matchAll(/cmd LC_BUILD_VERSION\n(?:.*\n){1,4}?\s*minos (\d+)\./g),
    ...load.matchAll(/cmd LC_VERSION_MIN_MACOSX\n(?:.*\n){1,2}?\s*version (\d+)\./g),
  ].map((m) => Number(m[1]));
  const worst = Math.max(...floors);
  if (!floors.length || worst > MACOS_FLOOR) {
    throw new Error(`${label}: needs macOS ${worst}, but the app supports ${MACOS_FLOOR}+`);
  }
}

function resolveYtDlpVersion() {
  if (process.env.YTDLP_VERSION) return process.env.YTDLP_VERSION;
  // The "latest" redirect names the tag without touching the rate-limited API.
  const headers = run('curl', ['--fail', '--silent', '--head', `${YTDLP_REPO}/latest`]);
  const m = headers.match(/^location:.*\/tag\/(\S+)/im);
  if (!m) throw new Error('Could not resolve the latest yt-dlp release.');
  return m[1].trim();
}

const stampFile = path.join(OUT, 'versions.json');

let ytdlpVersion;
try {
  ytdlpVersion = resolveYtDlpVersion();
} catch (err) {
  // Offline, with tools already assembled: a slightly old yt-dlp in the bundle
  // is fine (the app updates it at first launch), a failed build is not.
  if (!FORCE && fs.existsSync(stampFile)) {
    console.warn(`Could not check for a newer yt-dlp (${err.message.split('\n')[0]}); reusing the existing bundle.`);
    process.exit(0);
  }
  throw err;
}
const wanted = { 'yt-dlp': ytdlpVersion, ffmpeg: FFMPEG.version, quickjs: QUICKJS.version };

if (!FORCE && fs.existsSync(stampFile)) {
  try {
    const have = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    if (JSON.stringify(have) === JSON.stringify(wanted)) {
      console.log(`Bundled tools are current (yt-dlp ${have['yt-dlp']}, ffmpeg ${have.ffmpeg}, QuickJS ${have.quickjs}).`);
      process.exit(0);
    }
  } catch { /* unreadable stamp: rebuild */ }
}

console.log('Assembling bundled tools for macOS (arm64 + x86_64)');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'setengine-tools-'));
const stage = path.join(work, 'bin');
fs.mkdirSync(stage);

try {
  // ── ffmpeg / ffprobe ───────────────────────────────────────────────────────
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const slices = [];
    for (const arch of ['arm64', 'x64']) {
      const name = `${tool}-darwin-${arch}`;
      const file = path.join(work, name);
      download(`${FFMPEG.base}/${name}`, file);
      verify(file, FFMPEG.files[name], name);
      slices.push(file);
    }
    const out = path.join(stage, tool);
    run('lipo', ['-create', ...slices, '-output', out]);
    fs.chmodSync(out, 0o755);
    // lipo drops the slices' signatures, and an unsigned arm64 binary is killed
    // on launch. Ad-hoc is enough here; a Developer ID build re-signs everything.
    run('codesign', ['--force', '--sign', '-', out]);
    assertUniversal(out, tool);
    log(`${tool} ${FFMPEG.version}`);
  }

  // ── QuickJS ────────────────────────────────────────────────────────────────
  {
    const tarball = path.join(work, 'quickjs.tar.gz');
    const src = path.join(work, 'quickjs');
    download(QUICKJS.url, tarball);
    verify(tarball, QUICKJS.sha256, 'quickjs source');
    fs.mkdirSync(src);
    run('tar', ['-xzf', tarball, '-C', src, '--strip-components', '1']);
    const out = path.join(stage, 'qjs');
    run('cc', [
      '-O2', '-D_GNU_SOURCE', '-DQUICKJS_NG_BUILD',
      '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0',
      '-I', src, '-o', out,
      ...QUICKJS.sources.map((f) => path.join(src, f)),
      '-lm', '-lpthread',
    ]);
    run('codesign', ['--force', '--sign', '-', out]);
    assertUniversal(out, 'qjs');
    log(`QuickJS ${QUICKJS.version} (built from source)`);
  }

  // ── yt-dlp (onedir) ────────────────────────────────────────────────────────
  {
    const zip = path.join(work, 'yt-dlp_macos.zip');
    const sums = path.join(work, 'SHA2-256SUMS');
    download(`${YTDLP_REPO}/download/${ytdlpVersion}/yt-dlp_macos.zip`, zip);
    download(`${YTDLP_REPO}/download/${ytdlpVersion}/SHA2-256SUMS`, sums);
    const line = fs.readFileSync(sums, 'utf8').split('\n').find((l) => /\syt-dlp_macos\.zip$/.test(l));
    if (!line) throw new Error('yt-dlp: SHA2-256SUMS has no entry for yt-dlp_macos.zip');
    verify(zip, line.trim().split(/\s+/)[0], 'yt-dlp_macos.zip');

    const dir = path.join(stage, 'yt-dlp');
    fs.mkdirSync(dir);
    // ditto, not unzip: it restores the symlinks inside the bundled Python framework.
    run('ditto', ['-x', '-k', zip, dir]);
    fs.renameSync(path.join(dir, 'yt-dlp_macos'), path.join(dir, 'yt-dlp'));
    fs.chmodSync(path.join(dir, 'yt-dlp'), 0o755);
    // yt-dlp reads a config file sitting next to its own binary. deno is the only
    // runtime it enables by default; this adds the bundled QuickJS as a fallback
    // (deno still wins if the user happens to have it).
    fs.writeFileSync(path.join(dir, 'yt-dlp.conf'), '--js-runtimes quickjs\n');
    assertUniversal(path.join(dir, 'yt-dlp'), 'yt-dlp');
    log(`yt-dlp ${ytdlpVersion}`);
  }

  fs.writeFileSync(path.join(stage, 'versions.json'), `${JSON.stringify(wanted, null, 2)}\n`);
  fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), [
    'SetEngine bundles these separate, unmodified command-line programs. Each is',
    'run as its own process; none is linked into SetEngine.',
    '',
    `yt-dlp ${ytdlpVersion} — The Unlicense — https://github.com/yt-dlp/yt-dlp`,
    '  Its bundled Python runtime and libraries carry their own licenses; see',
    '  https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt',
    '',
    `FFmpeg ${FFMPEG.version} (ffmpeg, ffprobe) — GPL v3 — https://ffmpeg.org`,
    '  Static builds from https://github.com/eugeneware/ffmpeg-static (b6.1.1):',
    '  arm64 by https://www.osxexperts.net, x86_64 by https://evermeet.cx/ffmpeg.',
    '  Source code: https://ffmpeg.org/download.html',
    '',
    `QuickJS-ng ${QUICKJS.version} (qjs) — MIT — https://github.com/quickjs-ng/quickjs`,
    '',
  ].join('\n'));

  // ── Smoke test: each tool must actually start on this machine ──────────────
  const env = { ...process.env, PATH: `${path.join(stage, 'yt-dlp')}:${stage}:/usr/bin:/bin` };
  run('ffmpeg', ['-version'], { env });
  run('ffprobe', ['-version'], { env });
  run('qjs', ['-e', '1 + 1'], { env });
  const reported = run('yt-dlp', ['--version'], { env, timeout: 120_000 }).trim();
  if (reported !== ytdlpVersion) throw new Error(`yt-dlp reports ${reported}, expected ${ytdlpVersion}`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // cp -R keeps the framework symlinks intact; fs.cpSync would too, but dereferences on older Node.
  run('cp', ['-R', stage, OUT]);
  const mb = Math.round(Number(run('du', ['-sk', OUT]).split(/\s+/)[0]) / 1024);
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${mb} MB)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
