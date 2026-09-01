// SetEngine — Shazam recognition (the only recognition engine)
//
// Identifies tracks against Shazam's catalog. Fingerprinting happens here on the
// machine; only a ~250-character signature is sent, never the audio.
//
// This is the sole recognizer. SetEngine previously also supported AudD and
// ACRCloud; both were removed along with the engine picker, because both
// required an account, an API key and per-request payment, and both uploaded the
// entire set to a third party. Nothing here needs a key, an account or a
// payment, and the audio itself never leaves the machine.
//
// ── What this depends on, stated plainly ──────────────────────────────
// The endpoint below is Shazam's own, but it is *not* a published API. It was
// reverse-engineered by the open-source community and is used here without a
// key. That means: it is against Shazam/Apple's terms of service, it can change
// or start refusing us at any time with no notice, and there is no support to
// appeal to. This was a deliberate, informed choice — it is the only way to get
// "any song, no key, nothing to maintain".
//
// There is no fallback engine, so if this endpoint dies, audio recognition dies
// with it and Set Extraction degrades to published tracklists only
// (tracklist-sources.js) — which covers a large share of DJ sets.
//
// ── How this decides WHERE to listen ──────────────────────────────────
// Adaptively, and it is the core of the design. Rather than planning probe
// points up front from an offline novelty curve (the old segmenter.js, now
// deleted), the scan proves its own coverage:
//
//   • Probe a coarse grid.
//   • Any gap whose two ends prove the SAME record was playing throughout needs
//     no further probing — nothing can be hiding in it (see anchor.js for what
//     "prove" means).
//   • Otherwise bisect the widest unproven gap and repeat.
//
// Requests therefore land exactly where the uncertainty is: a five-minute
// continuous track costs two probes, a dense run of transitions gets as many as
// it needs. The old approach spent a fixed two probes per guessed segment and
// measurably missed boundaries — and where its guess went wrong it produced runs
// of confident junk (measured on one set: 11 of its 24 reported tracks were
// spurious).
//
// ── Rate limiting is a real constraint, and it was re-measured ────────
// Against the live endpoint, on this machine: 20 requests go through back to
// back (in ~6 s) and then it returns 429. Recovery is FAST — the very next
// request a few seconds later succeeded. A 3 s gap sustained 34/34 with no 429
// at all; a 2 s gap ran 20, took two 429s, then sustained another 18.
//
// So a 429 is cheap and local, not a ban: we wait and retry the SAME probe.
// (An older version slept 60 s, abandoned the probe, and failed the entire
// extraction after three of them — based on a "~90 s to clear" figure that
// re-measurement did not reproduce.)
//
// The pacing that enforces those figures lives in rate-gate.js, and it is
// MACHINE-wide on purpose. The limit is per machine, so per-run pacing is not
// pacing at all: three parallel extractions each waiting their own 3 s emitted a
// request every second, throttled each other, and all three died with "Shazam is
// rate-limiting this machine and did not recover". The gate also spans processes
// — `scripts/eval` probes from a separate node process, and Shazam sees one IP
// for both. Never add a request path that bypasses acquireShazamSlot().

import { net } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { signatureFor } from './signature.js';
import { tracklistFrom, proves, unidentifiedStretches, MIN_PLAY_HITS } from './anchor.js';
import { acquireShazamSlot, noteShazamAnswered, noteShazamRateLimited, shazamGateStatus } from './rate-gate.js';

// Shazam's signature generator expects 16 kHz mono; feeding it that directly
// avoids an internal resample.
const SAMPLE_RATE = 16000;

// Sample length per probe. Shazam matches from 3–12 s. Measured on hard material
// (regions where 8 s returned nothing): 16 s and 26 s returned nothing either,
// on every one of 10 points. Longer windows do not rescue unrecognisable audio,
// and they straddle transitions — at 12 s two probes near a mix point returned
// the *neighbouring* track. So 8 s, deliberately.
export const PROBE_SEC = 8;

// Attempts per probe before the moment is given up as unheard. Pacing and
// backoff between attempts are the gate's job (rate-gate.js) — by the last
// attempt the shared cooldown is tens of seconds, so this is a genuinely
// patient retry, not a burst.
const MAX_PROBE_ATTEMPTS = 6;

// Circuit breaker. If this many probes IN A ROW go unheard — 3 × 6 throttled
// attempts, spanning minutes of shared backoff — the endpoint isn't pacing us,
// it's refusing us, and grinding through the whole probe budget at that rate
// would take hours. Stop and report what was heard: a partial scan beats a job
// that hangs. Measured recovery is seconds, so reaching this is abnormal.
const MAX_CONSECUTIVE_UNHEARD = 3;

// Budget. Scales with runtime so a 60-minute set and a 160-minute set both get
// comparable resolution, with a floor and a ceiling on wall-clock cost.
//
// One probe per 8 s of runtime. Measured first at one-per-25 s, then one-per-15 s
// (recall 46.9% → 54.7%, and precision went UP, 85.7% → 87.5%), and it is now
// one-per-8 s. More evidence never costs precision here, because acceptance is
// decided by whether the audio's timing agrees (anchor.js), not by how many
// times a name appeared — so the only real cost is wall clock.
//
// 8 s of runtime per probe is FULL density — PROBE_SEC is 8, so probes any
// closer together would overlap and re-listen to the same audio. A 55-minute set
// is 414 probes ≈ 21 min at the measured 3 s pacing.
//
// Be honest about what the density bought on ordinary sets, because it is less
// than it looks: on the two corpus sets captured at full 8 s density, the extra
// probes did NOT add a single track — the all-probes ceiling scored exactly what
// the old 15 s budget scored, because what was missing was missing from Shazam's
// catalog, not from the sampling.
//
// The CAP is a different question, and it was the one actually costing recall.
// At 460 every set longer than ~61 minutes fell below full density — a 2-hour
// set got one probe per 15.7 s and a 3-hour set one per 23.5 s, which is exactly
// the band measured as worse (going 25 s → 15 s took recall 46.9% → 54.7%). So
// the cap is 900: full 8 s density through 2 hours, and ~12 s at three. Nothing
// changes for a set under an hour; long sets stop being quietly under-sampled.
//
// Note this is honest extrapolation, not a direct measurement — the corpus is
// 55–70 minutes, so the long-set case is argued from the older density figure
// rather than captured. Worth capturing a 2-hour set to confirm.
//
// The cost is wall clock and nothing else: 900 probes ≈ 45 min of listening on a
// very long set. That is a deliberate trade — the goal is to name as much of the
// set as possible, and time is the cheapest thing we have to spend.
//
// Note it is a CEILING, not a plan: the scan spends only where coverage is
// genuinely unproven, so an easy set still finishes early and cheap.
const PROBE_SECONDS_PER_REQUEST = 8;
const MIN_PROBE_BUDGET = 60;
const MAX_PROBE_BUDGET = 900;

// Bisection floors. Two regimes, because "we don't know what's here" has two
// very different causes:
//   CONFUSED — both ends matched but disagree. Worth probing hard: measured on a
//     real set, 37 s spacing never surfaced a track's correct title while 15 s
//     spacing surfaced it twice and proved it.
//   SILENT — neither end matched. Talking, crowd noise, an unreleased ID. Extra
//     probes buy nothing (measured: tripling density over six unidentified
//     tracks recovered exactly none), so back off and spend elsewhere.
const MIN_GAP_CONFUSED_SEC = 18;
const MIN_GAP_SILENT_SEC = 100;
const SILENT_PRIORITY = 0.25;

// The floors above are where bisection STOPS, and the scan used to stop with
// them — `break` on a fully-resolved plan, however much budget was left unspent.
// Measured on a 55-minute set, that converged at 156 probes of 221 available,
// leaving 100-second windows of "silent" mix never sampled at all.
//
// So when the plan resolves and budget remains, tighten the floors and go again.
// Each phase halves, ending at the probe length itself — below that, windows
// overlap and buy nothing. Like the budget above, this converts leftover budget
// into coverage at no cost to precision; also like the budget above, it did not
// by itself recover tracks on the two corpus sets, because there was nothing
// recoverable hiding in those windows.
export const FLOOR_PHASES = [
  { confused: MIN_GAP_CONFUSED_SEC, silent: MIN_GAP_SILENT_SEC },
  { confused: MIN_GAP_CONFUSED_SEC / 2, silent: MIN_GAP_SILENT_SEC / 2 },
  { confused: PROBE_SEC, silent: MIN_GAP_SILENT_SEC / 4 },
];

// Coarse seeding before adaptive bisection takes over.
const SEED_STEP_SEC = 300;

const USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TQ2A.230405.003)';

function endpointUrl() {
  return `https://amp.shazam.com/discovery/v5/en/US/android/-/tag/${crypto.randomUUID()}/${crypto.randomUUID()}`
    + '?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3';
}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// Decoding a short slice per probe (rather than holding the whole set at 16 kHz)
// keeps memory flat on long sets, and lets a probe be placed anywhere on demand
// — which the adaptive scan needs.
export function decodeSlice(filePath, startSec, durSec, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-ss', String(startSec),
      '-t', String(durSec),
      '-i', filePath,
      '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE),
      'pipe:1',
    ]);
    const chunks = [];
    let total = 0;
    let stderr = '';
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch (_) { /* gone */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    proc.stdout.on('data', (c) => { chunks.push(c); total += c.length; });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code !== 0) { reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 160).trim()}`)); return; }
      const buf = Buffer.concat(chunks, total);
      const out = new Float32Array(total / 4);
      out.set(new Float32Array(buf.buffer, buf.byteOffset, total / 4));
      resolve(out);
    });
  });
}

/**
 * One lookup.
 *
 * Returns the identified track AND `matches` — the reference recordings the
 * signature aligned to, each with its position (`offset`) inside that recording
 * and the playback-rate difference (`timeskew`). Those two fields are what all
 * of anchor.js reasons over; the previous version discarded them and kept only
 * the title, which is why it had nothing better than "how many times did I see
 * this name" to judge a result by.
 */
async function lookup(pcm, signal) {
  const { uri, samplems } = signatureFor(pcm, SAMPLE_RATE);

  // `net.fetch`, NOT the global `fetch`. This is not stylistic: Shazam's edge
  // silently blackholes connections from Node's undici client — every request
  // dies on a connect timeout after ~10 s — while the identical request through
  // Chromium's network stack returns 200 in ~270 ms. (Verified side by side; a
  // control host on the same machine answered fine over undici, so undici isn't
  // broken — this host just refuses it.) net.fetch is fetch-compatible, honours
  // AbortSignal, and additionally respects the system proxy. Switching this back
  // to global fetch will make every probe fail silently as "no match".
  let res;
  try {
    res = await net.fetch(endpointUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'en',
      },
      body: JSON.stringify({
        timezone: 'Europe/Paris',
        signature: { uri, samplems },
        timestamp: Date.now(),
        context: {},
        geolocation: {},
      }),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return { aborted: true };
    // Distinguished from a clean no-match on purpose. Silently treating an
    // unreachable endpoint as "nothing playing here" is how a total outage
    // disguises itself as an empty tracklist.
    return { networkError: true, message: err && err.message };
  }

  if (res.status === 429 || res.status >= 500) return { rateLimited: true };
  if (!res.ok) return { noMatch: true };

  let json;
  try { json = await res.json(); } catch (_) { return { noMatch: true }; }
  if (!json || !json.track || !json.track.title) return { noMatch: true };

  const t = json.track;
  let album = '';
  for (const section of (t.sections || [])) {
    for (const m of (section.metadata || [])) {
      if (m && m.title === 'Album' && m.text) { album = String(m.text); break; }
    }
    if (album) break;
  }
  return {
    track: {
      trackKey: String(t.key),
      title: String(t.title).trim(),
      artist: String(t.subtitle || '').trim(),
      album: album.trim(),
      isrc: t.isrc ? String(t.isrc) : '',
    },
    matches: (json.matches || []).map((m) => ({
      id: m && m.id, offset: m && m.offset, timeskew: m && m.timeskew,
    })).filter((m) => m.id != null && typeof m.offset === 'number'),
  };
}

/**
 * How much evidence to demand, from the user's confidence setting.
 *
 * The old engine exposed a 0–100 score threshold, but the scores it thresholded
 * were just sighting counts (70 for one, 95 for two) and a repeatable
 * misidentification scored 95 as readily as a truth. There is no meaningful
 * continuum to expose here, so the setting picks the weakest confidence tier
 * that appears at all (see confidenceOf in anchor.js).
 */
function acceptOptionsFor(settings) {
  const v = Number(settings && settings.recognizerMinConfidence);
  const level = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 60;
  // Only records whose reference position advances linearly right across the
  // play. The cleanest tracklist there is, but a briefly-played track — too few
  // sightings to form a chain — is dropped along with the junk.
  if (level >= 80) return { minTier: 'proven', minHits: MIN_PLAY_HITS };
  // Everything credible, including one-off sightings. Deliberately noisy: a
  // single sighting was measured junk 11 times in 12, and with one sighting
  // there is no rate to test, so the pinned-impostor check can't fire either.
  if (level < 40) return { minTier: 'uncertain', minHits: 1 };
  // Default. Proven and likely plays are reported plainly, thin ones are
  // reported as 'uncertain' and badged by the UI rather than silently dropped —
  // dropping them is what made a half-empty tracklist look finished.
  return { minTier: 'uncertain', minHits: MIN_PLAY_HITS };
}

/**
 * Runtime of the downloaded file, for when the yt-dlp metadata didn't carry one
 * (live re-broadcasts and some DASH manifests report no duration). The adaptive
 * scan needs a length to plan against, so measure the file rather than fail.
 */
function probeDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('error', () => resolve(0));
    proc.on('close', () => resolve(Math.floor(Number(out.trim()) || 0)));
  });
}

// Shared request state: pacing, 429 accounting and network-failure tallies. One
// of these is threaded through every probe of a run so the measured rate limit
// is respected across the whole run, including the spot check that may precede
// the full scan.
export function newProbeState() {
  return {
    // `requests` counts lookups actually sent; `answered` counts the ones that
    // came back as something other than a 429. The difference is what tells a
    // scan that was merely slowed apart from one that was refused outright.
    requests: 0, answered: 0, rateLimited: 0, unheard: 0, consecutiveUnheard: 0,
    networkFailures: 0, lastNetworkError: '',
    // Probes that died BEFORE a request was ever made — ffmpeg missing or unable
    // to read the file, or the WASM signature module failing to load. Tracked
    // separately from networkFailures because the two need different messages
    // and, more importantly, because a probe that never reached the network is
    // not evidence that nothing was playing. See the guard in recognize().
    localFailures: 0, lastLocalError: '',
  };
}

/**
 * One probe, with pacing and 429 retry.
 *
 * Always returns an observation — a no-match is an observation too, and the
 * adaptive scan needs it to know a region is silent rather than unvisited.
 */
export async function probeMoment(state, audioPath, t, signal) {
  const obs = { t, trackKey: null, matches: [] };

  // Decoded and signed once, before queueing for a slot: that work is local and
  // free, and a retry re-sends the same signature rather than re-running ffmpeg.
  // A slot is a scarce, machine-wide resource — don't hold one to decode.
  let pcm;
  try {
    pcm = await decodeSlice(audioPath, t, PROBE_SEC, signal);
  } catch (err) {
    // A bad probe never aborts the scan — but it must not pass for silence
    // either. Decoding and signing happen before any request, so a failure
    // here (no ffmpeg, an unreadable download, shazamio-core failing to load)
    // yields an observation that looks exactly like "nothing recognisable was
    // playing". At 100% that turns a broken install into a confidently empty
    // tracklist, which is the same trap the net.fetch bug set.
    state.localFailures++;
    state.lastLocalError = (err && err.message) || String(err);
    return obs;
  }
  if (pcm.length < SAMPLE_RATE) return obs;             // too short to fingerprint

  let throttled = false;
  for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    await acquireShazamSlot(signal);                    // machine-wide pacing

    let res;
    try {
      res = await lookup(pcm, signal);
    } catch (err) {
      state.localFailures++;
      state.lastLocalError = (err && err.message) || String(err);
      return obs;
    }
    state.requests++;

    if (res && res.aborted) throw new Error('Extraction cancelled.');
    if (res && res.rateLimited) {
      // Tell the gate, then simply ask for another slot. The backoff is shared,
      // so every other job — and every other SetEngine process — waits it out
      // too, which is the only way a machine-wide block clears while several
      // scans are running.
      state.rateLimited++;
      throttled = true;
      noteShazamRateLimited();
      continue;                                         // retry this same moment
    }
    if (res && res.networkError) {
      // Not an answer: the request never reached the endpoint, so it says
      // nothing about pacing and must not count towards `answered` — the
      // run-level guard uses that to catch a total outage.
      state.networkFailures++;
      state.lastNetworkError = res.message || '';
      return obs;
    }
    noteShazamAnswered();
    state.answered++;
    state.consecutiveUnheard = 0;

    if (res && res.track) return { t, ...res.track, matches: res.matches };
    return obs;                                         // a clean no-match
  }

  // Every attempt was throttled. The moment is UNHEARD, not silent, and the
  // difference is load-bearing: a no-match tells the bisection this region is
  // quiet and it stops probing there (floors.silent), so recording a 429 as a
  // no-match would let rate limiting quietly erase coverage instead of costing
  // time. Callers must drop this observation rather than believe it.
  if (throttled) { state.unheard++; state.consecutiveUnheard++; }
  return { ...obs, unheard: throttled };
}

export async function runtimeOf(audioPath, durationSec) {
  let total = Math.max(0, Math.floor(Number(durationSec) || 0));
  if (total < 2) total = await probeDuration(audioPath);
  return total;
}

/**
 * A cheap sanity check on a published tracklist that *looks* complete.
 *
 * Probes a dozen evenly-spaced moments and hands back what was playing. The
 * caller compares those against the list: if most of them name records the list
 * never mentions, the list was partial after all and the full scan should run.
 *
 * This is the backstop for the completeness heuristic in tracklist-sources.js.
 * That heuristic is tuned on a handful of sets and will misjudge some list it
 * has never seen; twelve probes cost well under a minute and catch it.
 *
 * Deliberately NOT a judgement of correctness — it asks "is there a lot of music
 * here you didn't mention", which is answerable from a dozen samples, not "are
 * your names right", which isn't.
 */
export async function spotCheck(audioPath, { points = 12, durationSec, signal } = {}) {
  const total = await runtimeOf(audioPath, durationSec);
  if (total < 2) return { observations: [], matchedCount: 0 };

  const state = newProbeState();
  const observations = [];
  for (let i = 0; i < points; i++) {
    const raw = Math.round((total * (i + 0.5)) / points);
    const t = Math.max(1, Math.min(total - PROBE_SEC - 1, raw));
    observations.push(await probeMoment(state, audioPath, t, signal));
    if (state.consecutiveUnheard >= MAX_CONSECUTIVE_UNHEARD) break;   // refused, not paced
  }
  const heard = observations.filter((o) => !o.unheard).sort((a, b) => a.t - b.t);
  if (state.unheard) {
    console.warn(`[SetEngine] Shazam spot check: ${state.unheard} of ${points} probes went unheard `
      + `(throttled). Gate now at ${shazamGateStatus().gapMs} ms.`);
  }
  return {
    // Only moments we actually heard. Everything downstream — the agreement
    // score, and the seeds handed to the full scan — must treat a throttled
    // probe as one that never happened.
    observations: heard,
    matchedCount: heard.filter((o) => o.trackKey).length,
    // A spot check that got no answer at all cannot contradict anything, so the
    // caller must not read "no probe named a listed track" as a failed list.
    answered: state.answered,
  };
}

/** Probe ceiling for a set of this length. */
export function probeBudgetFor(totalSec) {
  return Math.max(MIN_PROBE_BUDGET,
    Math.min(MAX_PROBE_BUDGET, Math.round(totalSec / PROBE_SECONDS_PER_REQUEST)));
}

/** The coarse grid the adaptive scan starts from. */
export function seedPoints(totalSec) {
  const pts = [];
  for (let t = Math.min(30, totalSec / 2); t < totalSec - 20; t += SEED_STEP_SEC) pts.push(t);
  return pts;
}

// Clamped so a probe never runs off either end of the file. Shared with
// planNextProbe so "is this midpoint already spent?" compares the same number
// the probe would actually be taken at.
function clampT(rawT, totalSec) {
  return Math.max(1, Math.min(totalSec - PROBE_SEC - 1, Math.round(rawT)));
}

/**
 * Where to listen next, or null when the plan is resolved at these floors.
 *
 * Exported and pure so the evaluation harness (scripts/eval) can replay the real
 * scan offline against a dense capture — the planner under test is then the
 * shipped one, not a re-implementation that can drift away from it.
 *
 * Widest unproven gap wins. A gap whose two ends PROVE the same record played
 * across it is skipped entirely: nothing can be hiding in it. A gap whose two
 * ends both heard nothing is deprioritised rather than skipped, because extra
 * probes in genuinely unrecognisable audio measurably recover nothing.
 */
export function planNextProbe(observations, totalSec, floors, spent) {
  let best = null;
  const consider = (width, mid, floor, weight) => {
    if (width < floor) return;
    const t = clampT(mid, totalSec);
    if (spent.has(t)) return;
    const priority = width * weight;
    if (!best || priority > best.priority) best = { priority, t };
  };
  for (let i = 0; i < observations.length - 1; i++) {
    const a = observations[i];
    const b = observations[i + 1];
    if (proves(a, b)) continue;
    const silent = !a.trackKey && !b.trackKey;
    consider(b.t - a.t, (a.t + b.t) / 2,
      silent ? floors.silent : floors.confused,
      silent ? SILENT_PRIORITY : 1);
  }
  if (observations.length) {
    consider(observations[0].t, observations[0].t / 2, floors.confused, 1);
    const lastT = observations[observations.length - 1].t;
    consider(totalSec - lastT, (lastT + totalSec) / 2, floors.confused, 1);
  }
  return best ? best.t : null;
}

export async function recognize(audioPath, { settings, signal, onProgress, durationSec, seedObservations } = {}) {
  const total = await runtimeOf(audioPath, durationSec);
  if (total < 2) throw new Error('Could not determine the length of this set — cannot scan it.');

  const maxProbes = probeBudgetFor(total);

  const observations = [];
  const spent = new Set();
  const state = newProbeState();

  // Reuse anything the spot check already paid for. Those probes are ordinary
  // observations and the bisection reads them exactly like its own seed grid.
  for (const o of (seedObservations || [])) {
    if (!o || typeof o.t !== 'number' || o.unheard || spent.has(o.t)) continue;
    spent.add(o.t);
    observations.push(o);
  }
  observations.sort((a, b) => a.t - b.t);

  const emit = () => { if (onProgress) onProgress({ done: spent.size, total: maxProbes }); };
  emit();

  const probeAt = async (rawT) => {
    const t = clampT(rawT, total);
    if (spent.has(t)) return null;
    spent.add(t);

    const obs = await probeMoment(state, audioPath, t, signal);
    emit();
    // Throttled: `t` stays spent, so planNextProbe won't keep choosing the same
    // point, but the moment is not recorded — the gap stays unproven and the
    // scan spends its next probe somewhere it can actually learn something.
    if (obs.unheard) return obs;
    observations.push(obs);
    observations.sort((a, b) => a.t - b.t);
    return obs;
  };

  // ── Seed a coarse grid ──────────────────────────────────────────────
  for (const t of seedPoints(total)) {
    if (spent.size >= maxProbes) break;
    await probeAt(t);
  }

  // ── Bisect until coverage is proven, then tighten and go again ──────
  // Each phase bisects to its own floors; when the plan resolves and budget is
  // left, the next phase halves the floors and reopens the gaps that were closed
  // for being "small enough". The old loop stopped at the first resolution and
  // handed the unspent budget back, which is pure lost recall.
  const refused = () => state.consecutiveUnheard >= MAX_CONSECUTIVE_UNHEARD;
  for (const floors of FLOOR_PHASES) {
    while (spent.size < maxProbes && !refused()) {
      if (signal && signal.aborted) throw new Error('Extraction cancelled.');
      const next = planNextProbe(observations, total, floors, spent);
      if (next === null) break;                           // resolved at these floors
      await probeAt(next);
    }
    if (spent.size >= maxProbes || refused()) break;
  }
  if (refused()) {
    console.warn(`[SetEngine] Shazam stopped answering: ${state.unheard} probes unheard in a row after `
      + `${state.rateLimited} rate-limited attempts. Reporting what was heard `
      + `(${state.answered} answered lookups).`);
  }

  // Every probe failing to even reach Shazam is an outage, not an unrecognisable
  // set. Say so, instead of handing back an empty tracklist the user would read
  // as "none of my tracks are known".
  // Note this fires only when the run got NOTHING back across every probe and
  // every retry. Ordinary throttling is absorbed by the gate and costs time,
  // not results — it must never fail a job on its own.
  if (state.requests > 0 && state.answered === 0) {
    if (state.rateLimited > state.networkFailures) {
      throw new Error(`Shazam refused all ${state.requests} lookups from this network. Nothing was recognized — try again later, or use a set whose uploader published a tracklist.`);
    }
    throw new Error(`Couldn't reach Shazam — all ${state.requests} lookups failed${state.lastNetworkError ? ` (${state.lastNetworkError})` : ''}. Check your connection.`);
  }
  // And every probe dying before it got that far is a broken local setup, which
  // looks identical from the outside and must not be reported as an empty set.
  if (state.requests === 0 && state.localFailures > 0) {
    throw new Error(`Couldn't listen to this set — all ${state.localFailures} probes failed before reaching Shazam`
      + `${state.lastLocalError ? ` (${state.lastLocalError})` : ''}. Check that ffmpeg is installed and on PATH.`);
  }

  const { tracks, plays, dropped } = tracklistFrom(observations, acceptOptionsFor(settings));

  const gaps = unidentifiedStretches(observations, plays, total);

  const matched = observations.filter((o) => o.trackKey).length;
  const tally = { proven: 0, likely: 0, uncertain: 0 };
  for (const t of tracks) if (tally[t.confidence] != null) tally[t.confidence]++;
  console.log(`[SetEngine] Shazam: ${observations.length}/${maxProbes} probes over ${Math.round(total / 60)} min `
    + `(${matched} matched) → ${plays.length} plays → ${tracks.length} track(s) `
    + `[${tally.proven} proven, ${tally.likely} likely, ${tally.uncertain} uncertain]`
    + `${dropped.length ? `, ${dropped.length} sighting(s) dropped as contradicted` : ''}`
    + `${gaps.length ? `, ${gaps.length} unidentified stretch(es) totalling ${Math.round(gaps.reduce((n, g) => n + (g.toSec - g.fromSec), 0) / 60)} min` : ''}.`);

  if (onProgress) onProgress({ done: maxProbes, total: maxProbes });
  return { tracks, gaps };
}
