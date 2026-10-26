import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { saveProfile } from "../server/spy.js";

// Every collection attempt the extension makes, so the panel can show what ran.
let dir: string;
let created: CreatedApp;
const TOKEN = "t";
const DAY = 86_400_000;
const now = Date.now();
const postSpy = (body: unknown) => request(created.app).post("/api/sync/spy").set("X-Sync-Token", TOKEN).send(body as object);
const reading = (over: Record<string, unknown> = {}) => ({
  profileId: "facebook:zuck", at: now - 1000, kind: "followers", source: "daily", ok: true, followers: 1500, ...over,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-readings-"));
  created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: TOKEN });
  saveProfile(created.database, "facebook", "zuck", 1000);
  saveProfile(created.database, "instagram", "nasa", 1000);
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("collection readings", () => {
  it("records successes and failures once and lists the last days newest first", async () => {
    const res = await postSpy({ readings: [
      reading(),
      reading(),
      reading({ at: now - 500, kind: "reels", source: "initial", followers: undefined, reelsAdded: 10, pages: 1 }),
      reading({ profileId: "instagram:nasa", at: now - 200, ok: false, error: "login_required", followers: undefined }),
    ] });
    expect(res.body.results.readings).toMatchObject({ recorded: 3, invalid: 0, unknown: 0 });
    const list = await request(created.app).get("/api/spy/readings?days=3");
    expect(list.body.readings.map((r: any) => [r.profileId, r.kind, r.ok])).toEqual([
      ["instagram:nasa", "followers", false],
      ["facebook:zuck", "reels", true],
      ["facebook:zuck", "followers", true],
    ]);
    expect(list.body.readings[0]).toMatchObject({ platform: "instagram", key: "nasa", error: "login_required", source: "daily" });
    expect(list.body.readings[1]).toMatchObject({ reelsAdded: 10, pages: 1, source: "initial" });
  });

  it("only shows the requested window and drops readings older than a week", async () => {
    await postSpy({ readings: [reading({ at: now - 2 * DAY }), reading({ at: now - 5 * DAY }), reading({ at: now - 8 * DAY })] });
    expect((await request(created.app).get("/api/spy/readings?days=3")).body.readings).toHaveLength(1);
    expect((await request(created.app).get("/api/spy/readings?days=30")).body.readings).toHaveLength(2);
  });

  it("records the reels reading that keeps the week's views current", async () => {
    const res = await postSpy({ readings: [reading({ kind: "reels", source: "refresh", followers: undefined, reelsAdded: 0, pages: 2 })] });
    expect(res.body.results.readings).toMatchObject({ recorded: 1, invalid: 0 });
    // The extension learns when the views were last read, whichever browser read them.
    const list = await request(created.app).get("/api/sync/spy/profiles").set("X-Sync-Token", TOKEN);
    expect(list.body.profiles.find((p: any) => p.id === "facebook:zuck").viewsReadAt).toBe(now - 1000);
    expect(list.body.profiles.find((p: any) => p.id === "instagram:nasa").viewsReadAt).toBeNull();
  });

  it("refuses unknown profiles and malformed readings", async () => {
    const res = await postSpy({ readings: [
      reading({ profileId: "facebook:nope" }), reading({ kind: "likes" }), reading({ source: "x" }), reading({ at: "soon" }), null,
    ] });
    expect(res.body.results.readings).toMatchObject({ recorded: 0, unknown: 1, invalid: 4 });
  });

  // Local: no login (hub-only).
  it.skip("requires the dashboard session", async () => {
    const authed = createApp({ dbPath: path.join(dir, "auth.db"), appPassword: "pw", sessionSecret: "s", syncToken: TOKEN });
    expect((await request(authed.app).get("/api/spy/readings")).status).toBe(401);
    authed.database.close();
  });
});

describe("collection health", () => {
  const evidence = (key: string, state: string, at: number) => created.database.db
    .prepare("INSERT INTO analysis_evidence (post_key, content_hash, schema_version, bundle_json, captured_at) VALUES (?, ?, 1, ?, ?)")
    .run(key, `h-${key}`, JSON.stringify({ video: { state } }), at);

  it("calls a kind that only failed in the last 24 h broken, and keeps its last success", async () => {
    const reels = (at: number, ok: boolean) => reading({ profileId: "instagram:nasa", at, kind: "reels", ok, followers: undefined, ...(ok ? {} : { error: "no_reels" }) });
    await postSpy({ readings: [
      reels(now - 3 * DAY, true), reels(now - 3000, false), reels(now - 2000, false), reels(now - 1000, false),
      reading({ at: now - 2 * DAY }),
      reading({ at: now - 4000 }), reading({ at: now - 3000, ok: false, error: "network", followers: undefined }),
    ] });
    // Local: no analysis videos, so no analysis_evidence and no "analysis:video" check.
    void evidence;
    const { body } = await request(created.app).get("/api/spy/health");
    expect(body.checks).toEqual([
      { key: "facebook:followers", platform: "facebook", kind: "followers", status: "ok", attempts: 2, ok: 1, lastOkAt: now - 4000, lastError: "network" },
      { key: "instagram:reels", platform: "instagram", kind: "reels", status: "broken", attempts: 3, ok: 0, lastOkAt: now - 3 * DAY, lastError: "no_reels" },
      { key: "instagram:views", platform: "instagram", kind: "views", status: "warn", attempts: 1, ok: 0, lastOkAt: now - 3 * DAY, lastError: "sem views há mais de 26 h: @nasa" },
    ]);
  });

  it("names the Instagram profiles whose views were not read in 26 h, past their first hour", async () => {
    saveProfile(created.database, "instagram", "esa", now - 10 * 60_000); // saved 10 min ago: not yet
    saveProfile(created.database, "instagram", "agnes", 1000);
    const db = created.database.db;
    db.prepare("UPDATE spy_profiles SET views_read_at = ? WHERE id = ?").run(now - 2 * 3_600_000, "instagram:nasa");
    let checks = (await request(created.app).get("/api/spy/health")).body.checks;
    expect(checks.find((c: any) => c.key === "instagram:views")).toMatchObject({ status: "warn", attempts: 2, ok: 1, lastOkAt: now - 2 * 3_600_000,
      lastError: "sem views há mais de 26 h: @agnes" });
    db.prepare("UPDATE spy_profiles SET views_read_at = ? WHERE id = ?").run(now - 3_600_000, "instagram:agnes");
    checks = (await request(created.app).get("/api/spy/health")).body.checks;
    expect(checks.find((c: any) => c.key === "instagram:views")).toMatchObject({ status: "ok", attempts: 2, ok: 2, lastError: null });
  });

  it("calls a kind with readings this week but none in 24 h stopped", async () => {
    await postSpy({ readings: [reading({ at: now - 2 * DAY })] });
    const { body } = await request(created.app).get("/api/spy/health");
    expect(body.checks).toMatchObject([{ key: "facebook:followers", status: "stopped", attempts: 0, ok: 0, lastError: null },
      { key: "instagram:views", status: "warn", ok: 0, lastOkAt: null }]);
  });
});
