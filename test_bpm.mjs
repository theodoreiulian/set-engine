// Scratchpad harness for the BPM consensus pipeline (not a test framework).
//
//   node test_bpm.mjs            → offline unit checks (reconcile + text helpers)
//   node test_bpm.mjs synth      → synthetic click-track detection (needs ffmpeg)
//   node test_bpm.mjs net        → live Deezer/GetSongBPM lookups
//   node test_bpm.mjs file <path> [--key=XXXX]  → full pipeline on a real file
//
// GETSONGBPM_KEY env var (or --key=) enables the GetSongBPM source for net/file.

import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  reconcileBpm, cleanTitle, primaryArtist, matchScore,
  lookupBpm, _clearLookupCache,
} from './src/main/bpm-sources.js';
import { detectKeyBpm } from './src/main/key-bpm-detector.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}
function approx(name, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}: got ${got}, want ${want}±${tol}`); }
}
const slim = (r) => ({ bpm: r.bpm, source: r.source, review: r.needsReview });
const MATCH_OK = 0.5;

function unitTests() {
  check('direct', slim(reconcileBpm({ local: { bpm: 128.0, confidence: 0.8, candidates: [{ bpm: 64 }, { bpm: 128 }, { bpm: 192 }, { bpm: 256 }] }, externals: [{ source: 'deezer', bpm: 128, matchScore: 0.9 }] })),
    { bpm: 128.0, source: 'consensus', review: false });

  // candidate list deliberately omits 108 so only the octave relation (216≈2·108) matches
  check('octave', slim(reconcileBpm({ local: { bpm: 216, confidence: 0.7, candidates: [{ bpm: 216 }, { bpm: 144 }] }, externals: [{ source: 'getsongbpm', bpm: 108, matchScore: 0.8 }] })),
    { bpm: 108, source: 'consensus-octave', review: false });
  // when the half IS among candidates it's a direct consensus (better outcome)
  check('octave-direct', slim(reconcileBpm({ local: { bpm: 216, confidence: 0.7, candidates: [{ bpm: 216 }, { bpm: 108 }, { bpm: 72 }] }, externals: [{ source: 'getsongbpm', bpm: 108, matchScore: 0.8 }] })),
    { bpm: 108, source: 'consensus', review: false });

  check('conflict', slim(reconcileBpm({ local: { bpm: 140, confidence: 0.6, candidates: [{ bpm: 70 }, { bpm: 280 }, { bpm: 210 }] }, externals: [{ source: 'deezer', bpm: 108, matchScore: 0.9 }] })),
    { bpm: 108, source: 'external-conflict', review: true });

  check('local-hi', slim(reconcileBpm({ local: { bpm: 124, confidence: 0.8, candidates: [{ bpm: 62 }, { bpm: 124 }] }, externals: [] })),
    { bpm: 124, source: 'local', review: false });

  check('local-lo', slim(reconcileBpm({ local: { bpm: 124, confidence: 0.1, candidates: [] }, externals: [] })),
    { bpm: 124, source: 'local', review: true });

  check('two-ext-local-picks', slim(reconcileBpm({ local: { bpm: 120, confidence: 0.7, candidates: [{ bpm: 60 }, { bpm: 120 }, { bpm: 240 }] }, externals: [{ source: 'getsongbpm', bpm: 128, matchScore: 0.7 }, { source: 'deezer', bpm: 120, matchScore: 0.9 }] })),
    { bpm: 120, source: 'consensus', review: false });

  check('cleanTitle-feat', cleanTitle('Strobe (feat. Foo) [Official Music Video]'), 'Strobe');
  check('cleanTitle-keep-remix', cleanTitle('Adagio For Strings (Tiësto Remix) [Official Audio]'), 'Adagio For Strings (Tiësto Remix)');
  check('primaryArtist', primaryArtist('deadmau5 - Topic'), 'deadmau5');
  check('primaryArtist-feat', primaryArtist('Calvin Harris feat. Rihanna'), 'Calvin Harris');

  check('matchScore-good', matchScore('Strobe', 'deadmau5', 600, 'Strobe', 'deadmau5', 605) > 0.8, true);
  check('matchScore-bad', matchScore('Strobe', 'deadmau5', 600, 'Levels', 'Avicii', 200) < MATCH_OK, true);
}

// ── Synthetic click track → wav → detect, asserting BPM + metrical level ──

function makeClickWav(bpm, seconds, sampleRate = 22050) {
  const total = Math.floor(seconds * sampleRate);
  const samples = new Float32Array(total);
  const periodSamples = (60 / bpm) * sampleRate;
  // Short decaying kick-ish click per beat.
  for (let beat = 0; ; beat++) {
    const start = Math.round(beat * periodSamples);
    if (start >= total) break;
    for (let i = 0; i < 1200 && start + i < total; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * 30);
      samples[start + i] += env * Math.sin(2 * Math.PI * 80 * t) * 0.9;
    }
  }
  // 16-bit PCM WAV.
  const dataLen = total * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < total; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

async function synthTests() {
  const bpms = [100, 108, 128, 140, 174];
  for (const bpm of bpms) {
    const p = path.join(os.tmpdir(), `setengine-click-${bpm}.wav`);
    await writeFile(p, makeClickWav(bpm, 30));
    try {
      const r = await detectKeyBpm(p, { needBpm: true, needKey: false });
      const okLevel = Math.abs(r.bpm - bpm) <= 1.0;
      if (okLevel) pass++; else { fail++; console.log(`FAIL synth ${bpm}: got ${r.bpm} (conf ${r.bpmConfidence.toFixed(2)}) cands ${JSON.stringify(r.bpmCandidates.map(c=>c.bpm))}`); }
      console.log(`synth ${bpm} → ${r.bpm} (conf ${r.bpmConfidence.toFixed(2)})`);
    } finally {
      await unlink(p).catch(() => {});
    }
  }
}

async function netTests(key) {
  _clearLookupCache();
  const cases = [
    { title: 'Strobe', artist: 'deadmau5' },
    { title: 'One More Time', artist: 'Daft Punk' },
    { title: 'Levels', artist: 'Avicii' },
  ];
  for (const c of cases) {
    const res = await lookupBpm({ ...c, durationSec: 0, getSongBpmApiKey: key });
    console.log(`net ${c.artist} - ${c.title} →`, JSON.stringify(res));
  }
}

async function fileTest(filePath, key) {
  const det = await detectKeyBpm(filePath, { needBpm: true, needKey: true });
  console.log('local:', { bpm: det.bpm, conf: det.bpmConfidence, cands: det.bpmCandidates.map(c => c.bpm), key: det.keyName, durSec: Math.round(det.durationSec) });
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');
  const [artist, title] = base.includes(' - ') ? base.split(' - ', 2) : ['', base];
  const externals = await lookupBpm({ title, artist, durationSec: det.durationSec, getSongBpmApiKey: key });
  console.log('externals:', JSON.stringify(externals));
  console.log('reconciled:', reconcileBpm({ local: det, externals }));
}

const mode = process.argv[2] || 'unit';
const keyArg = process.argv.find((a) => a.startsWith('--key='));
const key = keyArg ? keyArg.slice('--key='.length) : process.env.GETSONGBPM_KEY || '';

if (mode === 'unit') { unitTests(); }
else if (mode === 'synth') { await synthTests(); }
else if (mode === 'net') { await netTests(key); }
else if (mode === 'file') { await fileTest(process.argv[3], key); }
else { console.log('unknown mode'); process.exit(2); }

if (mode === 'unit' || mode === 'synth') {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
