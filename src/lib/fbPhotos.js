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
//
// …AND THE SECOND MODE. The theater walk is the only way to get the ORIGINAL
// pixels, but it is also the slow, fragile, tab-navigating part of the tool, and
// a lot of work (OCR / reading the text baked into a post) is perfectly happy
// with the 414×414 tile image. So there is a thumbnail-only mode that just
// scrolls the grid and keeps each tile's own `img.src`. Its ONE honesty problem
// is recorded in parseCropFromUrl below: most thumbnails are square CROPS, not
// shrinks, and the crop is signed so it cannot be undone.

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

// The CROP rectangle baked into a thumbnail's `stp`, when there is one.
//
// THIS IS THE HONESTY SWITCH FOR THE THUMBNAIL-ONLY MODE. Measured on a live
// profile (2026-07-25): 34 of the 42 tiles that carried an <img> — 81% — had a
// crop token, e.g. `stp=c0.241.941.941a_dst-jpg_tt6`, which is a 941×941 SQUARE
// taken out of a 941×1672 original. The top 241 px and the bottom ~490 px are
// physically absent from the bytes fbcdn serves: any text up there is simply not
// in the file. The other 8 were plain `stp=dst-jpg_tt6` (no crop) and the cover
// photo was `stp=dst-png` at 1945×720 — also uncropped, just a wide tile.
//
// It cannot be undone by rewriting the URL: `stp` is covered by the `oh=` HMAC,
// so dropping it or swapping it for `dst-jpg` both answer 403 (verified). The
// only recourse is the theater walk, i.e. the other mode.
//
// Presence of the token is therefore also the CHEAP test for "is this tile a
// whole frame?" — no decode, no extra request, just a regex on the src. Absent
// token ⇒ the tile is the whole photo, scaled down; present ⇒ pixels are gone.
// (A `c0.0.w.ha` box is still reported as a crop: the URL never says how big the
// original was, so "the crop happens to cover everything" is not knowable here,
// and over-reporting is the safe direction for a warning.)
//
// Returns {x, y, width, height} or null (no stp, no crop token, or a malformed /
// degenerate box).
export function parseCropFromUrl(url) {
  const stp = String(url || "").match(/[?&]stp=([^&]*)/);
  if (!stp) return null;
  const m = stp[1].match(/(?:^|_)c(\d+)\.(\d+)\.(\d+)\.(\d+)a(?:_|$)/);
  if (!m) return null;
  const box = { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
  return box.width > 0 && box.height > 0 ? box : null;
}

// Per-photo "is what we would download a cropped thumbnail?". A record that has
// a full-res URL is never cropped — the theater image is the whole frame. The
// flags the content script stamps on the record win, and the thumb URL is the
// fallback so a record rehydrated from anywhere still answers correctly.
export function isCroppedThumb(rec) {
  if (!rec || rec.full) return false;
  if (rec.crop) return true;
  if (typeof rec.cropped === "boolean") return rec.cropped;
  return !!parseCropFromUrl(rec.thumb);
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

// How many of the collected photos would ship as a THUMBNAIL, and how many of
// those are square crops. This is the number the panel has to show BEFORE the
// download button is pressed — see parseCropFromUrl for why it matters.
export function thumbCropStats(records) {
  let total = 0;
  let cropped = 0;
  for (const r of records || []) {
    if (!r || r.full || !r.thumb) continue; // a resolved photo ships whole
    total++;
    if (isCroppedThumb(r)) cropped++;
  }
  return { total, cropped, whole: total - cropped };
}

// The sentence the panel prints for those stats. It lives here, not in the JSX,
// so the wording is unit-tested along with the counting — this is the warning
// that stops the tool from quietly handing over half a photo.
export function cropNotice(stats) {
  const total = stats?.total || 0;
  const cropped = stats?.cropped || 0;
  if (!total) return null;
  if (!cropped) return `Nenhuma das ${total} miniatura(s) está recortada — são quadros inteiros.`;
  return (
    `${cropped} de ${total} miniatura(s) vêm recortadas em quadrado: o que ficou fora do quadro ` +
    `não está na imagem (texto no topo ou na base pode faltar). Para a foto inteira, colete no modo alta resolução.`
  );
}

// Which URL a run would actually download for one record. In "full" mode only
// the theater rendition counts. In "thumbs" mode the tile's own image IS the
// deliverable, so it stands in whenever no full-res URL was captured.
export function downloadUrlFor(rec, mode = "full") {
  if (!rec) return null;
  if (rec.full) return rec.full;
  return mode === "thumbs" ? rec.thumb || null : null;
}

// What a ZIP run will actually contain. Each entry carries the `url` that will be
// fetched and `fromThumb` (a cropped-thumbnail warning applies to it); the batch
// is capped BOTH by a photo count and by an estimated byte budget, and everything
// left over is reported as `skipped` so the UI can say so out loud instead of
// silently truncating.
export function selectForZip(records, { maxCount = 150, maxBytes = Infinity, avgBytes = 0, mode = "full" } = {}) {
  const ready = [];
  for (const r of records || []) {
    const url = downloadUrlFor(r, mode);
    if (url) ready.push({ ...r, url, fromThumb: !r.full });
  }
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
// caps — the numbers, the decision, and the sentence
//
// Every cap in this tool must SAY that it bit. A live profile is nowhere near
// any of them (the one this tool was built on has 43 photos against a cap of
// 300), so the only way these paths ever run is a unit test driving them with a
// fake tile set — which is exactly what fbPhotos.test.js does. photos-scrape.js
// mirrors harvestCap verbatim (it cannot import; see its header).
// ---------------------------------------------------------------------------

export const HARVEST_CAPS = { photos: 300, scrolls: 60, steps: 420 };

// Returns the cap that has bitten, or null while there is budget left.
//   photos  — the store is full (both modes: a thumbnail run grows it by
//             scrolling, a full-res run grows it by walking).
//   steps   — too many theater advances; guards a set that loops forever.
//   scroll  — the scroll budget ran out while the grid was STILL GROWING.
//             `growing:false` means the grid simply ended, which is not a cap.
export function harvestCap({ photos = 0, steps = 0, scrolls = 0, growing = false } = {}, caps = HARVEST_CAPS) {
  if (photos >= caps.photos) return "photos";
  if (steps >= caps.steps) return "steps";
  if (scrolls >= caps.scrolls && growing) return "scroll";
  return null;
}

// A cap that bit is always named out loud, and always with the cap that actually
// stopped the run — the grid scroll and the photo walk have different budgets
// and "collect again" only helps for some of them. In thumbnail mode a repeat
// collect would re-read the same first `photos` tiles, so that case gets its own
// (accurate) advice instead.
export function capMessage(reason, caps = HARVEST_CAPS, mode = "full") {
  if (reason === "scroll")
    return `a grade ainda estava carregando no limite de ${caps.scrolls} rolagens — colete de novo para pegar o resto`;
  if (reason === "steps")
    return `parado no limite de ${caps.steps} aberturas de foto — colete de novo para continuar`;
  return mode === "thumbs"
    ? `parado no limite de ${caps.photos} fotos por coleta — baixe estas e limpe a lista para pegar o resto`
    : `parado no limite de ${caps.photos} fotos por coleta — colete de novo para continuar`;
}

// Everything a finished (or truncated) ZIP run has to admit to, in one pt-BR
// line. Same rule as the harvest caps: a limit that silently drops photos is the
// defect, so each of these branches has a test.
export function zipNotes({ skipped = 0, unresolved = 0, stoppedAt = null, failed = 0, maxCount = 0, maxBytes = 0, mode = "full" } = {}) {
  const parts = [];
  if (skipped) parts.push(`${skipped} foto(s) ficaram de fora do limite de ${maxCount} por ZIP`);
  if (unresolved) parts.push(mode === "thumbs" ? `${unresolved} sem imagem nenhuma` : `${unresolved} sem resolução alta ainda`);
  if (stoppedAt != null) parts.push(`parou em ${stoppedAt} — limite de ${fmtBytes(maxBytes)} por ZIP`);
  if (failed) parts.push(`${failed} falharam ao baixar`);
  return parts.join(" · ") || null;
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
