// Pure helpers shared by version.mjs and make-update.mjs, and tested by
// scripts/eval/update.test.mjs. No I/O here.

/** [major, minor, patch] for "1.0.41" or "v1.0.41", else null. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const pa = Array.isArray(a) ? a : parseVersion(a);
  const pb = Array.isArray(b) ? b : parseVersion(b);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

export const formatVersion = (v) => v.join('.');

/**
 * The next release's version. MAJOR.MINOR come from package.json; PATCH is the
 * commit count, kept above every existing tag so the result is always newer
 * than anything already released.
 */
export function nextVersion({ packageVersion, commitCount, tags }) {
  const base = parseVersion(packageVersion);
  if (!base) throw new Error(`package.json has an unusable version "${packageVersion}".`);
  if (!Number.isSafeInteger(commitCount) || commitCount < 1) throw new Error(`Bad commit count ${commitCount}.`);
  let next = [base[0], base[1], commitCount];
  const released = tags.map(parseVersion).filter(Boolean).sort(compareVersions);
  const latest = released[released.length - 1];
  if (latest && compareVersions(next, latest) <= 0) next = [latest[0], latest[1], latest[2] + 1];
  return formatVersion(next);
}

// Commit types that never change what a user sees. A docs-only merge doesn't
// even trigger a release (paths-ignore in release.yml), but its commit still
// falls inside the next release's range.
const SKIP_TYPES = new Set(['docs', 'ci', 'test', 'tests', 'chore', 'style']);

/**
 * A commit subject as a line of release notes, or null for one that isn't
 * worth showing: "feat(download): accept SoundCloud links (#5)" becomes
 * { text: "Accept SoundCloud links", pr: 5 }.
 */
export function cleanSubject(subject) {
  let s = String(subject || '').trim();
  if (!s || /^Merge (pull request|branch|remote-tracking)/i.test(s)) return null;
  const typed = /^([a-z]+)(\([^)]*\))?!?:\s*(.+)$/i.exec(s);
  if (typed) {
    if (SKIP_TYPES.has(typed[1].toLowerCase())) return null;
    s = typed[3];
  }
  let pr = null;
  s = s.replace(/\s*\(#(\d+)\)\s*$/, (_, n) => { pr = Number(n); return ''; }).trim();
  if (!s) return null;
  return { text: s[0].toUpperCase() + s.slice(1), pr };
}

/** Cleaned, de-duplicated release notes from a list of commit subjects (newest first). */
export function notesFromSubjects(subjects) {
  const seen = new Set();
  const out = [];
  for (const subject of subjects) {
    const note = cleanSubject(subject);
    if (!note || seen.has(note.text.toLowerCase())) continue;
    seen.add(note.text.toLowerCase());
    out.push(note);
  }
  return out;
}
