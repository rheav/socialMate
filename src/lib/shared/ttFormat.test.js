import { describe, it, expect } from "vitest";
import {
  TT_ER_WEIGHTS,
  normalizeTtErWeights,
  ttEngagementRate,
  ttViewsPerFollower,
  fmtRatio,
  ttPermalink,
  ttErLabel,
  REACH_TIERS,
  reachTier,
  recordReachTier,
} from "./ttFormat.js";

const REC = {
  id: "7650586406246436127",
  username: "veloria691",
  play_count: 84600,
  digg_count: 14300,
  comment_count: 1032,
  share_count: 3614,
  collect_count: 4210,
  user_follower_count: 31400,
};

describe("ttEngagementRate", () => {
  it("weights comments and shares 4×, saves 2×, likes 1×", () => {
    const eng = 14300 + 4 * 1032 + 4 * 3614 + 2 * 4210;
    expect(ttEngagementRate(REC)).toBeCloseTo((eng / 84600) * 100, 6);
  });

  it("takes custom weights so the panel and the page agree", () => {
    expect(ttEngagementRate(REC, { like: 1, comment: 0, share: 0, save: 0 })).toBeCloseTo((14300 / 84600) * 100, 6);
  });

  it("is null without plays — an unknown rate is not a zero rate", () => {
    expect(ttEngagementRate({ ...REC, play_count: null })).toBe(null);
    expect(ttEngagementRate({ ...REC, play_count: 0 })).toBe(null);
    expect(ttEngagementRate(null)).toBe(null);
  });

  it("treats a missing count as zero rather than throwing the rate away", () => {
    expect(ttEngagementRate({ play_count: 100, digg_count: 10 })).toBeCloseTo(10, 6);
  });
});

describe("normalizeTtErWeights", () => {
  it("defaults, and keeps a valid field when its neighbour is junk", () => {
    expect(normalizeTtErWeights(null)).toEqual(TT_ER_WEIGHTS);
    expect(normalizeTtErWeights({ like: "x", comment: 9, share: -1, save: 0 })).toEqual({
      like: 1, comment: 9, share: 4, save: 0,
    });
  });
});

describe("ttViewsPerFollower", () => {
  it("says how far past its own audience a video travelled", () => {
    expect(ttViewsPerFollower(REC)).toBeCloseTo(84600 / 31400, 6);
  });

  it("is null when either half is missing", () => {
    expect(ttViewsPerFollower({ ...REC, user_follower_count: null })).toBe(null);
    expect(ttViewsPerFollower({ ...REC, user_follower_count: 0 })).toBe(null);
    expect(ttViewsPerFollower({ ...REC, play_count: null })).toBe(null);
  });
});

describe("fmtRatio", () => {
  it("keeps a decimal only where it means something", () => {
    expect(fmtRatio(2.694)).toBe("2.7×");
    expect(fmtRatio(112.4)).toBe("112×");
    expect(fmtRatio(null)).toBe(null);
  });
});

describe("ttPermalink", () => {
  it("builds the canonical video URL", () => {
    expect(ttPermalink(REC)).toBe("https://www.tiktok.com/@veloria691/video/7650586406246436127");
  });

  it("returns null rather than a broken link when the author is unknown", () => {
    expect(ttPermalink({ id: "1" })).toBe(null);
    expect(ttPermalink({ username: "a" })).toBe(null);
  });
});

describe("ttErLabel", () => {
  it("is the string both the overlay and the panel print", () => {
    expect(ttErLabel(REC)).toBe("48.8%");
    expect(ttErLabel({ play_count: null })).toBe(null);
  });
});

describe("reachTier", () => {
  // The ladder is a reading aid: 1x is the only exact boundary (the video
  // reached exactly its own follower count, so it never left the base).
  it("grades a video by how far past its own audience it went", () => {
    expect(reachTier(0.4).key).toBe("inside");
    expect(reachTier(1).key).toBe("baseline");
    expect(reachTier(2.7).key).toBe("baseline");
    expect(reachTier(3).key).toBe("working");
    expect(reachTier(9.9).key).toBe("working");
    expect(reachTier(10).key).toBe("strong");
    expect(reachTier(49).key).toBe("strong");
    expect(reachTier(50).key).toBe("breakout");
    expect(reachTier(352).key).toBe("breakout");
  });

  it("has no opinion when the figure is unknown", () => {
    expect(reachTier(null)).toBe(null);
    expect(reachTier(undefined)).toBe(null);
    expect(reachTier(NaN)).toBe(null);
  });

  it("gives every tier a colour and a plain-language label", () => {
    for (const t of REACH_TIERS) {
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.label.length).toBeGreaterThan(3);
    }
    // No red: there is no failure state here, and red would read as an error.
    expect(REACH_TIERS.map((t) => t.color)).not.toContain("#ef4444");
  });

  it("goes straight from a record to its tier", () => {
    expect(recordReachTier(REC).key).toBe("baseline"); // 84.6k / 31.4k = 2.7x
    expect(recordReachTier({ play_count: 1200000, user_follower_count: 3400 }).key).toBe("breakout");
  });
});
