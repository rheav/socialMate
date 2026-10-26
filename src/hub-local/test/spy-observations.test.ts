import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "./harness";
import type { MiniDatabase } from "../server/db.js";
import { saveProfile } from "../server/spy.js";
import { ingestPosts, forgetPosts, movePosts } from "../server/spyPosts.js";

let db: MiniDatabase;
const now = 1791800000000;
const id = "instagram:example";
const post = { profileId: id, id: "3001", createdAt: 1791700000, mediaType: "video" };
beforeEach(() => { db = createDatabase({ dbPath: ":memory:" }); saveProfile(db, "instagram", "example", now); });
afterEach(() => db.close());
const row = () => db.db.prepare("SELECT * FROM spy_posts WHERE profile_id = ?").get(id);
const history = () => db.db.prepare("SELECT * FROM spy_post_observations ORDER BY observed_at").all();

it("keeps timed observations, ignores duplicate retries and does not rewind partial counters", () => {
  ingestPosts(db, [{ ...post, views: 200, durationS: 42.5, observedAt: now - 1000 }], now);
  ingestPosts(db, [{ ...post, views: 100, likes: 10, comments: 2, observedAt: now - 2000 }], now);
  expect(row()).toMatchObject({ views: 200, likes: 10, comments: 2, duration_s: 42.5, views_at: now - 1000, likes_at: now - 2000 });
  ingestPosts(db, [{ ...post, views: 100, likes: 10, comments: 2, observedAt: now - 2000 }], now);
  expect(history()).toHaveLength(2);
  expect(history()[0]).toMatchObject({ views: 100, likes: 10, time_source: "extension" });
  expect(history()[1]).toMatchObject({ views: 200, likes: null });
});

it("preserves duration on missing or invalid enrichment and marks legacy timestamps", () => {
  ingestPosts(db, [{ ...post, durationS: 45, views: 100 }], now);
  ingestPosts(db, [{ ...post, durationS: -5 }, { ...post, durationS: 0 }], now + 1);
  expect(row()).toMatchObject({ duration_s: 45 });
  expect(history()[0]).toMatchObject({ time_source: "received", observed_at: now });
  expect(ingestPosts(db, [{ ...post, views: 900, observedAt: now + 86400000 }], now).invalid).toBe(1);
});

// Local: no backup (hub-only).
it.skip("preserves observations and per-field clocks through backup, profile merge and purge", () => {
  ingestPosts(db, [{ ...post, views: 100, likes: 2, durationS: 42.5, observedAt: now - 1000 }], now);
  const backup = exportBackup(db);
  importBackup(db, backup, "replace");
  expect(row()).toMatchObject({ duration_s: 42.5, views_at: now - 1000 });
  expect(history()).toHaveLength(1);
  saveProfile(db, "instagram", "kept", now);
  movePosts(db, "instagram:kept", id);
  forgetPosts(db, id);
  expect(history()).toEqual([expect.objectContaining({ profile_id: "instagram:kept", views: 100 })]);
  forgetPosts(db, "instagram:kept");
  expect(history()).toEqual([]);
});

it("merges a newer alias into an existing post without discarding its duration or counters", () => {
  saveProfile(db, "instagram", "alias", now);
  ingestPosts(db, [{ ...post, views: 2000, observedAt: now - 1000 }], now);
  ingestPosts(db, [{ ...post, profileId: "instagram:alias", views: 1000, likes: 50, comments: 10, durationS: 60, observedAt: now - 2000 }], now);
  movePosts(db, id, "instagram:alias");
  forgetPosts(db, "instagram:alias");
  expect(row()).toMatchObject({ views: 2000, likes: 50, comments: 10, duration_s: 60 });
  expect(history()).toHaveLength(2);
});

it("coalesces complementary observations at the same timestamp on profile merge", () => {
  saveProfile(db, "instagram", "alias", now);
  ingestPosts(db, [{ ...post, views: 1000, observedAt: now }], now);
  ingestPosts(db, [{ ...post, profileId: "instagram:alias", likes: 50, comments: 10, durationS: 60, observedAt: now }], now);
  movePosts(db, id, "instagram:alias");
  forgetPosts(db, "instagram:alias");
  expect(history()).toEqual([expect.objectContaining({ profile_id: id, views: 1000, likes: 50, comments: 10, duration_s: 60 })]);
});

it.skip("merges complementary observation fields from a backup without clearing known ones", () => {
  ingestPosts(db, [{ ...post, views: 1000, observedAt: now }], now);
  const backup = exportBackup(db);
  Object.assign(backup.spy!.observations![0], { views: null, likes: 50, duration_s: 60 });
  importBackup(db, backup, "merge");
  expect(history()).toEqual([expect.objectContaining({ views: 1000, likes: 50, duration_s: 60 })]);
});
