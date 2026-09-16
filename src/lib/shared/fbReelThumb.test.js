import { describe, it, expect } from "vitest";
import { fullResThumb, isReelsGridUrl, reelIdFromHref } from "./fbReelThumb.js";

// The real tile src, captured live on 2026-09-06 from
// facebook.com/profile.php?id=61592820645925&sk=owner_reels. Serves 540x960 as-is,
// 1080x1920 once `ctp` is gone.
const TILE =
  "https://scontent.fumu2-1.fna.fbcdn.net/v/t15.5256-10/791436480_2517459655388809_8963927853655664327_n.jpg" +
  "?stp=dst-jpg_tt6&cstp=mx1080x1920&ctp=s960x960&_nc_cat=107&ccb=1-7&_nc_sid=5fad0e" +
  "&_nc_ohc=gfhVDgiuH00Q7kNvwEIkkE5&_nc_zt=23&_nc_ht=scontent.fumu2-1.fna" +
  "&oh=00_AQIBVjFwPkrRNnrO5zo8IQuJ0Cr4jkfBbjXXKi4q95kyDQ&oe=6AA3406C";

describe("fullResThumb", () => {
  it("drops ctp and nothing else", () => {
    const out = fullResThumb(TILE);
    expect(out).not.toMatch(/ctp=/);
    expect(out).toContain("stp=dst-jpg_tt6");
    expect(out).toContain("cstp=mx1080x1920");
    expect(out).toContain("oh=00_AQIBVjFwPkrRNnrO5zo8IQuJ0Cr4jkfBbjXXKi4q95kyDQ");
    expect(out).toBe(TILE.replace("&ctp=s960x960", ""));
  });

  it("leaves the signed parameters byte-identical", () => {
    // A URLSearchParams round-trip would re-encode values and cost us a 403, so
    // every surviving pair must come back exactly as it went in.
    const pairs = (u) => u.slice(u.indexOf("?") + 1).split("&");
    const before = pairs(TILE).filter((p) => !p.startsWith("ctp="));
    expect(pairs(fullResThumb(TILE))).toEqual(before);
  });

  it("handles a query that is only ctp", () => {
    expect(fullResThumb("https://x.fbcdn.net/a.jpg?ctp=s960x960")).toBe(
      "https://x.fbcdn.net/a.jpg",
    );
  });

  it("passes through what it cannot improve", () => {
    expect(fullResThumb("https://x.fbcdn.net/a.jpg")).toBe("https://x.fbcdn.net/a.jpg");
    expect(fullResThumb("https://x.fbcdn.net/a.jpg?stp=dst-jpg")).toBe(
      "https://x.fbcdn.net/a.jpg?stp=dst-jpg",
    );
    expect(fullResThumb("")).toBe("");
    expect(fullResThumb(null)).toBe(null);
    expect(fullResThumb(undefined)).toBe(undefined);
  });

  it("does not match a parameter that merely ends in ctp", () => {
    const u = "https://x.fbcdn.net/a.jpg?cstp=mx1080x1920&ctp=s960x960";
    expect(fullResThumb(u)).toBe("https://x.fbcdn.net/a.jpg?cstp=mx1080x1920");
  });
});

describe("isReelsGridUrl", () => {
  it("accepts every shape of the profile reels grid", () => {
    expect(
      isReelsGridUrl("https://www.facebook.com/profile.php?id=61592820645925&sk=owner_reels"),
    ).toBe(true);
    expect(
      isReelsGridUrl("https://www.facebook.com/profile.php?id=61592820645925&sk=reels_tab"),
    ).toBe(true);
    expect(isReelsGridUrl("https://www.facebook.com/9gag/reels/")).toBe(true);
    expect(isReelsGridUrl("https://www.facebook.com/9gag/reels")).toBe(true);
    expect(isReelsGridUrl("https://www.facebook.com/9gag/reels_tab")).toBe(true);
  });

  it("rejects the player and the other tabs", () => {
    expect(isReelsGridUrl("https://www.facebook.com/reel/1076861848144759/")).toBe(false);
    expect(isReelsGridUrl("https://www.facebook.com/reel/?s=tab")).toBe(false);
    expect(
      isReelsGridUrl("https://www.facebook.com/profile.php?id=61592820645925&sk=photos"),
    ).toBe(false);
    expect(isReelsGridUrl("https://www.facebook.com/9gag/videos")).toBe(false);
    expect(isReelsGridUrl("https://www.facebook.com/")).toBe(false);
    expect(isReelsGridUrl("")).toBe(false);
    expect(isReelsGridUrl(null)).toBe(false);
  });

  it("does not confuse a longer sk value for the reels one", () => {
    expect(
      isReelsGridUrl("https://www.facebook.com/profile.php?id=1&sk=owner_reels_archive"),
    ).toBe(false);
  });
});

describe("reelIdFromHref", () => {
  it("reads the id out of a tile href", () => {
    expect(reelIdFromHref("/reel/1076861848144759/?s=fb_shorts_profile&stack_idx=0")).toBe(
      "1076861848144759",
    );
    expect(reelIdFromHref("https://www.facebook.com/reel/2159824528273025")).toBe(
      "2159824528273025",
    );
  });

  it("returns null when there is no id", () => {
    expect(reelIdFromHref("/reel/?s=tab")).toBe(null);
    expect(reelIdFromHref("")).toBe(null);
    expect(reelIdFromHref(null)).toBe(null);
  });
});
