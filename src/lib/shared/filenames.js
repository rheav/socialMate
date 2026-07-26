// Filename-part scrubbing. INLINED into content scripts — see
// src/lib/shared/README.md before editing (no imports allowed in this file).
//
// One definition, deliberately. It briefly existed twice (here and in
// downloadPath.js) with nothing enforcing agreement, which is exactly how Instagram
// filenames would have drifted from every other platform's.

/**
 * Scrub ONE name part (an author handle, a board title) for use inside a filename.
 * Caps at 40 chars, which is why it must never be applied to a whole filename —
 * that would eat the extension. `safeSegment` in downloadPath.js is the one for
 * full path segments.
 */
export function sanitizeFilenamePart(s) {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}
