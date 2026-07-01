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

// Compact engagement count for display: 964490 -> "964.5K", 1200000 -> "1.2M".
export function fmtCount(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
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
      return (r.username || "").toLowerCase() === owner;
    }
    return true;
  });
}
