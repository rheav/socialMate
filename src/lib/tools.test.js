import { describe, it, expect } from "vitest";
import { filterToolsForPlatform } from "./toolsFilter.js";

const fixture = [
  { id: "warm", platforms: ["facebook", "instagram", "tiktok"] },
  { id: "ig-sort", platforms: ["instagram"] },
  { id: "download", platforms: ["facebook"] },
  { id: "library", platforms: "global" },
];

describe("filterToolsForPlatform", () => {
  it("returns platform tools, excludes global", () => {
    expect(filterToolsForPlatform(fixture, "instagram").map((t) => t.id)).toEqual(["warm", "ig-sort"]);
    expect(filterToolsForPlatform(fixture, "facebook").map((t) => t.id)).toEqual(["warm", "download"]);
    expect(filterToolsForPlatform(fixture, "tiktok").map((t) => t.id)).toEqual(["warm"]);
  });
});
