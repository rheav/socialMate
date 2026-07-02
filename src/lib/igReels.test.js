import { describe, it, expect } from "vitest";
import {
  reelLabel, reelOwner, reelLatest, storyDate, storyToCard, storyFilename, groupReels,
} from "./igReels.js";

const vid = { pk: "1", media_type: "video", video: "v.mp4", thumb: "t.jpg", taken_at: 1782027155, duration: 12, owner_username: "solomonaldric" };
const photo = { pk: "2", media_type: "photo", image: "p.jpg", taken_at: 1782000000, owner_username: "solomonaldric" };
const carousel = { pk: "3", media_type: "carousel", carousel: [{ media_type: "photo", image: "a.jpg" }], owner_username: "ivy" };

describe("reelLabel", () => {
  it("uses the highlight title", () => {
    expect(reelLabel({ title: "Reviews" })).toBe("Reviews");
  });
  it("falls back to Stories for live reels (no title)", () => {
    expect(reelLabel({ title: null, reel_type: "user_reel" })).toBe("Stories");
    expect(reelLabel({})).toBe("Stories");
  });
});

describe("reelOwner", () => {
  it("reads owner from meta object or flat field", () => {
    expect(reelOwner({ owner: { username: "a" } })).toBe("a");
    expect(reelOwner({ owner_username: "b" })).toBe("b");
    expect(reelOwner({})).toBe("unknown");
  });
});

describe("reelLatest", () => {
  it("returns the max item taken_at", () => {
    expect(reelLatest({ items: [{ taken_at: 5 }, { taken_at: 9 }, { taken_at: 2 }] })).toBe(9);
    expect(reelLatest({ items: [] })).toBe(0);
    expect(reelLatest({})).toBe(0);
  });
});

describe("storyDate", () => {
  it("formats to YYYY-MM-DD HH:MM (UTC)", () => {
    expect(storyDate({ taken_at: 1704067200 })).toBe("2024-01-01 00:00");
    expect(storyDate({})).toBe("");
    expect(storyDate({ taken_at: 0 })).toBe("");
  });
});

describe("storyToCard", () => {
  it("maps a video story", () => {
    expect(storyToCard(vid)).toMatchObject({ id: "1", type: "video", hasVideo: true, isCarousel: false, duration: 12 });
  });
  it("maps a photo story (no video)", () => {
    const c = storyToCard(photo);
    expect(c).toMatchObject({ id: "2", type: "photo", hasVideo: false, isCarousel: false });
    expect(c.thumb).toBe("p.jpg");
  });
  it("flags carousels", () => {
    expect(storyToCard(carousel).isCarousel).toBe(true);
  });
  it("infers type from a video url when media_type missing", () => {
    expect(storyToCard({ pk: "9", video: "x.mp4" }).type).toBe("video");
  });
});

describe("storyFilename", () => {
  it("builds base and indexed names", () => {
    expect(storyFilename(vid, "mp4")).toBe("ig-story-solomonaldric-1.mp4");
    expect(storyFilename(carousel, "jpg", 2)).toBe("ig-story-ivy-3_2.jpg");
  });
  it("sanitizes the owner and falls back to unknown", () => {
    expect(storyFilename({ pk: "7", owner_username: "a/b:c" }, "jpg")).toBe("ig-story-a_b_c-7.jpg");
    expect(storyFilename({ pk: "7" }, "jpg")).toBe("ig-story-unknown-7.jpg");
  });
});

describe("groupReels", () => {
  const reels = [
    { title: "Reviews", owner: { username: "solomonaldric" }, items: [{ taken_at: 100 }] },
    { title: null, owner_username: "solomonaldric", items: [{ taken_at: 200 }] }, // newer → first
    { title: "Tips", owner: { username: "ivy" }, items: [{ taken_at: 50 }] },
  ];
  it("groups by owner (A→Z) with each owner's reels newest first", () => {
    const g = groupReels(reels);
    expect(g.map((x) => x.owner)).toEqual(["ivy", "solomonaldric"]);
    const sol = g.find((x) => x.owner === "solomonaldric");
    expect(sol.reels.map((r) => reelLabel(r))).toEqual(["Stories", "Reviews"]); // 200 before 100
  });
  it("handles empty input", () => {
    expect(groupReels([])).toEqual([]);
    expect(groupReels(null)).toEqual([]);
  });
});
