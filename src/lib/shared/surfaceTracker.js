// The "which page am I on" state machine, shared by Instagram and TikTok.
// INLINED into content scripts — see src/lib/shared/README.md before editing
// (no imports allowed here beyond a sibling).
//
// WHY THIS EXISTS. Both platforms have DETAIL routes — Instagram's /p/<code>/ and
// /reel/<code>/, TikTok's /@user/video/<id> — that you reach by clicking a tile in
// a grid. The URL changes, so a plain path→key function reports a different
// surface, and two things break, both measured live (2026-09-22):
//
//   * Instagram: clicking a tile on /explore/search/keyword/?q=%23soulmate pushes
//     /p/DNEq_P7KOOz/, whose key was "feed". The panel's surface filter then
//     dropped all 30 hashtag records — the grid emptied while a post was open.
//   * TikTok: clicking a tile on /tag/soulmate pushes
//     /@whatspeterdoingnow/video/7668715391899716886, whose key was
//     "profile:whatspeterdoingnow". TikTok then loads that page's recommendation
//     rail — 12 videos by mrbeast, adv.devedores, cinemaaquiagora… — and every one
//     was stamped as belonging to that profile. Measured: the list went 25 -> 2.
//
// A detail route is therefore TRANSPARENT: it does not become the surface. It
// reports the grid you came from for DISPLAY, while the records it captures are
// stamped `related:<that grid>` — so the recommendation rail is kept (the picker
// lists it) without contaminating the hashtag you were actually researching.

/** The bucket a detail route falls back to when nothing preceded it. */
export const ORPHAN_SURFACE = "post";

/** `related:<origin>` — where a detail route's own captures are filed. */
export function relatedSurface(origin) {
  const o = origin || ORPHAN_SURFACE;
  return o.startsWith("related:") ? o : "related:" + o;
}

/** The grid behind a `related:<grid>` key, or the key itself. */
export function relatedOrigin(surface) {
  const s = surface == null ? "" : String(surface);
  return s.startsWith("related:") ? s.slice("related:".length) : s;
}

/**
 * Build a tracker around a platform's `path,search -> key | null` function, where
 * `null` means "transparent detail route".
 *
 * `read(path, search)` returns `{ view, stamp }`:
 *   view  — the surface the panel should DISPLAY (a detail route inherits it)
 *   stamp — the surface records captured right now belong to
 *
 * Every caller reads through the same tracker instance, so the MAIN world and the
 * isolated bridge agree — the surface is decided WHERE AND WHEN a record is
 * captured, which is the invariant igSurface.js was written for.
 */
export function makeSurfaceTracker(keyOf) {
  let last = null; // the last non-transparent surface seen in this document
  // Closure, not methods on the returned object: every call site destructures
  // (`const { stamp } = tracker`), and a `this.read(...)` would throw there.
  const read = (path, search) => {
    const key = keyOf(path, search);
    if (key == null) {
      const view = last || ORPHAN_SURFACE;
      return { view, stamp: relatedSurface(view) };
    }
    last = key;
    return { view: key, stamp: key };
  };
  return {
    read,
    /** What the panel should show right now. */
    view: (path, search) => read(path, search).view,
    /** What a record captured right now should be stamped with. */
    stamp: (path, search) => read(path, search).stamp,
  };
}

/**
 * Count captured records per surface, in first-sighting order.
 *
 * This is what the panel's page picker lists: the capture store spans a whole SPA
 * session, so the surfaces you already scrolled are still in there. Showing them
 * turns "the list is full of stuff from another page" into "pick the page" — the
 * records were never the problem, the single undifferentiated list was.
 */
export function tallySurfaces(records) {
  const counts = new Map();
  for (const r of records) {
    const k = r && r.surface;
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = [];
  for (const [key, count] of counts) out.push({ key, count });
  return out;
}
