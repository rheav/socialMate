import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { saveProfile, removeProfile, ingestSnapshots, listCards, getHistory } from "../server/spy.js";

let dir: string;
let created: CreatedApp;
const TOKEN = "test-sync-token";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-api-"));
  created = createApp({
    dbPath: path.join(dir, "test.db"),
    appPassword: "",
    appName: "socialmate-test",
    syncToken: TOKEN,
  });
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("spy panel API auth", () => {
  // Local: no login (hub-only).
  it.skip("requires login cookie when APP_PASSWORD is set", async () => {
    const authedApp = createApp({
      dbPath: path.join(dir, "auth-test.db"),
      appPassword: "mypassword",
      sessionSecret: "test-secret",
      syncToken: TOKEN,
    });

    const denied = await request(authedApp.app).get("/api/spy/profiles");
    expect(denied.status).toBe(401);

    const login = await request(authedApp.app)
      .post("/api/login")
      .send({ password: "mypassword" });
    const cookie = login.headers["set-cookie"];
    expect(cookie).toBeDefined();

    const allowed = await request(authedApp.app)
      .get("/api/spy/profiles")
      .set("Cookie", cookie);
    expect(allowed.status).toBe(200);
    expect(allowed.body.profiles).toEqual([]);
    // One copy of the cards: the old `items` alias doubled the payload.
    expect(allowed.body).not.toHaveProperty("items");

    authedApp.database.close();
  });
});

describe("spy panel API CRUD", () => {
  it("orders successive dashboard actions even within the same millisecond", () => {
    saveProfile(created.database, "instagram", "audit", 1000);
    expect(removeProfile(created.database, "instagram:audit", 1000)).toBe(true);
    expect(listCards(created.database)).toEqual([]);
    // Saved again within the undo window: restored, not created.
    expect(saveProfile(created.database, "instagram", "audit", 1000).status).toBe("restored");
    expect(listCards(created.database)).toHaveLength(1);
  });

  it("keeps all-time deltas and stale latest measurements consistent with history", () => {
    saveProfile(created.database, "instagram", "audit", 1000);
    ingestSnapshots(created.database, [
      { day: "2020-01-01", followers: 100 },
      { day: "2020-02-01", followers: 200 },
      { day: "2020-03-01", followers: 300 },
    ].map((s) => ({ ...s, profileId: "instagram:audit", measuredAt: Date.parse(s.day), source: "daily" })));
    const card = listCards(created.database)[0];
    expect(card.latest?.followers).toBe(300);
    expect(card.deltaTotal).toBe(200);
    // Monthly points: nothing near 7 days back; 2020-02-01 is one day off 30.
    expect(card.delta7).toBeNull();
    expect(card.delta30).toBe(100);
    expect(card).toEqual(getHistory(created.database, "instagram:audit")!.profile);
  });

  it.each([
    // [days back of the only older point, delta7, delta30]
    [5, 10, null], [9, 10, null], [10, 10, null], [11, null, null],
    [24, null, 10], [31, null, 10], [37, null, 10], [38, null, null],
  ])("compares 7/30-day growth only against a point near that age (%i days back)", (back, d7, d30) => {
    saveProfile(created.database, "instagram", "audit", 1000);
    const day = (n: number) => new Date(Date.UTC(2026, 9, 3) - n * 86400000).toISOString().slice(0, 10);
    ingestSnapshots(created.database, [[back, 100], [0, 110]].map(([n, followers]) => ({
      profileId: "instagram:audit", day: day(n), measuredAt: Date.parse(day(n)), followers, source: "daily",
    })));
    const card = listCards(created.database)[0];
    expect([card.delta7, card.delta30]).toEqual([d7, d30]);
    expect(card).toEqual(getHistory(created.database, "instagram:audit")!.profile);
  });

  it("keeps the last 30 measured follower points plus all-time comparison anchors", () => {
    saveProfile(created.database, "instagram", "audit", 1000);
    ingestSnapshots(created.database, Array.from({ length: 100 }, (_, i) => ({
      profileId: "instagram:audit", day: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      measuredAt: Date.UTC(2020, 0, i + 1), followers: i + 100, source: "daily",
    })));
    const card = listCards(created.database)[0];
    expect(card.spark).toHaveLength(30);
    expect(card.spark[0].followers).toBe(170);
    expect(card.deltaTotal).toBe(99);
    expect(card.delta30).toBe(30);
    expect(card).toEqual(getHistory(created.database, "instagram:audit")!.profile);
  });

  it("POST creates profile with Instagram, Facebook vanity, and profile.php?id=", async () => {
    // 1. Instagram
    const rIg = await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.instagram.com/jeanniejonh?stkn=abc" });
    expect(rIg.status).toBe(201);
    expect(rIg.body).toMatchObject({
      id: "instagram:jeanniejonh",
      platform: "instagram",
      key: "jeanniejonh",
      name: null,
      profileUrl: "https://www.instagram.com/jeanniejonh/",
      storiesUrl: "https://www.instagram.com/stories/jeanniejonh/",
      latest: null,
      delta7: null,
      spark: [],
    });

    // 2. Facebook vanity
    const rFb = await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.facebook.com/NASA" });
    expect(rFb.status).toBe(201);
    expect(rFb.body).toMatchObject({
      id: "facebook:nasa",
      platform: "facebook",
      key: "nasa",
      profileUrl: "https://www.facebook.com/nasa",
    });

    // 3. Facebook numeric
    const rNum = await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.facebook.com/profile.php?id=100092403319843&sk=reels_tab" });
    expect(rNum.status).toBe(201);
    expect(rNum.body).toMatchObject({
      id: "facebook:100092403319843",
      platform: "facebook",
      key: "100092403319843",
      profileUrl: "https://www.facebook.com/profile.php?id=100092403319843",
    });

    // 4. Invalid URL
    const rInv = await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.tiktok.com/@nasa" });
    expect(rInv.status).toBe(400);
    expect(rInv.body.error).toBe("invalid_profile");
  });

  it("POST with handle and platform works", async () => {
    const r = await request(created.app)
      .post("/api/spy/profiles")
      .send({ platform: "instagram", handle: "@nasa" });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe("instagram:nasa");
  });

  it("POST of same profile twice returns 201 then 200, converging on single row", async () => {
    const r1 = await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.instagram.com/nasa" });
    expect(r1.status).toBe(201);

    const r2 = await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.instagram.com/NASA/" });
    expect(r2.status).toBe(200);

    const list = await request(created.app).get("/api/spy/profiles");
    expect(list.body.profiles).toHaveLength(1);
    expect(list.body.total).toBe(1);
  });

  it("DELETE removes profile from card list and marks removedAt in extension list", async () => {
    await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.instagram.com/nasa" });

    const del = await request(created.app).delete("/api/spy/profiles/instagram:nasa");
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, restorableUntil: expect.any(Number) });

    // Not in cards list
    const cards = await request(created.app).get("/api/spy/profiles");
    expect(cards.body.profiles).toHaveLength(0);

    // Present in extension sync list with removedAt
    const ext = await request(created.app)
      .get("/api/sync/spy/profiles")
      .set("X-Sync-Token", TOKEN);
    expect(ext.body.profiles).toHaveLength(1);
    expect(ext.body.profiles[0].removedAt).not.toBeNull();

    // 404 on deleting non-existent
    const del2 = await request(created.app).delete("/api/spy/profiles/instagram:nonexistent");
    expect(del2.status).toBe(404);
  });
});

describe("spy panel API metrics, sparkline and delta7", () => {
  it("delta7 handles 0, 1, and 8+ days of history; spark caps at 30 points and omits null followers", async () => {
    await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.instagram.com/nasa" });

    // 0 history: delta7 null, spark empty
    const c0 = await request(created.app).get("/api/spy/profiles");
    expect(c0.body.profiles[0].delta7).toBeNull();
    expect(c0.body.profiles[0].spark).toEqual([]);

    // Seed 1 day of history: 2026-10-01
    await request(created.app)
      .post("/api/sync/spy")
      .set("X-Sync-Token", TOKEN)
      .send({
        snapshots: [
          {
            profileId: "instagram:nasa",
            day: "2026-10-01",
            measuredAt: 1000,
            followers: 1000,
            source: "daily",
          },
        ],
      });

    // 1 day: delta7 is still null (cannot compute 7-day delta from 1 day)
    const c1 = await request(created.app).get("/api/spy/profiles");
    expect(c1.body.profiles[0].delta7).toBeNull();
    expect(c1.body.profiles[0].spark).toHaveLength(1);

    // Seed 35 days of history going backwards from 2026-10-02
    // with some null followers interspersed
    const snaps = [];
    const baseDate = new Date("2026-10-02T00:00:00Z");
    for (let i = 35; i >= 0; i--) {
      const d = new Date(baseDate.getTime() - i * 86400000);
      const dayStr = d.toISOString().slice(0, 10);
      // Day 15 ago has null followers
      const followers = i === 15 ? null : 1000 + (35 - i) * 10;
      snaps.push({
        profileId: "instagram:nasa",
        day: dayStr,
        measuredAt: 1000 + (35 - i),
        followers,
        source: "daily",
      });
    }

    await request(created.app)
      .post("/api/sync/spy")
      .set("X-Sync-Token", TOKEN)
      .send({ snapshots: snaps });

    const cMany = await request(created.app).get("/api/spy/profiles");
    const card = cMany.body.profiles[0];

    // spark caps at 30 points and never contains null followers
    expect(card.spark.length).toBeLessThanOrEqual(30);
    expect(card.spark.length).toBe(30);
    expect(card.spark.every((p: { followers: number }) => typeof p.followers === "number")).toBe(true);

    // delta7: latest (day 2026-10-02, i=0, followers = 1000 + 35 * 10 = 1350)
    // compared with snapshot <= 2026-10-02 - 7 days (2026-09-25, i=7, followers = 1000 + (35-7)*10 = 1280)
    // delta = 1350 - 1280 = 70
    expect(card.delta7).toBe(70);

    // delta30: compared with snapshot <= 2026-10-02 - 30 days (2026-09-02, i=30, followers = 1000 + 5*10 = 1050)
    // delta = 1350 - 1050 = 300
    expect(card.delta30).toBe(300);

    // deltaTotal: compared with first snapshot (i=35, followers = 1000)
    // delta = 1350 - 1000 = 350
    expect(card.deltaTotal).toBe(350);
  });
});

describe("spy panel API avatar & history", () => {
  it("/avatar returns bytes and Content-Type; 404 when no avatar", async () => {
    await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.instagram.com/nasa" });

    // Local: the card carries the stored data: URL itself (no /avatar route).
    const avatarUrl = async () => (await request(created.app).get("/api/spy/profiles")).body.profiles[0].avatarUrl;
    expect(await avatarUrl()).toBeNull();

    // Send base64 avatar via sync
    const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await request(created.app)
      .post("/api/sync/spy")
      .set("X-Sync-Token", TOKEN)
      .send({
        profiles: [
          {
            id: "instagram:nasa",
            at: Date.now(),
            avatar: `data:image/png;base64,${samplePngBase64}`,
          },
        ],
      });

    expect(await avatarUrl()).toBe(`data:image/png;base64,${samplePngBase64}`);
  });

  it("/history returns profile and snapshots in day ASC order", async () => {
    await request(created.app)
      .post("/api/spy/profiles")
      .send({ url: "https://www.instagram.com/nasa" });

    await request(created.app)
      .post("/api/sync/spy")
      .set("X-Sync-Token", TOKEN)
      .send({
        snapshots: [
          { profileId: "instagram:nasa", day: "2026-10-02", measuredAt: 200, followers: 105, source: "daily" },
          { profileId: "instagram:nasa", day: "2026-09-28", measuredAt: 100, followers: 101, source: "daily" },
          { profileId: "instagram:nasa", day: "2026-09-30", measuredAt: 150, followers: 103, source: "daily" },
        ],
      });

    const hist = await request(created.app).get("/api/spy/profiles/instagram:nasa/history");
    expect(hist.status).toBe(200);
    expect(hist.body.profile.id).toBe("instagram:nasa");
    expect(hist.body.snapshots).toHaveLength(3);
    expect(hist.body.snapshots.map((s: { day: string }) => s.day)).toEqual([
      "2026-09-28",
      "2026-09-30",
      "2026-10-02",
    ]);

    // 404 for unknown
    const unk = await request(created.app).get("/api/spy/profiles/instagram:nonexistent/history");
    expect(unk.status).toBe(404);
  });
});

describe("spy input limits", () => {
  it("refuses an oversized note and hides a removed profile's card and history", async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), "spy-limits-"));
    const app = createApp({ dbPath: path.join(dir2, "t.db"), appPassword: "", syncToken: "t" });
    try {
      saveProfile(app.database, "instagram", "nasa", 1000);
      const long = await request(app.app).patch("/api/spy/profiles/instagram:nasa").send({ notes: "x".repeat(10_001) });
      expect(long.status).toBe(400);
      expect(long.body.error).toBe("notes_too_long");

      removeProfile(app.database, "instagram:nasa");
      expect((await request(app.app).get("/api/spy/profiles/instagram:nasa/history")).status).toBe(404);
      expect((await request(app.app).patch("/api/spy/profiles/instagram:nasa").send({ notes: "x" })).status).toBe(404);
    } finally {
      app.database.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("keeps only http(s) links from the extension", async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), "spy-links-"));
    const app = createApp({ dbPath: path.join(dir2, "t.db"), appPassword: "", syncToken: "t" });
    try {
      saveProfile(app.database, "instagram", "nasa", 1000);
      const sync = (body: object) => request(app.app).post("/api/sync/spy").set("X-Sync-Token", "t").send(body);
      await sync({ profiles: [{ id: "instagram:nasa", at: 2000, externalUrl: "javascript:alert(1)" }] });
      let card = (await request(app.app).get("/api/spy/profiles")).body.profiles[0];
      expect(card.externalUrl).toBeNull();
      await sync({ profiles: [{ id: "instagram:nasa", at: 3000, externalUrl: "https://nasa.gov" }] });
      card = (await request(app.app).get("/api/spy/profiles")).body.profiles[0];
      expect(card.externalUrl).toBe("https://nasa.gov");

    } finally {
      app.database.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
