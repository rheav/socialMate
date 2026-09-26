import { describe, it, expect } from "vitest";
import { viewsPerDay, fmtVelocity } from "./fmt.js";

const DAY = 86400;
const NOW = 1_800_000_000;

describe("viewsPerDay", () => {
  it("is views divided by the days since the post went up", () => {
    expect(viewsPerDay(1_200_000, NOW - 3 * DAY, NOW)).toBe(400_000);
    expect(viewsPerDay(6_000_000, NOW - 730 * DAY, NOW)).toBeCloseTo(8219.18, 1);
  });

  it("counts a post younger than a day as one day, so a 2-hour-old reel is not 12× its views", () => {
    expect(viewsPerDay(5000, NOW - 2 * 3600, NOW)).toBe(5000);
  });

  it("is null without views or without a date — never a made-up zero", () => {
    expect(viewsPerDay(null, NOW - DAY, NOW)).toBe(null);
    expect(viewsPerDay(1000, null, NOW)).toBe(null);
    expect(viewsPerDay(1000, 0, NOW)).toBe(null);
  });

  it("accepts a millisecond timestamp too", () => {
    expect(viewsPerDay(1000, (NOW - 2 * DAY) * 1000, NOW)).toBe(500);
  });
});

describe("fmtVelocity", () => {
  it("prints the rounded rate per day in the rail's count style", () => {
    expect(fmtVelocity(400_000)).toBe("400K/dia");
    expect(fmtVelocity(8219.18)).toBe("8.2K/dia");
    expect(fmtVelocity(12.6)).toBe("13/dia");
    expect(fmtVelocity(null)).toBe(null);
  });
});
