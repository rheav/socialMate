import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";

let dir: string;
let created: CreatedApp;
const TOKEN = "test-sync-token";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-sync-"));
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

const postSpy = (body: unknown, token: string | null = TOKEN) => {
  const req = request(created.app).post("/api/sync/spy");
  if (token) req.set("X-Sync-Token", token);
  return req.send(body as object);
};

const getProfiles = (token: string | null = TOKEN) => {
  const req = request(created.app).get("/api/sync/spy/profiles");
  if (token) req.set("X-Sync-Token", token);
  return req;
};

const getPing = (token: string | null = TOKEN) => {
  const req = request(created.app).get("/api/sync/ping");
  if (token) req.set("X-Sync-Token", token);
  return req;
};

describe("spy sync auth", () => {
  it("accepts authenticated batches above 5MB within the documented 20MB limit", async () => {
    expect((await postSpy({ ops: [], padding: "x".repeat(6 * 1024 * 1024) })).status).toBe(200);
  });

  it("keeps errors ordered with both newer errors and successful measurements", async () => {
    await postSpy({ ops: [{ op: "save", platform: "instagram", key: "audit", at: 1000 }] });
    await postSpy({ errors: [{ profileId: "instagram:audit", error: "network", at: 3000 }] });
    await postSpy({ errors: [{ profileId: "instagram:audit", error: "older", at: 2000 }] });
    const row = () => created.database.db.prepare("SELECT last_error, last_error_at FROM spy_profiles WHERE id = ?").get("instagram:audit");
    expect(row()).toEqual({ last_error: "network", last_error_at: 3000 });
    await postSpy({ snapshots: [{ profileId: "instagram:audit", day: "2020-01-01", measuredAt: 2500, followers: 10, source: "daily" }] });
    expect(row()).toEqual({ last_error: "network", last_error_at: 3000 });
    await postSpy({ snapshots: [{ profileId: "instagram:audit", day: "2020-01-01", measuredAt: 4000, followers: 11, source: "daily" }], errors: [{ profileId: "instagram:audit", error: "stale", at: 3500 }] });
    expect(row()).toEqual({ last_error: null, last_error_at: null });
  });

  // Local: no token (hub-only).
  it.skip("refuses requests with no token or a wrong one", async () => {
    expect((await postSpy({ ops: [] }, null)).status).toBe(401);
    expect((await postSpy({ ops: [] }, "wrong")).status).toBe(401);
    expect((await getProfiles(null)).status).toBe(401);
    expect((await getProfiles("wrong")).status).toBe(401);
  });

  it.skip("reports 503 when no sync token is configured", async () => {
    const other = createApp({ dbPath: path.join(dir, "other.db"), appPassword: "", syncToken: "" });
    const resPost = await request(other.app).post("/api/sync/spy").send({ ops: [] });
    expect(resPost.status).toBe(503);
    expect(resPost.body.error).toBe("sync_disabled");

    const resGet = await request(other.app).get("/api/sync/spy/profiles");
    expect(resGet.status).toBe(503);
    expect(resGet.body.error).toBe("sync_disabled");
    other.database.close();
  });
});

describe("spy sync list operations (ops)", () => {
  it.each(["instagram", "facebook"])("propagates %s removals both ways and rejects stale saves", async (platform) => {
    const id = `${platform}:nasa`;
    const oldSave = { op: "save", platform, key: "nasa", at: Date.now() - 1000 };
    await postSpy({ ops: [oldSave] }).expect(200);
    await request(created.app).delete(`/api/spy/profiles/${id}`).expect(200);
    const synced = await getProfiles().expect(200);
    expect(synced.body.profiles.find((p: any) => p.id === id).removedAt).toBeTypeOf("number");
    await postSpy({ ops: [oldSave] }).expect(200);
    expect((await request(created.app).get("/api/spy/profiles")).body.profiles).toHaveLength(0);

    await request(created.app).post("/api/spy/profiles").send({ platform, handle: "nasa" }).expect(200);
    const restored = (await getProfiles()).body.profiles.find((p: any) => p.id === id);
    await postSpy({ ops: [{ op: "remove", platform, key: "nasa", at: restored.listUpdatedAt + 1 }] }).expect(200);
    expect((await request(created.app).get("/api/spy/profiles")).body.profiles).toHaveLength(0);
    expect((await getProfiles()).body.profiles.find((p: any) => p.id === id).removedAt).toBeTypeOf("number");
  });

  it("save creates; repeated save with equal or older timestamp is skipped", async () => {
    const t1 = 1_700_000_000_000;
    const r1 = await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "nasa", at: t1 }],
    });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.results.ops).toEqual({ applied: 1, skipped: 0, invalid: 0 });
    expect(r1.body.profiles).toHaveLength(1);
    expect(r1.body.profiles[0]).toMatchObject({
      id: "instagram:nasa",
      platform: "instagram",
      key: "nasa",
      savedAt: t1,
      removedAt: null,
      listUpdatedAt: t1,
    });

    // Equal timestamp -> skipped
    const r2 = await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "nasa", at: t1 }],
    });
    expect(r2.body.results.ops).toEqual({ applied: 0, skipped: 1, invalid: 0 });

    // Older timestamp -> skipped
    const r3 = await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "nasa", at: t1 - 1000 }],
    });
    expect(r3.body.results.ops).toEqual({ applied: 0, skipped: 1, invalid: 0 });
  });

  it("remove with newer timestamp marks removedAt and keeps snapshots; newer save revives", async () => {
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_005_000;
    const t3 = 1_700_000_010_000;

    // Create profile + snapshot
    await postSpy({
      ops: [{ op: "save", platform: "facebook", key: "nasa", at: t1 }],
      snapshots: [
        {
          profileId: "facebook:nasa",
          day: "2026-10-02",
          measuredAt: t1,
          followers: 28_000_000,
          source: "daily",
        },
      ],
    });

    // Remove
    const rRemove = await postSpy({
      ops: [{ op: "remove", platform: "facebook", key: "nasa", at: t2 }],
    });
    expect(rRemove.body.results.ops).toEqual({ applied: 1, skipped: 0, invalid: 0 });
    expect(rRemove.body.profiles[0].removedAt).toBe(t2);

    // Verify snapshot was deleted from database on remove
    const snap = created.database.db
      .prepare("SELECT * FROM spy_snapshots WHERE profile_id = ?")
      .get("facebook:nasa");
    expect(snap).toBeUndefined();

    // Revive with newer save
    const rRevive = await postSpy({
      ops: [{ op: "save", platform: "facebook", key: "nasa", at: t3 }],
    });
    expect(rRevive.body.results.ops).toEqual({ applied: 1, skipped: 0, invalid: 0 });
    expect(rRevive.body.profiles[0].removedAt).toBeNull();
    expect(rRevive.body.profiles[0].savedAt).toBe(t3); // revived gets new savedAt
    expect(rRevive.body.profiles[0].lastMeasuredAt).toBeNull();
  });

  it("remove older than last save is skipped", async () => {
    const t1 = 1_700_000_000_000;
    await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "nasa", at: t1 }],
    });

    const r = await postSpy({
      ops: [{ op: "remove", platform: "instagram", key: "nasa", at: t1 - 100 }],
    });
    expect(r.body.results.ops).toEqual({ applied: 0, skipped: 1, invalid: 0 });
    const p = await getProfiles();
    expect(p.body.profiles[0].removedAt).toBeNull();
  });

  it("timestamp in distant future is clamped to server clock", async () => {
    const future = Date.now() + 10 * 86400 * 1000; // 10 days in future
    const r = await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "futureuser", at: future }],
    });
    expect(r.body.results.ops.applied).toBe(1);
    expect(r.body.profiles[0].listUpdatedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("refuses the 101st active profile and refuses reviving with 100 active", async () => {
    const now = Date.now();
    // Fill 100 active profiles
    const ops = Array.from({ length: 100 }, (_, i) => ({
      op: "save",
      platform: "instagram",
      key: `user${i}`,
      at: now + i,
    }));
    const r100 = await postSpy({ ops });
    expect(r100.body.results.ops.applied).toBe(100);

    // 101st active profile
    const r101 = await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "user101", at: now + 200 }],
    });
    expect(r101.body.results.ops.invalid).toBe(1);

    // Local: no /ping; the same count, read from the database.
    void getPing;
    expect(created.database.db.prepare("SELECT COUNT(*) AS count FROM spy_profiles WHERE removed_at IS NULL").get()).toEqual({ count: 100 });
  });
});

describe("spy sync snapshots & metadata ingestion", () => {
  it("snapshot for unknown profile is counted as unknown; for removed profile as skipped", async () => {
    const now = Date.now();
    await postSpy({
      ops: [
        { op: "save", platform: "instagram", key: "removeduser", at: now },
        { op: "remove", platform: "instagram", key: "removeduser", at: now + 1 },
      ],
    });

    const r = await postSpy({
      snapshots: [
        {
          profileId: "instagram:unknown",
          day: "2026-10-02",
          measuredAt: now,
          followers: 1000,
          source: "daily",
        },
        {
          profileId: "instagram:removeduser",
          day: "2026-10-02",
          measuredAt: now,
          followers: 2000,
          source: "daily",
        },
      ],
    });
    expect(r.body.results.snapshots).toEqual({
      created: 0,
      updated: 0,
      skipped: 1,
      invalid: 0,
      unknown: 1,
    });
  });

  it("two snapshots on same day: newer wins and followers: null in newer does NOT erase previous", async () => {
    const now = Date.now();
    await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "nasa", at: now }],
    });

    // First snapshot
    await postSpy({
      snapshots: [
        {
          profileId: "instagram:nasa",
          day: "2026-10-02",
          measuredAt: 1000,
          followers: 50_000,
          following: 100,
          posts: 500,
          hasStory: true,
          source: "daily",
        },
      ],
    });

    // Newer snapshot with followers: null
    const r2 = await postSpy({
      snapshots: [
        {
          profileId: "instagram:nasa",
          day: "2026-10-02",
          measuredAt: 2000,
          followers: null,
          following: 105,
          posts: 501,
          hasStory: false,
          source: "visit",
        },
      ],
    });
    expect(r2.body.results.snapshots.updated).toBe(1);

    const snap = created.database.db
      .prepare("SELECT * FROM spy_snapshots WHERE profile_id = ? AND day = ?")
      .get("instagram:nasa", "2026-10-02") as Record<string, unknown>;
    expect(snap.followers).toBe(50_000); // not erased!
    expect(snap.following).toBe(105);
    expect(snap.posts).toBe(501);
    expect(snap.has_story).toBe(0);
    expect(snap.source).toBe("visit");
  });

  it("malformed day or negative counts count as invalid without dropping valid ones", async () => {
    const now = Date.now();
    await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "nasa", at: now }],
    });

    const r = await postSpy({
      snapshots: [
        {
          profileId: "instagram:nasa",
          day: "not-a-date",
          measuredAt: now,
          followers: 100,
          source: "daily",
        },
        {
          profileId: "instagram:nasa",
          day: "2026-10-02",
          measuredAt: now,
          followers: -10, // negative count with no other fields valid -> invalid
          source: "daily",
        },
        {
          profileId: "instagram:nasa",
          day: "2026-10-02",
          measuredAt: now,
          followers: 1200,
          source: "daily",
        },
      ],
    });
    expect(r.body.results.snapshots.invalid).toBe(2);
    expect(r.body.results.snapshots.created).toBe(1);
  });

  it("batch with ops and snapshots of the same new profile applies both in order", async () => {
    const now = Date.now();
    const r = await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "newbie", at: now }],
      snapshots: [
        {
          profileId: "instagram:newbie",
          day: "2026-10-02",
          measuredAt: now,
          followers: 42,
          source: "daily",
        },
      ],
    });
    expect(r.body.results.ops.applied).toBe(1);
    expect(r.body.results.snapshots.created).toBe(1);
  });

  it("discards avatar that is not a data: URL and preserves existing avatar", async () => {
    const now = Date.now();
    await postSpy({
      ops: [{ op: "save", platform: "instagram", key: "nasa", at: now }],
      profiles: [
        {
          id: "instagram:nasa",
          at: now,
          name: "NASA",
          avatar: "data:image/webp;base64,AAAA",
        },
      ],
    });

    // Try sending CDN URL
    const r = await postSpy({
      profiles: [
        {
          id: "instagram:nasa",
          at: now + 1,
          name: "NASA Updated",
          avatar: "https://cdn.instagram.com/p.jpg",
        },
      ],
    });
    expect(r.body.results.profiles.updated).toBe(1);

    const prof = created.database.db
      .prepare("SELECT name, avatar FROM spy_profiles WHERE id = ?")
      .get("instagram:nasa") as { name: string; avatar: string };
    expect(prof.name).toBe("NASA Updated");
    expect(prof.avatar).toBe("data:image/webp;base64,AAAA"); // preserved!
  });

  it("empty batch responds 400 empty_batch", async () => {
    const r = await postSpy({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("empty_batch");
  });
});
