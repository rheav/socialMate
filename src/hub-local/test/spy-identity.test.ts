import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { ingestProfiles, ingestSnapshots, saveProfile, updateProfileMeta } from "../server/spy.js";

// A renamed Instagram account, or one Facebook profile saved by vanity and by
// numeric id, ends up as two rows sharing the network's user id.
let dir: string;
let created: CreatedApp;
const snap = (profileId: string, day: string, followers: number) =>
  ({ profileId, day, measuredAt: Date.parse(`${day}T12:00:00Z`), followers, source: "daily" });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-identity-"));
  created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: "t" });
  const db = created.database;
  saveProfile(db, "instagram", "old_name", 1000);
  saveProfile(db, "instagram", "new_name", 2000);
  saveProfile(db, "instagram", "other", 3000);
  ingestProfiles(db, [
    { id: "instagram:old_name", userId: "777", at: 1100 },
    { id: "instagram:new_name", userId: "777", at: 2100 },
    { id: "instagram:other", userId: "888", at: 3100 },
  ]);
  ingestSnapshots(db, [
    snap("instagram:old_name", "2026-09-01", 100),
    snap("instagram:old_name", "2026-09-02", 110),
    snap("instagram:new_name", "2026-09-02", 999),
    snap("instagram:new_name", "2026-10-01", 150),
  ]);
  updateProfileMeta(db, "instagram:old_name", { tags: ["Cliente"], notes: "nota antiga" });
  updateProfileMeta(db, "instagram:new_name", { tags: ["Parceiro"], notes: "" });
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("same account under two profiles", () => {
  it("flags active profiles that share the network user id", async () => {
    const res = await request(created.app).get("/api/spy/profiles");
    const byId = Object.fromEntries(res.body.profiles.map((p: any) => [p.id, p]));
    expect(byId["instagram:new_name"].sameAccountAs).toEqual(["instagram:old_name"]);
    expect(byId["instagram:old_name"].sameAccountAs).toEqual(["instagram:new_name"]);
    expect(byId["instagram:other"].sameAccountAs).toEqual([]);
  });

  it("merges history, tags and notes into the kept profile and retires the other", async () => {
    const res = await request(created.app).post("/api/spy/profiles/instagram:new_name/merge").send({ from: "instagram:old_name" });
    expect(res.status).toBe(200);
    expect(res.body.profile.sameAccountAs).toEqual([]);
    expect(res.body.profile.tags).toEqual(["Parceiro", "Cliente"]);
    expect(res.body.profile.notes).toBe("nota antiga");
    const history = await request(created.app).get("/api/spy/profiles/instagram:new_name/history");
    // The kept profile's own measurement wins a shared day.
    expect(history.body.snapshots.map((s: any) => [s.day, s.followers])).toEqual([
      ["2026-09-01", 100], ["2026-09-02", 999], ["2026-10-01", 150],
    ]);
    expect(history.body.profile.deltaTotal).toBe(50);
    const list = await request(created.app).get("/api/spy/profiles");
    expect(list.body.profiles.map((p: any) => p.id)).not.toContain("instagram:old_name");
    const ext = await request(created.app).get("/api/sync/spy/profiles").set("X-Sync-Token", "t");
    expect(ext.body.profiles.find((p: any) => p.id === "instagram:old_name").removedAt).not.toBeNull();
  });

  it("refuses to merge different accounts or a profile into itself", async () => {
    const other = await request(created.app).post("/api/spy/profiles/instagram:new_name/merge").send({ from: "instagram:other" });
    expect(other.status).toBe(409);
    const self = await request(created.app).post("/api/spy/profiles/instagram:new_name/merge").send({ from: "instagram:new_name" });
    expect(self.status).toBe(400);
    const missing = await request(created.app).post("/api/spy/profiles/instagram:new_name/merge").send({ from: "instagram:nope" });
    expect(missing.status).toBe(404);
  });
});
