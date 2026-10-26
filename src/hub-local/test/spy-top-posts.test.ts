import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { removeProfile, saveProfile, updateProfileMeta } from "../server/spy.js";
import { ingestPosts, ingestThumbs } from "../server/spyPosts.js";
import { ingestReels } from "../server/spyReels.js";
import { dayStart, topPostById, topPosts } from "../server/spyTopPosts.js";

// Top posts: the five most viewed Instagram videos of the saved profiles,
// published yesterday, in the last 3 and in the last 7 closed days (GMT-3), and
// the median views per weekday and hour they were posted at.
let dir: string;
let created: CreatedApp;
const TOKEN = "t";
const IG = "instagram:barbie.the.aries";
const IG2 = "instagram:maya.astor";
const FB = "facebook:61589642519378";
const HOUR = 3600;
const DAY = 86_400;
const THUMB = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";
/** Sunday 2026-10-11, 19:00 in GMT-3. */
const NOW = Date.UTC(2026, 9, 11, 22, 0);
/** 00:00 of that Sunday in GMT-3, in seconds. */
const TODAY = Date.UTC(2026, 9, 11, 3, 0) / 1000;

let seq = 1000;
const video = (profileId: string, createdAt: number, views: number | null, extra: Record<string, unknown> = {}) => {
  const id = String(seq++);
  return { profileId, id, createdAt, mediaType: "video", code: `C${id}`, views, likes: 10, comments: 2, ...extra };
};
const ingest = (items: unknown[]) => ingestPosts(created.database, items, NOW);
const top = () => topPosts(created.database, NOW);
const ids = (days: number) => top().windows.find((w) => w.days === days)!.items.map((i) => i.id);

beforeEach(() => {
  seq = 1000;
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-top-posts-"));
  created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: TOKEN });
  saveProfile(created.database, "instagram", "barbie.the.aries", 1000);
  saveProfile(created.database, "instagram", "maya.astor", 1000);
  saveProfile(created.database, "facebook", "61589642519378", 1000);
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("report tags", () => {
  it("reads only the profiles with one of the rule's tags, in any case, and counts them", () => {
    updateProfileMeta(created.database, IG, { tags: ["Appyon", "real"] });
    ingest([video(IG, TODAY - 10 * HOUR, 1000), video(IG2, TODAY - 9 * HOUR, 5000)]);
    const only = topPosts(created.database, NOW, "views", ["appyon"]);
    expect(only.windows.find((w) => w.days === 1)!.items.map((i) => i.profileId)).toEqual([IG]);
    expect(only.profiles).toEqual({ tags: ["appyon"], read: 1, total: 3 });
    expect(topPosts(created.database, NOW).profiles).toEqual({ tags: [], read: 3, total: 3 });
    expect(ids(1)).toHaveLength(2);
  });

  it("a tag with an accented capital letter matches its own spelling", () => {
    updateProfileMeta(created.database, IG, { tags: ["Época"] });
    ingest([video(IG, TODAY - 10 * HOUR, 1000), video(IG2, TODAY - 9 * HOUR, 5000)]);
    const only = topPosts(created.database, NOW, "views", ["Época"]);
    expect(only.windows.find((w) => w.days === 1)!.items.map((i) => i.profileId)).toEqual([IG]);
    expect(only.profiles).toEqual({ tags: ["Época"], read: 1, total: 3 });
  });

  // Local: topPostById exists only for the hub's reel report.
  it.skip("a rule with no tagged profile reads nothing; the reel's own lookup still works", () => {
    ingest([video(IG2, TODAY - 9 * HOUR, 5000)]);
    const none = topPosts(created.database, NOW, "views", ["appyon"]);
    expect(none.windows.every((w) => w.items.length === 0)).toBe(true);
    expect(none.profiles).toEqual({ tags: ["appyon"], read: 0, total: 3 });
    expect(topPostById(created.database, "1000", NOW)).not.toBeNull();
  });

  // Local: no saved report rule (the route reads every profile).
  it.skip("GET /api/spy/top follows the saved rule", async () => {
    updateProfileMeta(created.database, IG, { tags: ["appyon"] });
    ingest([video(IG, TODAY - 10 * HOUR, 1000), video(IG2, TODAY - 9 * HOUR, 5000)]);
    updateSettings(created.database, { reportTags: ["appyon"] });
    // The route reads the wall clock: only Date is faked, the sockets keep their timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const res = await request(created.app).get("/api/spy/top").expect(200);
      expect(res.body.profiles).toEqual({ tags: ["appyon"], read: 1, total: 3 });
      expect(res.body.windows[0].items.map((i: { profileId: string }) => i.profileId)).toEqual([IG]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("day boundaries", () => {
  it("starts today at midnight in GMT-3, whatever the hour in UTC", () => {
    expect(dayStart(NOW)).toBe(TODAY);
    // 01:00 UTC on Monday is still Sunday 22:00 in GMT-3.
    expect(dayStart(Date.UTC(2026, 9, 12, 1, 0))).toBe(TODAY);
    expect(dayStart(Date.UTC(2026, 9, 12, 3, 0))).toBe(TODAY + DAY);
  });
});

describe("top 5 per period", () => {
  it("consolidates a collab's partial coauthor readings before calculating metrics", () => {
    const post = video(IG, TODAY - HOUR, 1000, { durationS: 60, likes: 50, comments: 10 });
    ingest([post, { ...post, profileId: IG2, views: 1001, likes: null, comments: null, durationS: null }]);
    expect(top().windows[0].duration).toEqual({ mean: 60, median: 60, known: 1, total: 1 });
    expect(topPosts(created.database, NOW, "engagement").windows[0].items).toEqual([
      expect.objectContaining({ id: post.id, views: 1001, likes: 50, comments: 10, durationS: 60 }),
    ]);
    created.database.db.prepare("UPDATE spy_posts SET views = NULL WHERE profile_id = ?").run(IG);
    expect(top().windows[0].duration).toEqual({ mean: 60, median: 60, known: 1, total: 1 });
  });
  it("averages known durations only inside each displayed top five", () => {
    ingest([
      video(IG, TODAY - HOUR, 6000, { durationS: 20 }),
      video(IG, TODAY - HOUR, 5000, { durationS: 40 }),
      video(IG, TODAY - HOUR, 4000),
      video(IG, TODAY - HOUR, 3000, { durationS: 0 }),
      video(IG, TODAY - HOUR, 2000, { durationS: -5 }),
      video(IG, TODAY - HOUR, 1000, { durationS: 900 }),
      video(IG, TODAY - 2 * DAY, 9000, { durationS: 60 }),
    ]);
    expect(top().windows[0].duration).toEqual({ mean: 30, median: 30, known: 2, total: 5 });
    expect(top().windows[1].duration).toEqual({ mean: 40, median: 40, known: 3, total: 5 });
  });

  it("calculates transparent engagement and ranks the full pool before taking five", () => {
    const posts = Array.from({ length: 6 }, (_, i) => video(IG, TODAY - HOUR, 10_000 + i, { likes: 10, comments: 1 }));
    const strong = video(IG, TODAY - HOUR, 2000, { likes: 80, comments: 20 });
    const tiny = video(IG, TODAY - HOUR, 10, { likes: 10, comments: 10 });
    ingest([...posts, strong, tiny]);
    const ranked = topPosts(created.database, NOW, "engagement").windows[0];
    expect(ranked.items[0]).toMatchObject({ id: strong.id, engagementRate: 5, weightedIndex: 8, commentsPer1000: 10 });
    expect(ranked.items).toHaveLength(5);
    expect(ranked.items.some((p) => p.id === tiny.id)).toBe(false);
  });

  it("keeps unknown rates null and compares against other earlier videos only", () => {
    ingest(Array.from({ length: 5 }, () => video(IG, TODAY - 10 * DAY, 100)));
    const post = video(IG, TODAY - HOUR, 1000, { likes: null, comments: 2 });
    ingest([post, video(IG, TODAY - HOUR, 0)]);
    const found = top().windows[0].items.find((p) => p.id === post.id)!;
    expect(found).toMatchObject({ engagementRate: null, weightedIndex: null, commentsPer1000: 2, relativeViews: 10, baselinePosts: 5 });
  });

  it("orders comment rates independently and excludes zero or unknown denominators", () => {
    const popular = video(IG, TODAY - HOUR, 10000, { likes: 1000, comments: 10 });
    const discussion = video(IG, TODAY - HOUR, 1000, { likes: null, comments: 50 });
    ingest([popular, discussion, video(IG, TODAY - HOUR, 0, { comments: 100 }), video(IG, TODAY - HOUR, null)]);
    const result = topPosts(created.database, NOW, "comments");
    expect(result.windows[0].items.map((p) => p.id)).toEqual([discussion.id, popular.id]);
    expect(result.windows[0].items[0]).toMatchObject({ commentsPer1000: 50, engagementRate: null });
    expect(result.windows[0].duration).toEqual({ mean: null, median: null, known: 0, total: 2 });
  });
  it("takes the closed days before today: yesterday, 3 days and 7 days", () => {
    const first = video(IG, TODAY - DAY, 10); // yesterday 00:00
    const last = video(IG, TODAY - 1, 20); // yesterday 23:59:59
    const today = video(IG, TODAY, 99_999); // today: no window
    const twoDays = video(IG, TODAY - DAY - 1, 30); // the day before yesterday
    const sixDays = video(IG, TODAY - 7 * DAY, 40); // the 7th day back
    const eightDays = video(IG, TODAY - 7 * DAY - 1, 50); // before the 7 days
    ingest([first, last, today, twoDays, sixDays, eightDays]);

    const windows = top().windows;
    expect(windows.map((w) => [w.days, w.from, w.to])).toEqual([
      [1, TODAY - DAY, TODAY],
      [3, TODAY - 3 * DAY, TODAY],
      [7, TODAY - 7 * DAY, TODAY],
    ]);
    expect(ids(1)).toEqual([last.id, first.id]);
    expect(ids(3)).toEqual([twoDays.id, last.id, first.id]);
    expect(ids(7)).toEqual([sixDays.id, twoDays.id, last.id, first.id]);
  });

  it("keeps the five most viewed, then the most liked, then the newest", () => {
    const posts = [
      video(IG, TODAY - 10 * HOUR, 500),
      video(IG, TODAY - 11 * HOUR, 100, { likes: 5 }),
      video(IG, TODAY - 12 * HOUR, 100, { likes: 9 }),
      video(IG2, TODAY - 13 * HOUR, 900),
      video(IG2, TODAY - 14 * HOUR, 300),
      video(IG2, TODAY - 15 * HOUR, 1),
      video(IG2, TODAY - 16 * HOUR, 300),
    ];
    ingest(posts);
    const [a, b, c, d, e, , g] = posts;
    expect(ids(1)).toEqual([d.id, a.id, e.id, g.id, c.id]);
    expect(ids(1)).not.toContain(b.id);
  });

  it("counts Instagram videos with views only", () => {
    const counted = video(IG, TODAY - 5 * HOUR, 10);
    ingest([
      counted,
      video(IG, TODAY - 6 * HOUR, null), // views not read
      { ...video(IG, TODAY - 7 * HOUR, null), mediaType: "photo", likes: 9_999 },
      { ...video(IG, TODAY - 8 * HOUR, null), mediaType: "carousel", likes: 9_999 },
    ]);
    ingestReels(created.database, [{ profileId: FB, id: "1234567", createdAt: TODAY - 9 * HOUR, views: 1_000_000 }], NOW);
    expect(ids(1)).toEqual([counted.id]);
  });

  it("leaves removed profiles out", () => {
    const kept = video(IG, TODAY - 5 * HOUR, 10);
    ingest([kept, video(IG2, TODAY - 5 * HOUR, 1_000)]);
    removeProfile(created.database, IG2, NOW);
    expect(ids(1)).toEqual([kept.id]);
  });

  it("counts a collab once, with the reading that has more views", () => {
    const post = video(IG, TODAY - 5 * HOUR, 700);
    ingest([post, { ...post, profileId: IG2, views: 900 }, video(IG, TODAY - 6 * HOUR, 800)]);
    const items = top().windows[0].items;
    expect(items.map((i) => [i.id, i.profileId, i.views])).toEqual([
      [post.id, IG2, 900],
      [String(Number(post.id) + 1), IG, 800],
    ]);
  });

  it("carries what the card shows: account, link, numbers, publication time and thumbnail", () => {
    const post = video(IG, TODAY - 5 * HOUR, 1234, { likes: 56, comments: 7 });
    ingest([post]);
    ingestThumbs(created.database, [{ profileId: IG, id: post.id, thumb: THUMB }]);
    expect(top().windows[0].items[0]).toMatchObject({
      id: post.id,
      profileId: IG,
      key: "barbie.the.aries",
      name: null,
      avatarUrl: null,
      url: `https://www.instagram.com/reel/${post.code}/`,
      createdAt: post.createdAt,
      views: 1234,
      likes: 56,
      comments: 7,
      thumbUrl: `/api/spy/profiles/${encodeURIComponent(IG)}/media/${post.id}/thumb`,
    });
  });
});

describe("hours map", () => {
  it("groups the videos by weekday and hour in GMT-3, with the median of their views", () => {
    // Saturday (day 6) 19:xx in GMT-3: three videos, median 200.
    const sat19 = TODAY - DAY + 19 * HOUR;
    // Friday (day 5) 08:xx: two videos, median between them.
    const fri08 = TODAY - 2 * DAY + 8 * HOUR;
    ingest([
      video(IG, sat19, 100),
      video(IG2, sat19 + 30 * 60, 200),
      video(IG, sat19 + 59 * 60, 9_000_000),
      video(IG, fri08, 10),
      video(IG2, fri08 + 60, 21),
    ]);
    const hours = top().hours;
    expect(hours.videos).toBe(5);
    expect(hours.cells).toEqual([
      { day: 5, hour: 8, videos: 2, median: 16 },
      { day: 6, hour: 19, videos: 3, median: 200 },
    ]);
  });

  it("covers the 90 closed days before today", () => {
    ingest([
      video(IG, TODAY + HOUR, 10), // today: too fresh
      video(IG, TODAY - 90 * DAY, 20), // first day of the 90
      video(IG, TODAY - 90 * DAY - 1, 30), // before them
    ]);
    const hours = top().hours;
    expect([hours.from, hours.to]).toEqual([TODAY - 90 * DAY, TODAY]);
    expect(hours.videos).toBe(1);
    expect(hours.cells).toEqual([{ day: 1, hour: 0, videos: 1, median: 20 }]);
  });

  it("counts a collab once", () => {
    const post = video(IG, TODAY - 5 * HOUR, 700);
    ingest([post, { ...post, profileId: IG2, views: 900 }]);
    expect(top().hours.cells).toEqual([{ day: 6, hour: 19, videos: 1, median: 900 }]);
  });
});

describe("GET /api/spy/top", () => {
  it("answers the three periods and the hours map", async () => {
    const res = await request(created.app).get("/api/spy/top");
    expect(res.status).toBe(200);
    expect(res.body.windows.map((w: any) => w.days)).toEqual([1, 3, 7]);
    expect(res.body.hours).toMatchObject({ videos: 0, cells: [] });
  });

  // Local: no login (hub-only).
  it.skip("requires the login cookie when APP_PASSWORD is set", async () => {
    const authed = createApp({
      dbPath: path.join(dir, "auth.db"), appPassword: "pw", sessionSecret: "s", syncToken: TOKEN,
    });
    expect((await request(authed.app).get("/api/spy/top")).status).toBe(401);
    authed.database.close();
  });
});
