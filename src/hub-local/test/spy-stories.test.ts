import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { SPY_REMOVED_KEEP_MS, mergeProfiles, purgeRemoved, removeProfile, saveProfile } from "../server/spy.js";
import { dayStart } from "../server/spyTopPosts.js";

// Stories swipe file: the extension captures an account's stories from the
// stories page, the hub keeps the metadata, the full media and a small poster
// for a configurable number of days.
// Design: docs/superpowers/specs/2026-10-19-stories-swipe-file-design.md
let dir: string;
let created: CreatedApp;
const TOKEN = "t";
const IG = "instagram:natgeo";

const cols = (table: string) =>
  new Set((created.database.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
const card = async () => (await request(created.app).get("/api/spy/profiles")).body.profiles.find((p: any) => p.id === IG);
const postSpy = (body: unknown) => request(created.app).post("/api/sync/spy").set("X-Sync-Token", TOKEN).send(body as object);
// An hour ago: a story past its retention is pruned on arrival, so a fixed date stops passing a week later.
const TAKEN = Date.now() - 3_600_000;
const story = (id: string, over: Partial<any> = {}) => ({ profileId: IG, id, reelId: "27143148638", mediaType: 2, takenAt: TAKEN,
  expiringAt: TAKEN + 86_400_000, durationMs: 20015, width: 720, height: 1280, caption: null,
  links: [{ url: "https://app.auralyapp.com/x", text: "auralyapp.com" }], music: { title: "Heartfelt", artist: "Xuan" }, mentions: [],
  aiLabel: true, mediaMime: "video/mp4", ...over });
const put = (id: string, kind: "media" | "poster", body: Buffer, type: string) =>
  request(created.app).put(`/api/sync/spy/stories/${id}/${kind}`).set("X-Sync-Token", TOKEN).set("Content-Type", type).send(body);
const mp4 = Buffer.from("00000018667479706d703432", "hex"); // any bytes; the hub does not sniff
const webp = Buffer.from("52494646", "hex");
const storiesDirOf = (key = "natgeo") => path.join(dir, "stories", "instagram", key);
async function ready(id: string, over: Partial<any> = {}) {
  await postSpy({ stories: [story(id, over)] });
  await put(id, "media", mp4, "video/mp4"); await put(id, "poster", webp, "image/webp");
}
const DAY = 86_400_000;
// Local: the media live in the storage adapter under "<id>/<media|poster>", not in files.
const files = async () => (await created.storage.mediaKeys()).sort();
const prune = async () => { const r = await created.app.prune(); return { ...r.stories, orphans: r.orphans }; };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-stories-"));
  created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: TOKEN });
  saveProfile(created.database, "instagram", "natgeo", 1000);
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("stories schema", () => {
  it("creates the stories tables and the tracking flag", () => {
    // Local: one DDL at the final state, no migration counter.
    expect(cols("spy_profiles").has("track_stories")).toBe(true);
    expect(cols("spy_stories")).toEqual(new Set(["id", "profile_id", "reel_id", "media_type", "taken_at", "expiring_at", "duration_ms",
      "width", "height", "caption", "links", "music", "mentions", "ai_label", "media_path", "media_bytes", "media_mime", "poster_path",
      "captured_at", "ready_at", "starred_at"]));
    expect(cols("spy_settings")).toEqual(new Set(["key", "value", "updated_at"]));
    const idx = (created.database.db.prepare("PRAGMA index_list(spy_stories)").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(["spy_stories_profile_taken", "spy_stories_taken"]));
  });
});

describe("stories settings", () => {
  it("answers the defaults and the usage", async () => {
    const res = await request(created.app).get("/api/spy/settings");
    expect(res.body).toEqual({ stories: { passesPerDay: 2, keepDays: 7, dailyReport: true }, usage: { bytes: 0, count: 0, starredBytes: 0, starredCount: 0 } });
  });
  it("saves a valid patch and keeps the other value", async () => {
    await request(created.app).patch("/api/spy/settings").send({ stories: { keepDays: 14 } }).expect(200);
    const res = await request(created.app).get("/api/spy/settings");
    expect(res.body.stories).toEqual({ passesPerDay: 2, keepDays: 14, dailyReport: true });
  });
  it("refuses values out of range or not integers", async () => {
    for (const stories of [{ passesPerDay: 0 }, { passesPerDay: 5 }, { keepDays: 31 }, { keepDays: 2.5 }, { keepDays: "7" }]) {
      const res = await request(created.app).patch("/api/spy/settings").send({ stories });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_settings" });
    }
  });
});

describe("tracking flag", () => {
  it("is off by default, saved by the panel and sent to the extension", async () => {
    expect((await card()).trackStories).toBe(false);
    const res = await request(created.app).patch(`/api/spy/profiles/${IG}`).send({ trackStories: true });
    expect(res.body.trackStories).toBe(true);
    const list = await request(created.app).get("/api/sync/spy/profiles").set("X-Sync-Token", TOKEN);
    const row = list.body.profiles.find((p: any) => p.id === IG);
    expect(row.trackStories).toBe(true);
    expect(row.storyPks).toEqual([]);
    expect(list.body.settings).toEqual({ stories: { passesPerDay: 2, keepDays: 7, dailyReport: true } });
  });
  it("refuses tracking on a Facebook profile", async () => {
    saveProfile(created.database, "facebook", "zuck", 1000);
    const res = await request(created.app).patch("/api/spy/profiles/facebook:zuck").send({ trackStories: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "stories_instagram_only" });
  });
});

describe("stories ingestion", () => {
  it("stores each story once, pending until its media arrives", async () => {
    const first = await postSpy({ stories: [story("4010802020595923127"), story("4010802020595923127"), story("4010802020595923128", { mediaType: 1, mediaMime: "image/jpeg" })] });
    expect(first.body.results.stories).toEqual({ added: 2, known: 1, unknown: 0, invalid: 0 });
    const row = created.database.db.prepare("SELECT ready_at, links, music, ai_label FROM spy_stories WHERE id = '4010802020595923127'").get() as any;
    expect(row).toMatchObject({ ready_at: null, ai_label: 1 });
    expect(JSON.parse(row.links)).toEqual([{ url: "https://app.auralyapp.com/x", text: "auralyapp.com" }]);
    expect(JSON.parse(row.music)).toEqual({ title: "Heartfelt", artist: "Xuan" });
  });
  it("rejects stories for unknown or removed profiles", async () => {
    removeProfile(created.database, IG, 2000);
    const res = await postSpy({ stories: [story("4010802020595923129"), { ...story("1"), profileId: "instagram:nope" }] });
    expect(res.body.results.stories).toEqual({ added: 0, known: 0, unknown: 2, invalid: 0 });
  });
  it("counts malformed rows as invalid", async () => {
    const res = await postSpy({ stories: [story("abc"), story("3", { mediaType: 3 }), story("4", { expiringAt: 1 }), null] });
    expect(res.body.results.stories).toEqual({ added: 0, known: 0, unknown: 0, invalid: 4 });
  });
  it("counts timestamps in seconds as invalid instead of storing a 1970 story", async () => {
    const res = await postSpy({ stories: [story("60", { takenAt: 1_792_345_000, expiringAt: 1_792_431_400 })] });
    expect(res.body.results.stories).toEqual({ added: 0, known: 0, unknown: 0, invalid: 1 });
  });
});

describe("stories media", () => {
  beforeEach(async () => { await postSpy({ stories: [story("4010802020595923127")] }); });
  it("stores media and poster and marks the story ready only with both", async () => {
    const m = await put("4010802020595923127", "media", mp4, "video/mp4").expect(200);
    expect(m.body).toEqual({ id: "4010802020595923127", bytes: mp4.length, ready: false });
    const p = await put("4010802020595923127", "poster", webp, "image/webp").expect(200);
    expect(p.body.ready).toBe(true);
    expect(await files()).toEqual(["4010802020595923127/media", "4010802020595923127/poster"]);
    const row = created.database.db.prepare("SELECT ready_at, media_bytes FROM spy_stories WHERE id = '4010802020595923127'").get() as any;
    expect(row.ready_at).toBeGreaterThan(0);
    expect(row.media_bytes).toBe(mp4.length);
  });
  it("accepts a retried upload without duplicating", async () => {
    await put("4010802020595923127", "media", mp4, "video/mp4").expect(200);
    const again = await put("4010802020595923127", "media", mp4, "video/mp4").expect(200);
    expect(again.body.bytes).toBe(mp4.length);
    expect(await files()).toEqual(["4010802020595923127/media"]);
  });
  it("answers 404 for a story whose metadata has not arrived", async () => {
    const res = await put("4010802020595923999", "media", mp4, "video/mp4");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "unknown_story" });
  });
  it("refuses other content types", async () => {
    const res = await put("4010802020595923127", "media", Buffer.from("<html>"), "text/html");
    expect(res.status).toBe(415);
    expect(await files()).toEqual([]);
  });
  it("refuses ids and keys that are not safe path parts", async () => {
    expect((await put("..%2Fx", "media", mp4, "video/mp4")).status).toBe(400);
    expect((await put("12a", "media", mp4, "video/mp4")).status).toBe(400);
  });
  it("refuses a poster above 200 KB", async () => {
    const res = await put("4010802020595923127", "poster", Buffer.alloc(200 * 1024 + 1), "image/webp");
    expect(res.status).toBe(413);
  });
});

describe("stories listing", () => {
  it("lists only ready stories, newest first, with the tray", async () => {
    const now = Date.now();
    await ready("1", { takenAt: now - 3_600_000, expiringAt: now + 20 * 3_600_000 });
    await ready("2", { takenAt: now - 7_200_000, expiringAt: now + 16 * 3_600_000 });
    await postSpy({ stories: [story("3", { takenAt: now - 60_000, expiringAt: now + DAY })] }); // no media
    const res = await request(created.app).get("/api/spy/stories?period=live").expect(200);
    expect(res.body.stories.map((s: any) => s.id)).toEqual(["1", "2"]);
    expect(res.body.tray).toEqual([{ profileId: IG, count: 2, liveCount: 2, newestAt: now - 3_600_000 }]);
    expect(res.body.stories[0]).toMatchObject({ profileId: IG, mediaType: 2, durationMs: 20015, aiLabel: true, music: { title: "Heartfelt", artist: "Xuan" } });
    expect(res.body.stories[0]).not.toHaveProperty("mediaUrl");
  });
  it("closes periods on GMT-3 day edges", async () => {
    const today = dayStart(Date.now()) * 1000;
    await ready("10", { takenAt: today - 1, expiringAt: today - 1 + DAY });          // 23:59:59.999 yesterday
    await ready("11", { takenAt: today, expiringAt: today + DAY });                  // 00:00 today
    await ready("12", { takenAt: today - 8 * DAY, expiringAt: today - 7 * DAY });    // outside 7d
    const y = await request(created.app).get("/api/spy/stories?period=yesterday");
    expect(y.body.stories.map((s: any) => s.id)).toEqual(["10"]);
    const week = await request(created.app).get("/api/spy/stories?period=7d");
    expect(week.body.stories.map((s: any) => s.id)).toEqual(["11", "10"]);
  });
  it("drops a story from live the moment it expires", async () => {
    const now = Date.now();
    await ready("20", { takenAt: now - DAY, expiringAt: now }); // not live
    const res = await request(created.app).get("/api/spy/stories?period=live");
    expect(res.body.stories).toEqual([]);
  });
  it("filters by profile and refuses a bad period", async () => {
    saveProfile(created.database, "instagram", "nasa", 1000);
    await ready("30", { profileId: "instagram:nasa" });
    const res = await request(created.app).get(`/api/spy/stories?period=7d&profile=${IG}`);
    expect(res.body.stories).toEqual([]);
    expect(res.body.tray.map((t: any) => t.profileId)).toEqual(["instagram:nasa"]);
    expect((await request(created.app).get("/api/spy/stories?period=today")).status).toBe(400);
  });
  // Local: the route answers the Blob in process (no HTTP ranges or cache headers).
  it("serves the files with ranges and a long cache, and 404 before ready", async () => {
    await ready("40");
    const full = await request(created.app).get("/api/spy/stories/40/media").expect(200);
    expect(full.headers["content-type"]).toBe("video/mp4");
    expect(full.blob!.size).toBe(mp4.length);
    expect((await request(created.app).get("/api/spy/stories/40/poster")).headers["content-type"]).toBe("image/webp");
    await postSpy({ stories: [story("41")] });
    expect((await request(created.app).get("/api/spy/stories/41/poster")).status).toBe(404);
  });
});

describe("starred stories", () => {
  it("stars and unstars a ready story through the panel", async () => {
    await ready("70");
    const on = await request(created.app).patch("/api/spy/stories/70").send({ starred: true }).expect(200);
    expect(on.body.story).toMatchObject({ id: "70", starredAt: expect.any(Number) });
    const list = await request(created.app).get("/api/spy/stories?period=7d");
    expect(list.body.stories[0].starredAt).toEqual(expect.any(Number));
    const off = await request(created.app).patch("/api/spy/stories/70").send({ starred: false }).expect(200);
    expect(off.body.story.starredAt).toBeNull();
    expect((await request(created.app).patch("/api/spy/stories/70").send({ starred: "yes" })).status).toBe(400);
    await postSpy({ stories: [story("71")] }); // no media yet
    expect((await request(created.app).patch("/api/spy/stories/71").send({ starred: true })).status).toBe(404);
  });
  it("lists the favourites whatever their date, and only them", async () => {
    const now = Date.now();
    await ready("72", { takenAt: now - DAY, expiringAt: now });
    await ready("73", { takenAt: now - DAY, expiringAt: now });
    await request(created.app).patch("/api/spy/stories/73").send({ starred: true });
    created.database.db.prepare("UPDATE spy_stories SET taken_at = ?, expiring_at = ? WHERE id = '73'").run(now - 40 * DAY, now - 39 * DAY);
    const res = await request(created.app).get("/api/spy/stories?period=starred").expect(200);
    expect(res.body.stories.map((s: any) => s.id)).toEqual(["73"]);
    expect(res.body.tray).toEqual([{ profileId: IG, count: 1, liveCount: 0, newestAt: now - 40 * DAY }]);
  });
  it("never prunes a favourite, and counts it in the usage", async () => {
    const now = Date.now();
    await ready("74");
    await ready("75");
    await request(created.app).patch("/api/spy/stories/75").send({ starred: true });
    created.database.db.prepare("UPDATE spy_stories SET taken_at = ?, expiring_at = ? WHERE id IN ('74', '75')").run(now - 8 * DAY, now - 7 * DAY);
    expect(await prune()).toEqual({ expired: 1, abandoned: 0, orphans: 0 });
    expect(created.database.db.prepare("SELECT id FROM spy_stories").all()).toEqual([{ id: "75" }]);
    expect(await files()).toEqual(["75/media", "75/poster"]);
    const settings = await request(created.app).get("/api/spy/settings");
    expect(settings.body.usage).toEqual({ bytes: mp4.length, count: 1, starredBytes: mp4.length, starredCount: 1 });
  });
});

describe("stories readings", () => {
  it("accepts a stories pass reading and lists it", async () => {
    const res = await postSpy({ readings: [{ profileId: IG, at: Date.now(), kind: "stories", source: "pass", ok: true, reelsAdded: 3 }] });
    expect(res.body.results.readings).toMatchObject({ recorded: 1, invalid: 0 });
    const list = await request(created.app).get("/api/spy/readings?days=1");
    expect(list.body.readings[0]).toMatchObject({ kind: "stories", source: "pass", reelsAdded: 3 });
  });
});

describe("stories retention", () => {
  it("removes stories older than keepDays with their files, abandoned rows and orphan files", async () => {
    const now = Date.now();
    // A batch prunes on arrival (spec §5.5), so the old ones are backdated after every batch landed.
    await ready("50", { takenAt: now - DAY, expiringAt: now });
    await ready("51", { takenAt: now - DAY, expiringAt: now });
    await postSpy({ stories: [story("52", { takenAt: now - 2 * DAY, expiringAt: now - DAY })] });
    created.database.db.prepare("UPDATE spy_stories SET taken_at = ?, expiring_at = ? WHERE id = '50'").run(now - 8 * DAY, now - 7 * DAY);
    created.database.db.prepare("UPDATE spy_stories SET captured_at = ? WHERE id = '52'").run(now - 37 * 3_600_000);
    await created.storage.putMedia("999/media", new Blob(["x"]));
    expect(await prune()).toEqual({ expired: 1, abandoned: 1, orphans: 1 });
    expect(created.database.db.prepare("SELECT id FROM spy_stories ORDER BY id").all()).toEqual([{ id: "51" }]);
    expect(await files()).toEqual(["51/media", "51/poster"]);
  });
  // Local: a Blob is written whole; there are no .part files.
  it.skip("leaves a fresh .part (an upload in flight) alone and removes a stale one", async () => {
    await ready("61");
    writeFileSync(path.join(storiesDirOf(), "62.mp4.part"), "x");
    const stale = path.join(storiesDirOf(), "63.mp4.part");
    writeFileSync(stale, "x");
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(stale, hourAgo, hourAgo);
    expect(created.stories.prune().orphans).toBe(1);
    expect(existsSync(path.join(storiesDirOf(), "62.mp4.part"))).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
  it("honours a shorter keepDays", async () => {
    const now = Date.now();
    await ready("53", { takenAt: now - 2 * DAY + 3_600_000, expiringAt: now - DAY + 3_600_000 }); // 47 h old: kept with 7 days
    expect((await prune()).expired).toBe(0);
    await request(created.app).patch("/api/spy/settings").send({ stories: { keepDays: 1 } });
    expect((await prune()).expired).toBe(1);
  });
  it("drops a purged profile's stories and moves a merged one's", async () => {
    await ready("54");
    saveProfile(created.database, "instagram", "natgeo2", 1000);
    created.database.db.prepare("UPDATE spy_profiles SET user_id = '7' WHERE id IN (?, ?)").run(IG, "instagram:natgeo2");
    mergeProfiles(created.database, "instagram:natgeo2", IG);
    expect(created.database.db.prepare("SELECT profile_id FROM spy_stories WHERE id = '54'").get()).toEqual({ profile_id: "instagram:natgeo2" });
    removeProfile(created.database, "instagram:natgeo2", Date.now());
    purgeRemoved(created.database, Date.now() + SPY_REMOVED_KEEP_MS + 1);
    expect(created.database.db.prepare("SELECT COUNT(*) AS n FROM spy_stories").get()).toEqual({ n: 0 });
    // Local: the media go once the next request is saved.
    await request(created.app).get("/api/spy/settings");
    expect(await files()).toEqual([]);
  });
});
