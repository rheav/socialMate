// Ordering for the Library's Salvos grid.
//
// The search tools each have a sortRecords over their own platform's capture
// shape (igMedia, ttMedia, fbReels, pinMedia). None of them fits here: a saved
// record is the ONE cross-platform shape written by buildSavedEntry —
// `counts.{like,comment,views,share}` rather than `like_count`/`play_count`, and
// `updatedAt` rather than `taken_at`. So the metrics are read from that shape,
// once, and every platform in the grid sorts by the same rule.
//
// Two shapes of missing data, both deliberate:
//   * Counts written before schema 2 are pre-formatted strings ("8,3 mil"), which
//     VideoCard still renders as-is. parseCount turns those back into numbers so a
//     legacy record sorts by its value instead of falling to the bottom.
//   * A post saved off a grid has no `takenAt` — only a transcript-derived entry
//     carries one. Instagram ids encode their own creation time, so those still
//     get a date; everything else sorts last under "Data do post", the same way
//     every other missing metric here does.
import { parseCount } from "./shared/counts.js";
import { dateFromPk } from "./igMedia.js";

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label — same contract as the search tools' SORT_OPTS.
export const SAVED_SORT_OPTS = [
  { value: "default", label: "Padrão" },
  { value: "views", label: "Visualizações", short: "Visualiz." },
  { value: "likes", label: "Curtidas" },
  { value: "comments", label: "Comentários", short: "Coment." },
  { value: "date", label: "Data do post", short: "Data" },
  { value: "saved", label: "Salvo em", short: "Salvo" },
];

const num = (v) => {
  const n = parseCount(v);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * When the post itself was published, in ms — or null when we do not know.
 *
 * `takenAt` is stored in SECONDS (it comes straight off Instagram's `taken_at`),
 * so it is scaled here. The Instagram fallback goes through `dateFromPk`, the
 * same decoder the metadata chips print, which resolves to a day: enough to
 * order a grid by, and it is the only date those records have at all.
 */
export function savedPostTimeMs(rec) {
  const taken = num(rec?.takenAt);
  if (taken != null && taken > 0) return taken * 1000;
  if (rec?.platform !== "instagram") return null;
  const iso = dateFromPk(rec.pk || rec.videoId);
  if (!iso) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

const METRIC = {
  views: (r) => num(r?.counts?.views),
  likes: (r) => num(r?.counts?.like),
  comments: (r) => num(r?.counts?.comment),
  date: savedPostTimeMs,
  saved: (r) => num(r?.updatedAt),
};

/** Comparator over saved records. Missing metrics sort last in BOTH directions. */
export function savedSortComparator(key, dir = "desc") {
  const get = METRIC[key] || METRIC.saved;
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign;
  };
}

/**
 * `default` is the order the store already hands over — most recently saved
 * first — and it stays that way whatever `dir` says, exactly like the search
 * tools' "Padrão". Pick "Salvo em" to flip it.
 */
export function sortSavedRecords(records, key, dir) {
  const list = Array.isArray(records) ? records : [];
  if (key === "default") return [...list];
  return [...list].sort(savedSortComparator(key, dir));
}
