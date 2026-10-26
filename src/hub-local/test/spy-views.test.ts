import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { createDatabase } from "./harness";
import { saveProfile } from "../server/spy.js";

// Views per period: the views of the reels published in the 24 h, 3 and 7 days
// before the last reading of the views. The windows end at that reading, so the
// numbers hold still between readings instead of draining with the clock.
let dir: string;
let created: CreatedApp;
const TOKEN = "t";
const IG = "instagram:barbie.the.aries";
const FB = "facebook:61589642519378";
const HOUR = 3600;
const DAY = 86_400;
const THUMB = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";

const postSpy = (body: unknown) => request(created.app).post("/api/sync/spy").set("X-Sync-Token", TOKEN).send(body as object);
const card = async (id: string) => (await request(created.app).get("/api/spy/profiles")).body.profiles.find((p: any) => p.id === id);
const detail = async (id: string) => (await request(created.app).get(`/api/spy/profiles/${encodeURIComponent(id)}/views`)).body;
const sums = (views: any) => views.windows.map((w: any) => w.views);
/** A post `ageS` seconds older than the reading at `atMs`. */
const igPost = (id: string, atMs: number, ageS: number, extra = {}) =>
  ({ profileId: IG, id, createdAt: Math.floor(atMs / 1000) - ageS, mediaType: "video", code: `C${id}`, ...extra });
const fbReel = (id: string, atMs: number, ageS: number, views: number | null) =>
  ({ profileId: FB, id, createdAt: Math.floor(atMs / 1000) - ageS, views });
const reelsReading = (profileId: string, at: number, ok = true) =>
  ({ profileId, at, kind: "reels", source: "daily", ok, ...(ok ? {} : { error: "network" }) });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-views-"));
  created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: TOKEN });
  saveProfile(created.database, "instagram", "barbie.the.aries", 1000);
  saveProfile(created.database, "facebook", "61589642519378", 1000);
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("views per period", () => {
  it("sums each reel into every window it was published in, before the reading", async () => {
    const at = Date.now() - 2 * HOUR * 1000;
    await postSpy({
      posts: [
        igPost("3001", at, 5 * HOUR, { views: 100 }), // 24 h, 3 d and 7 d
        igPost("3002", at, 26 * HOUR, { views: 20 }), // 3 d and 7 d
        igPost("3003", at, 4 * DAY, { views: 3 }), // 7 d
        igPost("3004", at, 8 * DAY, { views: 9999 }), // none
        igPost("3005", at, 2 * HOUR, { mediaType: "photo", likes: 50 }), // photos have no views
      ],
      readings: [reelsReading(IG, at)],
    });
    const { views } = await card(IG);
    expect(views.at).toBe(at);
    expect(views.windows.map((w: any) => [w.days, w.views, w.reels, w.missing])).toEqual([
      [1, 100, 1, 0], [3, 120, 2, 0], [7, 123, 3, 0]]);
  });

  it("shows the views the grid brought as a provisional reading until the reels were read once", async () => {
    const at = Date.now();
    // A post without views (photo, or a grid that brought none) gives nothing to show.
    await postSpy({ posts: [igPost("3000", at, 2 * HOUR)] });
    expect((await card(IG)).views).toBeNull();
    await postSpy({ posts: [igPost("3001", at, HOUR, { views: 100 })] });
    const early = (await card(IG)).views;
    expect(early).toMatchObject({ provisional: true });
    expect(early.at).toBeGreaterThanOrEqual(at);
    expect(early.windows.map((w: any) => [w.views, w.reels, w.missing])).toEqual([[100, 2, 1], [100, 2, 1], [100, 2, 1]]);
    expect((await detail(IG)).block).toMatchObject({ provisional: true });
    // Not a reading: nothing in the history, and the health check still waits for one.
    expect((await detail(IG)).history).toEqual([]);
    expect(created.database.db.prepare("SELECT views_read_at AS v FROM spy_profiles WHERE id = ?").get(IG)).toEqual({ v: null });
    await postSpy({ readings: [reelsReading(IG, at, false)] });
    expect((await card(IG)).views).toMatchObject({ provisional: true });
    await postSpy({ readings: [reelsReading(IG, at)] });
    const read = (await card(IG)).views;
    expect(read.provisional).toBeUndefined();
    expect(read.at).toBe(at);
    expect(sums(read)).toEqual([100, 100, 100]);
  });

  it("ends the windows at the reading: later reels wait for the next one", async () => {
    const at = Date.now() - 5 * HOUR * 1000;
    await postSpy({ posts: [igPost("3001", at, HOUR, { views: 100 })], readings: [reelsReading(IG, at)] });
    // Seen in the grid on a visit after the reading: no views yet, outside the windows.
    await postSpy({ posts: [igPost("3002", at, -2 * HOUR)] });
    let { views } = await card(IG);
    expect(views.windows[0]).toMatchObject({ views: 100, reels: 1, missing: 0 });
    // An older reading uploaded late never rewinds the windows.
    await postSpy({ readings: [reelsReading(IG, at - DAY * 1000)] });
    ({ views } = await card(IG));
    expect(views.at).toBe(at);
  });

  it("counts reels read without views and says when the record is too short", async () => {
    const at = Date.now();
    await postSpy({
      posts: [igPost("3001", at, HOUR, { views: 100 }), igPost("3002", at, 2 * DAY)],
      readings: [reelsReading(IG, at)],
    });
    let { views } = await card(IG);
    expect(views.windows.map((w: any) => [w.views, w.missing, w.complete])).toEqual([
      [100, 0, true], [100, 1, false], [100, 1, false]]);
    await postSpy({ posts: [igPost("3003", at, 8 * DAY, { views: 1 })] });
    ({ views } = await card(IG));
    expect(views.windows.every((w: any) => w.complete)).toBe(true);
  });

  it("sums Facebook reels, complete once the first full reading is done", async () => {
    const at = Date.now();
    await postSpy({
      reels: [fbReel("900101", at, 3 * HOUR, 1500), fbReel("900102", at, 50 * HOUR, 700), fbReel("900103", at, 6 * DAY, null)],
      readings: [reelsReading(FB, at)],
    });
    let { views } = await card(FB);
    expect(views.windows.map((w: any) => [w.views, w.reels, w.missing])).toEqual([[1500, 1, 0], [2200, 2, 0], [2200, 3, 1]]);
    expect(views.windows[2].complete).toBe(false);
    await postSpy({ reelsStatus: [{ profileId: FB, status: "done", at }] });
    ({ views } = await card(FB));
    expect(views.windows.every((w: any) => w.complete)).toBe(true);
  });
});

describe("views history and detail", () => {
  it("keeps one point per reading, and the posts that land shortly after it", async () => {
    const first = Date.now() - 2 * DAY * 1000;
    await postSpy({ posts: [igPost("3001", first, HOUR, { views: 100 })], readings: [reelsReading(IG, first)] });
    const second = Date.now() - 1000;
    await postSpy({ readings: [reelsReading(IG, second)] });
    // The reading's reels come in a later upload, minutes after it.
    await postSpy({ posts: [igPost("3002", second, 3 * HOUR, { views: 40 }), igPost("3001", first, HOUR, { views: 900 })] });
    const { history } = await detail(IG);
    expect(history.map((h: any) => [h.at, h.d1, h.d3, h.d7, h.reels])).toEqual([
      [first, 100, 100, 100, 1],
      [second, 40, 940, 940, 2],
    ]);
  });

  it("folds readings minutes apart into the newest one", async () => {
    const at = Date.now() - 1000;
    await postSpy({ reels: [fbReel("900101", at, HOUR, 10)], readings: [reelsReading(FB, at - 10 * 60_000)] });
    await postSpy({ reels: [fbReel("900101", at, HOUR, 25)], readings: [{ ...reelsReading(FB, at), source: "refresh" }] });
    expect((await detail(FB)).history.map((h: any) => [h.at, h.d1])).toEqual([[at, 25]]);
  });

  it("does not move an old reading's point when posts arrive much later", async () => {
    const at = Date.now() - DAY * 1000;
    await postSpy({ posts: [igPost("3001", at, HOUR, { views: 100 })], readings: [reelsReading(IG, at)] });
    await postSpy({ posts: [igPost("3001", at, HOUR, { likes: 3 })] }); // a visit's grid
    await postSpy({ posts: [igPost("3001", at, HOUR, { views: 500 })] }); // the next reading, before its report
    expect((await detail(IG)).history.map((h: any) => h.d1)).toEqual([100]);
  });

  it("lists the recent reels with links and thumbnails, newest first", async () => {
    const at = Date.now();
    await postSpy({
      posts: [igPost("3001", at, HOUR, { views: 100 }), igPost("3002", at, 2 * DAY, { views: 7 }),
        igPost("3003", at, 20 * DAY, { views: 1 })],
      readings: [reelsReading(IG, at)],
    });
    await postSpy({ thumbs: [{ profileId: IG, id: "3002", thumb: THUMB }] });
    const { block, reels } = await detail(IG);
    expect(sums(block)).toEqual([100, 107, 107]);
    expect(reels.map((r: any) => [r.id, r.views, r.url])).toEqual([
      ["3001", 100, "https://www.instagram.com/reel/C3001/"],
      ["3002", 7, "https://www.instagram.com/reel/C3002/"],
    ]);
    // Local: the stored data: URL itself instead of the hub's /thumb route.
    expect(reels[1].thumbUrl).toBe(THUMB);
    expect((await request(created.app).get("/api/spy/profiles/instagram:nobody/views")).status).toBe(404);
  });

  it("asks for and keeps the thumbnails of the week's reels, not only the top 3", async () => {
    const at = Date.now();
    await postSpy({
      posts: ["3001", "3002", "3003", "3004"].map((id, i) => igPost(id, at, (i + 1) * HOUR, { views: 100 - i })),
      readings: [reelsReading(IG, at)],
    });
    const list = (await request(created.app).get("/api/sync/spy/profiles").set("X-Sync-Token", TOKEN)).body.profiles;
    expect(list.find((p: any) => p.id === IG).wantThumbs).toEqual(["3001", "3002", "3003", "3004"]);
    await postSpy({ thumbs: [{ profileId: IG, id: "3004", thumb: THUMB }] });
    expect((await detail(IG)).reels.find((r: any) => r.id === "3004").thumbUrl).not.toBeNull();
  });

  it("starts over when a profile is removed for good, and follows a merge", async () => {
    const at = Date.now();
    await postSpy({ reels: [fbReel("900101", at, HOUR, 10)], readings: [reelsReading(FB, at)] });
    await request(created.app).delete(`/api/spy/profiles/${encodeURIComponent(FB)}`);
    await request(created.app).post("/api/spy/profiles").send({ platform: "facebook", handle: "61589642519378" });
    // Restored within the undo window: the history is back.
    expect((await detail(FB)).history).toHaveLength(1);
    created.database.db.prepare("UPDATE spy_profiles SET removed_at = ?, purged_at = NULL WHERE id = ?").run(1, FB);
    await request(created.app).get("/api/spy/profiles"); // purges removals past the window
    const row = created.database.db.prepare("SELECT COUNT(*) AS n FROM spy_views WHERE profile_id = ?").get(FB);
    expect(row).toEqual({ n: 0 });
  });

  // Local: no backup (hub-only).
  it.skip("travels in the backup", async () => {
    const at = Date.now();
    await postSpy({ posts: [igPost("3001", at, HOUR, { views: 100 })], readings: [reelsReading(IG, at)] });
    const backup = (await request(created.app).get("/api/export")).body;
    expect(backup.spy.views).toHaveLength(1);
    const res = await request(created.app).post("/api/import?mode=replace").send(backup);
    expect(res.status).toBe(200);
    expect((await card(IG)).views.at).toBe(at);
    expect((await detail(IG)).history).toHaveLength(1);
  });
});

// Local: a hub migration; the local schema starts at the final state.
describe.skip("views migration", () => {
  it("starts each profile at its newest reading of the views", () => {
    const file = path.join(dir, "old.db");
    const fresh = createDatabase({ dbPath: file });
    fresh.close();
    const raw = new Database(file);
    raw.exec(`
      INSERT INTO spy_profiles (id, platform, key, saved_at, list_updated_at) VALUES
        ('facebook:1234567', 'facebook', '1234567', 1, 1), ('instagram:nasa', 'instagram', 'nasa', 1, 1);
      INSERT INTO spy_readings (profile_id, at, kind, platform, source, ok) VALUES
        ('facebook:1234567', 5000, 'reels', 'facebook', 'daily', 1),
        ('facebook:1234567', 9000, 'reels', 'facebook', 'daily', 0),
        ('facebook:1234567', 9500, 'followers', 'facebook', 'daily', 1);
      INSERT INTO spy_posts (profile_id, post_id, created_at, first_seen_at, views, metrics_at) VALUES
        ('instagram:nasa', '111', 1791000000, 1, 10, 7000), ('instagram:nasa', '112', 1791000000, 1, NULL, 8000);
      UPDATE spy_profiles SET views_read_at = NULL;
    `);
    raw.pragma("user_version = 2");
    raw.close();
    const database = createDatabase({ dbPath: file });
    const rows = database.db.prepare("SELECT id, views_read_at AS at FROM spy_profiles ORDER BY id").all();
    expect(rows).toEqual([{ id: "facebook:1234567", at: 5000 }, { id: "instagram:nasa", at: 7000 }]);
    database.close();
  });
});
