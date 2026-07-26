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

export const ER_WEIGHTS = { like: 1, comment: 4, repost: 4 };

export function engagementRate(rec) {
  const v = rec.play_count;
  if (!v || v <= 0) return null;
  // ER = (like×wLike + comment×wComment + repost×wRepost) / plays × 100 — the
  // exact shape IG Sorter uses. (IG exposes no save count, so saves are omitted.)
  const w = ER_WEIGHTS;
  const eng =
    w.like * (rec.like_count || 0) +
    w.comment * (rec.comment_count || 0) +
    w.repost * (rec.repost || 0);
  return (eng / v) * 100;
}

// Unix seconds → "YYYY-MM-DD" (empty string when missing/invalid).
export function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// IG media ids encode creation time in their high bits (snowflake, epoch below),
// so we can show a date even when the lightweight grid JSON omits taken_at.
const IG_EPOCH_MS = 1314220021721n;
export function dateFromPk(pk) {
  const raw = String(pk || "").split("_")[0];
  if (!/^\d{6,}$/.test(raw)) return "";
  try {
    const ms = (BigInt(raw) >> 23n) + IG_EPOCH_MS;
    const d = new Date(Number(ms));
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

// Engagement-rate label. Never collapses to "0.0%": 1 decimal ≥10, 2 decimals
// ≥0.1, else 2 significant figures (e.g. "0.06%", "0.004%").
export function fmtER(er) {
  if (er == null) return null;
  if (er === 0) return "0%";
  if (er >= 10) return er.toFixed(1) + "%";
  if (er >= 0.1) return er.toFixed(2) + "%";
  return Number(er.toPrecision(2)) + "%";
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

// Bare file name, no folder. Kept separate from the path so the cover-only button
// can rename it (-thumb) and file it under miniaturas instead of with the media.
export function baseNameFor(rec, ext, idx) {
  const base = `ig-${sanitizeFilenamePart(rec.username)}-${rec.code || rec.pk || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}
