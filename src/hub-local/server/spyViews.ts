import type { MiniDatabase } from "./db.js";
import { dailyBlocks, itemUrl, type DailyBlock } from "./spyPosts.js";
import { profileTrends } from "./spyTrends.js";
import type { ProfileTrends } from "../shared/spy-trends.js";

// Views per period: the views of the reels published in the 24 h, 3 and 7 days
// before the last reading of the views (Instagram's Reels tab, Facebook's reels
// page). The windows end at that reading, not at "now": the numbers are the ones
// read then, and a window sliding with the clock would drop reels without ever
// seeing the new ones. Instagram reels are its videos; photos have no views.

export const VIEW_WINDOWS = [1, 3, 7] as const;
const DAY_S = 86_400;
/** Readings this close together are one reading spread over a few uploads. */
export const VIEWS_MERGE_MS = 30 * 60_000;
/** Reels the profile sheet lists: 14 days of bars plus room for any time zone. */
const DETAIL_WINDOW_S = 16 * DAY_S;

export interface ViewsWindow {
  days: number;
  /** Sum of the views read for the window's reels. */
  views: number;
  reels: number;
  /** Reels in the window read without views (counted as none). */
  missing: number;
  /** The record reaches back over the whole window. */
  complete: boolean;
}

export interface ViewsBlock {
  /** ms, the reading the windows end at. */
  at: number;
  windows: ViewsWindow[];
  /**
   * No Reels-tab reading yet: the windows end when the profile's grid last brought
   * views (a visit), may miss reels, and stay out of the history.
   */
  provisional?: true;
}

export interface ViewsReel {
  id: string;
  url: string;
  createdAt: number;
  views: number | null;
  thumbUrl: string | null;
}

export interface ViewsHistoryPoint {
  at: number;
  d1: number;
  d3: number;
  d7: number;
  reels: number;
  missing: number;
  complete: boolean;
}

export interface ViewsDetail {
  block: ViewsBlock | null;
  /** The reels of the last 16 days, newest first. */
  reels: ViewsReel[];
  history: ViewsHistoryPoint[];
  /** Level changes, spikes, returns, views per hour by age and the interaction rate (hub 0.53). */
  trends: ProfileTrends | null;
}

type ReelRow = { id: string; createdAt: number; views: number | null };

function reelRows(database: MiniDatabase, ids: string[], fromS: number): Map<string, ReelRow[]> {
  const out = new Map<string, ReelRow[]>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const rows = database.db.prepare(`
    SELECT profile_id AS profileId, post_id AS id, created_at AS createdAt, views
    FROM spy_posts WHERE media_type = 'video' AND created_at >= @from
    UNION ALL
    SELECT profile_id, reel_id, created_at, views
    FROM spy_reels WHERE created_at IS NOT NULL AND created_at >= @from
  `).all({ from: fromS }) as (ReelRow & { profileId: string })[];
  for (const r of rows) out.get(r.profileId)?.push({ id: r.id, createdAt: r.createdAt, views: r.views });
  return out;
}

function anchors(database: MiniDatabase, ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const stmt = database.db.prepare("SELECT views_read_at AS at FROM spy_profiles WHERE id = ?");
  for (const id of ids) {
    const row = stmt.get(id) as { at: number | null } | undefined;
    if (row?.at != null) out.set(id, row.at);
  }
  return out;
}

/** Before a profile's first Reels-tab reading: when its grid last brought views, per profile. */
function gridAnchors(database: MiniDatabase, ids: string[]): Map<string, number> {
  if (!ids.length) return new Map();
  const rows = database.db.prepare(`
    SELECT profile_id AS id, MAX(metrics_at) AS at FROM spy_posts
    WHERE media_type = 'video' AND views IS NOT NULL AND metrics_at IS NOT NULL AND profile_id IN (${ids.map(() => "?").join(",")})
    GROUP BY profile_id
  `).all(...ids) as { id: string; at: number }[];
  return new Map(rows.map((r) => [r.id, r.at]));
}

/** The three windows ending at `at` (ms), from a profile's reels and how far back its record reaches. */
export function viewsWindows(reels: ReelRow[], at: number, since: number | null): ViewsWindow[] {
  const endS = Math.floor(at / 1000);
  return VIEW_WINDOWS.map((days) => {
    const startS = endS - days * DAY_S;
    // A reel published after the reading (seen in the grid since) has no views yet.
    const inside = reels.filter((r) => r.createdAt > startS && r.createdAt <= endS);
    return {
      days,
      views: inside.reduce((sum, r) => sum + (r.views ?? 0), 0),
      reels: inside.length,
      missing: inside.filter((r) => r.views == null).length,
      complete: since != null && since <= startS,
    };
  });
}

/** Views block per profile; null until its views were read once. */
export function viewsBlocks(
  database: MiniDatabase,
  profiles: { id: string; platform: string }[],
  daily: Map<string, DailyBlock> = dailyBlocks(database, profiles),
): Map<string, ViewsBlock | null> {
  const ids = profiles.map((p) => p.id);
  const at = anchors(database, ids);
  const grid = gridAnchors(database, ids.filter((id) => !at.has(id)));
  const oldest = Math.min(...at.values(), ...grid.values());
  const rows = at.size || grid.size ? reelRows(database, [...at.keys(), ...grid.keys()], Math.floor(oldest / 1000) - 7 * DAY_S) : new Map();
  const out = new Map<string, ViewsBlock | null>();
  for (const id of ids) {
    const anchor = at.get(id) ?? grid.get(id);
    out.set(id, anchor == null ? null : {
      at: anchor,
      windows: viewsWindows(rows.get(id) ?? [], anchor, daily.get(id)?.since ?? null),
      ...(at.has(id) ? {} : { provisional: true as const }),
    });
  }
  return out;
}

/** The reading moves forward only: a late upload of an older one never rewinds it. */
export function markViewsRead(database: MiniDatabase, profileId: string, at: number): void {
  database.db.prepare(`
    UPDATE spy_profiles SET views_read_at = MAX(COALESCE(views_read_at, 0), ?) WHERE id = ?
  `).run(at, profileId);
}

/**
 * Keeps the windows of each profile's last reading in its history. Profiles in
 * `read` were just read; for the others the row is only refreshed while their
 * reading is recent, so posts uploaded a little after it still count there.
 */
export function recordViews(
  database: MiniDatabase,
  read: Iterable<string>,
  touched: Iterable<string> = [],
  now = Date.now(),
): void {
  const readSet = new Set(read);
  const ids = [...new Set([...readSet, ...touched])];
  if (!ids.length) return;
  const profiles = database.db.prepare(
    `SELECT id, platform FROM spy_profiles WHERE removed_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
  ).all(...ids) as { id: string; platform: string }[];
  const blocks = viewsBlocks(database, profiles);
  const clear = database.db.prepare("DELETE FROM spy_views WHERE profile_id = ? AND at >= ? AND at < ?");
  const upsert = database.db.prepare(`
    INSERT INTO spy_views (profile_id, at, d1, d3, d7, reels, missing, complete)
    VALUES (@id, @at, @d1, @d3, @d7, @reels, @missing, @complete)
    ON CONFLICT(profile_id, at) DO UPDATE SET d1 = excluded.d1, d3 = excluded.d3, d7 = excluded.d7,
      reels = excluded.reels, missing = excluded.missing, complete = excluded.complete
  `);
  for (const { id } of profiles) {
    const block = blocks.get(id);
    if (!block || block.provisional) continue;
    if (!readSet.has(id) && now - block.at > VIEWS_MERGE_MS) continue;
    const [d1, d3, d7] = block.windows;
    clear.run(id, block.at - VIEWS_MERGE_MS, block.at);
    upsert.run({ id, at: block.at, d1: d1.views, d3: d3.views, d7: d7.views,
      reels: d7.reels, missing: d7.missing, complete: d7.complete ? 1 : 0 });
  }
}

/** The profile sheet's views: the windows, the recent reels and the history. */
export function viewsDetail(database: MiniDatabase, profileId: string, now = Date.now()): ViewsDetail | null {
  const profile = database.db.prepare("SELECT id, platform, views_read_at AS at FROM spy_profiles WHERE id = ?")
    .get(profileId) as { id: string; platform: string; at: number | null } | undefined;
  if (!profile) return null;
  const block = viewsBlocks(database, [profile]).get(profileId) ?? null;
  const fromS = Math.floor(Math.min(now, profile.at ?? now) / 1000) - DETAIL_WINDOW_S;
  const rows = database.db.prepare(`
    SELECT post_id AS id, created_at AS createdAt, views, code, media_type, (thumb IS NOT NULL) AS hasThumb
    FROM spy_posts WHERE profile_id = @id AND media_type = 'video' AND created_at >= @from
    UNION ALL
    SELECT reel_id, created_at, views, NULL, 'video', (thumb IS NOT NULL)
    FROM spy_reels WHERE profile_id = @id AND created_at IS NOT NULL AND created_at >= @from
    ORDER BY createdAt DESC
  `).all({ id: profileId, from: fromS }) as
    { id: string; createdAt: number; views: number | null; code: string | null; media_type: string; hasThumb: number }[];
  const reels = rows.map((r) => ({
    id: r.id,
    url: itemUrl(profile.platform, r, profileId),
    createdAt: r.createdAt,
    views: r.views,
    thumbUrl: r.hasThumb ? `/api/spy/profiles/${encodeURIComponent(profileId)}/media/${r.id}/thumb` : null,
  }));
  const history = (database.db.prepare(`
    SELECT at, d1, d3, d7, reels, missing, complete FROM spy_views WHERE profile_id = ? ORDER BY at ASC
  `).all(profileId) as (Omit<ViewsHistoryPoint, "complete"> & { complete: number })[])
    .map((r) => ({ ...r, complete: !!r.complete }));
  return { block, reels, history, trends: profileTrends(database, profileId, now) };
}

/** Removal and re-adding start over, like the follower history. */
export function forgetViews(database: MiniDatabase, profileId: string): void {
  database.db.prepare("DELETE FROM spy_views WHERE profile_id = ?").run(profileId);
  database.db.prepare("UPDATE spy_profiles SET views_read_at = NULL WHERE id = ?").run(profileId);
}

/** Merge: the kept profile gets the other's history and the newer reading. */
export function moveViews(database: MiniDatabase, intoId: string, fromId: string): void {
  database.db.prepare(`
    INSERT OR IGNORE INTO spy_views (profile_id, at, d1, d3, d7, reels, missing, complete)
    SELECT ?, at, d1, d3, d7, reels, missing, complete FROM spy_views WHERE profile_id = ?
  `).run(intoId, fromId);
  const from = database.db.prepare("SELECT views_read_at AS at FROM spy_profiles WHERE id = ?").get(fromId) as
    { at: number | null } | undefined;
  if (from?.at != null) markViewsRead(database, intoId, from.at);
}
