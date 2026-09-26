import { describe, it, expect } from "vitest";
import { IG_QUERY_FIELDS } from "./igQuery.js";
import { TT_QUERY_FIELDS } from "./ttQuery.js";
import { applyQuery, emptyQuery } from "./feedQuery.js";

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
