// Pure, DOM-free helpers for the IG Sort tool (panel side). Unit-tested.

const KEY_FIELD = {
  likes: "like_count",
  views: "play_count",
  comments: "comment_count",
  date: "taken_at",
};

// Comparator over IG records. Missing metrics (e.g. photos have no play_count)
// always sort last, whatever the direction.
export function sortComparator(key, dir = "desc") {
  const field = KEY_FIELD[key] || "like_count";
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = a[field], bv = b[field];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign;
  };
}

export function sortRecords(records, key, dir) {
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
    hasVideo: !!rec.video || type === "video",
    permalink: code ? `https://www.instagram.com/p/${code}/` : null,
  };
}

export function sanitizeFilenamePart(s) {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function filenameFor(rec, ext, idx) {
  const base = `ig-${sanitizeFilenamePart(rec.username)}-${rec.code || rec.pk || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

export function extFromUrl(url, kind) {
  const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
  return kind === "video" ? "mp4" : "jpg";
}
