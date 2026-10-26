import type { MiniDatabase } from "./db.js";
import { comebackEvents, engagement, trendRef, viewEvents, viewsPerHour, type ProfileTrends, type TrendPost } from "../shared/spy-trends.js";
import { itemUrl } from "./spyPosts.js";

/** The profile sheet's signals: newest event first. */
export function profileTrends(database: MiniDatabase, profileId: string, now = Date.now()): ProfileTrends | null {
  const profile = database.db.prepare("SELECT platform, reels_status AS reelsStatus, views_read_at AS viewsReadAt FROM spy_profiles WHERE id = ?")
    .get(profileId) as { platform: string; reelsStatus: string | null; viewsReadAt: number | null } | undefined;
  if (!profile) return null;
  const rows = database.db.prepare(`
    SELECT post_id AS id, created_at AS createdAt, code, media_type, views, views_at AS viewsAt, likes, comments, pinned, exact_date AS exactDate
    FROM spy_posts WHERE profile_id = @id
    UNION ALL
    SELECT reel_id, created_at, NULL, 'video', views, COALESCE(@viewsReadAt, first_seen_at), NULL, NULL, 0, 1
    FROM spy_reels WHERE profile_id = @id AND created_at IS NOT NULL
  `).all({ id: profileId, viewsReadAt: profile.viewsReadAt }) as (Omit<TrendPost, "url"> & { code: string | null; media_type: string | null; pinned: number; exactDate: number })[];
  // Pinned posts sit on top of the grid with old dates and prove nothing about the days between.
  const posts = rows.filter((r) => !r.pinned).map((r) => ({ ...r, url: itemUrl(profile.platform, r, profileId) }));
  const videos = posts.filter((p) => p.media_type === "video");
  // The record is complete back to the oldest grid post (Facebook: its reels), as in the posts per day.
  const dated = profile.platform === "facebook" ? videos : posts.filter((p) => p.exactDate === 1);
  const since = profile.platform === "facebook" && profile.reelsStatus === "done" ? 0
    : dated.length ? Math.min(...dated.map((p) => p.createdAt)) : null;
  const readings = database.db.prepare(`
    SELECT post_id AS id, observed_at AS at, views FROM spy_post_observations WHERE profile_id = ? AND views IS NOT NULL
  `).all(profileId) as { id: string; at: number; views: number }[];
  const events = [...viewEvents(videos), ...comebackEvents(posts.map(trendRef), since)].sort((a, b) => b.at - a.at);
  return { events, vph: viewsPerHour(videos.map(trendRef), readings), engagement: engagement(videos, now) };
}
