import { describe, it, expect } from "vitest";
import {
  DATE_RANGES,
  withinDateRange,
  normalizeErWeights,
  ER_WEIGHTS,
  scrollGapMs,
  readReactMediaRef,
} from "./igFilters.js";

const NOW = 1_786_800_000; // seconds

describe("withinDateRange", () => {
  const daysAgo = (d) => NOW - d * 86400;

  it("keeps everything on the default range", () => {
    expect(withinDateRange(daysAgo(4000), "all", NOW)).toBe(true);
  });

  it("keeps a post inside the window and drops one outside it", () => {
    expect(withinDateRange(daysAgo(3), "7d", NOW)).toBe(true);
    expect(withinDateRange(daysAgo(9), "7d", NOW)).toBe(false);
    expect(withinDateRange(daysAgo(60), "90d", NOW)).toBe(true);
    expect(withinDateRange(daysAgo(100), "90d", NOW)).toBe(false);
  });

  it("keeps a post whose date never arrived — filtering it out would hide real posts", () => {
    expect(withinDateRange(null, "7d", NOW)).toBe(true);
  });

  it("ignores a range it doesn't know", () => {
    expect(withinDateRange(daysAgo(4000), "bogus", NOW)).toBe(true);
  });

  it("offers the ranges the panel lists", () => {
    expect(DATE_RANGES.map((r) => r.value)).toContain("30d");
    expect(DATE_RANGES[0].value).toBe("all");
  });
});

describe("normalizeErWeights", () => {
  it("defaults to the shipped weights", () => {
    expect(normalizeErWeights(null)).toEqual(ER_WEIGHTS);
  });

  it("takes the numbers a user set", () => {
    expect(normalizeErWeights({ like: 2, comment: 5, repost: 3 })).toEqual({ like: 2, comment: 5, repost: 3 });
  });

  it("keeps zero — muting a term is a real choice", () => {
    expect(normalizeErWeights({ like: 0, comment: 1, repost: 0 })).toEqual({ like: 0, comment: 1, repost: 0 });
  });

  it("falls back per field for junk, rather than throwing the whole set away", () => {
    expect(normalizeErWeights({ like: "x", comment: 9, repost: -4 })).toEqual({
      like: ER_WEIGHTS.like,
      comment: 9,
      repost: ER_WEIGHTS.repost,
    });
  });
});

describe("scrollGapMs", () => {
  it("slows down the longer it runs, the way a reader tires", () => {
    expect(scrollGapMs(0)).toBeLessThan(scrollGapMs(6));
    expect(scrollGapMs(6)).toBeLessThan(scrollGapMs(12));
  });

  it("never fires faster than a human could flick", () => {
    expect(scrollGapMs(0)).toBeGreaterThanOrEqual(2000);
  });
});

describe("readReactMediaRef", () => {
  // The full-screen /reels/ player wraps no <a> around the video, so the overlay
  // has nothing to read a shortcode from. Instagram's own React props do carry an
  // identifier — which one depends on the surface.
  it("reads a shortcode straight off a post prop", () => {
    expect(readReactMediaRef({ post: { code: "ABC" } })).toEqual({ kind: "code", value: "ABC" });
  });

  it("reads a media id", () => {
    expect(readReactMediaRef({ media$key: { id: "123" } })).toEqual({ kind: "id", value: "123" });
    expect(readReactMediaRef({ mediaId: "456" })).toEqual({ kind: "id", value: "456" });
  });

  it("reads the video player's FB id", () => {
    expect(readReactMediaRef({ coreVideoPlayerMetaData: { videoFBID: "789" } })).toEqual({ kind: "pk", value: "789" });
    expect(readReactMediaRef({ videoFBID: "790" })).toEqual({ kind: "pk", value: "790" });
  });

  it("reads a shortcode out of an href when that is all there is", () => {
    expect(readReactMediaRef({ href: "/reel/XYZ/" })).toEqual({ kind: "code", value: "XYZ" });
    expect(readReactMediaRef({ href: "/p/QRS/?img_index=1" })).toEqual({ kind: "code", value: "QRS" });
  });

  it("says nothing when the props name no media", () => {
    expect(readReactMediaRef({ children: 1 })).toBe(null);
    expect(readReactMediaRef(null)).toBe(null);
  });
});
