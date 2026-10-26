import type { MiniDatabase } from "./db.js";
import { postMetrics, durationSummary, median as exactMedian, RATE_MIN_VIEWS, type DurationSummary, type PostRanking, type PostMetrics } from "../shared/spy-metrics.js";
import { itemUrl } from "./spyPosts.js";
import { tagFilter } from "./analysis/reportTags.js";

// Top posts: the five most viewed Instagram videos of the saved profiles,
// published yesterday, in the last 3 and in the last 7 days, and when in the
// week the videos are posted. Days are closed days in the browser's time zone
// (local build; the hub uses GMT-3, the owner's time); the numbers are the last ones read. Instagram only in
// v1 (the owner's call): Facebook views come rounded and undated.
// Design: docs/superpowers/specs/2026-10-11-spy-top-posts-design.md

export const TOP_POSTS_DAYS = [1, 3, 7] as const;
export const TOP_POSTS_LIMIT = 5;
/** The hours map covers this many closed days. */
export const HOURS_DAYS = 90;
const DAY_S = 86_400;

export interface TopPost extends PostMetrics {
  durationS: number | null;
  metricsAt: number | null;
  relativeViews: number | null;
  baselinePosts: number;
  id: string;
  profileId: string;
  key: string;
  name: string | null;
  avatarUrl: string | null;
  url: string;
  /** s, publication time. */
  createdAt: number;
  views: number;
  likes: number | null;
  comments: number | null;
  thumbUrl: string | null;
}

export interface TopPostsWindow {
  days: number;
  /** s, inclusive: local midnight `days` days before today. */
  from: number;
  /** s, exclusive: local midnight today. */
  to: number;
  items: TopPost[];
  duration: DurationSummary;
}

export interface HoursCell {
  /** 0 = Sunday, local time. */
  day: number;
  hour: number;
  videos: number;
  /** Median views of the videos posted in this hour of this weekday. */
  median: number;
}

export interface HoursMap {
  from: number;
  to: number;
  videos: number;
  /** Only the cells with videos, by day then hour. */
  cells: HoursCell[];
}

export interface TopPosts {
  ranking: PostRanking;
  minViews: number;
  windows: TopPostsWindow[];
  hours: HoursMap;
  /** The report tags it read by (hub 0.49; [] = every profile) and how many active profiles, both networks, that lets in. */
  profiles: { tags: string[]; read: number; total: number };
}

/** s, midnight of today in the browser's time zone (local build; the hub: GMT-3). */
export function dayStart(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** s, the local midnight `days` days before the midnight `startS` (a day is not always 24 h with DST). */
export function daysBefore(startS: number, days: number): number {
  const d = new Date(startS * 1000);
  d.setDate(d.getDate() - days);
  return Math.floor(d.getTime() / 1000);
}

type ReadingRow = {
  profileId: string; id: string; createdAt: number; code: string | null; mediaType: string;
  durationS: number | null;
  viewsAt: number | null; likesAt: number | null; commentsAt: number | null; durationAt: number | null;
  views: number | null; likes: number | null; comments: number | null; metricsAt: number | null; hasThumb: number;
  key: string; name: string | null; hasAvatar: number; avatarV: number;
};

type Row = ReadingRow & { views: number };

type Ranked = { views: number; likes: number | null; createdAt: number };
const byViews = (a: Ranked, b: Ranked) =>
  b.views - a.views || (b.likes ?? -1) - (a.likes ?? -1) || b.createdAt - a.createdAt;

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function toPost(r: Row, rows: ReadingRow[]): TopPost {
  const reference = rows.filter((p) => p.profileId === r.profileId && p.id !== r.id &&
    p.createdAt < r.createdAt && p.createdAt >= r.createdAt - HOURS_DAYS * DAY_S && p.views != null) as Row[];
  const baseline = reference.length >= 5 ? exactMedian(reference.map((p) => p.views)) : null;
  return {
    ...postMetrics(r.views, r.likes, r.comments),
    durationS: r.durationS, metricsAt: r.metricsAt,
    relativeViews: baseline != null && baseline > 0 ? r.views / baseline : null,
    baselinePosts: reference.length,
    id: r.id,
    profileId: r.profileId,
    key: r.key,
    name: r.name,
    avatarUrl: r.hasAvatar ? `/api/spy/profiles/${encodeURIComponent(r.profileId)}/avatar?v=${r.avatarV}` : null,
    url: itemUrl("instagram", { id: r.id, code: r.code, media_type: r.mediaType }, r.profileId),
    createdAt: r.createdAt,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    thumbUrl: r.hasThumb ? `/api/spy/profiles/${encodeURIComponent(r.profileId)}/media/${r.id}/thumb` : null,
  };
}

/**
 * The saved profiles' Instagram videos of the hours map's days (plus a week), a
 * collab merged into one. With `tags`, only the profiles carrying one of them
 * (the reports' rule, hub 0.49): a profile's videos are all in or all out, so
 * the medians of the profiles read do not move.
 */
function readVideos(database: MiniDatabase, now: number, tags: string[] = []): { to: number; from: number; rows: ReadingRow[]; ranked: Row[] } {
  const to = dayStart(now);
  const from = daysBefore(to, HOURS_DAYS);
  const filter = tagFilter(tags);
  const rows = database.db.prepare(`
    SELECT s.profile_id AS profileId, s.post_id AS id, s.created_at AS createdAt, s.code, s.media_type AS mediaType,
      s.views, s.likes, s.comments, s.duration_s AS durationS, s.metrics_at AS metricsAt,
      s.views_at AS viewsAt, s.likes_at AS likesAt, s.comments_at AS commentsAt, s.duration_at AS durationAt, (s.thumb IS NOT NULL) AS hasThumb,
      p.key, p.name, (p.avatar IS NOT NULL AND length(p.avatar) > 0) AS hasAvatar,
      COALESCE(p.meta_updated_at, p.saved_at) AS avatarV
    FROM spy_posts s JOIN spy_profiles p ON p.id = s.profile_id
    WHERE p.removed_at IS NULL AND p.platform = 'instagram' AND s.media_type = 'video'
      AND s.created_at >= ? AND s.created_at < ?${filter.sql}
  `).all(from - 7 * DAY_S, to, ...filter.params) as ReadingRow[];

  // A collab sits in each co-author's grid: one video, the reading with more views.
  const videos = new Map<string, ReadingRow>();
  for (const r of rows) {
    const held = videos.get(r.id);
    if (!held) { videos.set(r.id, { ...r }); continue; }
    const merged = { ...((r.views ?? -1) > (held.views ?? -1) || (r.views === held.views && (r.metricsAt ?? 0) > (held.metricsAt ?? 0)) ? r : held) };
    // One media id, complementary readings from its coauthors. Never lose a
    // known duration or counter just because the other grid carries more views.
    for (const [field, clock] of [["views", "viewsAt"], ["likes", "likesAt"], ["comments", "commentsAt"], ["durationS", "durationAt"]] as const) {
      const source = r[field] != null && (held[field] == null || (r[clock] ?? 0) > (held[clock] ?? 0)) ? r
        : held[field] != null && (r[field] == null || (held[clock] ?? 0) > (r[clock] ?? 0)) ? held : merged;
      merged[field] = source[field] as number;
      merged[clock] = source[clock];
    }
    merged.metricsAt = Math.max(r.metricsAt ?? 0, held.metricsAt ?? 0) || null;
    videos.set(r.id, merged);
  }
  const ranked = [...videos.values()].filter((r): r is Row => r.views != null).sort(byViews);
  return { to, from, rows, ranked };
}

/** Active saved profiles, both networks, and how many of them carry one of `tags` (all of them without tags). */
export function profileCounts(database: MiniDatabase, tags: string[]): { read: number; total: number } {
  const count = (filter: { sql: string; params: string[] }) =>
    (database.db.prepare(`SELECT COUNT(*) AS n FROM spy_profiles p WHERE p.removed_at IS NULL${filter.sql}`).get(...filter.params) as { n: number }).n;
  const total = count({ sql: "", params: [] });
  return { read: tags.length ? count(tagFilter(tags)) : total, total };
}

export function topPosts(database: MiniDatabase, now = Date.now(), ranking: PostRanking = "views", tags: string[] = []): TopPosts {
  const { to, from, rows, ranked } = readVideos(database, now, tags);

  const metric = (r: Row) => ranking === "engagement"
    ? postMetrics(r.views, r.likes, r.comments).engagementRate
    : postMetrics(r.views, r.likes, r.comments).commentsPer1000;
  const windows = TOP_POSTS_DAYS.map((days) => {
    const start = daysBefore(to, days);
    const candidates = ranked.filter((r) => r.createdAt >= start &&
      (ranking === "views" || (r.views >= RATE_MIN_VIEWS && metric(r) != null)));
    if (ranking !== "views") candidates.sort((a, b) => metric(b)! - metric(a)! || byViews(a, b));
    const items = candidates.slice(0, TOP_POSTS_LIMIT).map((r) => toPost(r, rows));
    return { days, from: start, to, items, duration: durationSummary(items) };
  });

  const slots = new Map<number, number[]>();
  for (const r of ranked) {
    if (r.createdAt < from) continue;
    const local = new Date(r.createdAt * 1000);
    const slot = local.getDay() * 24 + local.getHours();
    const list = slots.get(slot);
    if (list) list.push(r.views);
    else slots.set(slot, [r.views]);
  }
  const cells = [...slots.entries()].sort(([a], [b]) => a - b).map(([slot, views]) => ({
    day: Math.floor(slot / 24),
    hour: slot % 24,
    videos: views.length,
    median: median(views.sort((a, b) => a - b)),
  }));

  return { ranking, minViews: ranking === "views" ? 0 : RATE_MIN_VIEWS, windows,
    hours: { from, to, videos: ranked.filter((r) => r.createdAt >= from).length, cells },
    profiles: { tags, ...profileCounts(database, tags) } };
}

// Local build: topPostsByRelative, topPostById, profileVideos and profileMedian
// exist only for the hub's AI reports and are not copied.
