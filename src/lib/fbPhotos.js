// Pure, DOM-free helpers for the FB Photos tool (panel + content script). Unit-tested.
//
// WHY this platform needs a DOM walk at all — three dead ends, all verified live
// on a real profile (2026-07-25), recorded here because every design choice below
// is a consequence of one of them:
//
//  1. A grid tile's <img> is only a 414×414 thumbnail. There is no srcset and no
//     bigger variant anywhere in the tile's markup.
//  2. The CDN URL CANNOT be rewritten up to the original. fbcdn signs the
//     transform: `stp=c0.241.941.941a_dst-jpg_tt6` (plus `cstp`/`ctp` size boxes)
//     is covered by the `oh=` HMAC, so dropping `stp` or forcing `stp=dst-jpg`
//     both return 403. This is the opposite of Pinterest (see pinMedia.js), where
//     the /originals/ path is a plain string swap — do not copy that trick here.
//  3. The permalink is empty. `fetch("https://www.facebook.com/photo/?fbid=…")`
//     answers 200 with ~1 MB of HTML containing ZERO `scontent` URLs and no
//     photo_image/image.uri keys; the same is true of /photo/download/?fbid=…
//     Facebook renders photo media from GraphQL after hydration, so there is
//     nothing to scrape out of the server response.
//
// What IS left: the theater viewer. Opening a photo loads a genuinely large
// `<img data-visualcompletion="media-vc-image">` (measured 1122×1402 / 941×1672
// where the tile was 414×414) and the viewer has a "next photo" control that
// advances the whole set without a page load. photos-scrape.js drives that; the
// helpers here are the parts of it that can be tested without a browser.

// ---------------------------------------------------------------------------
// URL / identity
// ---------------------------------------------------------------------------

// Tile hrefs come in two shapes on the same page:
//   /photo.php?fbid=<id>&set=pb.<ownerId>.-2207520000&type=3   (grid tiles)
//   /photo/?fbid=<id>&set=a.<albumId>                          (cover / album)
// Both carry fbid, which is the only stable per-photo identifier we get.
export function fbidFromHref(href) {
  const m = String(href || "").match(/[?&#]fbid=(\d+)/);
  return m ? m[1] : null;
}

// The photo "set" a tile belongs to. The theater's next/previous controls walk
// THIS set, so it also tells us which stream a walk is currently traversing.
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
// `/photo.php` are the theater — deliberately NOT a match, since the walk sends
// the page there and must still know it started from a grid.
export function isPhotosSurface(href) {
  try {
    const u = new URL(String(href), "https://www.facebook.com");
    if (/(^|&)sk=photos/.test(u.search.slice(1))) return true;
    return /\/photos(_[a-z]+)?\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export function photoPermalink(fbid, set) {
  if (!fbid) return null;
  const base = `https://www.facebook.com/photo/?fbid=${fbid}`;
  return set ? `${base}&set=${encodeURIComponent(set)}` : base;
}

// ---------------------------------------------------------------------------
// CDN URLs
// ---------------------------------------------------------------------------

// Every rendition of one photo shares the same fbcdn filename stem —
// "<uploadId>_<mediaId>_<hash>" in ".../753953991_122111787363372141_5417810366950726345_n.jpg".
// Only the query string (the signed size transform) differs. That makes the stem
// the join key for "all candidate renditions of the photo on screen right now":
// the 414×414 grid tile and the 1254×1254 theater image share it, so pickBest()
// can compare them. NOTE the stem's media id is NOT the fbid (they differ by a
// small constant on this account) — never use it as a photo identifier.
export function photoBaseFromUrl(url) {
  const m = String(url || "").match(/\/(\d+_\d+_\d+)_[a-z]\.(?:jpg|jpeg|png|webp|gif)/i);
  return m ? m[1] : null;
}

// Pixel box encoded in an fbcdn URL, when present. `cstp=mx941x1672` /
// `ctp=s941x1672` are the theater's requested max box; `stp=dst-jpg_s960x960` is
// the older form. Used as a size hint for a candidate whose <img> has not decoded
// yet (naturalWidth is 0 until it does).
export function parseBoxFromUrl(url) {
  const s = String(url || "");
  const m =
    s.match(/[?&]cstp=mx(\d+)x(\d+)/) ||
    s.match(/[?&]ctp=s(\d+)x(\d+)/) ||
    s.match(/[?&]stp=[^&]*?_s(\d+)x(\d+)/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// Largest candidate wins. `candidates` are {url, width, height}; a candidate with
// no usable dimensions falls back to the URL's size box, and failing that counts
// as area 0 — still selectable when it is all we have (the first such candidate
// wins, so capture order decides). Returns a normalised {url, width, height}.
export function pickBest(candidates) {
  let best = null;
  let bestArea = -1;
  for (const c of candidates || []) {
    if (!c || !c.url) continue;
    let w = Number(c.width) || 0;
    let h = Number(c.height) || 0;
    if (!w || !h) {
      const box = parseBoxFromUrl(c.url);
      if (box) { w = box.width; h = box.height; }
    }
    const area = w * h;
    if (area > bestArea) { best = { url: c.url, width: w || null, height: h || null }; bestArea = area; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

// Order-preserving dedupe by fbid. First sighting fixes the position; later
// sightings only FILL IN fields the first one left null. That is exactly the
// lifecycle here: the grid scan contributes {thumb, set}, the theater walk later
// contributes {full, width, height} for the same fbid, and neither should clobber
// the other.
export function dedupeByFbid(records) {
  const out = [];
  const at = new Map();
  for (const r of records || []) {
    if (!r) continue;
    const id = r.fbid == null ? null : String(r.fbid);
    if (!id) continue;
    if (!at.has(id)) {
      at.set(id, out.length);
      out.push({ ...r, fbid: id });
      continue;
    }
    const cur = out[at.get(id)];
    for (const k of Object.keys(r)) if (cur[k] == null && r[k] != null) cur[k] = r[k];
  }
  return out;
}

export function summarize(records) {
  const list = records || [];
  let resolved = 0;
  for (const r of list) if (r && r.full) resolved++;
  return { total: list.length, resolved, pending: list.length - resolved };
}

// What a ZIP run will actually contain. Only photos whose full-res URL was
// captured can go in; the batch is then capped BOTH by a photo count and by an
// estimated byte budget, and everything left over is reported as `skipped` so the
// UI can say so out loud instead of silently truncating.
export function selectForZip(records, { maxCount = 150, maxBytes = Infinity, avgBytes = 0 } = {}) {
  const ready = (records || []).filter((r) => r && r.full);
  const byBytes = avgBytes > 0 && maxBytes !== Infinity ? Math.max(1, Math.floor(maxBytes / avgBytes)) : Infinity;
  const limit = Math.min(maxCount, byBytes);
  const batch = ready.slice(0, limit);
  return {
    batch,
    skipped: ready.length - batch.length,
    unresolved: (records || []).length - ready.length,
  };
}

// ---------------------------------------------------------------------------
// filenames — same conventions as igMedia.js / ttMedia.js (identical bodies on
// purpose: a photo downloaded from any tool must land with the same shape of name)
// ---------------------------------------------------------------------------

export function sanitizeFilenamePart(s) {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function extFromUrl(url, kind) {
  const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
  return kind === "video" ? "mp4" : "jpg";
}

// fb-<owner>-<fbid>.jpg. Unlike ig/tt the owner can legitimately be unknown (a
// profile whose display name never rendered), and "fb--123.jpg" reads like a bug,
// so an empty owner degrades to "perfil" rather than an empty segment.
export function filenameFor(rec, ext, idx) {
  const owner = sanitizeFilenamePart(rec.owner || rec.ownerKey) || "perfil";
  const base = `fb-${owner}-${rec.fbid || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

// "2026-07-25_16-40-12" — filesystem-safe, sorts chronologically.
export function stampFor(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function zipFilename(owner, date) {
  return `socialmate-fotos/fb-${sanitizeFilenamePart(owner) || "perfil"}-${stampFor(date)}.zip`;
}

// Human size for the UI ("2,4 MB"). pt-BR decimal comma, since every label in
// this panel is pt-BR.
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
