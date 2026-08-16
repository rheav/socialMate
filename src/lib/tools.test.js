import { describe, it, expect } from "vitest";
import { filterToolsForPlatform, workspaceToolsForPlatform } from "./toolsFilter.js";

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

// The warmer is a top-level tab now, not one of the platform workspace tools, so
// the workspace list must not offer it — while the registry still carries it (the
// Aquecer tab renders it, and the platform picker still names it).
describe("workspaceToolsForPlatform", () => {
  it("drops the warmer from the platform workspace", () => {
    expect(workspaceToolsForPlatform(fixture, "facebook").map((t) => t.id)).toEqual(["download"]);
    expect(workspaceToolsForPlatform(fixture, "instagram").map((t) => t.id)).toEqual(["ig-sort"]);
  });

  it("can leave a platform with no workspace tools at all", () => {
    // TikTok in this fixture has only the warmer — the workspace is legitimately
    // empty, and the Shell already renders an empty-state for that.
    expect(workspaceToolsForPlatform(fixture, "tiktok")).toEqual([]);
  });

  it("still excludes global tools", () => {
    expect(workspaceToolsForPlatform(fixture, "facebook").some((t) => t.id === "library")).toBe(false);
  });
});
