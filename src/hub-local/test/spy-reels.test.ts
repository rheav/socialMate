import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { SPY_REMOVED_KEEP_MS, ingestProfiles, mergeProfiles, purgeRemoved, removeProfile, saveProfile } from "../server/spy.js";

// Facebook "posts" are reels. The hub keeps each reel once and counts them; the
// extension sends the reels it reads plus the state of the first full reading.
let dir: string;
let created: CreatedApp;
const TOKEN = "t";
const FB = "facebook:61589642519378";

const postSpy = (body: unknown) => request(created.app).post("/api/sync/spy").set("X-Sync-Token", TOKEN).send(body as object);
const reel = (id: string, createdAt = 1_790_000_000) => ({ profileId: FB, id, createdAt, duration: 30.5, views: 9100 });
const card = async () => (await request(created.app).get("/api/spy/profiles")).body.profiles.find((p: any) => p.id === FB);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-reels-"));
  created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: TOKEN });
  saveProfile(created.database, "facebook", "61589642519378", 1000);
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Facebook reels", () => {
  it("stores each reel once and counts them on the card", async () => {
    const first = await postSpy({ reels: [reel("900101"), reel("900102"), reel("900101")] });
    expect(first.body.results.reels).toMatchObject({ added: 2, known: 1, unknown: 0, invalid: 0 });
    const again = await postSpy({ reels: [reel("900102"), reel("900103")] });
    expect(again.body.results.reels).toMatchObject({ added: 1, known: 1 });
    expect((await card()).reels).toEqual({ count: 3, status: "pending", doneAt: null });
  });

  it("rejects reels for unknown profiles and malformed rows", async () => {
    const res = await postSpy({ reels: [{ ...reel("900104"), profileId: "facebook:nope" }, { profileId: FB, id: "abc" }, null] });
    expect(res.body.results.reels).toMatchObject({ added: 0, unknown: 1, invalid: 2 });
  });

  it("keeps the newest view count and fills the day's snapshot posts with the total", async () => {
    await postSpy({ snapshots: [{ profileId: FB, day: "2026-10-03", measuredAt: 5000, followers: 10, source: "daily" }] });
    await postSpy({ reels: [{ ...reel("900101"), views: 10 }, reel("900102")] });
    await postSpy({ reels: [{ ...reel("900101"), views: 99 }] });
    const history = await request(created.app).get(`/api/spy/profiles/${FB}/history`);
    expect(history.body.snapshots.at(-1).posts).toBe(2);
    const row = created.database.db.prepare("SELECT views FROM spy_reels WHERE reel_id = '900101'").get() as { views: number };
    expect(row.views).toBe(99);
  });

  it("tracks the first full reading and never goes back from done", async () => {
    await postSpy({ reelsStatus: [{ profileId: FB, status: "running", at: 10 }] });
    expect((await card()).reels.status).toBe("running");
    await postSpy({ reelsStatus: [{ profileId: FB, status: "done", at: 20 }] });
    await postSpy({ reelsStatus: [{ profileId: FB, status: "running", at: 30 }] });
    expect((await card()).reels).toMatchObject({ status: "done", doneAt: 20 });
  });

  it("tells the extension the reading state and the newest known reels", async () => {
    await postSpy({ reels: Array.from({ length: 35 }, (_, i) => reel(String(900000 + i), 1_790_000_000 + i)) });
    const res = await request(created.app).get("/api/sync/spy/profiles").set("X-Sync-Token", TOKEN);
    const p = res.body.profiles.find((x: any) => x.id === FB);
    expect(p.reels.status).toBe("pending");
    expect(p.reels.count).toBe(35);
    expect(p.reels.recent).toHaveLength(30);
    expect(p.reels.recent[0]).toBe("900034");
  });

  it("keeps reels through an undo, forgets them once the 7 days have passed", async () => {
    await postSpy({ reels: [reel("900101")], reelsStatus: [{ profileId: FB, status: "done", at: 5 }] });
    removeProfile(created.database, FB, 2000);
    saveProfile(created.database, "facebook", "61589642519378", 3000);
    expect((await card()).reels).toMatchObject({ count: 1, status: "done" });

    removeProfile(created.database, FB, 4000);
    purgeRemoved(created.database, 4000 + SPY_REMOVED_KEEP_MS + 1);
    saveProfile(created.database, "facebook", "61589642519378", 4000 + SPY_REMOVED_KEEP_MS + 2);
    expect((await card()).reels).toEqual({ count: 0, status: "pending", doneAt: null });
  });

  it("moves reels when merging the same account", async () => {
    saveProfile(created.database, "facebook", "zuck", 1100);
    ingestProfiles(created.database, [{ id: FB, userId: "4", at: 1 }, { id: "facebook:zuck", userId: "4", at: 1 }]);
    await postSpy({ reels: [reel("900101"), { ...reel("900102"), profileId: "facebook:zuck" }] });
    await postSpy({ reelsStatus: [{ profileId: "facebook:zuck", status: "done", at: 9 }] });
    const kept = mergeProfiles(created.database, FB, "facebook:zuck");
    expect(kept.reels).toMatchObject({ count: 2, status: "done" });
  });

  // Local: no backup (hub-only).
  it.skip("round-trips reels through the backup", async () => {
    await postSpy({ reels: [reel("900101"), reel("900102")], reelsStatus: [{ profileId: FB, status: "done", at: 7 }] });
    const backup = exportBackup(created.database);
    const other = createApp({ dbPath: path.join(dir, "other.db"), appPassword: "", syncToken: TOKEN });
    importBackup(other.database, JSON.parse(JSON.stringify(backup)), "replace");
    const res = await request(other.app).get("/api/spy/profiles");
    expect(res.body.profiles[0].reels).toMatchObject({ count: 2, status: "done", doneAt: 7 });
    other.database.close();
  });

  it("leaves Instagram cards without a reels block", async () => {
    saveProfile(created.database, "instagram", "nasa", 1200);
    const res = await request(created.app).get("/api/spy/profiles");
    expect(res.body.profiles.find((p: any) => p.id === "instagram:nasa").reels).toBeNull();
  });
});
