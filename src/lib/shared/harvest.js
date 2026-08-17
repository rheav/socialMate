// Collection knobs that are not platform-specific: how far back a research grid
// should look, and how fast an auto-scroll may paginate. INLINED into content
// scripts — see ./README.md before editing (no imports allowed in this file).
//
// These grew inside igFilters.js, but nothing in them is Instagram: TikTok's
// createTime is the same unix-seconds stamp, and a harvester that keeps a
// constant fast cadence reads as automation on every platform. Split out here so
// the TikTok tool can use them without inlining Instagram's ER weights and React
// prop reader alongside.

// ---- date range ----
// A hashtag search is mostly old posts; "what worked this month" is the question
// worth asking, and sorting alone can't answer it.
export const DATE_RANGES = [
  { value: "all", label: "Todo o período", days: null },
  { value: "7d", label: "Últimos 7 dias", days: 7 },
  { value: "14d", label: "Últimos 14 dias", days: 14 },
  { value: "30d", label: "Últimos 30 dias", days: 30 },
  { value: "90d", label: "Últimos 90 dias", days: 90 },
  { value: "180d", label: "Últimos 180 dias", days: 180 },
  { value: "1y", label: "Último ano", days: 365 },
  { value: "2y", label: "Últimos 2 anos", days: 730 },
];

/**
 * `takenAt` is UNIX SECONDS (IG's taken_at, TikTok's createTime). A record whose
 * date never arrived is KEPT: grid payloads often omit it, and hiding those posts
 * would look like the filter had eaten real results.
 */
export function withinDateRange(takenAt, range, nowSec = Math.floor(Date.now() / 1000)) {
  const r = DATE_RANGES.find((x) => x.value === range);
  if (!r || r.days == null) return true;
  if (typeof takenAt !== "number" || !Number.isFinite(takenAt)) return true;
  return takenAt >= nowSec - r.days * 86400;
}

// ---- paced auto-scroll ----
// IG Sorter scrolls to the bottom on a timer: 3 s for the first five, 6 s for the
// next five, then 10 s. Same shape here.
export function scrollGapMs(i) {
  if (i < 5) return 3000;
  if (i < 10) return 6000;
  return 10000;
}
