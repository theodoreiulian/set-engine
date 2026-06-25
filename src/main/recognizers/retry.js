// SetEngine — recognizer HTTP retry helpers
//
// Song recognition hammers rate-limited third-party APIs: ACRCloud gets one
// small request per scan window (hundreds on a long set), AudD gets one large
// upload. Transient failures — HTTP 429 / 5xx, network blips, provider "slow
// down" codes — must never silently drop a track or throw away a whole scan.
// These primitives give callers abort-aware sleeping and exponential backoff
// with full jitter, so retries spread out instead of stampeding in lockstep.

// Parse an HTTP Retry-After header: either delta-seconds ("5") or an HTTP date.
// Returns seconds to wait, or null when absent/unparseable.
export function parseRetryAfter(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10));
  const when = Date.parse(s);
  if (!Number.isNaN(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
  return null;
}

// Resolve after `ms`. If `signal` aborts first, resolve *early* (don't reject):
// callers re-check `signal.aborted` right after awaiting, so a long backoff
// never delays cancellation and no AbortError has to be threaded through.
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(); return; }
    let onAbort;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 10000;

// Wait before retry attempt `n` (0-based): exponential (800 ms · 2ⁿ) capped at
// 10 s, with full jitter, but never shorter than a server-sent Retry-After hint.
export async function backoff(attempt, retryAfterSec, signal) {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  let ms = Math.random() * ceiling;
  if (retryAfterSec != null) ms = Math.max(ms, retryAfterSec * 1000);
  await sleep(ms, signal);
}
