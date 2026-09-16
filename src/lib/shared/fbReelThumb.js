// Facebook reel COVER images: which surfaces carry the grid, and how to ask the
// CDN for the native frame instead of the cropped one it paints.
// INLINED into content scripts — see src/lib/shared/README.md before editing
// (no imports allowed in this file).
//
// A reel tile's <img> src looks like:
//   .../t15.5256-10/791436480_..._n.jpg?stp=dst-jpg_tt6&cstp=mx1080x1920&ctp=s960x960&...&oh=...&oe=...
// which serves 540x960 even though the reel itself is 1080x1920. Probed live on
// 2026-09-06 (facebook.com/profile.php?id=61592820645925&sk=owner_reels):
//
//   ctp removed / ctp=s1080x1920 -> 1080x1920, HTTP 200
//   ctp=s2000x2000               -> 403 (past the cstp cap)
//   cstp=mx2000x2000             -> 403
//   stp removed                  -> 403
//
// So `stp` and `cstp` are covered by the `oh` HMAC and `cstp=mx1080x1920` is the
// signed ceiling, while `ctp` is a free client-side crop hint. Dropping it is
// enough — and it is the whole trick. (This does NOT generalise to profile
// photos on t39: that CDN signs the crop, which is why the photos harvester goes
// through the lightbox instead.)

/**
 * The same cover image at its native resolution (1080x1920 for a reel).
 * Byte-exact on every other parameter: the query is edited as a string rather
 * than round-tripped through URLSearchParams, because re-encoding a signed
 * parameter would invalidate `oh` and earn a 403.
 * Returns the input untouched when there is nothing to strip.
 */
export function fullResThumb(url) {
  if (typeof url !== "string" || !url) return url;
  const q = url.indexOf("?");
  if (q < 0) return url;
  const kept = url
    .slice(q + 1)
    .split("&")
    .filter((p) => !/^ctp=/.test(p));
  return kept.length ? url.slice(0, q) + "?" + kept.join("&") : url.slice(0, q);
}

/**
 * Is this URL a profile's REELS GRID (the tile wall), rather than the
 * /reel/<id> player or any other tab?
 *
 * Facebook serves the same grid under three shapes, and they are not
 * interchangeable — `sk=owner_reels` is the one a profile.php URL gets, and it
 * used to fall through every check we had because its path is `/profile.php`:
 *
 *   /profile.php?id=<id>&sk=owner_reels     numeric profile
 *   /profile.php?id=<id>&sk=reels_tab       older alias, still linked in-page
 *   /<vanity>/reels/  |  /<vanity>/reels_tab   vanity profile / page
 */
export function isReelsGridUrl(href) {
  let path, search;
  try {
    const u = new URL(String(href || ""), "https://www.facebook.com");
    path = u.pathname;
    search = u.search;
  } catch {
    return false;
  }
  if (/\/reel\/\d/.test(path)) return false; // the player owns its own rail
  if (/[?&]sk=(reels_tab|owner_reels)(&|$)/.test(search)) return true;
  return /\/reels(_tab)?\/?$/.test(path);
}

/** The reel id inside a grid tile's href, or null. */
export function reelIdFromHref(href) {
  const m = String(href || "").match(/\/reel\/(\d+)/);
  return m ? m[1] : null;
}
