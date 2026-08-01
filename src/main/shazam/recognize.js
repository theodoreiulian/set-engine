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
// There is no fallback engine any more, so if this endpoint dies, audio
// recognition dies with it and Set Extraction degrades to published tracklists
// only (tracklist-sources.js) — which still covers a large share of DJ sets.
//
// ── Rate limiting is the design constraint ────────────────────────────
// Measured against the live endpoint: ~15 requests go through in a burst, then
// it returns 429 with no Retry-After header; one request per ~4 s sustains
// indefinitely (18/18 succeeded); a ~90 s pause clears a block. Everything below
// is shaped by that — requests are strictly serialized with a fixed gap, and
// segmenter.js exists so a 90-minute set costs ~40 requests instead of ~180.

import { net } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { decodePcm } from '../audio-analyzer.js';
import { findProbePoints } from '../segmenter.js';
import { signatureFor } from './signature.js';
import { cleanTitle, primaryArtist } from '../bpm-sources.js';

// Shazam's signature generator expects 16 kHz mono; feeding it that directly
// avoids an internal resample.
const SAMPLE_RATE = 16000;

// Sample length per probe. Shazam matches from 3–12 s. Measured: a track pitched
// +6% failed to match at 6 s and 7 s but matched at 8 s, so the extra couple of
// seconds is what carries borderline material. Costs nothing but a slightly
// larger signature — the request count, which is the real constraint, is
// unchanged.
const PROBE_SEC = 8;

// Measured sustainable spacing. Do not lower this without re-measuring — the
// endpoint's limiter is unforgiving and there is no header to negotiate with.
const REQUEST_GAP_MS = 4000;

// A 429 means the bucket is empty. Measured recovery was ~90 s.
const RATE_LIMIT_COOLDOWN_MS = 60000;
const MAX_RATE_LIMIT_RETRIES = 3;

// Ceiling on requests for one set: 80 × 4 s ≈ 5.5 minutes of scanning.
const MAX_PROBES = 80;

// Shazam returns no numeric score — a result is simply present or absent, having
// already passed Shazam's own internal threshold. So confidence is derived from
// corroboration instead: one probe naming a track is good evidence, two
// independent probes naming it is much stronger. With the default
// recognizerMinConfidence of 60 both are kept; raising it to 80 demands that a
// track be seen twice before it makes the tracklist.
const SCORE_SINGLE = 70;
const SCORE_CORROBORATED = 95;
// A hit obtained *only* by pitch-correcting the query is weaker evidence than a
// plain one: correction deliberately re-sends distorted audio, and distorted
// audio is exactly what makes a recognizer volunteer a confident wrong title
// (measured during tuning — pitched queries returned unrelated tracks by name).
// So an uncorroborated correction-only hit scores below the default floor: kept
// in the data, dropped from the tracklist unless the user lowers the threshold.
const SCORE_CORRECTED_SINGLE = 55;

// Playback-rate corrections retried when a probe comes back empty.
//
// Shazam absorbs a *linked* pitch/tempo change (the turntable case) over roughly
// −6%…+6% on its own, and handles keylock (tempo-only) across the whole fader
// range. Past that it starts returning nothing — or, worse, a confident wrong
// title. Measured: a track played at −8% was unidentifiable at four different
// points in the track, but re-sending the same audio resampled by ×1.06 or
// ×1.08 identified it correctly every time.
//
// So when a probe finds nothing, re-read it at a corrected rate before giving
// up. These two values cover the ends of a standard ±8% fader given the native
// tolerance in the middle. This is the same multiple-hypothesis idea the old
// local fingerprint engine used, applied sparingly here because each hypothesis
// costs a rate-limited request.
const PITCH_CORRECTIONS = [1.06, 0.94];

// Ceiling on *extra* requests spent on corrections across one set, so a set full
// of genuinely unknown tracks (every probe a no-match) can't double the scan.
const MAX_PITCH_RETRIES = 24;

// User-configured confidence floor (0–100), clamped, defaulting to 60. Lived in
// recognizers/util.js while three engines shared it; now that Shazam is the only
// one, it lives with the only code that applies it.
function minConfidenceOf(settings) {
  const v = Number(settings && settings.recognizerMinConfidence);
  if (!Number.isFinite(v)) return 60;
  return Math.min(100, Math.max(0, v));
}

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

// Probe duration is bounded, so decoding a slice per probe (rather than holding
// the whole set at 16 kHz twice) keeps memory flat on long sets.
function decodeSlice(filePath, startSec, durSec, signal, rate = 1) {
  return new Promise((resolve, reject) => {
    // `rate` re-times the slice to undo a DJ's pitch fader. Resample to a known
    // rate FIRST, then relabel: asetrate applied straight to the decoded stream
    // would be relative to the file's own sample rate, which mangles the audio
    // by whatever ratio that happens to be (a bug this went through once).
    const filter = rate === 1 ? [] :
      ['-af', `aresample=${SAMPLE_RATE},asetrate=${Math.round(SAMPLE_RATE * rate)}`];
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-ss', String(startSec),
      '-t', String(durSec),
      '-i', filePath,
      ...filter,
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

// One lookup. Returns { track } on a match, null on a clean no-match,
// { rateLimited: true } so the caller can back off, or { networkError: true }
// so a dead endpoint is never mistaken for silence.
async function lookup(pcm, signal) {
  const { uri, samplems } = signatureFor(pcm, SAMPLE_RATE);

  // `net.fetch`, NOT the global `fetch`. This is not stylistic: Shazam's edge
  // silently blackholes connections from Node's undici client — every request
  // dies on a connect timeout after ~10 s — while the identical request through
  // Chromium's network stack returns 200 in ~270 ms. (Verified side by side; the
  // a control host on the same machine answered fine over undici, so undici
  // isn't broken — this host just refuses it.) net.fetch is fetch-compatible, honours
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
    if (err && err.name === 'AbortError') return null;
    // Distinguished from a clean no-match on purpose. Silently treating an
    // unreachable endpoint as "nothing playing here" is how a total outage
    // disguises itself as an empty tracklist — which is exactly what happened
    // while this recognizer was on the wrong fetch implementation.
    return { networkError: true, message: err && err.message };
  }

  if (res.status === 429 || res.status >= 500) return { rateLimited: true };
  if (!res.ok) return null;

  let json;
  try { json = await res.json(); } catch (_) { return null; }
  if (!json || !json.track || !json.track.title) return null;

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
      title: String(t.title).trim(),
      artist: String(t.subtitle || '').trim(),
      album: album.trim(),
    },
  };
}

// Reject candidates that are *bracketed* by a stronger one.
//
// A recognizer answering "different song" is not the same as "a different song
// is playing". Sections of one track routinely match a *different* record —
// shared sample packs, recycled loops, remix families, and sparse breakdowns
// that carry little unique information. Measured on a real single-track upload:
// sweeping the song every 12 s returned the correct title 13 times and a
// completely unrelated track 3 times, always at the same sections. Because that
// confusion is section-locked rather than random, it *repeats*, so corroboration
// endorses it — the wrong track scored 95, higher than a genuine single hit.
//
// The structural fact that separates the two cases: in a mix, a track occupies a
// contiguous stretch of time. A DJ does not play A, B, A, B, A. So if candidate
// Y has hits both before and after every hit of candidate X, and Y is the
// stronger of the two, X is a misreading of Y's audio rather than a record that
// was actually played.
//
// The trade: a track genuinely played for a moment *between* two plays of
// another track is dropped too. That's rare (and set-extractor.js already merges
// repeat plays of the same track), whereas the failure above is common — this is
// the same precision-over-recall call the segment-length floor made in the
// previous engine.
function dropEnclosed(found) {
  const list = [...found.entries()].map(([key, v]) => ({ key, ...v }));
  const dropped = [];
  for (const x of list) {
    const encloser = list.find((y) => y !== x
      && y.firstAt < x.firstAt
      && y.lastAt > x.lastAt
      && y.hits > x.hits);
    if (encloser) dropped.push({ x, encloser });
  }
  for (const { x, encloser } of dropped) {
    console.log(`[SetEngine] Shazam: dropped "${x.artist} — ${x.title}" (${x.hits} hit(s) at ${x.firstAt}–${x.lastAt}s) `
      + `— it sits inside "${encloser.artist} — ${encloser.title}" (${encloser.hits} hits at ${encloser.firstAt}–${encloser.lastAt}s), `
      + `which isn't how a mix is played.`);
    found.delete(x.key);
  }
  return dropped.length;
}

function identityKey(artist, title) {
  const a = primaryArtist(artist || '').toLowerCase();
  const t = cleanTitle(title || '').toLowerCase();
  return `${a} ${t}`.replace(/\s+/g, ' ').trim();
}

export async function recognize(audioPath, { settings, signal, onProgress } = {}) {
  const emit = (done, total) => { if (onProgress) onProgress({ done, total }); };
  emit(0, 1);

  // One full decode drives segmentation; probes re-decode their own short slice.
  const pcm = await decodePcm(audioPath, SAMPLE_RATE);
  if (signal && signal.aborted) throw new Error('Extraction cancelled.');

  const { probes } = findProbePoints(pcm, SAMPLE_RATE, { maxProbes: MAX_PROBES });
  const durationSec = Math.floor(pcm.length / SAMPLE_RATE);

  const found = new Map();   // identity → { title, artist, album, offsetSec, hits }
  let rateLimitRetries = 0;
  let networkFailures = 0;
  let lastNetworkError = '';
  let done = 0;
  let pitchRetries = 0;
  // A DJ tends to hold a similar pitch across a set, so once a correction works
  // it is tried first next time — usually turning two extra requests into one.
  let preferredCorrection = null;

  for (const at of probes) {
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');

    const probeDur = Math.min(PROBE_SEC, Math.max(3, durationSec - at));
    let result = null;
    let usedCorrection = false;
    try {
      const slice = await decodeSlice(audioPath, at, probeDur, signal);
      if (slice.length >= SAMPLE_RATE) result = await lookup(slice, signal);
    } catch (_) {
      result = null;                                // one bad probe never aborts the scan
    }

    // Empty answer, and there's budget left: the track may simply be pitched
    // further than Shazam tolerates. Re-read this same moment at a corrected
    // rate. Only a clean no-match qualifies — retrying a rate-limited or
    // unreachable probe would just burn the budget on a problem correction
    // can't fix.
    if (result === null && pitchRetries < MAX_PITCH_RETRIES && !(signal && signal.aborted)) {
      const order = preferredCorrection
        ? [preferredCorrection, ...PITCH_CORRECTIONS.filter((c) => c !== preferredCorrection)]
        : PITCH_CORRECTIONS;
      for (const correction of order) {
        if (pitchRetries >= MAX_PITCH_RETRIES || (signal && signal.aborted)) break;
        pitchRetries++;
        await sleep(REQUEST_GAP_MS, signal);
        try {
          const slice = await decodeSlice(audioPath, at, probeDur, signal, correction);
          if (slice.length >= SAMPLE_RATE) result = await lookup(slice, signal);
        } catch (_) { result = null; }
        if (result && result.track) { preferredCorrection = correction; usedCorrection = true; break; }
        if (result && (result.rateLimited || result.networkError)) break;
        result = null;
      }
    }

    if (result && result.rateLimited) {
      rateLimitRetries++;
      if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        throw new Error('Shazam is rate-limiting this machine and did not recover. Wait a few minutes and try again, or switch the engine in Settings.');
      }
      console.warn(`[SetEngine] Shazam rate-limited; pausing ${RATE_LIMIT_COOLDOWN_MS / 1000}s (retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}).`);
      await sleep(RATE_LIMIT_COOLDOWN_MS, signal);
      if (signal && signal.aborted) throw new Error('Extraction cancelled.');
      continue;                                     // re-probing this point isn't worth another slot
    }

    if (result && result.networkError) {
      networkFailures++;
      lastNetworkError = result.message || '';
    }

    if (result && result.track) {
      const key = identityKey(result.track.artist, result.track.title);
      const prior = found.get(key);
      if (prior) {
        prior.hits++;
        if (!usedCorrection) prior.plainHits++;
        prior.offsetSec = Math.min(prior.offsetSec, at);
        prior.firstAt = Math.min(prior.firstAt, at);
        prior.lastAt = Math.max(prior.lastAt, at);
      } else {
        found.set(key, { ...result.track, offsetSec: at, hits: 1, firstAt: at, lastAt: at, plainHits: usedCorrection ? 0 : 1 });
      }
    }

    done++;
    emit(done, probes.length);
    if (done < probes.length) await sleep(REQUEST_GAP_MS, signal);
  }

  // Every probe failing to even reach Shazam is an outage, not an unrecognizable
  // set. Say so, instead of handing back an empty tracklist the user would read
  // as "none of my tracks are known".
  if (found.size === 0 && networkFailures >= probes.length && probes.length > 0) {
    throw new Error(`Couldn't reach Shazam — all ${probes.length} lookups failed${lastNetworkError ? ` (${lastNetworkError})` : ''}. Check your connection, or switch the engine in Settings.`);
  }

  // Structural filtering first: an enclosed candidate is implausible regardless
  // of how confident it looks, so it must not survive on score alone.
  const enclosed = dropEnclosed(found);

  const minConfidence = minConfidenceOf(settings);
  const scored = [...found.values()]
    .sort((a, b) => a.offsetSec - b.offsetSec)
    .map((t) => ({
      title: t.title,
      artist: t.artist,
      album: t.album,
      offsetSec: t.offsetSec,
      score: t.hits >= 2 ? SCORE_CORROBORATED
        : (t.plainHits > 0 ? SCORE_SINGLE : SCORE_CORRECTED_SINGLE),
    }));
  const tracks = scored.filter((t) => t.score >= minConfidence);

  const dropped = scored.length - tracks.length;
  console.log(`[SetEngine] Shazam: ${probes.length} probes (+${pitchRetries} pitch-corrected) over `
    + `${Math.round(durationSec / 60)} min → ${tracks.length} track(s)`
    + `${enclosed > 0 ? `, ${enclosed} dropped as enclosed` : ''}`
    + `${dropped > 0 ? `, ${dropped} below the confidence floor of ${minConfidence}` : ''}.`);
  emit(probes.length, probes.length);
  return { tracks };
}
