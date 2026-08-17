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
import { downloadPath, sanitizeFilenamePart } from "./downloadPath.js";
// parseCount lives in shared/ because the FB content scripts need it and cannot
// import (an import turns a content script into a dynamic-import loader — see
// src/lib/shared/README.md). Re-exported here so every existing caller and test
// keeps its import path.
import { parseCount, COUNT_UNITS } from "./shared/counts.js";

export { parseCount, COUNT_UNITS };

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

// One definition, in downloadPath.js — this used to be a byte-identical copy.
export { sanitizeFilenamePart };

// The Reels Sort tool only ever downloads the reel's COVER image, so this always
// files it with the other images; the -thumb suffix is what marks it as a cover.
export function filenameFor(owner, id) {
  return downloadPath("thumb", `fb-${sanitizeFilenamePart(owner) || "reel"}-${id || Date.now()}.jpg`);
}
