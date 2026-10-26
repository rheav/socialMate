import type { MiniDatabase } from "./db.js";

// Posts per day. Instagram: the posts the extension sees in a saved profile's
// grid, each kept once with its publication time (a collab sits in every
// co-author's grid, so it counts for each). Facebook: the reels the hub already
// keeps. The card carries the publication times of the last days and how far
// back the record is complete; the dashboard buckets them by the viewer's day.

export interface DailyBlock {
  kind: "posts" | "reels";
  /** s, publication times within the window, newest first. */
  times: number[];
  /** s, the record is complete from here on; 0 = the whole history; null = nothing yet. */
  since: number | null;
  /** ms, when the posts were last read: the grid on Instagram, the follower reading on Facebook. */
  readAt: number | null;
}

export interface IngestPostsResult {
  added: number;
  known: number;
  unknown: number;
  invalid: number;
}

/** 14 days plus room for any viewer's time zone. */
export const DAILY_WINDOW_S = 16 * 86_400;
const POST_ID_RE = /^\d{3,30}$/;
const MEDIA_TYPE_RE = /^[a-z_]{1,20}$/;
const CODE_RE = /^[A-Za-z0-9_-]{5,40}$/;
const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);

export function ingestPosts(database: MiniDatabase, items: unknown[], now = Date.now()): IngestPostsResult {
  const out: IngestPostsResult = { added: 0, known: 0, unknown: 0, invalid: 0 };
  if (!Array.isArray(items)) return out;
  const profileStmt = database.db.prepare(
    "SELECT 1 FROM spy_profiles WHERE id = ? AND platform = 'instagram' AND removed_at IS NULL",
  );
  const existsStmt = database.db.prepare("SELECT 1 FROM spy_posts WHERE profile_id = ? AND post_id = ?");
  // Numbers only move forward to the newest reading; a reading without them (the
  // grid has no views, the Reels tab no publication time) never clears them.
  const upsert = database.db.prepare(`
    INSERT INTO spy_posts (profile_id, post_id, created_at, media_type, pinned, first_seen_at,
      code, views, likes, comments, metrics_at, exact_date, duration_s, duration_at, views_at, likes_at, comments_at)
    VALUES (@profileId, @id, @createdAt, @mediaType, @pinned, @now, @code, @views, @likes, @comments, @metricsAt, @exactDate, @duration, CASE WHEN @duration IS NOT NULL THEN @observedAt END,
      CASE WHEN @views IS NOT NULL THEN @observedAt END, CASE WHEN @likes IS NOT NULL THEN @observedAt END,
      CASE WHEN @comments IS NOT NULL THEN @observedAt END)
    ON CONFLICT(profile_id, post_id) DO UPDATE SET
      -- The grid's publication time replaces a time read from the id (~30 s earlier).
      created_at = CASE WHEN excluded.exact_date = 1 AND exact_date = 0 THEN excluded.created_at ELSE created_at END,
      exact_date = MAX(exact_date, excluded.exact_date),
      pinned = excluded.pinned,
      media_type = COALESCE(excluded.media_type, media_type),
      code = COALESCE(excluded.code, code),
      views = CASE WHEN excluded.views_at >= COALESCE(views_at, 0) THEN excluded.views ELSE views END,
      views_at = MAX(COALESCE(views_at, 0), COALESCE(excluded.views_at, 0)),
      likes = CASE WHEN excluded.likes_at >= COALESCE(likes_at, 0) THEN excluded.likes ELSE likes END,
      likes_at = MAX(COALESCE(likes_at, 0), COALESCE(excluded.likes_at, 0)),
      comments = CASE WHEN excluded.comments_at >= COALESCE(comments_at, 0) THEN excluded.comments ELSE comments END,
      comments_at = MAX(COALESCE(comments_at, 0), COALESCE(excluded.comments_at, 0)),
      duration_s = CASE WHEN excluded.duration_at >= COALESCE(duration_at, 0) THEN excluded.duration_s ELSE duration_s END,
      duration_at = MAX(COALESCE(duration_at, 0), COALESCE(excluded.duration_at, 0)),
      metrics_at = MAX(COALESCE(metrics_at, 0), COALESCE(excluded.metrics_at, 0))
  `);
  const observation = database.db.prepare(`
    INSERT INTO spy_post_observations
      (profile_id, post_id, observed_at, received_at, time_source, views, likes, comments, duration_s)
    VALUES (@profileId, @id, @observedAt, @now, @timeSource, @views, @likes, @comments, @duration)
    ON CONFLICT(profile_id, post_id, observed_at) DO UPDATE SET
      views = COALESCE(excluded.views, views), likes = COALESCE(excluded.likes, likes),
      comments = COALESCE(excluded.comments, comments), duration_s = COALESCE(excluded.duration_s, duration_s)
  `);
  const latest = Math.floor(now / 1000) + 86_400;
  const touched = new Set<string>();
  for (const item of items) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const profileId = typeof r?.profileId === "string" ? r.profileId : null;
    const id = typeof r?.id === "string" ? r.id : null;
    const createdAt = r?.createdAt;
    if (!profileId || !id || !POST_ID_RE.test(id) || typeof createdAt !== "number" ||
        !Number.isInteger(createdAt) || createdAt < 1_000_000_000 || createdAt > latest) {
      out.invalid += 1;
      continue;
    }
    if (!profileStmt.get(profileId)) {
      out.unknown += 1;
      continue;
    }
    if (r!.observedAt != null && (!Number.isSafeInteger(r!.observedAt) ||
        (r!.observedAt as number) < createdAt * 1000 || (r!.observedAt as number) > now + 300_000)) {
      out.invalid += 1;
      continue;
    }
    const observedAt = r!.observedAt as number ?? now;
    const mediaType = typeof r!.mediaType === "string" && MEDIA_TYPE_RE.test(r!.mediaType) ? r!.mediaType : null;
    const known = !!existsStmt.get(profileId, id);
    const views = count(r!.views);
    const likes = count(r!.likes);
    const comments = count(r!.comments);
    const duration = mediaType === "video" && typeof r!.durationS === "number" && Number.isFinite(r!.durationS) && r!.durationS > 0 ? r!.durationS : null;
    const hasMetrics = views != null || likes != null || comments != null || duration != null;
    const values = {
      profileId, id, createdAt, mediaType, pinned: r!.pinned === true ? 1 : 0, now,
      code: typeof r!.code === "string" && CODE_RE.test(r!.code) ? r!.code : null, views, likes, comments,
      metricsAt: hasMetrics ? observedAt : null, duration, observedAt, timeSource: r!.observedAt == null ? "received" : "extension",
      exactDate: r!.exactDate === false ? 0 : 1,
    };
    upsert.run(values);
    if (hasMetrics) observation.run(values);
    if (known) out.known += 1;
    else out.added += 1;
    touched.add(profileId);
  }
  const readStmt = database.db.prepare("UPDATE spy_profiles SET posts_read_at = ? WHERE id = ?");
  for (const id of touched) readStmt.run(now, id);
  return out;
}

/** Daily block per profile: Instagram from its posts, Facebook from its reels. */
export function dailyBlocks(
  database: MiniDatabase,
  profiles: { id: string; platform: string }[],
  now = Date.now(),
): Map<string, DailyBlock> {
  const from = Math.floor(now / 1000) - DAILY_WINDOW_S;
  const out = new Map<string, DailyBlock>();
  for (const p of profiles) out.set(p.id, { kind: p.platform === "facebook" ? "reels" : "posts", times: [], since: null, readAt: null });
  if (!profiles.length) return out;
  const readRows = database.db.prepare(`
    SELECT id, CASE WHEN platform = 'facebook' THEN last_measured_at ELSE posts_read_at END AS readAt
    FROM spy_profiles WHERE removed_at IS NULL
  `).all() as { id: string; readAt: number | null }[];
  for (const row of readRows) {
    const block = out.get(row.id);
    if (block) block.readAt = row.readAt ?? null;
  }
  const timeRows = database.db.prepare(`
    SELECT profile_id AS id, created_at AS at FROM spy_posts WHERE created_at >= @from
    UNION ALL
    SELECT profile_id AS id, created_at AS at FROM spy_reels WHERE created_at IS NOT NULL AND created_at >= @from
    ORDER BY at DESC
  `).all({ from }) as { id: string; at: number }[];
  for (const row of timeRows) out.get(row.id)?.times.push(row.at);
  // Instagram: the grid is read newest first, so the record is complete back to
  // the oldest post seen there. Pinned posts sit on top with old dates, and the
  // Reels tab reaches further back than the grid but holds no photos: neither
  // proves anything about the days between.
  const sinceRows = database.db.prepare(`
    SELECT profile_id AS id, MIN(created_at) AS since FROM spy_posts WHERE pinned = 0 AND exact_date = 1 GROUP BY profile_id
    UNION ALL
    SELECT r.profile_id AS id, CASE WHEN p.reels_status = 'done' THEN 0 ELSE MIN(r.created_at) END AS since
    FROM spy_reels r JOIN spy_profiles p ON p.id = r.profile_id
    WHERE r.created_at IS NOT NULL GROUP BY r.profile_id
  `).all() as { id: string; since: number }[];
  for (const row of sinceRows) {
    const block = out.get(row.id);
    if (block) block.since = row.since;
  }
  return out;
}

/** Removal and re-adding start over, like the follower history. */
export function forgetPosts(database: MiniDatabase, profileId: string): void {
  database.db.prepare("DELETE FROM spy_post_observations WHERE profile_id = ?").run(profileId);
  database.db.prepare("DELETE FROM spy_posts WHERE profile_id = ?").run(profileId);
}

/**
 * Merge: the kept profile gets the other's posts, every column of them. A post
 * moved without its code, numbers and thumbnail lost its link and its place in
 * the top 3, and one moved without `exact_date` (defaulting to 1) made a date
 * read from the media id count as a grid date, stretching "complete since".
 */
export function movePosts(database: MiniDatabase, intoId: string, fromId: string): void {
  database.db.prepare(`
    INSERT INTO spy_posts (profile_id, post_id, created_at, media_type, pinned, first_seen_at,
      code, views, likes, comments, thumb, metrics_at, exact_date, duration_s, duration_at, views_at, likes_at, comments_at)
    SELECT ?, post_id, created_at, media_type, pinned, first_seen_at,
      code, views, likes, comments, thumb, metrics_at, exact_date, duration_s, duration_at, views_at, likes_at, comments_at
    FROM spy_posts WHERE profile_id = ?
    ON CONFLICT(profile_id, post_id) DO UPDATE SET
      views = CASE WHEN excluded.views IS NOT NULL AND (spy_posts.views IS NULL OR excluded.views_at >= COALESCE(spy_posts.views_at, 0)) THEN excluded.views ELSE spy_posts.views END,
      views_at = MAX(COALESCE(spy_posts.views_at, 0), COALESCE(excluded.views_at, 0)),
      likes = CASE WHEN excluded.likes IS NOT NULL AND (spy_posts.likes IS NULL OR excluded.likes_at >= COALESCE(spy_posts.likes_at, 0)) THEN excluded.likes ELSE spy_posts.likes END,
      likes_at = MAX(COALESCE(spy_posts.likes_at, 0), COALESCE(excluded.likes_at, 0)),
      comments = CASE WHEN excluded.comments IS NOT NULL AND (spy_posts.comments IS NULL OR excluded.comments_at >= COALESCE(spy_posts.comments_at, 0)) THEN excluded.comments ELSE spy_posts.comments END,
      comments_at = MAX(COALESCE(spy_posts.comments_at, 0), COALESCE(excluded.comments_at, 0)),
      duration_s = CASE WHEN excluded.duration_s IS NOT NULL AND (spy_posts.duration_s IS NULL OR excluded.duration_at >= COALESCE(spy_posts.duration_at, 0)) THEN excluded.duration_s ELSE spy_posts.duration_s END,
      duration_at = MAX(COALESCE(spy_posts.duration_at, 0), COALESCE(excluded.duration_at, 0)),
      code = COALESCE(spy_posts.code, excluded.code),
      thumb = COALESCE(spy_posts.thumb, excluded.thumb),
      metrics_at = MAX(COALESCE(spy_posts.metrics_at, 0), COALESCE(excluded.metrics_at, 0))
  `).run(intoId, fromId);
  database.db.prepare(`INSERT INTO spy_post_observations
    SELECT ?, post_id, observed_at, received_at, time_source, views, likes, comments, duration_s
    FROM spy_post_observations WHERE profile_id = ?
    ON CONFLICT(profile_id, post_id, observed_at) DO UPDATE SET
      views = COALESCE(views, excluded.views), likes = COALESCE(likes, excluded.likes),
      comments = COALESCE(comments, excluded.comments), duration_s = COALESCE(duration_s, excluded.duration_s)
  `).run(intoId, fromId);
  // The kept profile's grid was read when either of them last was.
  database.db.prepare(`
    UPDATE spy_profiles SET posts_read_at = (
      SELECT MAX(posts_read_at) FROM spy_profiles WHERE id IN (@into, @from)
    ) WHERE id = @into
  `).run({ into: intoId, from: fromId });
}

// ---- top 3 of the week ----

export const TOP_WINDOW_S = 7 * 86_400;
const THUMB_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const THUMB_MAX = 60_000;

export interface TopItem {
  id: string;
  url: string;
  createdAt: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** What the rank is by: views (reels), or likes for a post without them. */
  metric: "views" | "likes";
  thumbUrl: string | null;
}

export interface TopBlock {
  items: TopItem[];
  /** The whole week was read: the record reaches back past 7 days. */
  complete: boolean;
}

type Row = { profile_id: string; id: string; created_at: number; media_type: string | null; code: string | null;
  views: number | null; likes: number | null; comments: number | null; has_thumb: number };

function rankRows(platform: string, rows: Row[]): Row[] {
  if (platform === "facebook") return [...rows].sort((a, b) => (b.views ?? -1) - (a.views ?? -1)).slice(0, 3);
  // Instagram shows views on reels only: reels by views first, then the most liked
  // posts (a week without a reel is ranked by likes alone).
  const reels = rows.filter((r) => r.views != null).sort((a, b) => b.views! - a.views! || (b.likes ?? 0) - (a.likes ?? 0));
  const rest = rows.filter((r) => r.views == null).sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
  return [...reels, ...rest].slice(0, 3);
}

export function itemUrl(platform: string, row: Pick<Row, "id" | "code" | "media_type">, profileId: string): string {
  if (platform === "facebook") return `https://www.facebook.com/reel/${row.id}`;
  const key = profileId.slice(profileId.indexOf(":") + 1);
  if (!row.code) return `https://www.instagram.com/${key}/`;
  return row.media_type === "video" ? `https://www.instagram.com/reel/${row.code}/` : `https://www.instagram.com/p/${row.code}/`;
}

/** Top 3 of the last 7 days per profile, newest numbers. */
export function topBlocks(
  database: MiniDatabase,
  profiles: { id: string; platform: string }[],
  now = Date.now(),
  /** The same profiles' daily blocks, when the caller already has them. */
  daily: Map<string, DailyBlock> = dailyBlocks(database, profiles, now),
): Map<string, TopBlock> {
  const from = Math.floor(now / 1000) - TOP_WINDOW_S;
  const rows = database.db.prepare(`
    SELECT profile_id, post_id AS id, created_at, media_type, code, views, likes, comments,
      (thumb IS NOT NULL) AS has_thumb
    FROM spy_posts WHERE created_at >= @from
    UNION ALL
    SELECT profile_id, reel_id AS id, created_at, 'video', NULL, views, NULL, NULL, (thumb IS NOT NULL)
    FROM spy_reels WHERE created_at >= @from
  `).all({ from }) as Row[];
  const byProfile = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byProfile.get(row.profile_id);
    if (list) list.push(row);
    else byProfile.set(row.profile_id, [row]);
  }
  const out = new Map<string, TopBlock>();
  for (const p of profiles) {
    const since = daily.get(p.id)?.since ?? null;
    const items = rankRows(p.platform, byProfile.get(p.id) ?? []).map((r) => ({
      id: r.id, url: itemUrl(p.platform, r, p.id), createdAt: r.created_at,
      views: r.views, likes: r.likes, comments: r.comments,
      metric: (r.views != null ? "views" : "likes") as "views" | "likes",
      thumbUrl: r.has_thumb ? `/api/spy/profiles/${encodeURIComponent(p.id)}/media/${r.id}/thumb` : null,
    }));
    out.set(p.id, { items, complete: since != null && since <= from });
  }
  return out;
}

/** Every active profile's top 3. One sync computes it once and shares it. */
export function activeTopBlocks(database: MiniDatabase, now = Date.now()): Map<string, TopBlock> {
  const profiles = database.db.prepare("SELECT id, platform FROM spy_profiles WHERE removed_at IS NULL")
    .all() as { id: string; platform: string }[];
  return topBlocks(database, profiles, now);
}

/** How far back the reels lists of the views keep thumbnails: the 7-day window
 *  ends at the last reading, which can be a day behind the clock. */
const WEEK_THUMBS_S = 8 * 86_400;

/**
 * The posts that should hold a thumbnail, per active profile: the current top 3
 * first, then the reels of the last days (the views lists), most viewed first.
 */
function thumbTargets(
  database: MiniDatabase,
  now: number,
  top: Map<string, TopBlock>,
): Map<string, { id: string; hasThumb: boolean }[]> {
  const out = new Map<string, { id: string; hasThumb: boolean }[]>();
  const seen = new Set<string>();
  const add = (profileId: string, id: string, hasThumb: boolean) => {
    if (seen.has(`${profileId}|${id}`)) return;
    seen.add(`${profileId}|${id}`);
    const list = out.get(profileId);
    if (list) list.push({ id, hasThumb });
    else out.set(profileId, [{ id, hasThumb }]);
  };
  for (const [id, block] of top) for (const item of block.items) add(id, item.id, !!item.thumbUrl);
  const reels = database.db.prepare(`
    SELECT p.profile_id AS profileId, p.post_id AS id, p.views, (p.thumb IS NOT NULL) AS hasThumb
    FROM spy_posts p JOIN spy_profiles s ON s.id = p.profile_id
    WHERE s.removed_at IS NULL AND p.media_type = 'video' AND p.created_at >= @from
    UNION ALL
    SELECT r.profile_id, r.reel_id, r.views, (r.thumb IS NOT NULL)
    FROM spy_reels r JOIN spy_profiles s ON s.id = r.profile_id
    WHERE s.removed_at IS NULL AND r.created_at >= @from
    ORDER BY views DESC
  `).all({ from: Math.floor(now / 1000) - WEEK_THUMBS_S }) as { profileId: string; id: string; hasThumb: number }[];
  for (const r of reels) add(r.profileId, r.id, !!r.hasThumb);
  return out;
}

/** The posts that should hold a thumbnail and still have none, per active profile. */
export function wantedThumbs(
  database: MiniDatabase,
  now = Date.now(),
  top: Map<string, TopBlock> = activeTopBlocks(database, now),
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, items] of thumbTargets(database, now, top)) {
    const missing = items.filter((i) => !i.hasThumb).map((i) => i.id);
    if (missing.length) out.set(id, missing);
  }
  return out;
}

export function ingestThumbs(database: MiniDatabase, items: unknown[]): { applied: number; unknown: number; invalid: number } {
  const out = { applied: 0, unknown: 0, invalid: 0 };
  if (!Array.isArray(items)) return out;
  const post = database.db.prepare("UPDATE spy_posts SET thumb = ? WHERE profile_id = ? AND post_id = ?");
  const reel = database.db.prepare("UPDATE spy_reels SET thumb = ? WHERE profile_id = ? AND reel_id = ?");
  for (const item of items) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const thumb = r?.thumb;
    if (!r || typeof r.profileId !== "string" || typeof r.id !== "string" || typeof thumb !== "string" ||
        thumb.length > THUMB_MAX || !THUMB_RE.test(thumb)) {
      out.invalid += 1;
      continue;
    }
    const changed = post.run(thumb, r.profileId, r.id).changes || reel.run(thumb, r.profileId, r.id).changes;
    if (changed) out.applied += 1;
    else out.unknown += 1;
  }
  return out;
}

export function getMediaThumb(database: MiniDatabase, profileId: string, mediaId: string): { body: Buffer; contentType: string } | null {
  const row = database.db.prepare(`
    SELECT thumb FROM spy_posts WHERE profile_id = @p AND post_id = @m
    UNION ALL SELECT thumb FROM spy_reels WHERE profile_id = @p AND reel_id = @m
  `).all({ p: profileId, m: mediaId }).find((r: any) => r.thumb) as { thumb: string } | undefined;
  const m = row ? /^data:([^;,]+);base64,(.+)$/s.exec(row.thumb) : null;
  return m ? { body: Buffer.from(m[2], "base64"), contentType: m[1] } : null;
}

/**
 * Thumbnails are kept only for each profile's current top 3 and the reels of the
 * last days: a post that leaves both loses its thumbnail. One that comes back
 * gets a new one: the readings renew every recent post's image address, and the
 * extension sends what wantThumbs names.
 */
export function pruneThumbs(
  database: MiniDatabase,
  now = Date.now(),
  top?: Map<string, TopBlock>,
): number {
  const held = database.db.prepare(`
    SELECT profile_id, post_id AS id, 'posts' AS t FROM spy_posts WHERE thumb IS NOT NULL
    UNION ALL SELECT profile_id, reel_id AS id, 'reels' AS t FROM spy_reels WHERE thumb IS NOT NULL
  `).all() as { profile_id: string; id: string; t: "posts" | "reels" }[];
  if (!held.length) return 0;
  const keep = new Set<string>();
  for (const [id, items] of thumbTargets(database, now, top ?? activeTopBlocks(database, now))) {
    for (const item of items) keep.add(`${id}|${item.id}`);
  }
  const clearPost = database.db.prepare("UPDATE spy_posts SET thumb = NULL WHERE profile_id = ? AND post_id = ?");
  const clearReel = database.db.prepare("UPDATE spy_reels SET thumb = NULL WHERE profile_id = ? AND reel_id = ?");
  let cleared = 0;
  for (const row of held) {
    if (keep.has(`${row.profile_id}|${row.id}`)) continue;
    (row.t === "posts" ? clearPost : clearReel).run(row.profile_id, row.id);
    cleared += 1;
  }
  return cleared;
}
