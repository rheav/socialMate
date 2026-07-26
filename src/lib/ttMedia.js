// Pure, DOM-free helpers for the TikTok Sort tool (panel side). Unit-tested.
//
// Data is passive: it comes from response bodies TikTok's own fetch() already
// requested (teed by the MAIN-world hook, relayed through the bridge). We make no
// API calls of our own. TikTok's item_list exposes more than IG/FB grids — likes,
// comments, shares AND saves are all present on the list — so the ER weight set is
// richer than IG's.

import { downloadPath, kindFromExt, sanitizeFilenamePart } from "./downloadPath.js";

// ER weights: like 1×, comment & share 4×, save (collect) 2×. Tunable.
export const ER_WEIGHTS = { like: 1, comment: 4, share: 4, save: 2 };

export function engagementRate(rec) {
  const v = rec.play_count;
  if (!v || v <= 0) return null;
  const w = ER_WEIGHTS;
  const eng =
    w.like * (rec.digg_count || 0) +
    w.comment * (rec.comment_count || 0) +
    w.share * (rec.share_count || 0) +
    w.save * (rec.collect_count || 0);
  return (eng / v) * 100;
}

// Unix seconds → "YYYY-MM-DD" (empty string when missing/invalid).
export function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// Engagement-rate label. Never collapses to "0.0%".
export function fmtER(er) {
  if (er == null) return null;
  if (er === 0) return "0%";
  if (er >= 10) return er.toFixed(1) + "%";
  if (er >= 0.1) return er.toFixed(2) + "%";
  return Number(er.toPrecision(2)) + "%";
}

// Compact engagement count for display: 964490 -> "964.5K", 1200000 -> "1.2M".
export function fmtCount(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// Parse a displayed abbreviated count back to a number: "51.9M" -> 51900000,
// "964.5K" -> 964500, "1,2 mil" -> 1200, "222" -> 222. Used for the DOM-tile
// fallback (data-e2e views), which show abbreviated strings. null when unparseable.
export function parseCount(s) {
  if (s == null) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const t = String(s).trim().toLowerCase().replace(/\s+/g, " ");
  const m = t.match(/^([\d.,]+)\s*(k|m|b|mil|mi|bi)?$/);
  if (!m) return null;
  // Normalize decimal: a comma is the decimal sep in pt-br ("1,2"); strip
  // thousands dots when both are present.
  let numPart = m[1];
  if (numPart.includes(",") && numPart.includes(".")) numPart = numPart.replace(/\./g, "").replace(",", ".");
  else numPart = numPart.replace(",", ".");
  const base = parseFloat(numPart);
  if (!Number.isFinite(base)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, mil: 1e3, mi: 1e6, bi: 1e9 }[m[2]] || 1;
  return Math.round(base * mult);
}

const METRIC = {
  views: (r) => r.play_count,
  likes: (r) => r.digg_count,
  comments: (r) => r.comment_count,
  shares: (r) => r.share_count,
  saves: (r) => r.collect_count,
  date: (r) => r.create_time,
  er: engagementRate,
};

// Comparator over TikTok records. Missing metrics always sort last, whatever the
// direction (pinned-but-statless items don't jump the list).
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
  if (key === "default") return [...records]; // capture order (≈ TikTok's own order)
  return [...records].sort(sortComparator(key, dir));
}

export function recordToCard(rec) {
  return {
    id: rec.id,
    username: rec.username || rec.nickname || "unknown",
    thumb: rec.cover || rec.dynamic_cover || null,
    views: rec.play_count ?? null,
    likes: rec.digg_count ?? null,
    comments: rec.comment_count ?? null,
    shares: rec.share_count ?? null,
    saves: rec.collect_count ?? null,
    date: fmtDate(rec.create_time),
    hasVideo: !!rec.video,
    pinned: !!rec.pinned,
    permalink: rec.username && rec.id ? `https://www.tiktok.com/@${rec.username}/video/${rec.id}` : null,
  };
}

// One definition, in downloadPath.js — this used to be a byte-identical copy.
export { sanitizeFilenamePart };

// Bare file name, no folder. Kept separate from the path so the cover-only button
// can rename it (-thumb) and file it under miniaturas instead of with the media.
export function baseNameFor(rec, ext, idx) {
  const base = `tt-${sanitizeFilenamePart(rec.username || rec.nickname)}-${rec.id || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

// TikTok downloads are videos, but the cover is fetched through the same namer —
// so the sub-folder follows the actual media, not the platform default.
export function filenameFor(rec, ext, idx) {
  return downloadPath("tiktok", kindFromExt(ext), baseNameFor(rec, ext, idx));
}

// "Baixar miniatura": the same name with a -thumb suffix, under miniaturas.
export function thumbFilenameFor(rec, ext) {
  const name = baseNameFor(rec, ext).replace(new RegExp("\\." + ext + "$"), "-thumb." + ext);
  return downloadPath("tiktok", "thumb", name);
}

export function extFromUrl(url, kind) {
  const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
  return kind === "video" ? "mp4" : "jpg";
}

// Scope captured records to a surface. TikTok's fetch capture also picks up
// recommended/related items while you browse, so a raw surface match still leaks
// other creators. On a profile surface we additionally require the record's author
// to BE that profile; hashtag/search/feed surfaces are legitimately multi-author.
export function filterBySurface(records, surface) {
  if (!surface) return records;
  return records.filter((r) => {
    if (r.surface !== surface) return false;
    if (surface.startsWith("profile:")) {
      const owner = surface.slice("profile:".length).toLowerCase();
      const u = (r.username || "").toLowerCase();
      return u === owner || u === "";
    }
    return true;
  });
}
