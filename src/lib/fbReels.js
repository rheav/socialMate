// Pure, DOM-free helpers for the FB Reels Sort tool (panel side). Unit-tested.
//
// Facebook's reels-tab grid is thinner than Instagram's: it paginates OFF the
// main thread (a JSON.parse hook captures nothing — verified live), so the only
// universally-available stat is the VIEW COUNT rendered as localized text on
// each tile ("14 mil", "1,5 mil", "1.2M"). Comment/share/date come from the
// initial embedded <script> JSON for the first batch only. Likes/reactions are
// not exposed on the grid at all. So: views is the primary sort axis; comments,
// shares, date are best-effort.

import { fmtCount } from "./igMedia.js";
export { fmtCount };

// Localized abbreviated-count multipliers. FB renders tile view counts
// abbreviated with a locale word/suffix: pt-br "mil"/"mi", en "K"/"M", plus a
// few other locales' short forms.
const UNIT = {
  k: 1e3, mil: 1e3, rb: 1e3, tis: 1e3, tys: 1e3, tusen: 1e3,
  m: 1e6, mi: 1e6, mio: 1e6, jt: 1e6, mln: 1e6,
  b: 1e9, mrd: 1e9, bi: 1e9,
};

/**
 * Parse a localized count string off a reel tile into a number, or null.
 *   "14 mil" -> 14000   "1,5 mil" -> 1500   "1.2M" -> 1200000   "543" -> 543
 * When a unit word/suffix is present the numeric part is a small decimal, so a
 * comma is the decimal separator (pt-br "1,5"). Without a unit the value is a
 * plain integer whose separators are thousands groups and are stripped.
 */
export function parseCount(text) {
  if (text == null) return null;
  const s = String(text).trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/^([\d.,]+)([a-zçã]+)?$/);
  if (!m) return null;
  const rawNum = m[1];
  const unitWord = m[2] || "";
  const mult = unitWord ? UNIT[unitWord] : 1;
  if (unitWord && mult == null) return null; // unknown suffix → not a count
  let num;
  if (mult === 1) {
    // Plain integer: strip thousands separators (either "." or ",").
    num = parseInt(rawNum.replace(/[.,]/g, ""), 10);
  } else {
    // Abbreviated decimal: last separator is the decimal point.
    const norm = rawNum.replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    num = parseFloat(norm);
  }
  if (!Number.isFinite(num)) return null;
  return Math.round(num * mult);
}

const METRIC = {
  views: (r) => r.views,
  comments: (r) => r.comments,
  shares: (r) => r.shares,
  date: (r) => r.taken_at,
};

// Comparator over FB reel records. Missing metrics always sort last, whatever
// the direction (so a views-sorted list keeps stat-less tiles at the bottom).
export function sortComparator(key, dir = "desc") {
  const get = METRIC[key] || METRIC.views;
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign;
  };
}

export function sortRecords(records, key, dir) {
  if (key === "default") return [...records]; // capture order (≈ FB's own order)
  return [...records].sort(sortComparator(key, dir));
}

// Unix seconds → "YYYY-MM-DD" (empty string when missing/invalid).
export function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function recordToCard(rec) {
  return {
    id: rec.id,
    thumb: rec.thumb || null,
    views: rec.views ?? null,
    comments: rec.comments ?? null,
    shares: rec.shares ?? null,
    date: fmtDate(rec.taken_at),
    permalink: rec.id ? `https://www.facebook.com/reel/${rec.id}` : null,
  };
}

export function sanitizeFilenamePart(s) {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function filenameFor(owner, id) {
  return `fb-${sanitizeFilenamePart(owner) || "reel"}-${id || Date.now()}.jpg`;
}
