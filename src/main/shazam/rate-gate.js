// SetEngine — machine-wide pacing for Shazam lookups
//
// ── Why this exists ───────────────────────────────────────────────────
// Shazam's limit is per *machine* (per source IP). Pacing used to be per *run*:
// `newProbeState()` gave every scan its own `lastRequestAt`, so the measured-safe
// 3 s gap was only ever honoured by one job in isolation. Run the three
// extractions the job manager allows in parallel and the machine emits a request
// every ~1 s — a rate the endpoint was measured to refuse. Each job then counted
// its own 429s, hit MAX_CONSECUTIVE_RATE_LIMITS, and died with "Shazam is
// rate-limiting this machine and did not recover". All three failed at once,
// which is the giveaway: they were rate-limiting *each other*.
//
// So the gap belongs to the machine, not to the scan — and "the machine" is the
// operative word twice over:
//
//   1. Every lookup in this process — spot check and full scan, across every
//      concurrent job — passes through the single FIFO here.
//   2. Every lookup in *other* SetEngine processes passes through the same
//      reservation, held in a small shared state file. A second app window, a
//      dev build running beside a packaged one, or `scripts/eval` capturing a
//      corpus in a separate node process are all invisible to an in-process
//      queue but perfectly visible to Shazam, which sees one IP.
//
// Three jobs no longer emit 3× the requests; they share one measured-safe stream
// and each takes proportionally longer, which is the honest trade when the limit
// is machine-wide.
//
// ── And when we are throttled anyway ──────────────────────────────────
// A 429 seen by one job is information for *all* of them: the machine is over
// the line. Backing off locally (what the old code did) left the other jobs
// hammering away, so the block never cleared. Here a 429 widens the shared gap
// and parks a shared cooldown, so everything slows down together and then eases
// back after a sustained run of clean answers.
//
// ── Fail-soft, always ─────────────────────────────────────────────────
// The cross-process half is a best-effort optimisation layered on a correct
// in-process queue. Every filesystem operation is wrapped: if the state file
// can't be read, written or locked, pacing silently degrades to this process
// only — which is exactly the behaviour we'd have without it. Nothing here may
// throw, and nothing here may block indefinitely; a recognition scan must never
// hang on a lock.

import { mkdirSync, rmdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Measured sustainable spacing: 34/34 clean at 3 s, while a 2 s gap drew 429s.
const BASE_GAP_MS = 3000;

// Ceiling on the adaptive gap. Beyond this we are not being throttled, we are
// being refused, and waiting longer buys nothing.
const MAX_GAP_MS = 20000;

const GAP_GROWTH = 1.6;
const GAP_EASE = 0.8;

// Clean answers required before the gap is allowed to narrow again. High enough
// that one lucky response after a 429 doesn't undo the backoff.
const EASE_AFTER_CLEAN = 8;

// Shared cooldown parked on a 429, doubling per consecutive 429. Measured
// recovery is a few seconds, so the first step is deliberately small; the cap
// bounds how long a genuinely refusing endpoint can stall a scan before the
// caller's circuit breaker gives up on it.
const COOLDOWN_BASE_MS = 4000;
const MAX_COOLDOWN_MS = 30000;

// ── Cross-process state ───────────────────────────────────────────────
// Deliberately NOT under Electron's userData: `scripts/eval` runs the recognizer
// in a plain node process with no `app`, and it is one of the things that must
// share this stream. The home directory is the one location every SetEngine
// process agrees on without importing electron.
const STATE_DIR = (() => {
  try {
    const dir = path.join(os.homedir(), '.setengine');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (_) {
    try { return os.tmpdir(); } catch (_e) { return null; }
  }
})();
const STATE_PATH = STATE_DIR && path.join(STATE_DIR, 'shazam-gate.json');
const LOCK_PATH = STATE_DIR && path.join(STATE_DIR, 'shazam-gate.lock');

// A lock older than this belonged to a process that died holding it. Short,
// because everything done under the lock is a couple of sync file operations.
const LOCK_STALE_MS = 5000;

// How long to contend for the lock before giving up and proceeding anyway. This
// is deliberately tiny: the wait is a synchronous spin (it has to be — the
// critical section is a read followed by a write, and letting this process's
// event loop run in between would defeat it), and this code runs on Electron's
// MAIN thread, where a long spin is a frozen window. Losing the lock costs at
// worst one mistimed request inside a 3 s window; freezing the UI to avoid that
// would be a far worse trade.
const LOCK_WAIT_MS = 120;

// State written by a process that has since exited says nothing about now.
const STATE_STALE_MS = 5 * 60 * 1000;

let gapMs = BASE_GAP_MS;
let nextAllowedAt = 0;
let consecutiveRateLimits = 0;
let consecutiveClean = 0;
let waiting = 0;
let sharedState = STATE_PATH ? 'unknown' : 'disabled';   // for diagnostics

// Tail of the FIFO of slot requests. Only slot *acquisition* is serialized —
// the lookups themselves overlap in flight, so one slow request can't stall the
// queue behind it. What is guaranteed is that two lookups never *start* closer
// together than `gapMs`, which is what the endpoint actually measures.
let queueTail = Promise.resolve();

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

const now = () => Date.now();

/**
 * Run `fn` while holding the cross-process lock, if one can be had.
 *
 * `mkdir` is the atomic primitive here: it either creates the directory or
 * fails, with no window in between, and it needs no dependencies. If the lock
 * can't be acquired within LOCK_WAIT_MS the work runs anyway — an occasional
 * interleaved read/write costs at worst one mistimed request, whereas blocking
 * a scan on a lock would be a real bug.
 */
function withLock(fn) {
  if (!LOCK_PATH) return fn();
  const deadline = now() + LOCK_WAIT_MS;
  let held = false;
  while (now() < deadline) {
    try {
      mkdirSync(LOCK_PATH);
      held = true;
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') break;          // not a contention problem
      try {
        const age = now() - statSync(LOCK_PATH).mtimeMs;
        if (age > LOCK_STALE_MS) { rmdirSync(LOCK_PATH); continue; }   // holder died
      } catch (_) { /* vanished under us — just retry */ }
      // Busy-wait, briefly. Sync on purpose (see LOCK_WAIT_MS), and bounded by
      // it, so the worst case here is ~120 ms rather than an unbounded stall.
      const until = now() + 10;
      while (now() < until) { /* spin */ }
    }
  }
  try {
    return fn();
  } finally {
    if (held) { try { rmdirSync(LOCK_PATH); } catch (_) { /* already gone */ } }
  }
}

function readShared() {
  if (!STATE_PATH) return null;
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (!raw || typeof raw.updatedAt !== 'number') return null;
    if (now() - raw.updatedAt > STATE_STALE_MS) return null;
    sharedState = 'ok';
    return raw;
  } catch (err) {
    // ENOENT on first run is normal, not a failure worth reporting.
    sharedState = (err && err.code === 'ENOENT') ? 'ok' : 'unavailable';
    return null;
  }
}

function writeShared(next) {
  if (!STATE_PATH) return;
  try {
    writeFileSync(STATE_PATH, JSON.stringify({ ...next, updatedAt: now(), pid: process.pid }));
    sharedState = 'ok';
  } catch (_) {
    sharedState = 'unavailable';
  }
}

/**
 * Reserve the next request slot, or report how long to wait for one.
 *
 * Returns 0 when the slot is taken (and the next one has been pushed out by
 * `gapMs`), or a positive number of milliseconds to sleep before asking again.
 * The reservation is written back to the shared file inside the same lock, so
 * two processes cannot both take the same instant.
 */
function tryReserve() {
  return withLock(() => {
    const shared = readShared();
    // The other process's figures win when they are stricter than ours: a 429 it
    // saw is a 429 this machine earned.
    if (shared) {
      // Clamped: no legitimate reservation is further out than one maximum gap
      // plus one maximum cooldown. A corrupt file, or a clock that jumped on
      // another machine sharing a synced home directory, could otherwise park
      // every process on this one for hours. Trust it, but bound it.
      const ceiling = now() + MAX_GAP_MS + MAX_COOLDOWN_MS;
      if (typeof shared.nextAllowedAt === 'number' && shared.nextAllowedAt > nextAllowedAt) {
        nextAllowedAt = Math.min(shared.nextAllowedAt, ceiling);
      }
      if (typeof shared.gapMs === 'number' && shared.gapMs > gapMs) {
        gapMs = Math.min(MAX_GAP_MS, shared.gapMs);
      }
    }
    const wait = nextAllowedAt - now();
    if (wait > 0) return wait;
    nextAllowedAt = now() + gapMs;
    writeShared({ nextAllowedAt, gapMs });
    return 0;
  });
}

/**
 * Wait for this machine's next Shazam request slot.
 *
 * Resolves when it is this caller's turn AND enough time has passed since the
 * last request anywhere on the machine. Throws if `signal` aborts while queued,
 * so cancelling a job doesn't leave it parked behind another job's backoff.
 */
export async function acquireShazamSlot(signal) {
  const prev = queueTail;
  let releaseNext;
  queueTail = new Promise((resolve) => { releaseNext = resolve; });

  waiting++;
  try {
    await prev;
    for (;;) {
      if (signal && signal.aborted) throw new Error('Extraction cancelled.');
      const wait = tryReserve();
      if (wait <= 0) return;
      // Re-checked in slices: another job — or another process — can push the
      // reservation out while we are already waiting, and we must honour it.
      await sleep(Math.min(wait, 1000), signal);
    }
  } finally {
    waiting--;
    releaseNext();
  }
}

/** A 429 (or 5xx): slow the whole machine down and park a shared cooldown. */
export function noteShazamRateLimited() {
  consecutiveRateLimits++;
  consecutiveClean = 0;
  gapMs = Math.min(MAX_GAP_MS, Math.round(gapMs * GAP_GROWTH));
  const cooldown = Math.min(
    MAX_COOLDOWN_MS,
    COOLDOWN_BASE_MS * (2 ** (consecutiveRateLimits - 1)),
  );
  // Jittered so several jobs that were throttled together don't resume in
  // lockstep and immediately re-trip the limit.
  const resumeAt = now() + cooldown + Math.floor(Math.random() * 500);
  if (resumeAt > nextAllowedAt) nextAllowedAt = resumeAt;
  withLock(() => {
    const shared = readShared();
    const sharedNext = shared && typeof shared.nextAllowedAt === 'number' ? shared.nextAllowedAt : 0;
    writeShared({ nextAllowedAt: Math.max(nextAllowedAt, sharedNext), gapMs });
  });
}

/** A real answer (match, no-match, or any non-429 status). */
export function noteShazamAnswered() {
  consecutiveRateLimits = 0;
  if (gapMs <= BASE_GAP_MS) { consecutiveClean = 0; return; }
  if (++consecutiveClean < EASE_AFTER_CLEAN) return;
  consecutiveClean = 0;
  gapMs = Math.max(BASE_GAP_MS, Math.round(gapMs * GAP_EASE));
  // Easing is published too, otherwise a single 429 would leave every other
  // process permanently slow until it happened to see a 429 of its own.
  withLock(() => writeShared({ nextAllowedAt, gapMs }));
}

/** For logging/diagnostics only. */
export function shazamGateStatus() {
  return {
    gapMs,
    waiting,
    consecutiveRateLimits,
    cooldownMs: Math.max(0, nextAllowedAt - now()),
    shared: sharedState,
  };
}
