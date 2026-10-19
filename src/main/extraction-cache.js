// A track is ready only after a verified source has produced a usable file.
// Shared by automatic caching, Play retry and Save retry.
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { identityKey } from './track-merge.js';
import { resolveBestVideo } from './track-match.js';
import { verifyDownloadedAudio } from './download-verify.js';

export async function cacheTrack(track, { ytDlp, cacheDir, bitrate = 320, signal }) {
  const checkAbort = () => { if (signal?.aborted) throw new Error('Extraction cancelled.'); };
  checkAbort();
  const query = track.artist ? `${track.artist} ${track.title}` : track.title;
  const id = crypto.createHash('md5').update(identityKey(track.artist, track.title) || query).digest('hex');
  const destination = path.join(cacheDir, `${id}.mp3`);
  await mkdir(cacheDir, { recursive: true });
  const cached = await verifyDownloadedAudio(destination, { expectedDurationSec: track.durationSec });
  if (cached.ok) {
    track.cachePath = destination;
    delete track.cacheError;
    return track;
  }
  delete track.cachePath;
  let lastError = '';
  const target = await resolveBestVideo(ytDlp, query, track.title, track.artist, {
    signal,
    accept: async (candidate) => {
      checkAbort();
      // Isolate each attempt: yt-dlp must never reuse a partial or rejected file
      // left by another source. Publish to the cache only after verification.
      const scratch = await mkdtemp(path.join(cacheDir, '.track-'));
      try {
        await new Promise((resolve, reject) => {
          const dl = ytDlp.download(candidate.url, scratch, { bitrate, filenameTemplate: id, noPlaylist: true });
          let settled = false;
          const finish = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (err) reject(err); else resolve();
          };
          const cancel = () => { try { dl.cancel(); } catch (_) { /* already exited */ } };
          const onAbort = () => { finish(new Error('Extraction cancelled.')); cancel(); };
          const timer = setTimeout(() => { finish(new Error('Track download timed out.')); cancel(); }, 180000);
          dl.on('complete', () => finish());
          dl.on('error', finish);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
        checkAbort();
        const files = await readdir(scratch);
        const filename = files.find(f => f === `${id}.mp3`);
        if (!filename) throw new Error('The source did not produce an MP3.');
        const audio = path.join(scratch, filename);
        const check = await verifyDownloadedAudio(audio, { expectedDurationSec: candidate.durationSec });
        if (!check.ok) throw new Error(check.reason);
        checkAbort();
        await rename(audio, destination);
        track.cachePath = destination;
        track.sourceUrl = candidate.url;
        track.provider = candidate.provider || 'youtube';
        track.durationSec = candidate.durationSec;
        delete track.cacheError;
        return true;
      } catch (err) {
        checkAbort();
        lastError = err.message;
        return false;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  });
  if (!target || !track.cachePath) {
    track.cacheError = lastError
      ? `Sources were found but could not be downloaded: ${lastError}`
      : 'No verified recording was found on YouTube or SoundCloud. Retry to search again.';
    throw new Error(track.cacheError);
  }
  return track;
}
