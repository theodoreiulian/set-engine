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
// MACHINE-wide ON PURPOSE. The limit is per machine, so per-run pacing is not
// pacing at all: three parallel extractions each waiting their own 3 s emitted a
// request every second, throttled each other, and all three died with "Shazam is
// rate-limiting this machine and did not recover". Every lookup — spot check and
// full scan, every job, and every *other* SetEngine process (a second window, an
// eval capture run) — now shares one queue, one adaptive gap and one shared
// reservation. Never add a request path that bypasses acquireShazamSlot().

import { net } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { signatureFor } from './signature.js';
import { tracklistFrom, proves } from './anchor.js';
import { acquireShazamSlot, noteShazamAnswered, noteShazamRateLimited, shazamGateStatus } from './rate-gate.js';

// Shazam's signature generator expects 16 kHz mono; feeding it that directly
// avoids an internal resample.
const SAMPLE_RATE = 16000;

// Sample length per probe. Shazam matches from 3–12 s. Measured on hard material
// (regions where 8 s returned nothing): 16 s and 26 s returned nothing either,
// on every one of 10 points. Longer windows do not rescue unrecognisable audio,
// and they straddle transitions — at 12 s two probes near a mix point returned
// the *neighbouring* track. So 8 s, deliberately.
const PROBE_SEC = 8;

// Attempts per probe before the moment is given up as unheard. Pacing and
// backoff between attempts are the gate's job (rate-gate.js) — by the last
// attempt the shared cooldown is tens of seconds, so this is a genuinely
// patient retry, not a burst.
const MAX_PROBE_ATTEMPTS = 6;

// Circuit breaker. If this many probes IN A ROW go unheard — that is, 3 × 6
// throttled attempts spanning minutes of shared backoff — the endpoint isn't
// pacing us, it's refusing us, and grinding through a 340-probe budget at that
// rate would take hours. Stop and report on what was heard: a partial scan (or
// a published tracklist that no longer gets second-guessed) beats a job that
// hangs. Measured recovery is seconds, so reaching this is genuinely abnormal.
const MAX_CONSECUTIVE_UNHEARD = 3;

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

// Per-run tallies. Pacing itself is NOT here — it is machine-wide, in
// rate-gate.js. What a run still needs to know is whether it ever got a real
// answer, because a scan that was refused end to end must say so rather than
// hand back an empty tracklist (see the guard at the end of `recognize`).
function newProbeState() {
  return {
    attempts: 0,        // lookups actually sent
    answered: 0,        // lookups that came back with something other than a 429
    rateLimited: 0,     // 429/5xx responses
    unheard: 0,         // probes given up after MAX_PROBE_ATTEMPTS
    consecutiveUnheard: 0,
    networkFailures: 0,
    lastNetworkError: '',
  };
}

/**
 * One probe, with pacing and 429 retry.
 *
 * Returns an observation — a no-match is an observation too, and the adaptive
 * scan needs it to know a region is silent rather than unvisited. The one
 * exception is a moment we never actually heard because every attempt was
 * throttled: that comes back flagged `unheard`, and callers must NOT feed it to
 * the scan as evidence. "Shazam wouldn't answer" and "nothing recognisable is
 * playing here" look identical in the result shape and mean opposite things —
 * treating the first as the second tells the bisection a region is silent, and
 * silence is exactly what it stops probing (MIN_GAP_SILENT_SEC).
 */
async function probeMoment(state, audioPath, t, signal) {
  const obs = { t, trackKey: null, matches: [] };

  // Decoded once, before queueing for a slot: fingerprinting is local and free,
  // and a retry re-sends the same signature rather than re-running ffmpeg. A
  // slot is a scarce, machine-wide resource — don't hold one to decode.
  let pcm;
  try {
    pcm = await decodeSlice(audioPath, t, PROBE_SEC, signal);
  } catch (_) {
    return obs;                                         // a bad probe never aborts the scan
  }
  if (pcm.length < SAMPLE_RATE) return obs;             // too short to fingerprint

  let throttled = false;
  for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    await acquireShazamSlot(signal);                    // machine-wide pacing

    let res;
    try {
      res = await lookup(pcm, signal);
    } catch (_) {
      return obs;
    }
    state.attempts++;

    if (res && res.aborted) throw new Error('Extraction cancelled.');
    if (res && res.rateLimited) {
      // Tell the gate, then simply ask for another slot. The backoff is shared,
      // so every other job in this process waits it out too — which is the only
      // way a machine-wide limit ever clears while several jobs are running.
      state.rateLimited++;
      throttled = true;
      noteShazamRateLimited();
      continue;                                         // retry this same moment
    }
    if (res && res.networkError) {
      // Not an answer: the request never reached the endpoint, so it says
      // nothing about pacing and must NOT count towards `answered` — the
      // run-level guard uses `answered === 0` to catch a total outage.
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

  // Every attempt was throttled. That moment is unheard, not fatal — the scan
  // carries on, and the run-level guard decides what a *whole run* of unheard
  // probes means.
  if (throttled) { state.unheard++; state.consecutiveUnheard++; }
  return { ...obs, unheard: throttled };
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
    if (state.consecutiveUnheard >= MAX_CONSECUTIVE_UNHEARD) break;   // refused, not paced
  }
  const heard = observations.filter((o) => !o.unheard).sort((a, b) => a.t - b.t);
  if (state.unheard) {
    console.warn(`[SetEngine] Shazam spot check: ${state.unheard} of ${points} probes went unheard (throttled). `
      + `Gate now at ${shazamGateStatus().gapMs} ms.`);
  }
  return {
    // Only moments we actually heard. Everything downstream — the agreement
    // score, and the seeds handed to the full scan — must see a throttled probe
    // as one that never happened.
    observations: heard,
    matchedCount: heard.filter((o) => o.trackKey).length,
    // A spot check that never got an answer proves nothing, so the caller must
    // not read "no probe named a listed track" as "the tracklist is wrong".
    answered: state.answered,
  };
}

export async function recognize(audioPath, { settings, signal, onProgress, durationSec, seedObservations } = {}) {
  const total = await runtimeOf(audioPath, durationSec);
  if (total < 2) throw new Error('Could not determine the length of this set — cannot scan it.');

  const maxProbes = Math.max(MIN_PROBE_BUDGET,
    Math.min(MAX_PROBE_BUDGET, Math.round(total / PROBE_SECONDS_PER_REQUEST)));

  const observations = [];
  const spent = new Set();
  const unheardAt = new Set();      // spent, but throttled — no observation recorded
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

  // A spent midpoint normally means the scan can make no further progress here
  // and the caller stops — unchanged. The exception is a midpoint that was spent
  // on an UNHEARD probe: it recorded no observation, so the gap it was meant to
  // split is still open and the bisection will keep choosing the same point. One
  // throttled probe would therefore end the whole scan. In that case only, step
  // outwards (within a quarter of the gap) for a second we haven't tried.
  const probeAt = async (rawT, spread = 0) => {
    const lo = 1;
    const hi = Math.max(1, total - PROBE_SEC - 1);
    const centre = Math.max(lo, Math.min(hi, Math.round(rawT)));
    let t = centre;
    if (spent.has(t)) {
      if (!unheardAt.has(t)) return null;
      const reach = Math.floor(Math.min(spread / 4, 15));
      let found = null;
      for (let d = 1; d <= reach && found === null; d++) {
        for (const cand of [centre - d, centre + d]) {
          if (cand >= lo && cand <= hi && !spent.has(cand)) { found = cand; break; }
        }
      }
      if (found === null) return null;
      t = found;
    }
    spent.add(t);

    const obs = await probeMoment(state, audioPath, t, signal);
    emit();
    // Throttled: `t` stays spent (so a refusing endpoint can't spin the
    // bisection forever on the same midpoint) but the moment is not recorded —
    // the gap stays unproven and the scan will look at a nearby point instead.
    if (obs.unheard) { unheardAt.add(t); return obs; }
    observations.push(obs);
    observations.sort((a, b) => a.t - b.t);
    return obs;
  };

  // ── Seed a coarse grid ──────────────────────────────────────────────
  const refused = () => state.consecutiveUnheard >= MAX_CONSECUTIVE_UNHEARD;
  for (let t = Math.min(30, total / 2); t < total - 20 && spent.size < maxProbes; t += SEED_STEP_SEC) {
    await probeAt(t);
    if (refused()) break;
  }

  // ── Bisect until coverage is proven or the budget runs out ──────────
  while (spent.size < maxProbes && !refused()) {
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    let best = null;
    const consider = (width, mid, floor, weight) => {
      if (width < floor) return;
      const priority = width * weight;
      if (!best || priority > best.priority) best = { priority, mid, width };
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
    if (await probeAt(best.mid, best.width) === null) break;   // gap fully spent
  }

  // Every probe failing to get an answer is an outage, not an unrecognisable
  // set. Say so, instead of handing back an empty tracklist the user would read
  // as "none of my tracks are known". Note this fires only when the run got
  // NOTHING back across every probe and every retry — ordinary throttling is
  // absorbed by the gate and costs time, not results.
  if (refused()) {
    console.warn(`[SetEngine] Shazam stopped answering: ${state.unheard} probes unheard in a row after `
      + `${state.rateLimited} rate-limited attempts. Reporting what was heard (${state.answered} answered lookups).`);
  }

  if (state.attempts > 0 && state.answered === 0) {
    if (state.rateLimited > state.networkFailures) {
      throw new Error(`Shazam refused all ${state.attempts} lookups from this network. Nothing was recognized — try again later, or use a set whose uploader published a tracklist.`);
    }
    throw new Error(`Couldn't reach Shazam — all ${state.attempts} lookups failed${state.lastNetworkError ? ` (${state.lastNetworkError})` : ''}. Check your connection.`);
  }

  const { tracks, plays, dropped } = tracklistFrom(observations, acceptOptionsFor(settings));

  const matched = observations.filter((o) => o.trackKey).length;
  console.log(`[SetEngine] Shazam: ${observations.length} probes over ${Math.round(total / 60)} min `
    + `(${matched} matched) → ${plays.length} plays → ${tracks.length} track(s)`
    + `${dropped.length ? `, ${dropped.length} sighting(s) dropped as contradicted` : ''}`
    + `${state.unheard ? `. ${state.unheard} probe(s) went unheard (throttled)` : ''}.`);

  if (onProgress) onProgress({ done: maxProbes, total: maxProbes });
  return { tracks };
}
