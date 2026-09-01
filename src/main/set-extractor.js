// SetEngine — Set Extractor
//
// Orchestrates DJ-set tracklist extraction end to end:
//   1. Read the link's info (title + duration) via yt-dlp.
//   2. If the uploader already published a tracklist (chapters / timestamped
//      description lines), use it and skip straight to step 5 — it's exact,
//      free, and means the set never has to be downloaded at all.
//   3. Otherwise download the audio to a temp dir (128 kbps mono-ish MP3 —
//      recognition doesn't need 320, and a smaller file scans faster).
//   4. Hand the file to the Shazam recognizer, then merge consecutive duplicate
//      hits into the play-order tracklist.
// The temp file is always cleaned up, and the whole flow is cancellable via an
// AbortSignal. Progress is reported through `onProgress` as { phase, percent }.
//
// Honest scope: no fingerprinter recognizes *every* track in a mix — unreleased
// IDs, bootlegs, mashups and heavily-effected sections defeat all of them. This
// scans continuously and merges duplicates to get as close as the engine allows.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { recognize, spotCheck } from './shazam/recognize.js';
import { parsePublishedTracklist, splitArtistTitle, completenessOf } from './tracklist-sources.js';
import { lookupByVideoId } from './mixesdb.js';
import { resolveBestVideo } from './track-match.js';
import { verifyDownloadedAudio } from './download-verify.js';
import { mergeTracklists, spotCheckAgreement, identityKey } from './track-merge.js';

// Ceiling on the optional comment-fetching pass. It paginates a separate,
// slower endpoint, so it needs a bound — otherwise a stall would hang the job
// with no way out. Falling through to audio recognition costs minutes anyway,
// so waiting more than this to maybe avoid that is a bad trade.
const COMMENT_FETCH_TIMEOUT_MS = 90000;

// ── Spot check ────────────────────────────────────────────────────────
// How much evidence a complete-looking published tracklist has to survive.
// Below MIN_AGREEMENT the list is treated as partial and the full scan runs.
// Fewer than MIN_MATCHES matching probes is inconclusive, not damning: a set
// Shazam simply can't hear must not have its perfectly good chapter list thrown
// out because of it.
const SPOT_CHECK_POINTS = 12;
const SPOT_CHECK_MIN_MATCHES = 3;
const SPOT_CHECK_MIN_AGREEMENT = 0.5;

// A tracklist this sparse is almost certainly still missing tracks even after
// everything above. Surfaced to the user rather than hidden — their only clue
// that anything was wrong used to be a suspiciously short list.
//
// 5, not 12. A DJ set averaging more than five minutes a track is unusual —
// three is typical — and at 12 this never fired for the 55-minute set that came
// back with 9 tracks (6.1 min/track), so a half-empty result was presented as a
// finished one with no warning at all.
//
// It fires often now, and that is correct rather than noisy: measured on two
// full sets, a large share of what a scan misses is simply NOT IN SHAZAM'S
// CATALOG and never can be found. On an Anjunadeep show with a published chapter
// list, 4 of its 9 named tracks were returned by ZERO probes out of 426 — all of
// them the host's own label promos. On the HÖR set, 15 of 55 minutes produced no
// repeated name at all. No amount of probing or scoring recovers those, so the
// only honest thing left is to say the list is short and why.
const SPARSE_MINUTES_PER_TRACK = 5;

// Collapse all hits for the same track into a single entry, keeping the earliest
// offset. A DJ holds a track across many scan windows, and recognizers also
// re-report a track when it recurs later in the set or when an unrecognized
// window splits a run — every such duplicate is dropped, so each unique song
// appears exactly once (in first-played order).
function dedupeTracks(tracks) {
  const sorted = tracks.slice().sort((a, b) => (a.offsetSec || 0) - (b.offsetSec || 0));
  const out = [];
  const seen = new Set();
  for (const t of sorted) {
    if (!t || !t.title) continue;
    const key = identityKey(t.artist, t.title);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({
      artist: (t.artist || '').trim(),
      title: (t.title || '').trim(),
      album: (t.album || '').trim(),
      offsetSec: Math.max(0, Math.round(t.offsetSec || 0)),
      // Which source named this track. Carried through to the UI so a merged
      // tracklist shows, per row, whether a human wrote it or Shazam heard it.
      source: t.source || 'published',
      // How well the audio backs a recognized row ('proven' | 'likely' |
      // 'uncertain'; see shazam/anchor.js). Absent on published rows — a person
      // named those, so there is nothing to grade. This object is rebuilt field
      // by field, so anything not copied here never reaches the UI.
      confidence: t.confidence || null,
    });
  }
  return out;
}

// Locate the downloaded audio. yt-dlp's --audio-format mp3 yields "<id>.mp3";
// fall back to any matching file in case the muxer chose another container.
async function findDownloaded(tmpDir, id) {
  try {
    const files = await readdir(tmpDir);
    const exact = files.find((f) => f === `${id}.mp3`);
    if (exact) return path.join(tmpDir, exact);
    const any = files.find((f) => f.startsWith(`${id}.`) && /\.(mp3|m4a|opus|ogg|webm|wav)$/i.test(f));
    if (any) return path.join(tmpDir, any);
  } catch (_) { /* fall through to the expected path */ }
  return path.join(tmpDir, `${id}.mp3`);
}

export async function extractSet(url, { ytDlp, settings, signal, onProgress, cacheDir } = {}) {
  const emit = (data) => { try { if (onProgress) onProgress(data); } catch (_) { /* ignore */ } };

  if (!cacheDir) throw new Error('extractSet requires a cacheDir.');

  emit({ phase: 'info', percent: 0 });
  let info = null;
  try {
    info = await ytDlp.getVideoInfo(url);
  } catch (err) {
    throw new Error(`Couldn't read that link: ${err.message}`);
  }

  // The cache dir is owned by this job (one private dir per extraction). It is
  // created fresh in the caching phase below and torn down when the job is
  // deleted — this orchestrator never wipes it, so parallel jobs can't clobber
  // each other's cached audio. Cache files are keyed by the track's normalized
  // identity.
  const durationSec = Number(info && info.duration) || 0;
  const meta = { title: (info && info.title) || '', durationSec };
  emit({ phase: 'info', percent: 5, info: meta });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'setengine-extract-'));
  const id = crypto.randomUUID();

  try {
    // The audio is needed in nearly every path now — a partial list gets
    // supplemented by a scan, and even a complete-looking one gets spot-checked
    // — so start fetching it immediately and let it run *behind* the published
    // lookups rather than after them. When the tracklist only turns up in the
    // comments (a pass that can take 90 s) the download is effectively free.
    const audio = startAudioDownload();
    const published = await resolvePublished();
    audio.reveal();          // only now let its progress drive the phase readout

    const audioPath = await audio.path();     // null if the download failed
    if (!published && !audioPath) {
      throw audio.error || new Error('Could not download this set to scan it.');
    }

    let complete = published ? published.complete !== false : false;
    let seedObservations = null;
    let spotResult = null;

    // ── Is a complete-looking list actually complete? ───────────────────
    // The completeness heuristic in tracklist-sources.js is tuned on a handful
    // of sets and will misjudge one it has never seen. Twelve probes settle it.
    if (published && complete && audioPath) {
      emit({ phase: 'scanning', percent: 0 });
      const spot = await spotCheck(audioPath, {
        points: SPOT_CHECK_POINTS, durationSec, signal,
      });
      seedObservations = spot.observations;
      spotResult = spotCheckAgreement(spot.observations, published.entries);
      if (spot.answered === 0) {
        // Shazam answered nothing at all (throttled or unreachable). That is not
        // evidence against the tracklist — a spot check that never heard the
        // audio can't contradict anything, so the list stands unchallenged.
        console.log(`[SetEngine] spot check could not reach Shazam — trusting the ${published.source} tracklist unchecked.`);
      } else if (spotResult.matched < SPOT_CHECK_MIN_MATCHES) {
        console.log(`[SetEngine] spot check inconclusive (${spotResult.matched} of ${SPOT_CHECK_POINTS} probes matched) — trusting the ${published.source} tracklist.`);
      } else if (spotResult.fraction < SPOT_CHECK_MIN_AGREEMENT) {
        complete = false;
        console.log(`[SetEngine] spot check CONTRADICTS the ${published.source} tracklist: only ${spotResult.agree}/${spotResult.matched} probes named a listed track (${Math.round(100 * spotResult.fraction)}%). Scanning the audio.`);
      } else {
        console.log(`[SetEngine] spot check confirms the ${published.source} tracklist: ${spotResult.agree}/${spotResult.matched} probes named a listed track (${Math.round(100 * spotResult.fraction)}%).`);
      }
    }

    // ── Scan, and merge with whatever was published ─────────────────────
    let entries;
    let usedShazam = false;
    let gaps = [];
    if (!complete && audioPath) {
      // A scan that can't reach Shazam is only fatal when there is nothing
      // published to fall back on — the same rule the audio download follows.
      // Losing a real, human-written tracklist because the recognizer was
      // refused would be the worst possible trade: the published entries are
      // the best-named ones we have, and supplementing them is a bonus, not a
      // precondition. Cancellation stays fatal, always.
      let scan = null;
      try {
        scan = await scanAudio(audioPath, seedObservations);
      } catch (err) {
        if ((signal && signal.aborted) || !published) throw err;
        console.error(`[SetEngine] could not scan the audio (${err.message}) — keeping the `
          + `${published.source} tracklist as-is.`);
      }
      const scanned = (scan ? scan.tracks : []).map((t) => ({ ...t, source: 'shazam' }));
      gaps = scan ? scan.gaps : [];
      entries = published ? mergeTracklists(published.entries, scanned) : scanned;
      usedShazam = scan !== null;
      if (published && usedShazam) {
        console.log(`[SetEngine] supplemented a partial ${published.source} tracklist: `
          + `${published.entries.length} published + ${scanned.length} recognized → ${entries.length} track(s).`);
      }
    } else {
      entries = published.entries.map((e) => ({ ...e, source: 'published' }));
      console.log(`[SetEngine] used a published tracklist (${published.source}): ${entries.length} track(s) — no recognition.`);
    }

    const merged = dedupeTracks(entries);

    // A stretch the scan couldn't name is not unidentified if a person named
    // something in it. Published entries carry no span, so treat an entry as
    // accounting for the stretch it starts in — the point of reporting a gap is
    // "nobody could tell you what this was", and here somebody could.
    gaps = gaps.filter((g) => !merged.some((t) => t.source === 'published'
      && t.offsetSec >= g.fromSec && t.offsetSec < g.toSec));

    emit({ phase: 'merging', percent: 100 });

    // `published-<source>` rather than `youtube-<source>`: MixesDB isn't
    // YouTube, and the renderer names each source distinctly (they don't carry
    // equal authority — see SOURCE_LABELS in renderer/pages/extract.js).
    const engineLabel = published
      ? `published-${published.source}${usedShazam ? ' + shazam' : ''}`
      : 'shazam';

    // Even after all of the above a tracklist can still be short — a set of
    // unreleased dubs defeats every source we have. Say so instead of letting a
    // suspiciously short list pass for a finished one, which is exactly how this
    // failure went unnoticed.
    const minutesPerTrack = merged.length && durationSec
      ? (durationSec / 60) / merged.length : 0;
    // An EMPTY tracklist is the sparsest result there is, and it used to be the
    // one case this missed: with no tracks, minutesPerTrack is 0, 0 is not
    // greater than the threshold, and a set that produced nothing at all was
    // presented without so much as a note.
    const sparse = durationSec > 0 && (!merged.length || minutesPerTrack > SPARSE_MINUTES_PER_TRACK);
    const supplemented = Boolean(published && usedShazam);
    if (sparse) {
      console.log(`[SetEngine] tracklist looks sparse: ${merged.length} track(s) over ${Math.round(durationSec / 60)} min (${minutesPerTrack.toFixed(1)} min/track).`);
    }

    // ── Caching ───────────────────────────────────────────────────────────
    return await cacheAndFinish(merged, { engineLabel, sparse, supplemented, gaps });
  } finally {
    // Only the scratch download/scan dir is cleaned here. The job's cacheDir is
    // owned by ExtractionJobManager and removed when the job is deleted (and the
    // whole ExtractionCache root is wiped at app boot), so a cancelled/failed run
    // leaves its partial cache in place until the user deletes the job.
    try { await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (_) { /* best-effort */ }
  }

  // ── Published tracklist ───────────────────────────────────────────────
  // Tried cheapest-first, and each source is *also* more accurate than the one
  // after it. A hit here doesn't end the job any more — see `complete` above —
  // but it still supplies better names than a fingerprinter can.
  async function resolvePublished() {
    if (settings.usePublishedTracklist === false) return null;

    let found = null;
    try { found = parsePublishedTracklist(info); }
    catch (_) { found = null; }               // never let parsing break an extraction

    // 2) MixesDB — a community wiki of DJ-set tracklists, matched by exact
    // YouTube video id. One API call (~300 ms), and it covers the case nothing
    // else can: a set whose uploader published nothing AND whose records aren't
    // in Shazam's catalog. Tried before comments because it costs a fraction as
    // much — comments paginate a separate, much slower endpoint.
    if (!found) {
      emit({ phase: 'info', percent: 7, info: meta });
      try {
        const hit = await lookupByVideoId(info && info.id, splitArtistTitle, { signal });
        if (hit) {
          found = { source: 'mixesdb', entries: hit.entries, ...completenessOf(hit.entries, durationSec) };
          console.log(`[SetEngine] MixesDB matched "${hit.title}" — ${hit.entries.length} track(s).`);
        }
      } catch (_) { /* fail-soft: fall through */ }
      if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    }

    // 3) Comments — the slowest published source, so it goes last, but a
    // valuable one: of six 1-hour-plus sets that published neither chapters nor
    // a description tracklist, all six had a complete tracklist in a heavily
    // upvoted comment. Bounded by a timeout + the job's AbortSignal.
    if (!found) {
      emit({ phase: 'info', percent: 8, info: meta });
      try {
        const withComments = await ytDlp.getVideoInfo(url, null, {
          withComments: true,
          timeoutMs: COMMENT_FETCH_TIMEOUT_MS,
          signal,
        });
        if (withComments) found = parsePublishedTracklist(withComments);
      } catch (_) { found = null; }
      if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    }

    if (found) {
      const c = found.coverage || {};
      console.log(`[SetEngine] published tracklist (${found.source}): ${found.entries.length} entries, `
        + `${Math.round(100 * (c.accountedFraction || 0))}% of runtime accounted for, `
        + `${Math.round((c.headGapSec || 0) / 60)} min head gap → ${found.complete ? 'COMPLETE' : 'PARTIAL'}.`);
    }
    return found;
  }

  // ── Fetch the set audio, in the background ────────────────────────────
  // Resolves to a path, or to null if the download failed. A failure is only
  // fatal when there is no published tracklist to fall back on, so it is
  // captured rather than thrown — a video that can't be downloaded but does
  // carry chapters should still produce a tracklist.
  function startAudioDownload() {
    let revealed = false;
    let finished = false;
    let lastPercent = 0;
    const state = { error: null };

    // Settles to { path, error } and **never rejects**. It is deliberately left
    // unawaited while the published lookups run (up to 90 s for the comment
    // pass), and a promise that rejected in that window with nothing attached
    // would surface as an unhandled rejection.
    const promise = new Promise((resolve, reject) => {
      const dl = ytDlp.download(url, tmpDir, { bitrate: 128, filenameTemplate: id });
      const onAbort = () => { try { dl.cancel(); } catch (_) { /* gone */ } reject(new Error('Extraction cancelled.')); };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      dl.on('progress', (p) => {
        lastPercent = p.percent || 0;
        if (revealed) emit({ phase: 'downloading', percent: Math.min(99, lastPercent) });
      });
      dl.on('complete', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
      dl.on('error', (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
    }).then(
      async () => {
        finished = true;
        if (revealed) emit({ phase: 'downloading', percent: 100 });
        return { path: await findDownloaded(tmpDir, id), error: null };
      },
      (err) => {
        finished = true;
        return { path: null, error: err || new Error('Download failed.') };
      },
    );

    return {
      reveal() {
        revealed = true;
        emit({ phase: 'downloading', percent: finished ? 100 : Math.min(99, lastPercent) });
      },
      async path() {
        const { path: p, error } = await promise;
        state.error = error;
        // Cancellation is never soft — it must abort the job, not fall back to
        // a published-only result.
        if (error && signal && signal.aborted) throw error;
        if (error) console.error('[SetEngine] could not download the set audio:', error.message);
        return p;
      },
      get error() { return state.error; },
    };
  }

  async function scanAudio(audioPath, seedObservations) {
    emit({ phase: 'scanning', percent: 0 });
    const { tracks, gaps } = await recognize(audioPath, {
      signal,
      durationSec,
      settings,
      seedObservations,
      onProgress: ({ done, total }) => emit({
        phase: 'scanning',
        percent: total ? Math.round((done / total) * 100) : 0,
      }),
    });
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');
    return { tracks: tracks || [], gaps: gaps || [] };
  }

  // ── Cache each track's audio, then report the finished tracklist ──────
  async function cacheAndFinish(merged, { engineLabel, sparse, supplemented, gaps }) {
    emit({ phase: 'caching', percent: 0 });
    await mkdir(cacheDir, { recursive: true });   // this job's private cache dir

    let cachedTracksCount = 0;
    // Lowered from 5. Each track now costs far more yt-dlp processes than it used
    // to — up to two searches plus several metadata fetches for verification — and
    // at five-way concurrency that was enough to draw transient throttling from
    // YouTube. Throttling is especially damaging here because a failed search
    // looks like "YouTube doesn't have this track" and pushes the track onto the
    // SoundCloud fallback; measured, that misrouted 56 of 159 tracks. The retry in
    // track-match.js handles the rest, but not provoking it is better.
    const concurrencyLimit = 3;
    const activeDownloads = new Set();
    // Per-track download quality follows the user's audio-quality setting (same
    // key the normal queue uses); these files are copied verbatim to the user's
    // folder by download:track / download:tracks.
    const downloadBitrate = settings.audioQuality || 320;

    const runCacheDownload = async (t) => {
      if (signal && signal.aborted) return;
      const query = t.artist ? `${t.artist} ${t.title}` : t.title;
      // Key the cache file by the track's *normalized* identity — the same key
      // dedupe uses — so two surviving tracks can never collide onto one file and
      // serve each other's audio (a raw query could).
      const fileId = crypto.createHash('md5').update(identityKey(t.artist, t.title) || query).digest('hex');
      const expectedFile = path.join(cacheDir, `${fileId}.mp3`);

      // Whole body is guarded: a single track can only ever fail to produce a
      // cachePath, never reject the batch. resolveBestVideoUrl is documented as
      // best-effort, but a stray throw here must not abort the whole extraction.
      try {
        try {
          await stat(expectedFile);
          // A cache hit still has to be a playable file. A run killed mid-write
          // can leave a truncated .mp3 behind, and serving that under the right
          // name is the same class of failure as serving the wrong song.
          const cached = await verifyDownloadedAudio(expectedFile, {});
          if (!cached.ok) {
            try { await unlink(expectedFile); } catch (_) { /* best-effort */ }
            throw new Error(`cached file rejected: ${cached.reason}`);   // fall through to re-download
          }
          t.cachePath = expectedFile;
        } catch (_) {
          // Cache miss → resolve to a YouTube video that has been VERIFIED to be
          // this recording (title, artist, version and duration all checked
          // against the video's real metadata). null = nothing could be verified;
          // leave this track without a cached file rather than download something
          // wrong — a correctly-labelled wrong file is the worst outcome here.
          const target = await resolveBestVideo(ytDlp, query, t.title, t.artist);
          if (target) {
            try {
              await new Promise((resolve, reject) => {
                const dl = ytDlp.download(target.url, cacheDir, { bitrate: downloadBitrate, filenameTemplate: fileId });
                const onAbort = () => { try { dl.cancel(); } catch (_) {} reject(new Error('Extraction cancelled.')); };
                if (signal) {
                  if (signal.aborted) { onAbort(); return; }
                  signal.addEventListener('abort', onAbort, { once: true });
                }
                dl.on('complete', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
                dl.on('error', (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
              });
              const actualPath = await findDownloaded(cacheDir, fileId);

              // Last gate: confirm what landed on disk really is the recording we
              // verified. The metadata check above can't see a truncated file, a
              // format fallback, or a stale file matched by the filename glob —
              // and every one of those would be served to the user under the
              // right name. Refuse the file rather than cache a wrong one.
              const check = await verifyDownloadedAudio(actualPath, {
                expectedDurationSec: target.durationSec,
              });
              if (!check.ok) {
                try { await unlink(actualPath); } catch (_) { /* best-effort */ }
                console.error(`[SetEngine] discarded download for "${query}": ${check.reason} (${target.url})`);
              } else {
                t.cachePath = actualPath;
                t.sourceUrl = target.url;        // provenance, so a bad match is auditable
                // Surfaced in the UI. It matters: SoundCloud tops out at 128 kbps,
                // so a track found there is lower quality than one from YouTube
                // Music — worth having, but the user should know which they got.
                t.provider = target.provider || 'youtube';
              }
            } catch (err) {
              // Remove any partial/`.part` file this failed download left behind.
              try { await unlink(expectedFile); } catch (_) { /* may not exist */ }
              console.error('Failed to cache track:', query, err.message);
            }
          }
        }
      } catch (err) {
        console.error('Cache step failed for track:', query, err && err.message);
      } finally {
        cachedTracksCount++;
        emit({ phase: 'caching', percent: Math.round((cachedTracksCount / merged.length) * 100) });
      }
    };

    const promises = [];
    for (const t of merged) {
      if (signal && signal.aborted) break;
      while (activeDownloads.size >= concurrencyLimit) {
        await Promise.race(activeDownloads);
      }
      const p = runCacheDownload(t).finally(() => activeDownloads.delete(p));
      activeDownloads.add(p);
      promises.push(p);
    }
    await Promise.all(promises);
    if (signal && signal.aborted) throw new Error('Extraction cancelled.');

    const payload = { tracks: merged, gaps, engine: engineLabel, info: meta, sparse, supplemented };
    emit({ phase: 'done', percent: 100, ...payload });
    return { success: true, ...payload };
  }
}
