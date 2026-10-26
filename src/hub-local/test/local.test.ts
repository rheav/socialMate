// What the local hub adds to the hub's contract: SQLite in WebAssembly (JSON1
// included), persistence through the storage adapter, the observations'
// retention, "Coletar stories" without a relay, and the client the Spy code calls.

import { afterEach, describe, expect, it, vi } from "vitest";
import { SQL, createApp } from "./harness";
import { createLocalHub, OBSERVATIONS_KEEP_MS } from "../router.ts";
import { memoryStorage } from "../storage.js";
import { createDatabase } from "../server/db.js";
import { saveProfile } from "../server/spy.js";

const IG = "instagram:natgeo";

describe("sql.js", () => {
  it("has JSON1: json_each and json_extract work", () => {
    const db = createDatabase(SQL).db;
    expect(db.prepare("SELECT json_extract('{\"a\":{\"b\":7}}', '$.a.b') AS v").get()).toEqual({ v: 7 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM json_each('[\"x\",\"Y\"]') WHERE lower(value) = 'y'").get()).toEqual({ n: 1 });
  });

  it("binds better-sqlite3 style: named params without prefix, arrays spread, undefined as NULL, nested transactions", () => {
    const db = createDatabase(SQL).db;
    db.exec("CREATE TABLE t (a, b)");
    expect(db.prepare("INSERT INTO t VALUES (@a, :b)").run({ a: 1, b: "x" }).changes).toBe(1);
    db.prepare("INSERT INTO t VALUES (?, ?)").run([2, undefined]);
    expect(db.prepare("SELECT * FROM t WHERE a = ?").get(9)).toBeUndefined();
    expect(db.prepare("SELECT * FROM t ORDER BY a").all()).toEqual([{ a: 1, b: "x" }, { a: 2, b: null }]);
    const outer = db.transaction(() => {
      db.prepare("INSERT INTO t VALUES (3, 'kept')").run();
      try {
        db.transaction(() => {
          db.prepare("INSERT INTO t VALUES (4, 'gone')").run();
          throw new Error("inner");
        })();
      } catch { /* the inner savepoint rolled back alone */ }
    });
    outer();
    expect(db.prepare("SELECT a FROM t ORDER BY a").all()).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });
});

describe("persistence", () => {
  it("saves after a write, not after a read, and a new hub over the same storage finds everything", async () => {
    const storage = memoryStorage();
    const save = vi.spyOn(storage, "save");
    const hub = createLocalHub({ SQL, storage });
    expect((await hub.handle("GET", "/local/sync/spy/profiles")).json).toMatchObject({ ok: true, profiles: [] });
    expect(save).not.toHaveBeenCalled();

    const at = Date.now();
    await hub.handle("POST", "/local/sync/spy", {
      ops: [{ op: "save", platform: "instagram", key: "natgeo", at }],
      snapshots: [{ profileId: IG, day: "2026-10-26", measuredAt: at, followers: 42, source: "daily" }],
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(await storage.load()).toBeInstanceOf(Uint8Array);

    const again = createLocalHub({ SQL, storage });
    const { json } = await again.handle("GET", "/api/spy/profiles");
    expect((json as any).profiles.map((p: any) => [p.id, p.latest.followers])).toEqual([[IG, 42]]);
  });

  it("keeps story media out of SQLite and deletes them when their rows go", async () => {
    const { app, storage, database } = createApp();
    saveProfile(database, "instagram", "natgeo", 1000);
    const takenAt = Date.now() - 3_600_000;
    await app.handle("POST", "/local/sync/spy", { stories: [{ profileId: IG, id: "77", mediaType: 1, takenAt,
      expiringAt: takenAt + 86_400_000, mediaMime: "image/jpeg" }] });
    const put = (kind: string, type: string) =>
      app.handle("PUT", `/local/sync/spy/stories/77/${kind}`, { blob: new Blob([new Uint8Array(5)], { type }), contentType: type });
    expect((await put("media", "image/jpeg")).json).toEqual({ id: "77", bytes: 5, ready: false });
    expect((await put("poster", "image/webp")).json).toEqual({ id: "77", bytes: 5, ready: true });
    expect(await storage.mediaKeys()).toEqual(["77/media", "77/poster"]);
    expect(database.db.prepare("SELECT media_path, poster_path FROM spy_stories").get()).toEqual({ media_path: "77/media", poster_path: "77/poster" });

    database.db.prepare("UPDATE spy_stories SET taken_at = ?").run(Date.now() - 40 * 86_400_000);
    await app.prune();
    expect(await storage.mediaKeys()).toEqual([]);
  });

  it("answers images as the stored data: URLs", async () => {
    const { app, database } = createApp();
    saveProfile(database, "instagram", "natgeo", 1000);
    const avatar = "data:image/png;base64,iVBORw0KGgo=";
    await app.handle("POST", "/local/sync/spy", { profiles: [{ id: IG, at: Date.now(), avatar }] });
    const { json } = await app.handle("GET", `/api/spy/profiles/${encodeURIComponent(IG)}/history`);
    expect((json as any).profile.avatarUrl).toBe(avatar);
  });
});

describe("observations retention", () => {
  it("drops observations older than 97 days on the hourly prune", async () => {
    const { app, database } = createApp();
    saveProfile(database, "instagram", "natgeo", 1000);
    const now = Date.now();
    const insert = database.db.prepare(`INSERT INTO spy_post_observations
      (profile_id, post_id, observed_at, received_at, time_source, views) VALUES (?, ?, ?, ?, 'extension', 1)`);
    insert.run(IG, "1001", now - OBSERVATIONS_KEEP_MS - 1, now);
    insert.run(IG, "1002", now - OBSERVATIONS_KEEP_MS + 60_000, now);
    expect((await app.prune()).observations).toBe(1);
    expect(database.db.prepare("SELECT post_id FROM spy_post_observations").all()).toEqual([{ post_id: "1002" }]);
  });
});

describe("Coletar stories", () => {
  afterEach(() => vi.useRealTimers());

  it("runs the extension's pass outside the request queue and reports like the hub's relay", async () => {
    let reply: any = null;
    const collectStories = vi.fn((_msg, r) => { reply = r; });
    const { app, database } = createApp({}, { collectStories });
    saveProfile(database, "instagram", "natgeo", 1000);
    expect((await app.handle("POST", "/api/spy/stories/collect", {})).json).toEqual({ error: "nothing_tracked" });
    database.db.prepare("UPDATE spy_profiles SET track_stories = 1").run();

    const started = await app.handle("POST", "/api/spy/stories/collect", {});
    expect(started.status).toBe(202);
    const { requestId, total } = started.json as any;
    expect(total).toBe(1);
    expect((await app.handle("POST", "/api/spy/stories/collect", {})).json).toEqual({ error: "already_collecting", requestId });

    await new Promise((r) => setTimeout(r, 0));
    expect(collectStories).toHaveBeenCalledWith({ profileIds: [IG] }, expect.anything());
    // The pass posts its readings back through the hub while the command runs.
    expect((await app.handle("GET", "/local/sync/spy/profiles")).status).toBe(200);
    reply.progress({ done: 1, total: 1, added: 2 });
    reply.result(true, { added: 2, failed: 0 });
    const state = (await app.handle("GET", `/api/spy/stories/collect/${requestId}`)).json as any;
    expect(state.request).toMatchObject({ requestId, command: "stories.collect", done: true, ok: true, error: null,
      progress: { done: 1, total: 1, added: 2, failed: 0 } });
    expect((await app.handle("GET", "/api/spy/stories/collect/nope")).status).toBe(404);
  });

  it("answers extension_offline without a pass to run", async () => {
    const { app, database } = createApp();
    saveProfile(database, "instagram", "natgeo", 1000);
    database.db.prepare("UPDATE spy_profiles SET track_stories = 1").run();
    expect(await app.handle("POST", "/api/spy/stories/collect", {})).toEqual({ status: 409, json: { error: "extension_offline" } });
  });
});

describe("client (the syncClient names, in process)", () => {
  it("keeps syncClient's shapes and error semantics", async () => {
    const hub = createLocalHub({ SQL, storage: memoryStorage() });
    vi.doMock("../hub.js", () => ({ localHub: async () => hub }));
    const client = await import("../client.js");
    expect(client.isSyncConfigured(client.syncSettings(undefined))).toBe(true);
    expect(client.SYNC_KEY).toBe("fbw_sync");
    expect(await client.getSpyProfiles(client.syncSettings())).toMatchObject({ ok: true, profiles: [], max: 100 });

    const res = await client.postSpy({}, { ops: [{ op: "save", platform: "instagram", key: "natgeo", at: Date.now() }] });
    expect(res.results.ops).toEqual({ applied: 1, skipped: 0, invalid: 0 });
    const err = await client.postSpy({}, {}).catch((e: any) => e);
    expect(err.status).toBe(400);
    expect(client.isRetryable(err.status)).toBe(false);

    expect(await client.putStoryMedia({}, "123", "media", new Blob(["x"]), "video/mp4"))
      .toEqual({ ok: false, status: 404, json: { error: "unknown_story" } });
    vi.doUnmock("../hub.js");
  });
});
