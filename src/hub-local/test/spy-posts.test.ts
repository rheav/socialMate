import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { SPY_REMOVED_KEEP_MS, applyListOps, mergeProfiles, purgeRemoved, saveProfile } from "../server/spy.js";

// Posts per day: Instagram posts the extension sees in a profile's grid (a
// collab counts for every grid it is in), Facebook reels already kept by the hub.
// The card gets the publication times of the last days and how far back the
// record is complete; the dashboard buckets them by the viewer's local day.
let dir: string;
let created: CreatedApp;
const TOKEN = "t";
const IG = "instagram:nasa";
const FB = "facebook:61589642519378";
const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);

const postSpy = (body: unknown) => request(created.app).post("/api/sync/spy").set("X-Sync-Token", TOKEN).send(body as object);
const post = (id: string, createdAt: number, extra = {}) => ({ profileId: IG, id, createdAt, mediaType: "image", ...extra });
const card = async (id: string) => (await request(created.app).get("/api/spy/profiles")).body.profiles.find((p: any) => p.id === id);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-posts-"));
  created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: TOKEN });
  saveProfile(created.database, "instagram", "nasa", 1000);
  saveProfile(created.database, "facebook", "61589642519378", 1000);
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Instagram posts per day", () => {
  it("keeps each post once and gives the card the last days' publication times", async () => {
    const t = nowSec();
    const first = await postSpy({ posts: [post("3001", t - 3600), post("3002", t - DAY - 60), post("3001", t - 3600)] });
    expect(first.body.results.posts).toMatchObject({ added: 2, known: 1, unknown: 0, invalid: 0 });
    await postSpy({ posts: [post("3003", t - 20 * DAY)] });
    const { daily } = await card(IG);
    expect(daily.kind).toBe("posts");
    expect(daily.times).toEqual([t - 3600, t - DAY - 60]);
  });

  it("is complete back to the oldest post that is not pinned", async () => {
    const t = nowSec();
    await postSpy({ posts: [post("3001", t - 3600), post("3002", t - 5 * DAY), post("2001", t - 90 * DAY, { pinned: true })] });
    expect((await card(IG)).daily.since).toBe(t - 5 * DAY);
  });

  it("is complete only as far back as the grid was read: a Reels-tab post dated by its id says nothing about photos", async () => {
    const t = nowSec();
    await postSpy({ posts: [post("3001", t - 3600), post("3002", t - 5 * DAY), post("2001", t - 40 * DAY, { exactDate: false, views: 9 })] });
    expect((await card(IG)).daily.since).toBe(t - 5 * DAY);
    // Seen later in the grid, it is dated exactly and counts.
    await postSpy({ posts: [post("2001", t - 40 * DAY + 30)] });
    expect((await card(IG)).daily.since).toBe(t - 40 * DAY + 30);
  });

  it("has no record until a post arrives", async () => {
    expect((await card(IG)).daily).toMatchObject({ kind: "posts", times: [], since: null });
  });

  it("refuses posts for unknown, removed or Facebook profiles and malformed rows", async () => {
    const t = nowSec();
    applyListOps(created.database, [{ op: "save", platform: "instagram", key: "gone", at: 2000 },
      { op: "remove", platform: "instagram", key: "gone", at: 3000 }]);
    const res = await postSpy({ posts: [
      { ...post("3001", t), profileId: "instagram:nope" },
      { ...post("3002", t), profileId: "instagram:gone" },
      { ...post("3003", t), profileId: FB },
      { profileId: IG, id: "x y", createdAt: t },
      { profileId: IG, id: "3004", createdAt: "yesterday" },
      null,
    ] });
    expect(res.body.results.posts).toMatchObject({ added: 0, unknown: 3, invalid: 3 });
  });

  it("forgets the posts with the profile and moves them on a merge", async () => {
    const t = nowSec();
    await postSpy({ posts: [post("3001", t - 60)] });
    applyListOps(created.database, [{ op: "remove", platform: "instagram", key: "nasa", at: 5000 }]);
    // Saved again within 7 days: the posts are still there.
    applyListOps(created.database, [{ op: "save", platform: "instagram", key: "nasa", at: 6000 }]);
    expect((await card(IG)).daily.times).toEqual([t - 60]);
    // Removed and left past the window: they go.
    applyListOps(created.database, [{ op: "remove", platform: "instagram", key: "nasa", at: 6500 }]);
    purgeRemoved(created.database, 6500 + SPY_REMOVED_KEEP_MS + 1);
    applyListOps(created.database, [{ op: "save", platform: "instagram", key: "nasa", at: 6500 + SPY_REMOVED_KEEP_MS + 2 }]);
    expect((await card(IG)).daily.times).toEqual([]);

    saveProfile(created.database, "instagram", "nasa_old", 7000);
    created.database.db.prepare("UPDATE spy_profiles SET user_id = '42' WHERE id IN (?, ?)").run(IG, "instagram:nasa_old");
    await postSpy({ posts: [{ ...post("3009", t - 120), profileId: "instagram:nasa_old" }] });
    mergeProfiles(created.database, IG, "instagram:nasa_old");
    expect((await card(IG)).daily.times).toEqual([t - 120]);
  });

  it("keeps a moved post's link, numbers, thumbnail and date quality on a merge", async () => {
    const t = nowSec();
    saveProfile(created.database, "instagram", "nasa_old", 7000);
    created.database.db.prepare("UPDATE spy_profiles SET user_id = '42' WHERE id IN (?, ?)").run(IG, "instagram:nasa_old");
    await postSpy({ posts: [{ ...post("3010", t - 300, { code: "Cx1abcde", views: 900, likes: 50, comments: 4, exactDate: false, mediaType: "video" }), profileId: "instagram:nasa_old" }] });
    created.database.db.prepare("UPDATE spy_posts SET thumb = 'data:image/webp;base64,AAAA' WHERE post_id = '3010'").run();
    const readAt = (created.database.db.prepare("SELECT posts_read_at FROM spy_profiles WHERE id = ?").get("instagram:nasa_old") as { posts_read_at: number }).posts_read_at;

    mergeProfiles(created.database, IG, "instagram:nasa_old");

    const row = created.database.db.prepare("SELECT * FROM spy_posts WHERE profile_id = ? AND post_id = '3010'").get(IG);
    expect(row).toMatchObject({
      code: "Cx1abcde", views: 900, likes: 50, comments: 4, exact_date: 0,
      thumb: "data:image/webp;base64,AAAA", media_type: "video",
    });
    expect((row as { metrics_at: number | null }).metrics_at).toEqual(expect.any(Number));
    const kept = created.database.db.prepare("SELECT posts_read_at FROM spy_profiles WHERE id = ?").get(IG) as { posts_read_at: number };
    expect(kept.posts_read_at).toBe(readAt);
  });

  // Local: no backup (hub-only).
  it.skip("survives a backup round trip", async () => {
    const t = nowSec();
    await postSpy({ posts: [post("3001", t - 60, { pinned: true })] });
    const backup = exportBackup(created.database);
    expect(backup.spy?.posts).toHaveLength(1);
    importBackup(created.database, backup, "replace");
    const row = created.database.db.prepare("SELECT * FROM spy_posts").get() as Record<string, unknown>;
    expect(row).toMatchObject({ profile_id: IG, post_id: "3001", created_at: t - 60, pinned: 1 });
  });
});

describe("when the posts were last read", () => {
  it("records when the extension last sent the grid, even with no new post", async () => {
    const t = nowSec();
    expect((await card(IG)).daily.readAt).toBeNull();
    const before = Date.now();
    await postSpy({ posts: [post("3001", t - 60)] });
    await postSpy({ posts: [post("3001", t - 60)] });
    expect((await card(IG)).daily.readAt).toBeGreaterThanOrEqual(before);
  });

  // Local: a hub migration; the local schema starts at the final state.
  it.skip("drops once the posts collected before the author filter existed", () => {
    const dbPath = path.join(dir, "test.db");
    created.database.db.prepare("INSERT INTO spy_posts (profile_id, post_id, created_at, media_type, pinned, first_seen_at) VALUES (?, '3001', 1791000000, 'video', 0, 1)").run(IG);
    created.database.db.exec("ALTER TABLE spy_profiles DROP COLUMN posts_read_at");
    // A database from before the hub numbered its migrations.
    created.database.db.pragma("user_version = 0");
    created.database.close();
    created = createApp({ dbPath, appPassword: "", syncToken: TOKEN });
    expect(created.database.db.prepare("SELECT COUNT(*) AS n FROM spy_posts").get()).toEqual({ n: 0 });
    created.database.db.prepare("INSERT INTO spy_posts (profile_id, post_id, created_at, media_type, pinned, first_seen_at) VALUES (?, '3002', 1791000000, 'video', 0, 1)").run(IG);
    created.database.close();
    created = createApp({ dbPath, appPassword: "", syncToken: TOKEN });
    expect(created.database.db.prepare("SELECT COUNT(*) AS n FROM spy_posts").get()).toEqual({ n: 1 });
  });
});

describe("Facebook reels per day", () => {
  it("uses the reels the hub already keeps, complete once the full reading is done", async () => {
    const t = nowSec();
    await postSpy({ reels: [{ profileId: FB, id: "900101", createdAt: t - 7200 }, { profileId: FB, id: "900102", createdAt: t - 3 * DAY }] });
    let daily = (await card(FB)).daily;
    expect(daily).toMatchObject({ kind: "reels", times: [t - 7200, t - 3 * DAY], since: t - 3 * DAY });
    await postSpy({ reelsStatus: [{ profileId: FB, status: "done", at: 10 }] });
    daily = (await card(FB)).daily;
    expect(daily.since).toBe(0);
    expect(daily.readAt).toBeNull(); // the follower reading time, none yet
  });
});
