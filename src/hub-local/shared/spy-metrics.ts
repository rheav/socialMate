export type PostRanking = "views" | "engagement" | "comments";
export const RATE_MIN_VIEWS = 1000;

export interface PostMetrics {
  engagementRate: number | null;
  weightedIndex: number | null;
  commentsPer1000: number | null;
}

export interface DurationSummary {
  mean: number | null;
  median: number | null;
  known: number;
  total: number;
}

export function postMetrics(views: number, likes: number | null, comments: number | null): PostMetrics {
  const complete = views > 0 && likes != null && comments != null;
  return {
    engagementRate: complete ? 100 * (likes + comments) / views : null,
    weightedIndex: complete ? 100 * (likes + 4 * comments) / views : null,
    commentsPer1000: views > 0 && comments != null ? 1000 * comments / views : null,
  };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function durationSummary(items: { durationS: number | null }[]): DurationSummary {
  const known = items.flatMap((p) => p.durationS != null && p.durationS > 0 ? [p.durationS] : []);
  return {
    mean: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
    median: median(known), known: known.length, total: items.length,
  };
}
