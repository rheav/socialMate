// Which video a floating overlay rail is actually pointing at. INLINED into content
// scripts — see src/lib/shared/README.md before editing (no imports allowed here).
//
// Feed rails are `position: fixed` and repositioned from a scroll handler. When that
// handler cannot run — a hidden tab never fires requestAnimationFrame — the rail
// keeps its SCREEN position while the feed scrolls underneath it, so a button drawn
// for post A ends up sitting next to post B. Clicking it used to transcribe A under
// B's metadata: the wrong transcript, with nothing on screen suggesting anything was
// off. Geometry is the tie-breaker, because geometry is what the user actually sees.
//
// `slack` allows for the 10px inset the rail is drawn at, plus a rail taller than
// its media's top edge.

/** Is `rail`'s anchor (its top-left) inside `media`, allowing `slack` above/left? */
export function railHitsMedia(rail, media, slack = 40) {
  if (!rail || !media) return false;
  return (
    rail.top >= media.top - slack &&
    rail.top <= media.bottom &&
    rail.left >= media.left - slack &&
    rail.left <= media.right
  );
}

/**
 * The index into `mediaRects` the rail is over, or -1.
 * First hit wins — rails sit at the top-left of their media, and feed media do not
 * overlap, so a second hit would be a media element stacked on another.
 */
export function mediaUnderRail(rail, mediaRects, slack = 40) {
  if (!rail || !Array.isArray(mediaRects)) return -1;
  return mediaRects.findIndex((m) => railHitsMedia(rail, m, slack));
}

/**
 * Can this rail's BOUND media still be trusted?
 *
 * A rail anchored in the page next to its video (`floating: false`) always can —
 * it moves with the post by construction, and it is not drawn inside the media box,
 * so a containment test would wrongly reject it. A floating rail can only be trusted
 * while it is still drawn over the media it was bound to.
 */
export function boundMediaIsStale({ floating, connected, railRect, boundRect }, slack = 40) {
  if (!connected) return true;
  if (!floating) return false;
  return !railHitsMedia(railRect, boundRect, slack);
}
