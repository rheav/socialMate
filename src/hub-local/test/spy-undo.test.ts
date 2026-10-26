import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import {
  SPY_REMOVED_KEEP_MS,
  ingestSnapshots,
  mergeProfiles,
  purgeRemoved,
  removeProfile,
  saveProfile,
} from "../server/spy.js";

// Removing a profile keeps its history, tags and notes for 7 days; saving it
// again inside that window brings everything back.
let dir: string;
let created: CreatedApp;
const TOKEN = "t";
const IG = "instagram:nasa";
const snapCount = (id: string) =>
  (created.database.db.prepare("SELECT COUNT(*) AS n FROM spy_snapshots WHERE profile_id = ?").get(id) as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "spy-undo-"));
  created = createApp({ dbPath: path.join(dir, "t.db"), appPassword: "", syncToken: TOKEN });
  saveProfile(created.database, "instagram", "nasa", 1000);
  ingestSnapshots(created.database, [{ profileId: IG, day: "2026-10-01", measuredAt: 1500, followers: 100, source: "daily" }]);
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("undo a removal", () => {
  it("hides the profile at once and brings back its history when saved again from the panel", async () => {
    const del = await request(created.app).delete(`/api/spy/profiles/${IG}`).expect(200);
    expect(del.body.restorableUntil).toBeGreaterThan(Date.now());
    expect((await request(created.app).get("/api/spy/profiles")).body.profiles).toEqual([]);
    expect(snapCount(IG)).toBe(1);

    const back = await request(created.app).post("/api/spy/profiles").send({ platform: "instagram", handle: "nasa" }).expect(200);
    expect(back.body.latest.followers).toBe(100);
    expect(back.body.savedAt).toBe(1000);
  });

  it("restores the same way when the extension saves it again", async () => {
    removeProfile(created.database, IG, 2000);
    const res = await request(created.app).post("/api/sync/spy").set("X-Sync-Token", TOKEN)
      .send({ ops: [{ op: "save", platform: "instagram", key: "nasa", at: 3000 }] }).expect(200);
    expect(res.body.profiles.find((p: { id: string }) => p.id === IG).removedAt).toBeNull();
    expect(snapCount(IG)).toBe(1);
  });

  it("deletes the history for good once the window passes, and a later save starts over", () => {
    removeProfile(created.database, IG, 2000);
    expect(purgeRemoved(created.database, 2000 + SPY_REMOVED_KEEP_MS - 1)).toBe(0);
    expect(snapCount(IG)).toBe(1);
    expect(purgeRemoved(created.database, 2000 + SPY_REMOVED_KEEP_MS + 1)).toBe(1);
    expect(snapCount(IG)).toBe(0);
    // Once purged, never again.
    expect(purgeRemoved(created.database, 2000 + 2 * SPY_REMOVED_KEEP_MS)).toBe(0);

    const later = 2000 + SPY_REMOVED_KEEP_MS + 5;
    expect(saveProfile(created.database, "instagram", "nasa", later).status).toBe("created");
    const row = created.database.db.prepare("SELECT saved_at, purged_at FROM spy_profiles WHERE id = ?").get(IG);
    expect(row).toEqual({ saved_at: later, purged_at: null });
  });

  it("does not restart the window when a removed profile is removed again", () => {
    removeProfile(created.database, IG, 2000);
    removeProfile(created.database, IG, 2000 + SPY_REMOVED_KEEP_MS - 10);
    expect(purgeRemoved(created.database, 2000 + SPY_REMOVED_KEEP_MS + 1)).toBe(1);
  });

  it("purges at once the profile a merge retired: its history moved to the kept one", () => {
    saveProfile(created.database, "instagram", "nasa_old", 1100);
    created.database.db.prepare("UPDATE spy_profiles SET user_id = '42' WHERE id IN (?, ?)").run(IG, "instagram:nasa_old");
    ingestSnapshots(created.database, [{ profileId: "instagram:nasa_old", day: "2026-09-01", measuredAt: 1600, followers: 90, source: "daily" }]);
    mergeProfiles(created.database, IG, "instagram:nasa_old");
    expect(snapCount("instagram:nasa_old")).toBe(0);
    expect(saveProfile(created.database, "instagram", "nasa_old", Date.now()).status).toBe("created");
  });

  it("purges on boot what expired while the app was down", () => {
    const dbPath = path.join(dir, "t.db");
    removeProfile(created.database, IG, 2000);
    created.database.close();
    created = createApp({ dbPath, appPassword: "", syncToken: TOKEN });
    expect(snapCount(IG)).toBe(0);
  });
});
