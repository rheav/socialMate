import { describe, it, expect } from "vitest";
import { DATE_RANGES, withinDateRange, scrollGapMs } from "./harvest.js";

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

  // TikTok stamps createTime in the same unit, which is why this lives in a
  // platform-neutral module now rather than inside igFilters.
  it("reads a TikTok createTime with no conversion", () => {
    expect(withinDateRange(daysAgo(2), "7d", NOW)).toBe(true);
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
