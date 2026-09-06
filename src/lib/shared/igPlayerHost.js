// Which media on an Instagram page is THE PLAYER — the one a floating, top-level
// rail may be drawn for — and which is a grid tile that already carries its own
// in-tile rail. INLINED into content scripts — see src/lib/shared/README.md before
// editing (no imports allowed in this file).
//
// Shared between the MAIN-world stamper (main-world.js `annotateReelPlayer`) and
// the isolated bridge that draws the rails (bridge.js `renderOverlays`) because
// both were asking the same question and both were answering it with the ROUTE
// ALONE: `/^\/(reels?|p)\//` matches, so stamp/draw for every <video> big enough.
//
// That is only true when a post page is loaded on its own. Clicking a result on a
// grid — explore, hashtag search, a profile — pushes /p/<code>/ while THE GRID
// STAYS MOUNTED behind the modal. Measured live on
// /explore/search/keyword/?q=%23auralytrend → click (2026-08-25): 25 stamped
// hosts, 24 of them grid tiles at 279x372 (over the 200px floor) and one real
// player. Each tile then got a SECOND rail in #sw-ig-layer, which is
// position:fixed at z-index 2147483000 — above Instagram's own dialog — so 72
// phantom nodes painted across the open post, and because `.sw-acts` is
// pointer-events:auto they also swallowed clicks meant for the caption and the
// comment box. Worse, a tile rail and its phantom showed different media, so the
// numbers next to the video were another post's.
//
// Structure, not route, is the discriminator: a grid tile is wrapped in its own
// permalink <a>, and the player never is — true for the modal player, the
// standalone /p/ page and the fullscreen /reels/ player alike, with no dependency
// on Instagram's dialog markup.

/** Instagram's grid tiles: every one is an anchor to the media's own permalink. */
export const IG_TILE_LINK = 'a[href*="/p/"], a[href*="/reel/"]';

/** The routes that can show a single-media player: /p/, /reel/, /reels/. */
export const IG_PLAYER_ROUTE = /^\/(reels?|p)\//;

/** Is `pathname` a route that can show a player at all? */
export function onIgPlayerRoute(pathname) {
  return IG_PLAYER_ROUTE.test(pathname == null ? "" : String(pathname));
}

/**
 * Is `el` (a <video> or the box around it) part of a grid tile?
 *
 * Tolerates anything without `closest` — the callers hand this raw DOM straight
 * out of a querySelectorAll on a page that is mutating underneath them.
 */
export function isIgTileMedia(el) {
  return !!(el && typeof el.closest === "function" && el.closest(IG_TILE_LINK));
}

/**
 * May a floating rail be drawn for `el` on `pathname`?
 *
 * Both halves matter: off a player route there is no player to draw for, and on
 * one, everything still wrapped in a permalink is a tile the caller has already
 * served in place.
 */
export function isIgPlayerMedia(el, pathname) {
  return !!el && onIgPlayerRoute(pathname) && !isIgTileMedia(el);
}

// Where a rail may paint at all. The profile HOVERCARD — hover a username in the
// feed or a comment thread and Instagram opens a popover with the account's three
// latest posts — carries real /p/<code>/ anchors, so the tile scan matched them
// and stamped three full stat rails over a 120px thumbnail each. Measured live on
// /p/<code>/ → hover the author (2026-08-31): the card is a portal with three
// 120x120 permalink tiles whose `closest("main")` and `closest('[role=dialog]')`
// are BOTH null, while every surface a rail belongs on answers one of them —
// profile/explore grid tiles and the fullscreen /reels/ player sit inside <main>,
// and the post modal is its own portal inside [role="dialog"] (also outside
// <main>, so requiring <main> alone would kill the modal's rail).
//
// Size is not the discriminator: a narrow window shrinks real grid tiles toward
// the same 120px, and the card's tiles grow on a wide one.

/** The two containers that hold Instagram's own media surfaces. */
export const IG_RAIL_SURFACE = 'main, [role="dialog"]';

/**
 * Is `el` inside a surface a rail may annotate (page content or the post modal)?
 *
 * False for popovers Instagram renders outside both — today the profile
 * hovercard. Tolerates anything without `closest`, like the checks above.
 */
export function onIgRailSurface(el) {
  return !!(el && typeof el.closest === "function" && el.closest(IG_RAIL_SURFACE));
}
