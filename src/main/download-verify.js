// SetEngine — post-download verification
//
// The last line of defence for the failure this whole path exists to prevent: a
// file that is correctly labelled and contains the wrong recording.
//
// `track-match.js` already verifies a candidate's metadata BEFORE downloading,
// so by the time we get here the URL is known to be the right song. This checks
// that what actually landed on disk is that URL's audio — catching a different
// class of problem the metadata gate cannot see:
//
//   • yt-dlp falling back to a different format or a different video
//   • a truncated or partially-written file left by an interrupted download
//   • a stale file from an earlier run being picked up by the filename glob
//
// The check is a duration comparison, because duration is the one property we
// know from the verified metadata and can measure cheaply on the result. It is
// deliberately tolerant: containers pad, encoders round, and a few seconds of
// difference is normal. A *wrong track* is essentially never within a few
// seconds of the right one by accident.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

// Encoder/container slack. Re-encoding to MP3 pads with silence and rounds to a
// frame boundary, so exact equality is not achievable.
const DURATION_TOLERANCE_SEC = 12;

// Below this a "download" is a fragment, not a track.
const MIN_BYTES = 32 * 1024;

/** Duration of an audio file in seconds, or 0 when it can't be determined. */
export function probeDurationSec(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) { resolve(0); return; }
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 15000);
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('error', () => { clearTimeout(timer); resolve(0); });
    proc.on('close', () => { clearTimeout(timer); resolve(Math.round(Number(out.trim()) || 0)); });
  });
}

/**
 * Confirm a downloaded file is plausibly the recording we verified.
 *
 * @param {string} filePath
 * @param {{ expectedDurationSec?: number }} expected
 * @returns {Promise<{ ok: boolean, reason: string, durationSec: number }>}
 */
export async function verifyDownloadedAudio(filePath, { expectedDurationSec = 0 } = {}) {
  let size = 0;
  try { size = (await stat(filePath)).size; }
  catch (_) { return { ok: false, reason: 'file missing', durationSec: 0 }; }
  if (size < MIN_BYTES) {
    return { ok: false, reason: `file too small (${size} bytes)`, durationSec: 0 };
  }

  const durationSec = await probeDurationSec(filePath);
  if (!durationSec) {
    // Unreadable audio is a failure in its own right — the file exists but
    // nothing can play it.
    return { ok: false, reason: 'unreadable audio', durationSec: 0 };
  }

  if (expectedDurationSec > 0) {
    const drift = Math.abs(durationSec - expectedDurationSec);
    if (drift > DURATION_TOLERANCE_SEC) {
      return {
        ok: false,
        reason: `duration mismatch: expected ~${expectedDurationSec}s, got ${durationSec}s`,
        durationSec,
      };
    }
  }
  return { ok: true, reason: '', durationSec };
}
