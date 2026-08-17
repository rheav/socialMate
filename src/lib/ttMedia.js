// Pure, DOM-free helpers for the TikTok Sort tool (panel side). Unit-tested.
//
// Data is passive: it comes from response bodies TikTok's own fetch() already
// requested (teed by the MAIN-world hook, relayed through the bridge). We make no
// API calls of our own. TikTok's item_list exposes more than IG/FB grids — likes,
// comments, shares AND saves are all present on the list — so the ER weight set is
// richer than IG's.

import { downloadPath, kindFromExt, sanitizeFilenamePart } from "./downloadPath.js";
import { fmtCount, parseCount } from "./shared/counts.js";
// The page overlay runs the SAME code: everything below is inlined into
// src/content/tt/tt-relay.js by scripts/gen-inline.mjs, so the rail on a tile and
// the rail in this panel can never report different numbers.
import {
  TT_ER_WEIGHTS,
  TT_ER_WEIGHTS_KEY,
  normalizeTtErWeights,
  ttEngagementRate,
  ttViewsPerFollower,
  fmtRatio,
  ttPermalink,
} from "./shared/ttFormat.js";
import { fmtDate, fmtER } from "./shared/fmt.js";
export {
  TT_ER_WEIGHTS,
  TT_ER_WEIGHTS_KEY,
  normalizeTtErWeights,
  ttViewsPerFollower,
  fmtRatio,
  ttPermalink,
  fmtDate,
  fmtER,
};
// parseCount used to be a private copy here that mis-read a lone pt-BR thousands
// separator ("1.234" is 1234, not 1.234). The shared parser gets that right and
// knows 14 locale unit words instead of 6.
export { fmtCount, parseCount };

// ER weights are a user SETTING now, not a constant — what counts as engagement
// differs per niche, and the panel and the page overlay have to agree on it. The
// weights are the argument; ER_WEIGHTS is kept as the legacy alias for the
// defaults so older callers still resolve.
export const ER_WEIGHTS = TT_ER_WEIGHTS;

export function engagementRate(rec, weights) {
  return ttEngagementRate(rec, weights);
}

// Compact engagement count for display: 964490 -> "964.5K", 1200000 -> "1.2M".


// Parse a displayed abbreviated count back to a number: "51.9M" -> 51900000,
// "964.5K" -> 964500, "1,2 mil" -> 1200, "222" -> 222. Used for the DOM-tile
// fallback (data-e2e views), which show abbreviated strings. null when unparseable.

const METRIC = {
  views: (r) => r.play_count,
  likes: (r) => r.digg_count,
  comments: (r) => r.comment_count,
  shares: (r) => r.share_count,
  saves: (r) => r.collect_count,
  date: (r) => r.create_time,
  // Creator size, and how far past that audience the video travelled. Both ride
  // along on every TikTok list payload (authorStats) — Instagram needs a separate
  // enrichment request for the first and cannot sort by the second at all.
  followers: (r) => r.user_follower_count,
  vpf: ttViewsPerFollower,
  er: ttEngagementRate,
};

// Comparator over TikTok records. Missing metrics always sort last, whatever the
// direction (pinned-but-statless items don't jump the list). `weights` is threaded
// through so an ER sort uses the same numbers the visible ER label was drawn from.
export function sortComparator(key, dir = "desc", weights) {
  const get = METRIC[key] || METRIC.views;
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = get(a, weights), bv = get(b, weights);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign;
  };
}

export function sortRecords(records, key, dir, weights) {
  if (key === "default") return [...records]; // capture order (≈ TikTok's own order)
  return [...records].sort(sortComparator(key, dir, weights));
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
    followers: rec.user_follower_count ?? null,
    viewsPerFollower: ttViewsPerFollower(rec),
    hasVideo: !!rec.video,
    pinned: !!rec.pinned,
    permalink: ttPermalink(rec),
  };
}

// One definition, in downloadPath.js — this used to be a byte-identical copy.
export { sanitizeFilenamePart };

// Bare file name, no folder. Kept separate from the path so the cover-only button
// can rename it (-thumb); the suffix is what marks a cover now that covers
// share the imagens/ bucket with the full-size images.
export function baseNameFor(rec, ext, idx) {
  const base = `tt-${sanitizeFilenamePart(rec.username || rec.nickname)}-${rec.id || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

// TikTok downloads are videos, but the cover is fetched through the same namer —
// so the bucket follows the actual media.
export function filenameFor(rec, ext, idx) {
  return downloadPath(kindFromExt(ext), baseNameFor(rec, ext, idx));
}

// "Baixar miniatura": the same name with a -thumb suffix.
export function thumbFilenameFor(rec, ext) {
  const name = baseNameFor(rec, ext).replace(new RegExp("\\." + ext + "$"), "-thumb." + ext);
  return downloadPath("thumb", name);
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
