import { describe, it, expect } from "vitest";
import {
  emptyNav,
  normalizeNav,
  migrateNav,
  toolIdFor,
  withPlatform,
  withToolId,
  withTab,
} from "./navState.js";

describe("emptyNav / normalizeNav", () => {
  it("defaults to the Warmer tab at Home", () => {
    expect(emptyNav()).toEqual({ tab: "warm", platform: null, perPlatform: {} });
  });
  it("coerces junk to defaults", () => {
    expect(normalizeNav(null)).toEqual(emptyNav());
    expect(normalizeNav("nope")).toEqual(emptyNav());
    expect(normalizeNav({ tab: "bogus", platform: "myspace" })).toEqual(emptyNav());
  });
  it("drops unknown platforms and malformed entries from perPlatform", () => {
    const out = normalizeNav({
      tab: "library",
      platform: "tiktok",
      perPlatform: {
        tiktok: { toolId: "tt-sort" },
        myspace: { toolId: "x" },
        instagram: { toolId: 42 },
        facebook: "nope",
      },
    });
    expect(out.tab).toBe("library");
    expect(out.platform).toBe("tiktok");
    expect(out.perPlatform).toEqual({ tiktok: { toolId: "tt-sort" } });
  });
});

describe("migrateNav", () => {
  it("prefers an existing v3 value", () => {
    const v3 = { tab: "warm", platform: "instagram", perPlatform: { instagram: { toolId: "ig-stories" } } };
    expect(migrateNav(v3, { platform: "tiktok", toolId: "tt-sort" })).toEqual(v3);
  });
  it("seeds per-platform memory from the legacy flat v2 value", () => {
    const out = migrateNav(null, { tab: "warm", platform: "tiktok", toolId: "tt-comments" });
    expect(out.platform).toBe("tiktok");
    expect(out.perPlatform).toEqual({ tiktok: { toolId: "tt-comments" } });
  });
  it("carries the legacy top-level tab", () => {
    expect(migrateNav(null, { tab: "library" }).tab).toBe("library");
  });
  it("falls back to empty when both are absent/garbage", () => {
    expect(migrateNav(null, null)).toEqual(emptyNav());
    expect(migrateNav(undefined, { platform: "myspace", toolId: "x" })).toEqual(emptyNav());
  });
});

describe("withPlatform", () => {
  it("switches platform", () => {
    expect(withPlatform(emptyNav(), "tiktok").platform).toBe("tiktok");
  });
  it("returns the SAME reference when unchanged (no re-render)", () => {
    const nav = withPlatform(emptyNav(), "tiktok");
    expect(withPlatform(nav, "tiktok")).toBe(nav);
  });
  it("treats an unknown platform as Home", () => {
    const nav = withPlatform(emptyNav(), "tiktok");
    expect(withPlatform(nav, "myspace").platform).toBeNull();
  });
  it("null → Home is a no-op when already Home", () => {
    const nav = emptyNav();
    expect(withPlatform(nav, null)).toBe(nav);
  });
});

describe("withToolId / toolIdFor", () => {
  it("remembers a tool per platform independently", () => {
    let nav = emptyNav();
    nav = withToolId(nav, "instagram", "ig-stories");
    nav = withToolId(nav, "tiktok", "tt-comments");
    expect(toolIdFor(nav, "instagram")).toBe("ig-stories");
    expect(toolIdFor(nav, "tiktok")).toBe("tt-comments");
    expect(toolIdFor(nav, "facebook")).toBeNull();
  });
  it("survives switching platform back and forth", () => {
    let nav = emptyNav();
    nav = withToolId(nav, "tiktok", "tt-stories");
    nav = withPlatform(nav, "instagram");
    nav = withToolId(nav, "instagram", "ig-sort");
    nav = withPlatform(nav, "tiktok");
    expect(nav.platform).toBe("tiktok");
    expect(toolIdFor(nav, "tiktok")).toBe("tt-stories"); // resumed
    expect(toolIdFor(nav, "instagram")).toBe("ig-sort"); // untouched
  });
  it("returns the SAME reference when unchanged", () => {
    const nav = withToolId(emptyNav(), "tiktok", "tt-sort");
    expect(withToolId(nav, "tiktok", "tt-sort")).toBe(nav);
  });
  it("ignores bad input", () => {
    const nav = emptyNav();
    expect(withToolId(nav, "myspace", "x")).toBe(nav);
    expect(withToolId(nav, "tiktok", null)).toBe(nav);
    expect(withToolId(nav, null, "tt-sort")).toBe(nav);
  });
  it("toolIdFor is null-safe", () => {
    expect(toolIdFor(null, "tiktok")).toBeNull();
    expect(toolIdFor(emptyNav(), null)).toBeNull();
  });
});

describe("withTab", () => {
  it("switches tab and no-ops when unchanged", () => {
    const nav = emptyNav();
    const lib = withTab(nav, "library");
    expect(lib.tab).toBe("library");
    expect(withTab(lib, "library")).toBe(lib);
    expect(withTab(nav, "bogus")).toBe(nav);
  });
  it("does not disturb platform or per-platform memory", () => {
    let nav = withToolId(withPlatform(emptyNav(), "tiktok"), "tiktok", "tt-sort");
    nav = withTab(nav, "library");
    expect(nav.platform).toBe("tiktok");
    expect(toolIdFor(nav, "tiktok")).toBe("tt-sort");
  });
});
