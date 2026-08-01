// SetEngine — Shared audio-file discovery
//
// One definition of "what counts as an audio file" and one recursive walker,
// shared by Match Maker's library scan, the Crate Sorter's source folders, and
// the fingerprint catalog's ingestion. Previously private to ipc-handlers.js;
// lifted here when the catalog needed the same traversal in the main process.

import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';

export const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.wav', '.wave', '.aiff', '.aif',
  '.ogg', '.m4a', '.mp4', '.aac', '.alac', '.wma', '.opus',
]);

/**
 * Recursively collect audio files under `dirPath`, pushing
 * `{ path, name, size, relativePath }` into `out`. Dotfiles are skipped, and
 * unreadable directories/files are stepped over rather than thrown on — a scan
 * of a large library shouldn't die on one permission error.
 */
export async function walkAudioDir(dirPath, relativeBase, out) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dirPath, e.name);
    const rel = relativeBase ? `${relativeBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walkAudioDir(full, rel, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) {
        try {
          const s = await stat(full);
          out.push({ path: full, name: e.name, size: s.size, relativePath: rel });
        } catch { /* unreadable, skip */ }
      }
    }
  }
}
