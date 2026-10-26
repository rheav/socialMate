import { median, RATE_MIN_VIEWS } from "./spy-metrics.js";

// Signals of a saved profile, read from its posts (the profile sheet, hub 0.53):
// the views changed level, a spike that went back to normal, a return after a
// pause, the views per hour a reel usually makes at its age, and the
// interaction rate with more weight on recent posts. Pure functions over rows;
// the reader that feeds them is server/spyTrends.ts. Shared so the sheet's copy
// quotes the same thresholds.

const DAY_S = 86_400;
/** A reel's views are compared only once read at this age: younger ones are still growing. */
export const MATURE_S = 3 * DAY_S;
/** Levels are weekly medians: a week needs this many mature reels… */
export const WEEK_MIN = 4;
/** …and is compared with the median of the BASE_WEEKS before it (at least BASE_MIN reels). */
export const BASE_WEEKS = 2;
export const BASE_MIN = 5;
/** New level: the week's median at least this many times the one before… */
export const STEP_UP = 1.8;
/** …or at most this fraction of it, and the next week (when there is one) on the same side. */
export const STEP_DOWN = 0.55;
/**
 * Spike: one reel at least this many times the median of the SPIKE_BASE_DAYS
 * before it. Reel views are heavy-tailed: on the real data (19 profiles,
 * 2026-10-22) 3× fired every few days per profile, 10× zero to five times in
 * six weeks.
 */
export const SPIKE = 10;
export const SPIKE_BASE_DAYS = 14;
/** …and the reels of the SPIKE_AFTER_DAYS after it (at least SPIKE_AFTER_MIN) back under SPIKE_BACK times that median. */
export const SPIKE_AFTER_DAYS = 3;
export const SPIKE_AFTER_MIN = 2;
export const SPIKE_BACK = 1.5;
/** Days without a post before the next one counts as a return. */
export const GAP_DAYS = 14;
/** Views per hour, by the reel's age when its views were read (hours, [from, to)). */
export const VPH_BUCKETS = [
  { key: "1d", fromH: 1, toH: 24 },
  { key: "3d", fromH: 24, toH: 72 },
  { key: "7d", fromH: 72, toH: 168 },
  { key: "30d", fromH: 168, toH: 720 },
] as const;
/** A bucket's median needs at least this many reels. */
export const VPH_MIN_POSTS = 3;
/** Interaction rate: posts of the last ER_WINDOW_DAYS, weight halved every ER_HALF_LIFE_DAYS. */
export const ER_WINDOW_DAYS = 90;
export const ER_HALF_LIFE_DAYS = 30;

export interface TrendPost {
  id: string;
  url: string;
  /** s, publication time. */
  createdAt: number;
  views: number | null;
  /** ms, when the views were read. */
  viewsAt: number | null;
  likes: number | null;
  comments: number | null;
}

export interface TrendRef {
  id: string;
  url: string;
  createdAt: number;
  views: number | null;
}

export interface TrendEvent {
  kind: "step_up" | "step_down" | "spike" | "comeback";
  /** s, publication time of the first reel of the event. */
  at: number;
  /** step: new level ÷ old; spike: the reel ÷ level. */
  ratio?: number;
  /** comeback: days without a post before it. */
  gapDays?: number;
  posts: TrendRef[];
}

export interface VphBucket {
  key: (typeof VPH_BUCKETS)[number]["key"];
  /** Median views per hour of the profile's reels read at this age; null with too few. */
  median: number | null;
  posts: number;
}

export interface VphLatest extends TrendRef {
  ageH: number;
  vph: number;
  bucket: VphBucket["key"];
  /** vph ÷ the bucket's median of the profile's other reels. */
  ratio: number | null;
}

export interface Engagement {
  /** Mean of (likes + comments) ÷ views, in %. */
  plain: number;
  /** The same, each post weighted by its age. */
  weighted: number;
  posts: number;
}

export interface ProfileTrends {
  events: TrendEvent[];
  vph: { buckets: VphBucket[]; latest: VphLatest | null };
  engagement: Engagement | null;
}

export const trendRef = (p: TrendRef): TrendRef => ({ id: p.id, url: p.url, createdAt: p.createdAt, views: p.views });

/** Level changes (weekly) and spikes, oldest first, from reels whose views were read at MATURE_S or later. */
export function viewEvents(posts: TrendPost[]): TrendEvent[] {
  const m = posts
    .filter((p): p is TrendPost & { views: number; viewsAt: number } =>
      p.views != null && p.viewsAt != null && p.viewsAt / 1000 - p.createdAt >= MATURE_S)
    .sort((a, b) => a.createdAt - b.createdAt);
  const out: TrendEvent[] = [];
  if (!m.length) return out;
  const views = (list: typeof m) => list.map((p) => p.views);
  const between = (from: number, to: number) => m.filter((p) => p.createdAt >= from && p.createdAt < to);

  // Weeks counted back from the newest mature reel, oldest first.
  const end = m[m.length - 1].createdAt + 1;
  const weeks: (typeof m)[] = [];
  for (let to = end; to > m[0].createdAt; to -= 7 * DAY_S) weeks.unshift(between(to - 7 * DAY_S, to));
  // A week the next one undoes is noise: it never becomes the level a later week is compared with.
  const noise = new Set<number>();
  let last: TrendEvent["kind"] | null = null;
  for (let k = BASE_WEEKS; k < weeks.length; k++) {
    const week = weeks[k];
    const base = weeks.slice(0, k).filter((_, i) => !noise.has(i)).slice(-BASE_WEEKS).flat();
    const bm = base.length >= BASE_MIN ? median(views(base)) : null;
    if (!bm || week.length < WEEK_MIN) { last = null; continue; }
    const side = (list: typeof m) => {
      const r = median(views(list))! / bm;
      return r >= STEP_UP ? "step_up" : r <= STEP_DOWN ? "step_down" : null;
    };
    const kind = side(week);
    if (!kind) { last = null; continue; }
    const next = weeks[k + 1];
    if (next && next.length >= WEEK_MIN && side(next) !== kind) { noise.add(k); continue; }
    // The week after a change is the same level, not a second change.
    if (kind !== last) {
      out.push({ kind, at: week[0].createdAt, ratio: median(views(week))! / bm,
        posts: [...week].sort((a, b) => b.views - a.views).slice(0, 3).map(trendRef) });
    }
    last = kind;
  }

  for (const p of m) {
    const base = between(p.createdAt - SPIKE_BASE_DAYS * DAY_S, p.createdAt);
    const bm = base.length >= BASE_MIN ? median(views(base)) : null;
    if (!bm || p.views < SPIKE * bm) continue;
    const after = m.filter((x) => x.createdAt > p.createdAt && x.createdAt <= p.createdAt + SPIKE_AFTER_DAYS * DAY_S);
    if (after.length >= SPIKE_AFTER_MIN && median(views(after))! <= SPIKE_BACK * bm)
      out.push({ kind: "spike", at: p.createdAt, ratio: p.views / bm, posts: [trendRef(p)] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Returns after GAP_DAYS or more without a post, counted only where the record is complete (from `since`, s). */
export function comebackEvents(posts: TrendRef[], since: number | null): TrendEvent[] {
  if (since == null) return [];
  const sorted = posts.filter((p) => p.createdAt >= since).sort((a, b) => a.createdAt - b.createdAt);
  const out: TrendEvent[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].createdAt - sorted[i - 1].createdAt) / DAY_S;
    if (gap >= GAP_DAYS) out.push({ kind: "comeback", at: sorted[i].createdAt, gapDays: Math.floor(gap), posts: [sorted[i]] });
  }
  return out;
}

const bucketOf = (ageH: number) => VPH_BUCKETS.find((b) => ageH >= b.fromH && ageH < b.toH)?.key ?? null;

/**
 * Views per hour by age: each reel counts once per bucket, with its last reading
 * in it. `latest` is the newest reel's last reading against the other reels.
 */
export function viewsPerHour(posts: TrendRef[], readings: { id: string; at: number; views: number }[]): ProfileTrends["vph"] {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const last = new Map<string, { vph: number; at: number; ageH: number; views: number; bucket: VphBucket["key"] }>();
  for (const r of readings) {
    const p = byId.get(r.id);
    if (!p) continue;
    const ageH = (r.at / 1000 - p.createdAt) / 3600;
    const bucket = bucketOf(ageH);
    if (!bucket) continue;
    const k = `${r.id}|${bucket}`;
    if ((last.get(k)?.at ?? -1) < r.at) last.set(k, { vph: r.views / ageH, at: r.at, ageH, views: r.views, bucket });
  }
  const values = (key: string, except?: string) =>
    [...last.entries()].filter(([k, v]) => v.bucket === key && k.split("|")[0] !== except).map(([, v]) => v.vph);
  const bucketMedian = (key: string, except?: string) => {
    const v = values(key, except);
    return v.length >= VPH_MIN_POSTS ? median(v) : null;
  };
  const buckets = VPH_BUCKETS.map((b) => ({ key: b.key, median: bucketMedian(b.key), posts: values(b.key).length }));

  const newest = [...posts].sort((a, b) => b.createdAt - a.createdAt).find((p) => [...last.keys()].some((k) => k.startsWith(`${p.id}|`)));
  if (!newest) return { buckets, latest: null };
  const reading = [...last.entries()].filter(([k]) => k.startsWith(`${newest.id}|`)).map(([, v]) => v).sort((a, b) => b.at - a.at)[0];
  const base = bucketMedian(reading.bucket, newest.id);
  return {
    buckets,
    latest: { ...newest, views: reading.views, ageH: reading.ageH, vph: reading.vph, bucket: reading.bucket,
      ratio: base ? reading.vph / base : null },
  };
}

/** (likes + comments) ÷ views of the posts of the last ER_WINDOW_DAYS with at least RATE_MIN_VIEWS views. */
export function engagement(posts: TrendPost[], nowMs: number): Engagement | null {
  const nowS = nowMs / 1000;
  let plain = 0, weighted = 0, weights = 0, n = 0;
  for (const p of posts) {
    if (p.views == null || p.views < RATE_MIN_VIEWS || p.likes == null || p.comments == null) continue;
    const ageDays = Math.max(0, nowS - p.createdAt) / DAY_S;
    if (ageDays > ER_WINDOW_DAYS) continue;
    const er = (100 * (p.likes + p.comments)) / p.views;
    const w = 0.5 ** (ageDays / ER_HALF_LIFE_DAYS);
    plain += er;
    weighted += w * er;
    weights += w;
    n += 1;
  }
  return n ? { plain: plain / n, weighted: weighted / weights, posts: n } : null;
}
