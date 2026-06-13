// SetEngine — Rating writer
//
// MP3:  ID3v2 POPM ("Popularimeter") byte for compatibility with Mixed In
//       Key / foobar / MediaMonkey, AND a "[★★★★] " marker in the COMM
//       frame so Serato (which ignores POPM) shows the rating in its
//       Comments column.
//
// M4A / FLAC / OGG / Opus / AAC: no POPM-equivalent that's widely read, so
//       we only write the "[★★★★] " marker — but to the format's native
//       comment field via ffmpeg's stream-copy remux. Serato displays
//       that the same as the MP3 comment.
//
// Star ratings 0..5 map to bytes via the Windows Explorer convention:
//   0★ = 0, 1★ = 1, 2★ = 64, 3★ = 128, 4★ = 196, 5★ = 255
// We read back any value and round to the nearest star, so files rated by
// other software display correctly.

import NodeID3 from 'node-id3';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { rename, unlink } from 'node:fs/promises';

const EMAIL = 'SetEngine';

// Star → byte (Windows / Explorer convention, widely interoperable)
const STAR_TO_BYTE = { 0: 0, 1: 1, 2: 64, 3: 128, 4: 196, 5: 255 };

// Matches a leading "[★★★★] " marker (filled stars only). Also tolerates
// the legacy "[★★★★☆]" mixed form so old files migrate cleanly when
// re-rated.
const RATING_PREFIX_RE = /^\[[★☆]+\]\s*/;

// Non-MP3 extensions where we delegate to ffmpeg for comment writes. WAV
// and AIFF are excluded — they don't carry standard comment tags in any
// portable way DJ software actually reads.
const FFMPEG_FORMATS = new Set(['.m4a', '.mp4', '.aac', '.flac', '.ogg', '.opus']);

function ext(filePath) {
  return path.extname(filePath).toLowerCase();
}

function byteToStar(byte) {
  if (byte <= 0) return 0;
  if (byte < 32) return 1;
  if (byte < 96) return 2;
  if (byte < 160) return 3;
  if (byte < 224) return 4;
  return 5;
}

function buildStarPrefix(stars) {
  if (stars <= 0) return '';
  const s = Math.max(0, Math.min(5, Math.round(stars)));
  return `[${'★'.repeat(s)}] `;
}

// node-id3 returns COMM either as { language, shortText, text } or as an
// array. Serato reads the "main" entry (the one with no description), so
// that's the one we read and update.
function getMainCommentText(tags) {
  if (!tags || !tags.comment) return '';
  const c = tags.comment;
  if (Array.isArray(c)) {
    const main = c.find((x) => !x.shortText) || c[0];
    return (main && main.text) || '';
  }
  return c.text || '';
}

// Parses the stars value from a comment string. Returns 0 if no marker.
function starsFromComment(text) {
  if (!text) return 0;
  const m = /^\[([★☆]+)\]/.exec(text);
  if (!m) return 0;
  const filled = (m[1].match(/★/g) || []).length;
  return Math.max(0, Math.min(5, filled));
}

// ── ffmpeg / ffprobe helpers ──────────────────────────────────────────

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || `exit ${code}`).slice(0, 400).trim()));
    });
  });
}

async function readFfprobeComment(filePath) {
  try {
    const { stdout } = await runProcess('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format_tags=comment',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    return stdout.trim();
  } catch {
    return '';
  }
}

// ── MP3 path (node-id3, fast in-place writes) ─────────────────────────

function readMp3Rating(filePath) {
  try {
    const tags = NodeID3.read(filePath);
    if (!tags) return { supported: true, stars: null };
    if (tags.popularimeter && typeof tags.popularimeter.rating === 'number') {
      return { supported: true, stars: byteToStar(tags.popularimeter.rating) };
    }
    // Fall back to parsing the COMM marker — covers files rated outside
    // SetEngine (or by an older build that wrote only the marker).
    const fromComment = starsFromComment(getMainCommentText(tags));
    return { supported: true, stars: fromComment > 0 ? fromComment : null };
  } catch {
    return { supported: true, stars: null };
  }
}

function writeMp3Rating(filePath, stars) {
  const byte = STAR_TO_BYTE[stars] ?? 0;

  let existingComment = '';
  try {
    const tags = NodeID3.read(filePath);
    existingComment = getMainCommentText(tags);
  } catch { /* fall through to write fresh */ }

  const cleaned = existingComment.replace(RATING_PREFIX_RE, '');
  const newComment = `${buildStarPrefix(stars)}${cleaned}`.trimEnd();

  try {
    const ok = NodeID3.update(
      {
        popularimeter: { email: EMAIL, rating: byte, counter: 0 },
        comment: { language: 'eng', shortText: '', text: newComment },
      },
      filePath,
    );
    if (ok === true) return { supported: true, success: true, stars };
    return { supported: true, success: false, error: 'node-id3 returned false' };
  } catch (err) {
    return { supported: true, success: false, error: err.message };
  }
}

// ── ffmpeg path (M4A / FLAC / OGG / etc) ──────────────────────────────

async function readFfmpegRating(filePath) {
  const comment = await readFfprobeComment(filePath);
  const stars = starsFromComment(comment);
  return { supported: true, stars: stars > 0 ? stars : null };
}

async function writeFfmpegRating(filePath, stars) {
  const existing = await readFfprobeComment(filePath);
  const cleaned = existing.replace(RATING_PREFIX_RE, '');
  const newComment = `${buildStarPrefix(stars)}${cleaned}`.trimEnd();

  // Write to a sibling temp file, then atomically rename. -c copy keeps
  // the audio data intact (no re-encode); only the container tags change.
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.setengine-${Date.now()}-${base}`);

  try {
    // `-map_metadata 0` carries existing tags through, then `-metadata
    // comment=…` overwrites just the comment we care about.
    await runProcess('ffmpeg', [
      '-v', 'error',
      '-i', filePath,
      '-map_metadata', '0',
      '-metadata', `comment=${newComment}`,
      '-c', 'copy',
      '-y',
      tempPath,
    ]);
  } catch (err) {
    try { await unlink(tempPath); } catch {}
    return { supported: true, success: false, error: `ffmpeg: ${err.message}` };
  }

  try {
    await rename(tempPath, filePath);
  } catch (err) {
    try { await unlink(tempPath); } catch {}
    return { supported: true, success: false, error: `rename: ${err.message}` };
  }

  return { supported: true, success: true, stars };
}

// ── Public API ─────────────────────────────────────────────────────────

export async function readRating(filePath) {
  const e = ext(filePath);
  if (e === '.mp3') return readMp3Rating(filePath);
  if (FFMPEG_FORMATS.has(e)) return await readFfmpegRating(filePath);
  return { supported: false, stars: null };
}

export async function writeRating(filePath, stars) {
  if (typeof stars !== 'number' || stars < 0 || stars > 5) {
    return { supported: true, success: false, error: 'stars must be 0..5' };
  }
  const rounded = Math.round(stars);
  const e = ext(filePath);
  if (e === '.mp3') return writeMp3Rating(filePath, rounded);
  if (FFMPEG_FORMATS.has(e)) return await writeFfmpegRating(filePath, rounded);
  return { supported: false, success: false };
}

// ── BPM / Key writer ────────────────────────────────────────────────────
//
// Writes detected tempo/key into the source file, only the fields provided
// (gap-fill: pass just `bpm` or just `keyName`/`keyCamelot` to leave the other
// alone). Standard tags so DJ software reads them: TBPM (rounded int) + TKEY
// (musical name, e.g. "Am"). The precise decimal BPM and the Camelot code go
// into custom fields (TXXX on MP3, freeform tags elsewhere) that metadata.js
// reads back on re-import. WAV/AIFF have no portable tag format → unsupported.

function writeMp3BpmKey(filePath, { bpm, keyName, keyCamelot }) {
  const tags = {};
  const hasBpm = typeof bpm === 'number' && bpm > 0;

  // Custom TXXX frames (CAMELOT, precise BPM). Merge with any existing TXXX so
  // we don't clobber unrelated user fields.
  let existingUdt = [];
  try {
    const cur = NodeID3.read(filePath);
    if (cur && cur.userDefinedText) {
      existingUdt = Array.isArray(cur.userDefinedText) ? cur.userDefinedText : [cur.userDefinedText];
    }
  } catch { /* fresh write */ }

  const ours = new Set();
  if (hasBpm) ours.add('BPM');
  if (keyCamelot) ours.add('CAMELOT');
  const merged = existingUdt.filter((u) => !ours.has((u.description || '').toUpperCase()));
  if (hasBpm) merged.push({ description: 'BPM', value: String(bpm) });
  if (keyCamelot) merged.push({ description: 'CAMELOT', value: keyCamelot });

  if (hasBpm) tags.bpm = String(Math.round(bpm));   // TBPM
  if (keyName) tags.initialKey = keyName;            // TKEY
  if (merged.length) tags.userDefinedText = merged;

  if (Object.keys(tags).length === 0) return { supported: true, success: true, written: false };

  try {
    const ok = NodeID3.update(tags, filePath);
    if (ok === true) return { supported: true, success: true, written: true };
    return { supported: true, success: false, error: 'node-id3 returned false' };
  } catch (err) {
    return { supported: true, success: false, error: err.message };
  }
}

async function writeFfmpegBpmKey(filePath, { bpm, keyName, keyCamelot }, isMp4) {
  const hasBpm = typeof bpm === 'number' && bpm > 0;
  if (!hasBpm && !keyName && !keyCamelot) {
    return { supported: true, success: true, written: false };
  }

  const args = ['-v', 'error', '-i', filePath, '-map_metadata', '0'];
  // The MP4/MOV muxer silently drops unrecognized metadata keys unless told to
  // keep them as freeform (mdta) tags. Vorbis/FLAC/Ogg need no such flag.
  if (isMp4) args.push('-movflags', 'use_metadata_tags');
  if (hasBpm) {
    args.push('-metadata', `TBPM=${Math.round(bpm)}`);
    args.push('-metadata', `BPM=${bpm}`);
  }
  if (keyName) {
    args.push('-metadata', `TKEY=${keyName}`);
    args.push('-metadata', `INITIALKEY=${keyName}`);
  }
  if (keyCamelot) args.push('-metadata', `CAMELOT=${keyCamelot}`);

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.setengine-tag-${Date.now()}-${base}`);
  args.push('-c', 'copy', '-y', tempPath);

  try {
    await runProcess('ffmpeg', args);
  } catch (err) {
    try { await unlink(tempPath); } catch {}
    return { supported: true, success: false, error: `ffmpeg: ${err.message}` };
  }
  try {
    await rename(tempPath, filePath);
  } catch (err) {
    try { await unlink(tempPath); } catch {}
    return { supported: true, success: false, error: `rename: ${err.message}` };
  }
  return { supported: true, success: true, written: true };
}

// Vorbis-comment containers: ffmpeg writes the keys as-is.
const VORBIS_BPMKEY_FORMATS = new Set(['.flac', '.ogg', '.opus']);
// MP4 containers: need the use_metadata_tags flag (handled above).
const MP4_BPMKEY_FORMATS = new Set(['.m4a', '.mp4']);

// fields: { bpm?: number, keyName?: string, keyCamelot?: string }
export async function writeBpmKey(filePath, fields) {
  const f = fields || {};
  const e = ext(filePath);
  if (e === '.mp3') return writeMp3BpmKey(filePath, f);
  if (VORBIS_BPMKEY_FORMATS.has(e)) return await writeFfmpegBpmKey(filePath, f, false);
  if (MP4_BPMKEY_FORMATS.has(e)) return await writeFfmpegBpmKey(filePath, f, true);
  // WAV/AIFF and raw AAC/ALAC have no portable BPM/key tag we can write here.
  return { supported: false, success: false };
}
