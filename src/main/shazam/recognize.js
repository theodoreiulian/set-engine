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
// So a 429 is cheap and local, not a ban. We pause a couple of seconds and retry
// the SAME probe. (The previous code slept 60 s, abandoned the probe, and failed
// the entire extraction after three of them — all based on a "~90 s to clear"
// figure that re-measurement did not reproduce.)

import { net } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { signatureFor } from './signature.js';
import { tracklistFrom, proves } from './anchor.js';

// Shazam's signature generator expects 16 kHz mono; feeding it that directly
// avoids an internal resample.
const SAMPLE_RATE = 16000;

// Sample length per probe. Shazam matches from 3–12 s. Measured on hard material
// (regions where 8 s returned nothing): 16 s and 26 s returned nothing either,
// on every one of 10 points. Longer windows do not rescue unrecognisable audio,
// and they straddle transitions — at 12 s two probes near a mix point returned
// the *neighbouring* track. So 8 s, deliberately.
const PROBE_SEC = 8;

// Measured sustainable spacing (34/34 clean at 3 s).
const REQUEST_GAP_MS = 3000;

// A 429 empties briefly and refills within seconds — back off and retry the same
// probe rather than losing it.
const RATE_LIMIT_BACKOFF_MS = 2500;
const MAX_PROBE_ATTEMPTS = 4;

// Give up only if the endpoint is refusing us persistently across the whole run.
const MAX_CONSECUTIVE_RATE_LIMITS = 12;

// Budget. Scales with runtime so a 60-minute set and a 160-minute set both get
// comparable resolution, with a floor and a ceiling on wall-clock cost.
//
// One probe per 15 s of runtime, measured: on a dense drum & bass set (64 tracks
// in 61 minutes, so ~57 s of play each), going from one-per-25 s to one-per-15 s
// took recall from 46.9% to 54.7% — and precision went UP, 85.7% to 87.5%. More
// evidence never costs precision here, because acceptance is decided by whether
// the audio's timing agrees (anchor.js), not by how many times a name appeared.
//
// Raising the cap is close to free on easy sets, because the scan stops as soon
// as coverage is proven rather than spending what it is given: that same run
// converged at 230 probes with 300 available. Short tracks are what needs the
// headroom — a play has to be seen twice to be proven at all.
const PROBE_SECONDS_PER_REQUEST = 15;
const MIN_PROBE_BUDGET = 60;
const MAX_PROBE_BUDGET = 340;

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
function decodeSlice(filePath, startSec, durSec, signal) {
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
 * continuum to expose here, so the setting is reduced to the decision it was
 * actually making: is a single proven play enough, or must an unproven one
 * accumulate several consistent sightings?
 */
function acceptOptionsFor(settings) {
  const v = Number(settings && settings.recognizerMinConfidence);
  const level = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 60;
  if (level >= 80) return { minUnprovenHits: Infinity };   // proven plays only
  if (level <= 30) return { minUnprovenHits: 2 };
  return { minUnprovenHits: 3 };
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
function newProbeState() {
  return {
    lastRequestAt: 0, consecutiveRateLimits: 0, networkFailures: 0, lastNetworkError: '', requests: 0,
  };
}

/**
 * One probe, with pacing and 429 retry.
 *
 * Always returns an observation — a no-match is an observation too, and the
 * adaptive scan needs it to know a region is silent rather than unvisited.
 */
async function probeMoment(state, audioPath, t, signal) {
  let obs = { t, trackKey: null, matches: [] };
  for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    const wait = REQUEST_GAP_MS - (Date.now() - state.lastRequestAt);
    if (wait > 0) await sleep(wait, signal);
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');

    let res;
    try {
      const pcm = await decodeSlice(audioPath, t, PROBE_SEC, signal);
      if (pcm.length < SAMPLE_RATE) break;              // too short to fingerprint
      res = await lookup(pcm, signal);
    } catch (_) {
      break;                                            // a bad probe never aborts the scan
    }
    state.lastRequestAt = Date.now();
    state.requests++;

    if (res && res.aborted) throw new Error('Extraction cancelled.');
    if (res && res.rateLimited) {
      state.consecutiveRateLimits++;
      if (state.consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
        throw new Error('Shazam is rate-limiting this machine and did not recover. Wait a few minutes and try again.');
      }
      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1), signal);
      continue;                                         // retry this same moment
    }
    state.consecutiveRateLimits = 0;

    if (res && res.networkError) {
      state.networkFailures++;
      state.lastNetworkError = res.message || '';
      break;
    }
    if (res && res.track) obs = { t, ...res.track, matches: res.matches };
    break;
  }
  return obs;
}

async function runtimeOf(audioPath, durationSec) {
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
  }
  observations.sort((a, b) => a.t - b.t);
  return { observations, matchedCount: observations.filter((o) => o.trackKey).length };
}

export async function recognize(audioPath, { settings, signal, onProgress, durationSec, seedObservations } = {}) {
  const total = await runtimeOf(audioPath, durationSec);
  if (total < 2) throw new Error('Could not determine the length of this set — cannot scan it.');

  const maxProbes = Math.max(MIN_PROBE_BUDGET,
    Math.min(MAX_PROBE_BUDGET, Math.round(total / PROBE_SECONDS_PER_REQUEST)));

  const observations = [];
  const spent = new Set();
  const state = newProbeState();

  // Reuse anything the spot check already paid for. Those probes are ordinary
  // observations and the bisection reads them exactly like its own seed grid.
  for (const o of (seedObservations || [])) {
    if (!o || typeof o.t !== 'number' || spent.has(o.t)) continue;
    spent.add(o.t);
    observations.push(o);
  }
  observations.sort((a, b) => a.t - b.t);

  const emit = () => { if (onProgress) onProgress({ done: spent.size, total: maxProbes }); };
  emit();

  const probeAt = async (rawT) => {
    const t = Math.max(1, Math.min(total - PROBE_SEC - 1, Math.round(rawT)));
    if (spent.has(t)) return null;
    spent.add(t);

    const obs = await probeMoment(state, audioPath, t, signal);
    observations.push(obs);
    observations.sort((a, b) => a.t - b.t);
    emit();
    return obs;
  };

  // ── Seed a coarse grid ──────────────────────────────────────────────
  for (let t = Math.min(30, total / 2); t < total - 20 && spent.size < maxProbes; t += SEED_STEP_SEC) {
    await probeAt(t);
  }

  // ── Bisect until coverage is proven or the budget runs out ──────────
  while (spent.size < maxProbes) {
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    let best = null;
    const consider = (width, mid, floor, weight) => {
      if (width < floor) return;
      const priority = width * weight;
      if (!best || priority > best.priority) best = { priority, mid };
    };
    for (let i = 0; i < observations.length - 1; i++) {
      const a = observations[i];
      const b = observations[i + 1];
      if (proves(a, b)) continue;                         // nothing can hide here
      const silent = !a.trackKey && !b.trackKey;
      consider(b.t - a.t, (a.t + b.t) / 2,
        silent ? MIN_GAP_SILENT_SEC : MIN_GAP_CONFUSED_SEC,
        silent ? SILENT_PRIORITY : 1);
    }
    if (observations.length) {
      consider(observations[0].t, observations[0].t / 2, MIN_GAP_CONFUSED_SEC, 1);
      const lastT = observations[observations.length - 1].t;
      consider(total - lastT, (lastT + total) / 2, MIN_GAP_CONFUSED_SEC, 1);
    }
    if (!best) break;                                     // fully resolved
    if (await probeAt(best.mid) === null) break;          // midpoint already spent
  }

  // Every probe failing to even reach Shazam is an outage, not an unrecognisable
  // set. Say so, instead of handing back an empty tracklist the user would read
  // as "none of my tracks are known".
  if (state.requests > 0 && state.networkFailures >= state.requests) {
    throw new Error(`Couldn't reach Shazam — all ${state.requests} lookups failed${state.lastNetworkError ? ` (${state.lastNetworkError})` : ''}. Check your connection.`);
  }

  const { tracks, plays, dropped } = tracklistFrom(observations, acceptOptionsFor(settings));

  const matched = observations.filter((o) => o.trackKey).length;
  console.log(`[SetEngine] Shazam: ${observations.length} probes over ${Math.round(total / 60)} min `
    + `(${matched} matched) → ${plays.length} plays → ${tracks.length} track(s)`
    + `${dropped.length ? `, ${dropped.length} sighting(s) dropped as contradicted` : ''}.`);

  if (onProgress) onProgress({ done: maxProbes, total: maxProbes });
  return { tracks };
}
