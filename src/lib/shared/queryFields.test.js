import { describe, it, expect } from "vitest";
import { IG_QUERY_FIELDS } from "./igQuery.js";
import { TT_QUERY_FIELDS } from "./ttQuery.js";
import { applyQuery, emptyQuery, isSortableField } from "./feedQuery.js";

describe("IG_QUERY_FIELDS", () => {
  const rec = { play_count: 1000, like_count: 50, comment_count: 10, repost: 5, user_follower_count: 200, taken_at: 9, media_type: "video" };

  it("reads the IG record's own field names", () => {
    expect(IG_QUERY_FIELDS.views.get(rec)).toBe(1000);
    expect(IG_QUERY_FIELDS.date.get(rec)).toBe(9);
    expect(IG_QUERY_FIELDS.type.get(rec)).toBe("video");
  });

  it("derives the per-view rates and reach", () => {
    expect(IG_QUERY_FIELDS.likeRate.get(rec)).toBe(5);
    expect(IG_QUERY_FIELDS.commentRate.get(rec)).toBe(1);
    expect(IG_QUERY_FIELDS.repostRate.get(rec)).toBe(0.5);
    expect(IG_QUERY_FIELDS.vpf.get(rec)).toBe(5);
  });

  it("leaves a rate null without views instead of dividing by zero", () => {
    expect(IG_QUERY_FIELDS.likeRate.get({ like_count: 5 })).toBe(null);
    expect(IG_QUERY_FIELDS.vpf.get({ play_count: 5 })).toBe(null);
  });

  it("uses the ER weights from the context", () => {
    const heavy = IG_QUERY_FIELDS.er.get(rec, { weights: { like: 0, comment: 10, repost: 0 } });
    expect(heavy).toBe(10);
  });
});

describe("TT_QUERY_FIELDS", () => {
  const rec = { play_count: 2000, digg_count: 100, comment_count: 20, share_count: 10, collect_count: 40, user_follower_count: 1000, create_time: 3, desc: "tarot", hashtags: ["tarot"] };

  it("derives every per-view rate TikTok's counts allow", () => {
    expect(TT_QUERY_FIELDS.likeRate.get(rec)).toBe(5);
    expect(TT_QUERY_FIELDS.commentRate.get(rec)).toBe(1);
    expect(TT_QUERY_FIELDS.shareRate.get(rec)).toBe(0.5);
    expect(TT_QUERY_FIELDS.saveRate.get(rec)).toBe(2);
    expect(TT_QUERY_FIELDS.vpf.get(rec)).toBe(2);
  });

  it("filters on hashtags through the engine", () => {
    const q = { ...emptyQuery(), filters: [{ field: "hashtags", op: "contains", value: "TAROT" }] };
    expect(applyQuery([rec, { ...rec, hashtags: [] }], q, TT_QUERY_FIELDS)).toHaveLength(1);
  });
});

describe("which fields a sort can use", () => {
  it("leaves followers and duration out of the sort lists on both networks", () => {
    for (const F of [IG_QUERY_FIELDS, TT_QUERY_FIELDS]) {
      expect(isSortableField(F.followers)).toBe(false);
      expect(isSortableField(F.duration)).toBe(false);
      expect(isSortableField(F.views)).toBe(true);
      expect(isSortableField(F.vpf)).toBe(true);
      expect(isSortableField(F.date)).toBe(true);
    }
  });

  it("still lets a filter rule use them", () => {
    const q = { ...emptyQuery(), filters: [{ field: "followers", op: "gte", value: 1000 }] };
    const recs = [{ user_follower_count: 500 }, { user_follower_count: 5000 }];
    expect(applyQuery(recs, q, IG_QUERY_FIELDS)).toHaveLength(1);
  });

  it("never offers text or enum fields as a sort", () => {
    expect(isSortableField(IG_QUERY_FIELDS.caption)).toBe(false);
    expect(isSortableField(IG_QUERY_FIELDS.type)).toBe(false);
  });
});

describe("velocity (views per day)", () => {
  it("exists on both networks as a sortable number, read from each record's own date field", () => {
    const now = Math.floor(Date.now() / 1000);
    const ig = { play_count: 3000, taken_at: now - 3 * 86400 };
    const tt = { play_count: 3000, create_time: now - 3 * 86400 };
    expect(IG_QUERY_FIELDS.velocity.get(ig)).toBeCloseTo(1000, 0);
    expect(TT_QUERY_FIELDS.velocity.get(tt)).toBeCloseTo(1000, 0);
    expect(isSortableField(IG_QUERY_FIELDS.velocity)).toBe(true);
    expect(isSortableField(TT_QUERY_FIELDS.velocity)).toBe(true);
  });

  it("is missing (sorts last) for a photo with no views", () => {
    expect(IG_QUERY_FIELDS.velocity.get({ taken_at: 1, like_count: 5 })).toBe(null);
  });
});
