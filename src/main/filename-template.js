// =============================================================================
// filename-template.js — Shared output-filename-template sanitization.
//
// Both the yt-dlp and spotdl engines accept the user's yt-dlp-style template
// (e.g. "%(artist)s - %(title)s") that comes from Settings. This sanitizer keeps
// the template human-readable — spaces, hyphens, commas, and brackets all
// survive — while stripping anything that could turn the template into a *path*
// rather than a filename:
//   - directory separators ("/" and "\") and ".." traversal, so every download
//     lands inside the chosen output folder (which is prepended separately via
//     path.join), and
//   - characters that are illegal in filenames on Windows/macOS plus ASCII
//     control characters.
//
// Previously yt-dlp's wrapper used an allow-list regex that stripped the space
// character (and commas, etc.), so a natural template like "%(artist)s -
// %(title)s" was silently rewritten to "%(artist)s-%(title)s". The spotdl
// wrapper, meanwhile, did no sanitization at all, so the two engines produced
// different filenames from the same template. Both now share this function.
// =============================================================================

const DEFAULT_TEMPLATE = '%(title)s';

/**
 * Sanitize a yt-dlp-style output filename template.
 * @param {string} template
 * @returns {string} a safe single-component template (never empty)
 */
export function sanitizeFilenameTemplate(template) {
  let s = String(template == null ? '' : template);

  // Collapse ".." (and longer runs) so the template can't traverse upward, and
  // turn any directory separator into a space so it can't escape the output
  // folder or silently create subdirectories.
  s = s.replace(/\.{2,}/g, '.');
  s = s.replace(/[\\/]+/g, ' ');

  // Remove characters that are illegal in filenames on Windows/macOS, plus
  // ASCII control characters. Spaces, hyphens, commas, parentheses, and the
  // %()s template tokens are all preserved.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[<>:"|?*\x00-\x1f]/g, '');

  // Tidy whitespace and trim leading/trailing dots or spaces. A leading dot
  // would create a hidden file; trailing dots/spaces are stripped by Windows
  // anyway and would otherwise sit awkwardly before the appended extension.
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  return s.length ? s : DEFAULT_TEMPLATE;
}
