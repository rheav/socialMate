// Instagram engagement / date / filename formatting. INLINED into content scripts
// — see src/lib/shared/README.md before editing (no imports allowed in this file).
//
// src/lib/igMedia.js re-exports all of it, so the panel's IG Sort tool and the
// in-page overlay run one implementation. They used to run two: bridge.js carried
// erOf / fmtDateOvl / dateFromPkOvl / fmtErOvl / sanit / igExt / igName as hand
// copies, including a SECOND literal of the snowflake epoch below — a number that
// would have to be changed in both places on the same day, and never would be.

// ER weights — IG Sorter's defaults (comments & reposts each count 4×, likes 1×).
// Tweak to reweight; the overlay and the panel both read these.
//
// Passive-only data: counts come from JSON Instagram parses itself (we make no API
// calls of our own). Reels-tab payloads carry views; posts-grid payloads often
// don't. Missing reposts count as 0; missing views make ER null so ER-sorted lists
// and labels degrade gracefully (null sorts last, shows "—").
import { sanitizeFilenamePart } from "./filenames.js";
import { fmtDate } from "./fmt.js";
// The weights live in igFilters (one definition: the panel edits them, the page
// reads them, and two inlined copies of the same const would not parse).
import { ER_WEIGHTS } from "./igFilters.js";
// fmtDate/fmtER used to be declared here. They moved to ./fmt.js — TikTok prints
// the same two strings, and this file's copy already had a twin in ttMedia.js.
// Importers take them from there; nothing in this module needs them.


export function engagementRate(rec, weights) {
  const v = rec.play_count;
  if (!v || v <= 0) return null;
  // ER = (like×wLike + comment×wComment + repost×wRepost) / plays × 100 — the
  // exact shape IG Sorter uses. (IG exposes no save count, so saves are omitted.)
  const w = weights || ER_WEIGHTS;
  const eng =
    w.like * (rec.like_count || 0) +
    w.comment * (rec.comment_count || 0) +
    w.repost * (rec.repost || 0);
  return (eng / v) * 100;
}

// IG media ids encode creation time in their high bits (snowflake, epoch below),
// so we can show a date even when the lightweight grid JSON omits taken_at.
// The id is minted when the upload starts, ~30 s before taken_at (measured
// 2026-10-05 on five posts: 29–37 s), so prefer taken_at whenever it is there.
const IG_EPOCH_MS = 1314220021721n;
/** Unix SECONDS the media id was minted, or null. */
export function pkSeconds(pk) {
  const raw = String(pk || "").split("_")[0];
  if (!/^\d{6,}$/.test(raw)) return null;
  try {
    return Number(((BigInt(raw) >> 23n) + IG_EPOCH_MS) / 1000n);
  } catch {
    return null;
  }
}
/** "YYYY-MM-DD" (viewer's time zone) the media id was minted, or "". */
export function dateFromPk(pk) {
  return fmtDate(pkSeconds(pk));
}

// Same scrubber as downloadPath.js's, which the fb/tt/pin libs share. It has to be
// restated here because a module in src/lib/shared/ may not import anything but a
// sibling — and downloadPath.js is a panel/background module, not an inlinable one.
// What this buys: the page overlay and the panel now name the same record the same
// way, which they demonstrably did not before.

export function extFromUrl(url, kind) {
  const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
  return kind === "video" ? "mp4" : "jpg";
}

// Bare file name, no folder — and it LEADS with the creator's handle.
//
// The handle used to sit in the middle ("ig-ivymoontarot7-DaBF.mp4"), which reads
// fine in a bucketed tree and badly in a flat one: sorted by name, every file
// grouped by PLATFORM and nothing grouped by creator. Since the folder became a
// setting (0.99.0) a flat folder is a supported layout, and in a flat folder the
// name is the only structure there is — so the handle goes first and a creator's
// videos, covers and audio sit together. The platform tag stays, just demoted.
// Kept separate from the path so the cover-only button can rename it (-thumb) —
// the suffix is what marks a cover now that covers share the imagens/ bucket with
// the full-size images.
export function baseNameFor(rec, ext, idx) {
  // An empty handle used to produce "ig--DaBF.mp4"; the fallback keeps the shape.
  const who = sanitizeFilenamePart(rec.username) || "instagram";
  const base = `${who}-ig-${rec.code || rec.pk || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}
