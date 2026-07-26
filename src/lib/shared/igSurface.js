// Which Instagram surface a record belongs to. INLINED into content scripts —
// see src/lib/shared/README.md before editing (no imports allowed in this file).
//
// This is shared between the MAIN-world capture and the isolated bridge because
// the surface has to be decided WHERE AND WHEN the record is captured, not when it
// is relayed. The bridge used to stamp `surfaceKey()` at relay time, which is
// wrong for replays: after "Atualizar" the MAIN world resends everything it ever
// captured, so records from profile A arrived while the user was on profile B and
// got labelled `profile:B` — and the username backfill then attributed A's posts
// to B, defeating the Sort tool's ownership filter.

// Top-level IG routes that are features, not usernames. A path like /explore/ or
// /direct/ must never be read as a profile.
export const IG_RESERVED_SEGMENTS = [
  "explore",
  "reels",
  "reel",
  "p",
  "direct",
  "stories",
  "accounts",
  "tv",
  "guides",
  "challenges",
  "about",
  "legal",
  "privacy",
  "terms",
];

/**
 * `path` is a pathname (defaults to the live location). Returns one of:
 *   "tag:<name>" | "explore" | "profile:<username>" | "feed"
 */
export function igSurfaceKey(path) {
  const p = path == null ? location.pathname : String(path);
  let m;
  if ((m = p.match(/\/explore\/tags\/([^/]+)/))) {
    try {
      return "tag:" + decodeURIComponent(m[1]);
    } catch {
      return "tag:" + m[1]; // a malformed escape must not throw here
    }
  }
  if (p.startsWith("/explore")) return "explore";
  if ((m = p.match(/^\/([^/]+)\/?(?:reels\/?)?$/))) {
    const u = m[1];
    if (!IG_RESERVED_SEGMENTS.includes(u)) return "profile:" + u;
  }
  return "feed";
}
