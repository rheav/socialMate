// Pure, DOM-free helpers for the IG Sort tool (panel side). Unit-tested.

import { ER_WEIGHTS, ER_WEIGHTS_KEY } from "./shared/igFilters.js";
export { ER_WEIGHTS, ER_WEIGHTS_KEY };
import { downloadPath, kindFromExt } from "./downloadPath.js";
import { fmtCount } from "./shared/counts.js";
import { sanitizeFilenamePart } from "./shared/filenames.js";
// The overlay injected into instagram.com runs the SAME code: everything below is
// inlined into src/content/ig/bridge.js by scripts/gen-inline.mjs. bridge.js used
// to hand-copy all of it, epoch literal included.
import {
  engagementRate,
  dateFromPk,
  extFromUrl,
  baseNameFor,
} from "./shared/igFormat.js";
// The date and ER labels are platform-agnostic and now live in shared/fmt.js —
// TikTok prints the identical strings from the identical code.
import { fmtDate, fmtER } from "./shared/fmt.js";
export { fmtCount };
export { engagementRate, fmtDate, dateFromPk, fmtER, extFromUrl, baseNameFor };

const METRIC = {
  likes: (r) => r.like_count,
  views: (r) => r.play_count,
  comments: (r) => r.comment_count,
  date: (r) => r.taken_at,
  er: engagementRate,
};

// Comparator over IG records. Missing metrics (e.g. photos have no play_count)
// always sort last, whatever the direction.
export function sortComparator(key, dir = "desc") {
  const get = METRIC[key] || METRIC.likes;
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
  if (key === "default") return [...records]; // capture order (≈ IG's own order)
  return [...records].sort(sortComparator(key, dir));
}

export function recordToCard(rec) {
  const type = rec.media_type || (rec.video ? "video" : "photo");
  const code = rec.code || null;
  return {
    id: code || rec.pk || "",
    username: rec.username || rec.full_name || "unknown",
    thumb: rec.thumb || rec.image || null,
    type,
    likes: rec.like_count ?? null,
    comments: rec.comment_count ?? null,
    views: rec.play_count ?? null,
    reposts: rec.repost ?? null,
    date: fmtDate(rec.taken_at) || dateFromPk(rec.pk),
    hasVideo: !!rec.video || type === "video",
    permalink: code ? `https://www.instagram.com/p/${code}/` : null,
  };
}

// One definition, in shared/igFormat.js — this used to be a byte-identical copy.
export { sanitizeFilenamePart };

// A post can be a photo or a video, so the sub-folder follows the actual media.
export function filenameFor(rec, ext, idx) {
  return downloadPath(kindFromExt(ext), baseNameFor(rec, ext, idx));
}

// "Baixar miniatura": the same name with a -thumb suffix.
export function thumbFilenameFor(rec, ext) {
  const name = baseNameFor(rec, ext).replace(new RegExp("\\." + ext + "$"), "-thumb." + ext);
  return downloadPath("thumb", name);
}

// Scope captured records to a surface. IG's JSON.parse also parses suggested/
// recommended media (explore rails, "suggested for you") while you're on a page,
// so a raw surface match still leaks other creators. On a profile surface we
// additionally require the record's author to BE that profile; hashtag/feed
// surfaces are legitimately multi-author and pass through on surface match.
export function filterBySurface(records, surface) {
  if (!surface) return records;
  return records.filter((r) => {
    if (r.surface !== surface) return false;
    if (surface.startsWith("profile:")) {
      const owner = surface.slice("profile:".length).toLowerCase();
      const u = (r.username || "").toLowerCase();
      // Keep the owner's posts. The profile's own Reels-tab items omit the
      // username (context implies the owner), so keep null-username records too;
      // only records that explicitly name a DIFFERENT account are dropped.
      return u === owner || u === "";
    }
    return true;
  });
}
