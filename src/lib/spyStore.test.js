import { describe, expect, it } from "vitest";
import { measuredAt,
  igLimit,
  queuePosts,
  queueThumb,
  rememberThumbUrls,
  thumbsToFetch,
  dayKey,
  measureDayKey,
  dueProfiles,
  emptySpyQueue,
  queueReels,
  queueReelsStatus,
  queueReading,
  emptySpyState,
  isBlocked,
  mergeList,
  queueError,
  queueOp,
  queueProfile,
  queueSnapshot,
} from "./spyStore.js";

describe("spyStore", () => {
  describe("dayKey", () => {
    it("formats local YYYY-MM-DD and handles day turnover", () => {
      // Create dates in local time
      const today = new Date(2026, 9, 2, 23, 59, 59); // Oct 2, 2026 23:59:59
      const tomorrow = new Date(2026, 9, 3, 0, 0, 1);  // Oct 3, 2026 00:00:01

      expect(dayKey(today.getTime())).toBe("2026-10-02");
      expect(dayKey(tomorrow.getTime())).toBe("2026-10-03");
    });
  });

  describe("mergeList", () => {
    it("removes server-deleted profiles from local copy", () => {
      const cache = {
        profiles: {
          "instagram:nasa": {
            id: "instagram:nasa",
            platform: "instagram",
            key: "nasa",
            listUpdatedAt: 1000,
            removedAt: null,
          },
        },
      };

      const serverList = [
        {
          id: "instagram:nasa",
          platform: "instagram",
          key: "nasa",
          listUpdatedAt: 2000,
          removedAt: 2000,
        },
      ];

      const merged = mergeList(cache, serverList);
      expect(merged.profiles["instagram:nasa"]).toBeUndefined();
    });

    it("drops local profiles absent from an updated server list", () => {
      const cache = {
        profiles: {
          "instagram:old": {
            id: "instagram:old",
            platform: "instagram",
            key: "old",
            listUpdatedAt: 1000,
          },
        },
      };

      const serverList = [
        {
          id: "instagram:fresh",
          platform: "instagram",
          key: "fresh",
          listUpdatedAt: 2000,
          removedAt: null,
        },
      ];

      const merged = mergeList(cache, serverList);
      expect(merged.profiles["instagram:old"]).toBeUndefined();
      expect(merged.profiles["instagram:fresh"]).toBeDefined();
    });

    it("preserves local operations in queue from being undone by an older server list", () => {
      // 1. Local optimistic save with newer listUpdatedAt
      const cache = {
        profiles: {
          "instagram:nasa": {
            id: "instagram:nasa",
            platform: "instagram",
            key: "nasa",
            listUpdatedAt: 3000,
            removedAt: null,
          },
        },
      };

      // Older server list arrived (e.g. from an earlier fetch or delayed sync)
      const olderServerList = [
        {
          id: "instagram:nasa",
          platform: "instagram",
          key: "nasa",
          listUpdatedAt: 1000,
          removedAt: 1000,
        },
      ];

      const merged1 = mergeList(cache, olderServerList);
      expect(merged1.profiles["instagram:nasa"]).toBeDefined();
      expect(merged1.profiles["instagram:nasa"].listUpdatedAt).toBe(3000);

      // 2. Pending save in pendingOps
      const pendingOps = [{ op: "save", id: "facebook:meta", at: 3000 }];
      const olderServerList2 = [
        {
          id: "facebook:meta",
          platform: "facebook",
          key: "meta",
          listUpdatedAt: 1000,
          removedAt: 1000,
        },
      ];

      const merged2 = mergeList({ profiles: {} }, olderServerList2, pendingOps);
      expect(merged2.profiles["facebook:meta"]).toBeDefined();

      // 3. Pending remove in pendingOps prevents older active server entry
      const pendingRemove = [{ op: "remove", id: "instagram:nasa", at: 4000 }];
      const serverActive = [
        {
          id: "instagram:nasa",
          platform: "instagram",
          key: "nasa",
          listUpdatedAt: 2000,
          removedAt: null,
        },
      ];
      const merged3 = mergeList(cache, serverActive, pendingRemove);
      expect(merged3.profiles["instagram:nasa"]).toBeUndefined();
    });
  });

  describe("queue helpers", () => {
    it("queueOp appends operations purely", () => {
      const q0 = emptySpyQueue();
      const q1 = queueOp(q0, "save", { platform: "instagram", key: "nasa" }, 1000);
      expect(q0.ops).toHaveLength(0);
      expect(q1.ops).toEqual([{ op: "save", platform: "instagram", key: "nasa", at: 1000 }]);

      const q2 = queueOp(q1, { op: "remove", id: "instagram:nasa", at: 2000 });
      expect(q2.ops).toHaveLength(2);
    });

    it("queueSnapshot keeps newest snapshot by id|day and does not let null erase followers", () => {
      const q0 = emptySpyQueue();
      const snap1 = {
        profileId: "instagram:nasa",
        day: "2026-10-02",
        measuredAt: 1000,
        followers: 50000,
        followersApprox: false,
        source: "daily",
      };

      const q1 = queueSnapshot(q0, snap1);
      expect(q1.snapshots["instagram:nasa|2026-10-02"].followers).toBe(50000);

      // Newer snapshot arrives with null followers: should NOT erase 50000
      const snap2 = {
        profileId: "instagram:nasa",
        day: "2026-10-02",
        measuredAt: 2000,
        followers: null,
        source: "visit",
      };
      const q2 = queueSnapshot(q1, snap2);
      expect(q2.snapshots["instagram:nasa|2026-10-02"].followers).toBe(50000);
      expect(q2.snapshots["instagram:nasa|2026-10-02"].source).toBe("visit");
      expect(q2.snapshots["instagram:nasa|2026-10-02"].measuredAt).toBe(2000);

      // Newer snapshot with real followers updates count
      const snap3 = {
        profileId: "instagram:nasa",
        day: "2026-10-02",
        measuredAt: 3000,
        followers: 52000,
        source: "visit",
      };
      const q3 = queueSnapshot(q2, snap3);
      expect(q3.snapshots["instagram:nasa|2026-10-02"].followers).toBe(52000);

      // Older snapshot arriving late does not overwrite newer count
      const snapOld = {
        profileId: "instagram:nasa",
        day: "2026-10-02",
        measuredAt: 500,
        followers: 40000,
        source: "daily",
      };
      const q4 = queueSnapshot(q3, snapOld);
      expect(q4.snapshots["instagram:nasa|2026-10-02"].followers).toBe(52000);
    });

    it("queueProfile merges profile patches", () => {
      const q0 = emptySpyQueue();
      const q1 = queueProfile(q0, { id: "instagram:nasa", name: "NASA" });
      const q2 = queueProfile(q1, { id: "instagram:nasa", verified: true });
      expect(q2.profiles["instagram:nasa"]).toEqual({
        id: "instagram:nasa",
        name: "NASA",
        verified: true,
      });
    });

    it("queueError records error by profile id", () => {
      const q0 = emptySpyQueue();
      const q1 = queueError(q0, "instagram:nasa", "rate_limited", 5000);
      expect(q1.errors["instagram:nasa"]).toEqual({
        id: "instagram:nasa",
        error: "rate_limited",
        at: 5000,
      });
    });
  });

  describe("isBlocked", () => {
    it("checks whether platform is blocked until a future timestamp", () => {
      const now = 10000;
      const state = {
        blocked: {
          instagram: 20000,
          facebook: 5000,
        },
      };

      expect(isBlocked(state, "instagram", now)).toBe(true);
      expect(isBlocked(state, "facebook", now)).toBe(false);
      expect(isBlocked(state, "tiktok", now)).toBe(false);
      expect(isBlocked(null, "instagram", now)).toBe(false);
    });
  });

  // 2026-10-20: the Mac is off at night, so the daily pass runs at 23:00 and its day starts there.
  describe("the measurement's day starts at 23:00", () => {
    const at = (h, m = 0, d = 20) => new Date(2026, 9, d, h, m).getTime();
    const ig = (last) => ({ id: "instagram:nasa", platform: "instagram", key: "nasa", removedAt: null, viewsReadAt: last });
    it("files 23:00 onward under the next day", () => {
      expect(measureDayKey(at(22, 59))).toBe("2026-10-20");
      expect(measureDayKey(at(23, 0))).toBe("2026-10-21");
    });
    it("a profile read at 23:10 is not due again until 23:00 the next day", () => {
      const state = emptySpyState(at(23, 10));
      expect(dueProfiles([ig(at(23, 10))], state, at(10, 0, 21))).toEqual([]);
      expect(dueProfiles([ig(at(23, 10))], state, at(23, 0, 21))).toHaveLength(1);
      expect(dueProfiles([ig(at(22, 50))], state, at(23, 5))).toHaveLength(1);
    });
  });

  describe("dueProfiles", () => {
    const now = new Date(2026, 9, 2, 12, 0, 0).getTime();
    const today = dayKey(now); // "2026-10-02"

    const baseProfile = {
      id: "instagram:test",
      platform: "instagram",
      key: "test",
      removedAt: null,
      lastMeasuredAt: null,
    };

    it("includes active profiles never measured or not measured today", () => {
      const state = emptySpyState(now);
      const list = [
        { ...baseProfile, id: "p1" },
        { ...baseProfile, id: "p2", lastMeasuredAt: new Date(2026, 9, 1, 12, 0, 0).getTime() },
      ];

      expect(dueProfiles(list, state, now).map((p) => p.id)).toEqual(["p1", "p2"]);
    });

    it("excludes profiles already measured today", () => {
      const state = emptySpyState(now);
      const morning = new Date(2026, 9, 2, 8, 0, 0).getTime();
      const list = [
        { ...baseProfile, id: "p1", viewsReadAt: morning },
        { ...baseProfile, id: "facebook:p2", platform: "facebook", lastMeasuredAt: morning },
      ];

      expect(dueProfiles(list, state, now)).toHaveLength(0);
    });

    it("counts an Instagram profile as measured only once its views were read, here or as the hub knows", () => {
      const morning = new Date(2026, 9, 2, 8, 0, 0).getTime();
      // A visit read the followers only: the views are still due.
      const visited = { ...baseProfile, id: "instagram:visited", lastMeasuredAt: morning };
      const readHere = { ...baseProfile, id: "instagram:here", lastMeasuredAt: morning };
      const readElsewhere = { ...baseProfile, id: "instagram:hub", lastMeasuredAt: morning, viewsReadAt: morning };
      const state = { ...emptySpyState(now), igViewsAt: { "instagram:here": morning } };
      expect(dueProfiles([visited, readHere, readElsewhere], state, now).map((p) => p.id)).toEqual(["instagram:visited"]);
      expect(measuredAt(state, visited)).toBeNull();
      expect(measuredAt(state, readHere)).toBe(morning);
    });

    it("excludes removed profiles", () => {
      const state = emptySpyState(now);
      const list = [{ ...baseProfile, id: "p1", removedAt: 1000 }];
      expect(dueProfiles(list, state, now)).toHaveLength(0);
    });

    it("excludes profiles when platform is blocked", () => {
      const state = {
        day: today,
        blocked: { instagram: now + 3600000 },
        attempts: {},
      };
      const list = [{ ...baseProfile, id: "p1" }];
      expect(dueProfiles(list, state, now)).toHaveLength(0);
    });

    it("excludes profiles that reached 2 attempts today", () => {
      const state = {
        day: today,
        blocked: {},
        attempts: {
          p1: { n: 2, at: now - 7 * 3600 * 1000 },
        },
      };
      const list = [{ ...baseProfile, id: "p1" }];
      expect(dueProfiles(list, state, now)).toHaveLength(0);
    });

    it("excludes profiles whose last attempt was less than 6 hours ago", () => {
      const state = {
        day: today,
        blocked: {},
        attempts: {
          p1: { n: 1, at: now - 3 * 3600 * 1000 }, // 3h ago
        },
      };
      const list = [{ ...baseProfile, id: "p1" }];
      expect(dueProfiles(list, state, now)).toHaveLength(0);
    });

    it("allows a second attempt if the first attempt was more than 6 hours ago", () => {
      const state = {
        day: today,
        blocked: {},
        attempts: {
          p1: { n: 1, at: now - 7 * 3600 * 1000 }, // 7h ago
        },
      };
      const list = [{ ...baseProfile, id: "p1" }];
      expect(dueProfiles(list, state, now).map((p) => p.id)).toEqual(["p1"]);
    });

    it("resets attempts when day changes", () => {
      const state = {
        day: "2026-10-01", // yesterday
        blocked: {},
        attempts: {
          p1: { n: 2, at: now - 1000 },
        },
      };
      const list = [{ ...baseProfile, id: "p1" }];
      expect(dueProfiles(list, state, now).map((p) => p.id)).toEqual(["p1"]);
    });
  });
});

describe("authoritative Spy upload reconciliation", () => {
  it("drops rejected optimistic saves while keeping later pending saves", () => {
    const cache = { profiles: {
      rejected: { id: "rejected", listUpdatedAt: 100, removedAt: null },
      pending: { id: "pending", listUpdatedAt: 101, removedAt: null },
    } };
    const result = mergeList(cache, [], [{ id: "pending", op: "save", at: 101 }], { settled: new Set(["rejected"]) });
    expect(result.profiles.rejected).toBeUndefined();
    expect(result.profiles.pending).toBeDefined();
  });

  it("accepts a server tombstone after a save was rejected despite a newer local timestamp", () => {
    const cache = { profiles: { p: { id: "p", listUpdatedAt: 200, removedAt: null } } };
    expect(mergeList(cache, [{ id: "p", listUpdatedAt: 100, removedAt: 100 }], [], { settled: new Set(["p"]) }).profiles).toEqual({});
  });

  it("keeps profiles the upload did not touch when the hub does not know them", () => {
    // Measured live: a hub with an empty or restored database wiped the whole
    // local list after an upload that only carried metadata and snapshots.
    const cache = { profiles: { kept: { id: "kept", listUpdatedAt: 100, removedAt: null } } };
    expect(mergeList(cache, [], [], { settled: new Set() }).profiles.kept).toBeDefined();
  });
});

describe("reels, reading-state and readings queue", () => {
  it("keeps each reel once per profile and the newest reading state", () => {
    let q = emptySpyQueue();
    q = queueReels(q, "facebook:1", [{ id: "100001", createdAt: 1, views: 5 }, { id: "100002", createdAt: 2 }]);
    q = queueReels(q, "facebook:1", [{ id: "100001", createdAt: 1, views: 9 }]);
    expect(Object.keys(q.reels)).toEqual(["facebook:1|100001", "facebook:1|100002"]);
    expect(q.reels["facebook:1|100001"]).toEqual({ profileId: "facebook:1", id: "100001", createdAt: 1, duration: null, views: 9 });
    q = queueReelsStatus(q, "facebook:1", "running", 10);
    q = queueReelsStatus(q, "facebook:1", "done", 20);
    expect(q.reelsStatus["facebook:1"]).toEqual({ profileId: "facebook:1", status: "done", at: 20 });
  });

  it("keeps the newest 400 readings", () => {
    let q = emptySpyQueue();
    for (let i = 0; i < 405; i++) q = queueReading(q, { profileId: "facebook:1", at: i, kind: "followers", source: "daily", ok: true });
    const ats = Object.values(q.readings).map((r) => r.at);
    expect(ats).toHaveLength(400);
    expect(Math.min(...ats)).toBe(5);
  });
});

describe("igLimit", () => {
  it("reads the daily Instagram reading cap from the prefs, 20 by default, between 1 and 60", () => {
    expect(igLimit(undefined)).toBe(20);
    expect(igLimit({ daily: true })).toBe(20);
    expect(igLimit({ igLimit: 35 })).toBe(35);
    expect(igLimit({ igLimit: "40" })).toBe(40);
    expect(igLimit({ igLimit: 500 })).toBe(200);
    expect(igLimit({ igLimit: 0 })).toBe(20);
    expect(igLimit({ igLimit: "abc" })).toBe(20);
  });
});

describe("queuePosts", () => {
  it("keeps each Instagram post once per profile with its publication time and drops malformed rows", () => {
    let q = queuePosts(undefined, "instagram:nasa", [
      { id: "3001", createdAt: 1791000000, mediaType: "photo", pinned: false },
      { id: "3002", createdAt: 1791000100, mediaType: "video", pinned: true },
      { id: "x", createdAt: 1791000000 }, { id: "3003", createdAt: "ontem" }, null,
    ]);
    q = queuePosts(q, "instagram:nasa", [{ id: "3001", createdAt: 1791000000, mediaType: "photo", pinned: false }]);
    expect(Object.values(q.posts)).toEqual([
      { profileId: "instagram:nasa", id: "3001", createdAt: 1791000000, mediaType: "photo", pinned: false,
        code: null, views: null, likes: null, comments: null, exactDate: true },
      { profileId: "instagram:nasa", id: "3002", createdAt: 1791000100, mediaType: "video", pinned: true,
        code: null, views: null, likes: null, comments: null, exactDate: true },
    ]);
    expect(Object.keys(q.posts)).toEqual(["instagram:nasa|3001", "instagram:nasa|3002"]);
  });
});

describe("top 3 numbers and thumbnails", () => {
  it("coalesces partial fields for the same queued observation", () => {
    const post = { id: "3001", createdAt: 1791000000, mediaType: "video", observedAt: 1791001000000 };
    let q = queuePosts(undefined, "instagram:nasa", [{ ...post, views: 1000, durationS: 60 }]);
    q = queuePosts(q, "instagram:nasa", [{ ...post, likes: 30, comments: 2 }]);
    expect(Object.values(q.posts)).toEqual([expect.objectContaining({ views: 1000, likes: 30, comments: 2, durationS: 60 })]);
  });
  it("keeps separate timestamped observations while offline, with duration in seconds", () => {
    const post = { id: "3001", createdAt: 1791000000, mediaType: "video", views: 100, durationS: 42.5, observedAt: 1791001000000 };
    let q = queuePosts(undefined, "instagram:nasa", [post]);
    q = queuePosts(q, "instagram:nasa", [{ ...post, views: 200, observedAt: 1791002000000 }]);
    expect(Object.values(q.posts)).toEqual([
      expect.objectContaining({ views: 100, durationS: 42.5, observedAt: 1791001000000 }),
      expect.objectContaining({ views: 200, durationS: 42.5, observedAt: 1791002000000 }),
    ]);
    q = queuePosts(q, "instagram:nasa", [post]);
    expect(Object.values(q.posts)).toHaveLength(2);
  });
  it("queues a post's numbers and link code, never its image address", () => {
    const q = queuePosts(undefined, "instagram:nasa", [{ id: "3001", createdAt: 1791000000, mediaType: "video",
      code: "DeIOdt4jVu6", views: 528, likes: 12, comments: 13, thumbUrl: "https://cdn/t.jpg" }]);
    expect(q.posts["instagram:nasa|3001"]).toEqual({ profileId: "instagram:nasa", id: "3001", createdAt: 1791000000,
      mediaType: "video", pinned: false, code: "DeIOdt4jVu6", views: 528, likes: 12, comments: 13, exactDate: true });
    const fromId = queuePosts(undefined, "instagram:nasa", [{ id: "3002", createdAt: 1791000000, exactDate: false }]);
    expect(fromId.posts["instagram:nasa|3002"].exactDate).toBe(false);
  });

  it("remembers image addresses for a few days and picks the ones the hub asks for", () => {
    const now = 1_791_000_000_000;
    let cache = rememberThumbUrls({}, "instagram:nasa", [{ id: "3001", thumbUrl: "https://cdn/a.jpg" },
      { id: "3002", thumbUrl: "https://cdn/b.jpg" }, { id: "3003" }], now);
    cache = rememberThumbUrls(cache, "facebook:x", [{ id: "900101", thumbUrl: "https://fb/c.jpg" }], now - 4 * 86400000);
    const jobs = thumbsToFetch(cache, [
      { id: "instagram:nasa", wantThumbs: ["3002", "3009"] }, { id: "facebook:x", wantThumbs: ["900101"] }, { id: "instagram:y" },
    ], now);
    expect(jobs).toEqual([{ profileId: "instagram:nasa", id: "3002", url: "https://cdn/b.jpg" }]); // the Facebook one is stale
  });

  it("caps the address cache", () => {
    const items = Array.from({ length: 700 }, (_, i) => ({ id: String(1000 + i), thumbUrl: `https://cdn/${i}` }));
    expect(Object.keys(rememberThumbUrls({}, "instagram:nasa", items, 1)).length).toBe(500);
  });

  it("queues a thumbnail per post", () => {
    const q = queueThumb(undefined, "instagram:nasa", "3001", "data:image/webp;base64,AAAA");
    expect(q.thumbs).toEqual({ "instagram:nasa|3001": { profileId: "instagram:nasa", id: "3001", thumb: "data:image/webp;base64,AAAA" } });
  });
});

describe("mergeList and the stories fields", () => {
  it("keeps trackStories, userId and storyPks from the hub's list", () => {
    const cache = { profiles: { "instagram:nasa": { id: "instagram:nasa", platform: "instagram", key: "nasa", removedAt: null, listUpdatedAt: 1 } } };
    const server = [{ id: "instagram:nasa", platform: "instagram", key: "nasa", removedAt: null, listUpdatedAt: 2, trackStories: true, userId: "528817151", storyPks: ["1", "2"] }];
    const merged = mergeList(cache, server);
    expect(merged.profiles["instagram:nasa"]).toMatchObject({ trackStories: true, userId: "528817151", storyPks: ["1", "2"] });
  });
});
