// FB photo identity: tile href / page URL / <title> / fbcdn URL → stable keys,
// plus the harvest caps. INLINED into content scripts — see
// src/lib/shared/README.md before editing (no imports allowed in this file).

// Tile hrefs come in two shapes on the same page:
//   /photo.php?fbid=<id>&set=pb.<ownerId>.-2207520000&type=3   (grid tiles)
//   /photo/?fbid=<id>&set=a.<albumId>                          (cover / album)
// Both carry fbid, which is the only stable per-photo identifier we get — and it
// is the same value the GraphQL row calls `id`, which is what joins the two.
export function fbidFromHref(href) {
  const m = String(href || "").match(/[?&#]fbid=(\d+)/);
  return m ? m[1] : null;
}

// The photo "set" a tile belongs to. Only used to rebuild a permalink now that
// nothing walks the set.
export function setFromHref(href) {
  const m = String(href || "").match(/[?&#]set=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// The profile this page belongs to: the numeric `id` for /profile.php URLs, else
// the vanity path segment. Used to key the store per profile and to name files
// when the display name can't be read.
export function ownerKeyFromUrl(href) {
  try {
    const u = new URL(String(href), "https://www.facebook.com");
    const id = u.searchParams.get("id");
    if (id) return id;
    const seg = u.pathname.split("/").filter(Boolean)[0] || null;
    if (!seg || seg === "profile.php" || seg === "photo" || seg === "photo.php") return null;
    // FB vanity names are letters/digits/dots/hyphens. Anything else means the
    // caller handed us something that isn't a profile URL at all (a bare string
    // resolves against the base and would otherwise come back percent-encoded).
    return /^[A-Za-z0-9.-]+$/.test(seg) ? seg : null;
  } catch {
    return null;
  }
}

// Facebook's <title> is the cheapest locale-independent source for the display
// name: "(3) Astra Vale | Facebook" → "Astra Vale". The unread-notification
// counter and the " | Facebook" suffix are always stripped; a few surfaces title
// themselves "Fotos de <name>" instead, so that prefix is peeled too.
export function ownerNameFromTitle(title) {
  const t = String(title || "")
    .replace(/^\(\d+\+?\)\s*/, "")
    .replace(/\s*[|·]\s*Facebook\s*$/i, "")
    .trim();
  if (!t || /^facebook$/i.test(t)) return null;
  const m = t.match(/^(?:fotos?|photos?)\s+(?:de|do|da|of)\s+(.+)$/i);
  const name = (m ? m[1] : t).trim();
  return name ? name.slice(0, 60) : null;
}

// The photos surface, in any of its tab flavours (sk=photos, photos_by,
// photos_of, photos_albums) plus the vanity /<name>/photos path. `/photo/` and
// `/photo.php` are the theater viewer — deliberately NOT a match: the harvest
// scrolls a grid, and a lone photo page has no grid to scroll.
export function isPhotosSurface(href) {
  try {
    const u = new URL(String(href), "https://www.facebook.com");
    if (/(^|&)sk=photos/.test(u.search.slice(1))) return true;
    return /\/photos(_[a-z]+)?\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

// Every rendition of one photo shares the same fbcdn filename stem —
// "<uploadId>_<mediaId>_<hash>" in ".../753953991_122111787363372141_5417810366950726345_n.jpg".
// Only the query string (the signed transform) differs, so the stem joins the
// grid tile's cropped <img src> to the captured `viewer_image.uri` even if
// Facebook ever stops using the fbid as the GraphQL node id. NOTE the stem's
// media id is NOT the fbid (they differ by a small constant) — it is a join key,
// never a photo identifier.
export function photoBaseFromUrl(url) {
  const m = String(url || "").match(/\/(\d+_\d+_\d+)_[a-z]\.(?:jpg|jpeg|png|webp|gif)/i);
  return m ? m[1] : null;
}

// Every cap in this tool must SAY that it bit. A live profile is nowhere near any
// of them (the one this tool was built on has 43 photos against a cap of 300), so
// the only way these paths ever run is a unit test driving them with a fake tile
// set. The numbers live HERE, once — the content script used to re-declare them.
export const HARVEST_CAPS = { photos: 300, scrolls: 60 };

// Returns the cap that has bitten, or null while there is budget left.
//   photos  — the store is full.
//   scroll  — the scroll budget ran out while the grid was STILL GROWING.
//             `growing:false` means the grid simply ended, which is not a cap.
export function harvestCap({ photos = 0, scrolls = 0, growing = false } = {}, caps = HARVEST_CAPS) {
  if (photos >= caps.photos) return "photos";
  if (scrolls >= caps.scrolls && growing) return "scroll";
  return null;
}
