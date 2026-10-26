import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { saveProfile } from "../server/spy.js";

// Top 3 of the last 7 days per profile: Instagram reels by views (a week with no
// reel ranks posts by likes, and reels come before photos), Facebook reels by
// views. Thumbnails are small images the extension sends for the hub's current
// top 3, served from the hub because the networks' image links expire.
let dir: string;
let created: CreatedApp;
const TOKEN = "t";
const IG = "instagram:barbie.the.aries";
const FB = "facebook:61589642519378";
const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);
const THUMB = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";

const postSpy = (body: unknown) => request(created.app).post("/api/sync/spy").set("X-Sync-Token", TOKEN).send(body as object);
const card = async (id: string) => (await request(created.app).get("/api/spy/profiles")).body.profiles.find((p: any) => p.id === id);
const igPost = (id: string, ageS: number, extra = {}) =>
  ({ profileId: IG, id, createdAt: nowSec() - ageS, mediaType: "video", code: `C${id}`, ...extra });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-top-"));
  created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: TOKEN });
  saveProfile(created.database, "instagram", "barbie.the.aries", 1000);
  saveProfile(created.database, "facebook", "61589642519378", 1000);
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Instagram top 3 of the week", () => {
  it("ranks the week's reels by views and links each one", async () => {
    await postSpy({ posts: [
      igPost("3001", 3600, { views: 528, likes: 12, comments: 13 }),
      igPost("3002", 2 * DAY, { views: 4625, likes: 127, comments: 63 }),
      igPost("3003", 3 * DAY, { views: 1897, likes: 30, comments: 16 }),
      igPost("3004", 4 * DAY, { views: 214, likes: 4, comments: 6 }),
      igPost("3005", 8 * DAY, { views: 99999, likes: 9999 }), // outside the week
    ] });
    const { top } = await card(IG);
    expect(top.items.map((i: any) => [i.id, i.views, i.metric])).toEqual([
      ["3002", 4625, "views"], ["3003", 1897, "views"], ["3001", 528, "views"]]);
    expect(top.items[0]).toMatchObject({ likes: 127, comments: 63, url: "https://www.instagram.com/reel/C3002/", thumbUrl: null });
  });

  it("ranks by likes in a week with no reel, and fills behind fewer than 3 reels with the most liked posts", async () => {
    await postSpy({ posts: [
      igPost("3001", 3600, { mediaType: "photo", likes: 40 }),
      igPost("3002", DAY, { mediaType: "carousel", likes: 90 }),
      igPost("3003", 2 * DAY, { mediaType: "photo", likes: 10 }),
      igPost("3004", 3 * DAY, { mediaType: "photo", likes: 70 }),
    ] });
    let { top } = await card(IG);
    expect(top.items.map((i: any) => [i.id, i.metric])).toEqual([["3002", "likes"], ["3004", "likes"], ["3001", "likes"]]);
    expect(top.items[0].url).toBe("https://www.instagram.com/p/C3002/");
    await postSpy({ posts: [igPost("3010", 5 * DAY, { views: 50, likes: 1 })] });
    ({ top } = await card(IG));
    expect(top.items.map((i: any) => i.id)).toEqual(["3010", "3002", "3004"]);
  });

  it("keeps the newest numbers and never clears one with an empty reading", async () => {
    await postSpy({ posts: [igPost("3001", 3600, { views: 100, likes: 5 })] });
    await postSpy({ posts: [igPost("3001", 3600, { views: 250 })] });
    await postSpy({ posts: [igPost("3001", 3600)] });
    expect((await card(IG)).top.items[0]).toMatchObject({ views: 250, likes: 5 });
  });

  it("says whether the week is complete", async () => {
    await postSpy({ posts: [igPost("3001", 3600, { views: 1 })] });
    expect((await card(IG)).top.complete).toBe(false);
    await postSpy({ posts: [igPost("3002", 8 * DAY, { views: 1 })] });
    expect((await card(IG)).top.complete).toBe(true);
  });
});

describe("Facebook top 3 of the week", () => {
  it("ranks the week's reels by views", async () => {
    await postSpy({ reels: [
      { profileId: FB, id: "900101", createdAt: nowSec() - 3600, views: 263000 },
      { profileId: FB, id: "900102", createdAt: nowSec() - 2 * DAY, views: 1_300_000 },
      { profileId: FB, id: "900103", createdAt: nowSec() - 3 * DAY, views: 858000 },
      { profileId: FB, id: "900104", createdAt: nowSec() - 4 * DAY, views: 1000 },
      { profileId: FB, id: "900105", createdAt: nowSec() - 9 * DAY, views: 9_000_000 },
    ] });
    const { top } = await card(FB);
    expect(top.items.map((i: any) => [i.id, i.views])).toEqual([["900102", 1_300_000], ["900103", 858000], ["900101", 263000]]);
    expect(top.items[0]).toMatchObject({ metric: "views", url: "https://www.facebook.com/reel/900102" });
  });
});

describe("thumbnails of the top 3", () => {
  it("asks the extension for the missing ones, stores what it sends and serves the bytes", async () => {
    await postSpy({ posts: [igPost("3001", 3600, { views: 10 }), igPost("3002", 7200, { views: 20 })] });
    await postSpy({ reels: [{ profileId: FB, id: "900101", createdAt: nowSec() - 3600, views: 5 }] });
    let list = (await request(created.app).get("/api/sync/spy/profiles").set("X-Sync-Token", TOKEN)).body.profiles;
    expect(list.find((p: any) => p.id === IG).wantThumbs).toEqual(["3002", "3001"]);
    expect(list.find((p: any) => p.id === FB).wantThumbs).toEqual(["900101"]);

    const res = await postSpy({ thumbs: [
      { profileId: IG, id: "3002", thumb: THUMB }, { profileId: FB, id: "900101", thumb: THUMB },
      { profileId: IG, id: "9999", thumb: THUMB }, { profileId: IG, id: "3001", thumb: "https://cdn/x.jpg" },
    ] });
    expect(res.body.results.thumbs).toEqual({ applied: 2, unknown: 1, invalid: 1 });
    list = res.body.profiles;
    expect(list.find((p: any) => p.id === IG).wantThumbs).toEqual(["3001"]);

    const item = (await card(IG)).top.items[0];
    // Local: the stored data: URL itself instead of the hub's /thumb route.
    expect(item.thumbUrl).toBe(THUMB);
  });
});

describe("thumbnails only for the current top 3 and the week's reels", () => {
  it("drops a photo's thumbnail once it leaves its profile's top 3", async () => {
    const photo = (id: string, ageS: number, likes: number) => igPost(id, ageS, { mediaType: "photo", likes });
    await postSpy({ posts: [photo("3001", 3600, 10), photo("3002", 7200, 20), photo("3003", 9000, 30)] });
    await postSpy({ thumbs: [{ profileId: IG, id: "3001", thumb: THUMB }, { profileId: IG, id: "3002", thumb: THUMB }, { profileId: IG, id: "3003", thumb: THUMB }] });
    // A new reel pushes 3001 out of the top 3.
    await postSpy({ posts: [igPost("3004", 600, { views: 99 })] });
    const thumbs = created.database.db.prepare("SELECT post_id FROM spy_posts WHERE thumb IS NOT NULL ORDER BY post_id").all();
    expect(thumbs).toEqual([{ post_id: "3002" }, { post_id: "3003" }]);
    expect((await request(created.app).get("/api/sync/spy/profiles").set("X-Sync-Token", TOKEN)).body.profiles
      .find((p: any) => p.id === IG).wantThumbs).toEqual(["3004"]);
  });

  it("drops a reel's thumbnail when the week moves past it", async () => {
    await postSpy({ reels: [{ profileId: FB, id: "900101", createdAt: nowSec() - 3600, views: 5 }] });
    await postSpy({ thumbs: [{ profileId: FB, id: "900101", thumb: THUMB }] });
    // The views lists reach a day past the week (the windows end at the last reading).
    created.database.db.prepare("UPDATE spy_reels SET created_at = ? WHERE reel_id = '900101'").run(nowSec() - 9 * DAY);
    await postSpy({ reels: [{ profileId: FB, id: "900102", createdAt: nowSec() - 60, views: 1 }] });
    expect(created.database.db.prepare("SELECT COUNT(*) AS n FROM spy_reels WHERE thumb IS NOT NULL").get()).toEqual({ n: 0 });
  });
});

// Local: no backup (hub-only).
describe.skip("backup of the top 3 data", () => {
  it("keeps numbers, links and thumbnails", async () => {
    const { exportBackup, importBackup } = await import("../server/backup.js");
    await postSpy({ posts: [igPost("3001", 3600, { views: 10, likes: 2, comments: 1 })] });
    await postSpy({ reels: [{ profileId: FB, id: "900101", createdAt: nowSec() - 3600, views: 5 }] });
    await postSpy({ thumbs: [{ profileId: IG, id: "3001", thumb: THUMB }, { profileId: FB, id: "900101", thumb: THUMB }] });
    importBackup(created.database, exportBackup(created.database), "replace");
    expect((await card(IG)).top.items[0]).toMatchObject({ views: 10, likes: 2, comments: 1, url: "https://www.instagram.com/reel/C3001/" });
    expect((await card(IG)).top.items[0].thumbUrl).not.toBeNull();
    expect((await card(FB)).top.items[0].thumbUrl).not.toBeNull();
  });
});
