// Is this TikTok surface actually showing a PLAYER — one video the floating
// action rail can act on — or a grid of tiles that each carry their own rail?
// INLINED into content scripts — see src/lib/shared/README.md before editing (no
// imports allowed in this file).
//
// `maintainOverlay` used to decide with:
//
//   const onVideo = /\/video\/\d+/.test(path) || path.startsWith("/foryou")
//                || path === "/" || !!centered;
//
// That last clause is the bug. `centered` is just the most-centred <video> on the
// page, and a TikTok grid tile autoplays a muted preview — one big enough to clear
// the 120px floor. So on /search/video?q=… a single playing tile was enough to
// append the fixed save / download / transcribe / comments / like rail to
// <body>, floating at the right edge of a page that has no player at all.
// Measured live on the #auralytrend search grid: one <video> on the page, inside a
// tile anchor that already carried its own rail, and the floating rail sitting at
// x=1454.
//
// It was not only clutter: the rail's buttons act on `currentRecord(centered)`, so
// pressing Download there downloaded whichever tile happened to drift closest to
// the middle of the viewport.
//
// The discriminator is structural, the same one the Instagram overlay uses: a grid
// tile is wrapped in the post's own permalink, a player never is. Verified live on
// /@user/video/<id> — both <video> elements there have no permalink ancestor.

/** TikTok's grid tiles: each is an anchor to the post's own permalink. */
export const TT_TILE_LINK = 'a[href*="/video/"]';

/** Routes that always show exactly one player, before any DOM is inspected. */
export const TT_PLAYER_ROUTE = /\/video\/\d+|^\/foryou|^\/$/;

/**
 * Is `el` (a <video>) a grid tile's preview rather than a player?
 *
 * Tolerates anything without `closest` — callers hand this raw DOM straight out of
 * a querySelectorAll on a page that mutates underneath them.
 */
export function isTtTileMedia(el) {
  return !!(el && typeof el.closest === "function" && el.closest(TT_TILE_LINK));
}

/**
 * Should the floating player rail exist on this surface?
 *
 * A known single-video route is enough on its own — the rail must be there before
 * a <video> has been resolved. Otherwise the only thing that counts is a centred
 * video that is NOT a tile: that keeps whatever surface the old `|| !!centered`
 * was reaching for, minus the grids it swept up by accident.
 */
export function isTtPlayerSurface(pathname, centered) {
  if (TT_PLAYER_ROUTE.test(pathname == null ? "" : String(pathname))) return true;
  return !!centered && !isTtTileMedia(centered);
}

/**
 * The part of a <video> box the picture actually covers.
 *
 * TikTok's /video/ page stretches the element across the whole black stage and
 * letterboxes with object-fit:contain, so the element's own rect hung the rail on
 * the stage's left edge and the stats card on its right edge, both off the picture.
 * `vw`/`vh` are the intrinsic size (0 until metadata loads → the box as-is).
 * shortcut: assumes the default centred object-position, read it if a player ever offsets.
 */
export function ttPaintedRect(r, vw, vh, fit) {
  if (fit !== "contain" || !vw || !vh) return r;
  const s = Math.min(r.width / vw, r.height / vh);
  const width = vw * s, height = vh * s;
  const left = r.left + (r.width - width) / 2, top = r.top + (r.height - height) / 2;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * Where the user dragged the player's stats card, for every video:
 * `{ x, y }`, each 0..1 of the room the card has inside the picture, so the same
 * spot holds at any window size and the card can never land off the picture.
 */
export const TT_CARD_POS_KEY = "sw_tt_card_pos";

/** A stored spot, or null for anything storage hands back that is not one. */
export function ttCardSpotOf(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** A spot → the top-left of a `cw`×`ch` card inside picture `r`. */
export function ttCardAt(r, cw, ch, spot) {
  return {
    left: r.left + clamp01(spot.x) * Math.max(0, r.width - cw),
    top: r.top + clamp01(spot.y) * Math.max(0, r.height - ch),
  };
}

/** The inverse: the spot for a card whose top-left was dropped at `left`/`top`. */
export function ttCardSpot(r, cw, ch, left, top) {
  const rx = r.width - cw, ry = r.height - ch;
  return { x: rx > 0 ? clamp01((left - r.left) / rx) : 0, y: ry > 0 ? clamp01((top - r.top) / ry) : 0 };
}
