// Pure, DOM-free helpers for the FB Photos tool (panel + content script). Unit-tested.
//
// ===========================================================================
// HOW THIS TOOL GETS THE FULL PHOTO — and why it used to be so much harder.
//
// Facebook's photos-grid GraphQL row carries TWO renditions of the same photo:
//
//   image.uri        → the SQUARE CROP the grid tile paints, e.g.
//                      `stp=c0.241.941.941a_dst-jpg_tt6` — a 941×941 square cut
//                      out of a 941×1672 original. The 241 px off the top and
//                      the ~490 off the bottom are physically absent from the
//                      bytes fbcdn serves.
//   viewer_image.uri → the FULL, UNCROPPED photo, e.g. `stp=dst-jpg_tt6`, with
//                      the real `width`/`height` right beside it.
//
// src/content/fb/photos-capture.js tees those rows out of the page's own XHR
// traffic (plus the server-rendered hydration blocks that carry the first grid
// page), so the whole frame arrives while the grid is merely scrolling.
// Measured 2026-07-25 on the reference profile: 43 of 43 photos resolved, no
// crop token on any captured URI, one fetched file decoding to exactly the
// 941×1672 the row reported.
//
// This replaced a much worse design that opened every photo in the theater
// lightbox to read the big <img> out of it (~57 s for 43 photos, and it drove
// the user's tab). Two dead ends from that era are still worth recording so
// nobody re-tries them:
//   • The CDN URL cannot be rewritten up. fbcdn signs the transform: `stp` is
//     covered by the `oh=` HMAC, so dropping it or forcing `stp=dst-jpg` both
//     answer 403. This is the opposite of Pinterest (see pinMedia.js), where the
//     /originals/ path is a plain string swap — do not copy that trick here.
//     It is also why a crop can never be undone once it is in the URL.
//   • The permalink is empty. GET /photo/?fbid=… answers 200 with ~1 MB of HTML
//     containing ZERO `scontent` URLs (same for /photo/download/?fbid=…),
//     because Facebook renders photo media from GraphQL after hydration.
//
// A photo whose GraphQL row was never captured has NO full URL, and nothing here
// substitutes the cropped thumbnail for it. It stays unresolved, it is counted,
// the panel says so, and the ZIP carries a text list of what is missing.
// ===========================================================================

import { downloadPath, kindFromExt, sanitizeFilenamePart } from "./downloadPath.js";
// Photo identity + the harvest caps are shared with
// src/content/fb/photos-scrape.js, which is inlined at build time because a
// content script cannot import (see src/lib/shared/README.md). The caps used to
// be declared in both places — two homes for one number.
import {
  fbidFromHref,
  setFromHref,
  ownerKeyFromUrl,
  ownerNameFromTitle,
  isPhotosSurface,
  photoBaseFromUrl,
  HARVEST_CAPS,
  harvestCap,
} from "./shared/fbPhotoIds.js";

export {
  fbidFromHref,
  setFromHref,
  ownerKeyFromUrl,
  ownerNameFromTitle,
  isPhotosSurface,
  photoBaseFromUrl,
  HARVEST_CAPS,
  harvestCap,
};


// ---------------------------------------------------------------------------
// URL / identity
// ---------------------------------------------------------------------------

export function photoPermalink(fbid, set) {
  if (!fbid) return null;
  const base = `https://www.facebook.com/photo/?fbid=${fbid}`;
  return set ? `${base}&set=${encodeURIComponent(set)}` : base;
}

// ---------------------------------------------------------------------------
// CDN URLs
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

// Fill each grid record's full-image fields from the captured GraphQL rows.
// Join order is deliberate: the node `id` IS the tile's fbid (verified live,
// 35/35 captured ids matched a tile), and the thumbnail's fbcdn stem is the
// fallback for the day that stops being true. A record that already has `full`
// is left alone, and a record with no match keeps `full: null` — an unresolved
// photo is reported, never papered over with its crop.
//
// `records` is not mutated; the merged copies are new objects.
export function mergeCaptured(records, captured) {
  const byId = new Map();
  const byStem = new Map();
  for (const c of captured || []) {
    if (!c || !c.full || c.id == null) continue;
    const id = String(c.id);
    if (!byId.has(id)) byId.set(id, c);
    const stem = photoBaseFromUrl(c.thumb) || photoBaseFromUrl(c.full);
    if (stem && !byStem.has(stem)) byStem.set(stem, c);
  }
  return (records || []).map((r) => {
    if (!r || r.full) return r;
    const stem = photoBaseFromUrl(r.thumb);
    const hit = byId.get(String(r.fbid)) || (stem ? byStem.get(stem) : null) || null;
    if (!hit) return r;
    return { ...r, full: hit.full, width: hit.width ?? null, height: hit.height ?? null };
  });
}

// Order-preserving dedupe by fbid. First sighting fixes the position; later
// sightings only FILL IN fields the first one left null — a re-scan of the grid
// must not clobber a `full` that a capture already supplied.
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

// The photos that never got a `viewer_image` URL. They are the tool's one
// honesty problem, so they get a first-class accessor rather than being derived
// ad hoc at each call site.
export function unresolvedPhotos(records) {
  return (records || []).filter((r) => r && !r.full);
}

// Which URL a run would download for one record: the full frame or nothing. The
// cropped thumbnail is NOT a fallback — shipping it as the photo is exactly the
// defect this tool was rebuilt to remove.
export function downloadUrlFor(rec) {
  return (rec && rec.full) || null;
}

// What a ZIP run will actually contain. The batch is capped BOTH by a photo
// count and by an estimated byte budget, and everything left over is reported
// as `skipped` / `unresolved` so the UI can say so out loud.
export function selectForZip(records, { maxCount = 150, maxBytes = Infinity, avgBytes = 0 } = {}) {
  const ready = [];
  for (const r of records || []) {
    const url = downloadUrlFor(r);
    if (url) ready.push({ ...r, url });
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

// A plain-text list of the photos the archive does NOT contain, written into the
// archive itself. A note in the panel scrolls away; a file inside the ZIP is
// still there next month, when the only remaining question is "did I get all of
// them?". Returns null when nothing is missing, so the caller adds no entry.
export function unresolvedManifest(records, owner) {
  const missing = unresolvedPhotos(records);
  if (!missing.length) return null;
  const lines = [
    `Fotos sem a imagem inteira: ${missing.length} de ${(records || []).length}`,
    owner ? `Perfil: ${owner}` : null,
    "",
    "Estas fotos NÃO estão neste ZIP. O Facebook entrega a imagem sem recorte",
    "(viewer_image) junto com a grade; nestas o dado não foi capturado — role a",
    "aba Fotos de novo e colete outra vez. A miniatura da grade existe, mas é um",
    "recorte quadrado e não seria a foto inteira, então não foi incluída.",
    "",
    ...missing.map((r) => `${r.fbid}\t${r.permalink || photoPermalink(r.fbid, r.set) || ""}`),
  ];
  return lines.filter((l) => l != null).join("\n") + "\n";
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

// A cap that bit is always named out loud, and always with the cap that actually
// stopped the run — the two have different budgets and different ways out.
export function capMessage(reason, caps = HARVEST_CAPS) {
  if (reason === "scroll")
    return `a grade ainda estava carregando no limite de ${caps.scrolls} rolagens — colete de novo para pegar o resto`;
  return `parado no limite de ${caps.photos} fotos por coleta — baixe estas e limpe a lista para pegar o resto`;
}

// Name of the manifest entry inside the archive. Leading "_" so it sorts to the
// top of the file list, where a "some are missing" note has to be seen.
export const UNRESOLVED_ENTRY = "_fotos-nao-resolvidas.txt";

// Everything a finished (or truncated) ZIP run has to admit to, in one pt-BR
// line. Same rule as the harvest caps: a limit that silently drops photos is the
// defect, so each of these branches has a test.
export function zipNotes({ skipped = 0, unresolved = 0, stoppedAt = null, failed = 0, maxCount = 0, maxBytes = 0 } = {}) {
  const parts = [];
  if (skipped) parts.push(`${skipped} foto(s) ficaram de fora do limite de ${maxCount} por ZIP`);
  if (unresolved) parts.push(`${unresolved} sem a imagem inteira — listadas em ${UNRESOLVED_ENTRY}`);
  if (stoppedAt != null) parts.push(`parou em ${stoppedAt} — limite de ${fmtBytes(maxBytes)} por ZIP`);
  if (failed) parts.push(`${failed} falharam ao baixar`);
  return parts.join(" · ") || null;
}

// ---------------------------------------------------------------------------
// filenames — same conventions as igMedia.js / ttMedia.js (identical bodies on
// purpose: a photo downloaded from any tool must land with the same shape of name)
// ---------------------------------------------------------------------------

// One definition, in downloadPath.js — this used to be a byte-identical copy.
export { sanitizeFilenamePart };

export function extFromUrl(url, kind) {
  const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
  return kind === "video" ? "mp4" : "jpg";
}

// fb-<owner>-<fbid>.jpg. Unlike ig/tt the owner can legitimately be unknown (a
// profile whose display name never rendered), and "fb--123.jpg" reads like a bug,
// so an empty owner degrades to "perfil" rather than an empty segment.
// Bare file name, no folder. Kept separate from the path because the bulk ZIP uses
// it for its ENTRY names: a path there would make every extracted archive rebuild a
// social-mate/facebook/fotos/ tree inside whatever folder you unzip into.
export function baseNameFor(rec, ext, idx) {
  const owner = sanitizeFilenamePart(rec.owner || rec.ownerKey) || "perfil";
  const base = `fb-${owner}-${rec.fbid || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

export function filenameFor(rec, ext, idx) {
  return downloadPath("facebook", kindFromExt(ext), baseNameFor(rec, ext, idx));
}

// "2026-07-25_16-40-12" — filesystem-safe, sorts chronologically.
export function stampFor(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// The bulk ZIP holds photos, so it sits with them under facebook/fotos rather than
// in a folder of its own — one place to look for "the photos I pulled off a page".
export function zipFilename(owner, date) {
  return downloadPath("facebook", "image", `fb-${sanitizeFilenamePart(owner) || "perfil"}-${stampFor(date)}.zip`);
}

// Human size for the UI ("2,4 MB"). pt-BR decimal comma, since every label in
// this panel is pt-BR.
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
