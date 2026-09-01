// SetEngine — dense probe capture for the recognition evaluation harness.
//
//   npx electron scripts/eval/capture.mjs <youtube-url> [out.json]
//
// Runs under Electron, with no BrowserWindow, for one reason: `net.fetch`.
// Shazam's edge blackholes Node's undici client (see the long note in
// src/main/shazam/recognize.js) so the only way to capture real probe results is
// inside the Electron runtime the app itself uses.
//
// ── What this produces, and why it is shaped this way ─────────────────
// It probes a FIXED, DENSE grid — every CAPTURE_STEP_SEC seconds, edge to edge —
// and writes every raw observation, including the `matches[]` array that
// anchor.js reasons over.
//
// That grid is a superset of any probe set the adaptive scan could choose (as
// long as its floors are multiples of the step), which is the whole point: the
// scan can then be REPLAYED offline against this file, serving each probe from
// the capture instead of the network. Budgets, gap floors and acceptance rules
// can be evaluated in milliseconds instead of ~20 minutes of live requests, and
// every variant is scored against the identical audio evidence.
//
// A capture is expensive (one request per step at the measured 3 s pacing, so
// ~21 min for a 55-minute set) but it is paid ONCE per set. Captures are also
// strictly serial across sets — Shazam rate-limits per IP, so running two at
// once just buys 429s.

import { app } from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { probeMoment, newProbeState, runtimeOf } = await import(path.join(here, '.build', 'capture.mjs'));

// Matches the finest bisection floor we want to be able to simulate. Anything
// coarser and a replayed scan would have to interpolate, which would make the
// simulation a model rather than a measurement.
const CAPTURE_STEP_SEC = 8;

// Same PATH shim main.js installs. Without it a yt-dlp installed by Homebrew or
// pip is invisible to a process launched from a stripped environment.
function shimPath() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  process.env.PATH = [...extra.filter((p) => existsSync(p)), process.env.PATH].join(':');
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let err = '';
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

// 128 kbps is what set-extractor.js downloads for a scan, so the captured audio
// is bit-for-bit the material the real pipeline would fingerprint.
async function fetchAudio(url, dir) {
  await run('yt-dlp', [
    '-x', '--audio-format', 'mp3', '--audio-quality', '128K',
    '--extractor-args', 'youtube:player_client=default,web_safari,tv,mweb',
    '--concurrent-fragments', '4', '--no-warnings', '--no-playlist',
    '-o', path.join(dir, 'set.%(ext)s'), url,
  ]);
  const files = await readdir(dir);
  const f = files.find((x) => /^set\./.test(x));
  if (!f) throw new Error('yt-dlp produced no file');
  return path.join(dir, f);
}

// Three separate --print expressions, one per line, with the title LAST. A DJ-set
// title routinely contains both `|` and `/` ("Ive Lovers | HÖR - July 30 / 2026"),
// so any single-line delimited format mis-splits it — and because the id is used
// as the capture filename, that silently wrote a capture into a directory named
// after half the title.
function videoMeta(url) {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ['--no-warnings', '--skip-download',
      '--print', '%(id)s', '--print', '%(duration)s', '--print', '%(title)s', url]);
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('error', () => resolve(['', '', 0]));
    proc.on('close', () => {
      const [id, dur, ...rest] = out.trim().split('\n');
      resolve([rest.join(' ').trim(), (id || '').trim(), Number(dur) || 0]);
    });
  });
}

async function main() {
  shimPath();
  const url = process.argv[2];
  if (!url) throw new Error('usage: npx electron scripts/eval/capture.mjs <url> [out.json]');

  const [title, id, metaDuration] = await videoMeta(url);
  const outPath = process.argv[3] || path.join(here, 'captures', `${id || 'set'}.json`);
  await mkdir(path.dirname(outPath), { recursive: true });
  console.log(`[capture] ${title || url}`);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'setengine-eval-'));
  try {
    console.log('[capture] downloading audio…');
    const audioPath = await fetchAudio(url, dir);
    const total = await runtimeOf(audioPath, metaDuration);
    const points = [];
    for (let t = 1; t < total - 10; t += CAPTURE_STEP_SEC) points.push(Math.round(t));
    console.log(`[capture] ${Math.round(total / 60)} min → ${points.length} probes `
      + `(~${Math.round((points.length * 3) / 60)} min at the measured 3 s pacing)`);

    const state = newProbeState();
    const observations = [];
    const startedAt = Date.now();
    for (let i = 0; i < points.length; i++) {
      const obs = await probeMoment(state, audioPath, points[i], null);
      observations.push(obs);
      if (i % 25 === 0 || i === points.length - 1) {
        const matched = observations.filter((o) => o.trackKey).length;
        const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
        console.log(`[capture] ${i + 1}/${points.length} · ${matched} matched · ${mins} min elapsed`);
        // Written incrementally: a capture is 20+ minutes of irreplaceable
        // requests and must survive being interrupted.
        await writeFile(outPath, JSON.stringify({
          url, id, title, durationSec: total, stepSec: CAPTURE_STEP_SEC,
          complete: i === points.length - 1, observations,
        }, null, 1));
      }
    }
    const matched = observations.filter((o) => o.trackKey).length;
    const names = new Set(observations.filter((o) => o.trackKey).map((o) => o.trackKey));
    console.log(`[capture] done → ${outPath}`);
    console.log(`[capture] ${matched}/${observations.length} probes matched, ${names.size} distinct records seen`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => { console.error('[capture] FAILED:', err && err.message); app.exit(1); });
