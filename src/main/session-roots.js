import path from 'node:path';

// In-memory allow-list of directories the user explicitly chose this session
// (Crate Sorter source folders / files / destination crates). The
// setengine-audio:// protocol handler consults this so audio that lives outside
// Music / Downloads / Home — e.g. a DJ library on an external drive
// (/Volumes/...) — can still be previewed.
//
// Security: the renderer can never inject a path here. Entries are added only
// from inside the dialog-backed sorter:* IPC handlers, i.e. paths the OS file
// picker actually returned and that main validated as absolute. The set lives
// only for the lifetime of the process.
const roots = new Set();

export function addSessionRoot(p) {
  if (!p || typeof p !== 'string') return;
  if (!path.isAbsolute(p)) return;
  roots.add(path.normalize(p));
}

export function isUnderSessionRoot(normalizedPath) {
  if (!normalizedPath) return false;
  for (const r of roots) {
    if (normalizedPath === r || normalizedPath.startsWith(r + path.sep)) return true;
  }
  return false;
}
