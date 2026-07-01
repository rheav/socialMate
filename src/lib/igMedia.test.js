import { describe, it, expect } from "vitest";
import {
  sortComparator, sortRecords, recordToCard,
  sanitizeFilenamePart, filenameFor, extFromUrl, fmtCount, filterBySurface, engagementRate,
} from "./igMedia.js";

const recs = [
  { code: "A", username: "a", like_count: 10, comment_count: 3, play_count: 100, taken_at: 5, media_type: "video", video: "v" },
  { code: "B", username: "b", like_count: 50, comment_count: 1, play_count: null, taken_at: 9, media_type: "photo", image: "i" },
  { code: "C", username: "c", like_count: 30, comment_count: 9, play_count: 200, taken_at: 1, media_type: "video", video: "v" },
];

describe("sortComparator", () => {
  it("sorts by likes desc", () => {
    expect(sortRecords(recs, "likes", "desc").map(r => r.code)).toEqual(["B", "C", "A"]);
  });
  it("sorts by likes asc", () => {
    expect(sortRecords(recs, "likes", "asc").map(r => r.code)).toEqual(["A", "C", "B"]);
  });
  it("puts null metric last regardless of dir (views)", () => {
    expect(sortRecords(recs, "views", "desc").map(r => r.code)).toEqual(["C", "A", "B"]);
    expect(sortRecords(recs, "views", "asc").map(r => r.code)).toEqual(["A", "C", "B"]);
  });
  it("sorts by date desc", () => {
    expect(sortRecords(recs, "date", "desc").map(r => r.code)).toEqual(["B", "A", "C"]);
  });
  it("sorts by engagement rate, nulls (no views) last", () => {
    // A: (10+3)/100=13% · C: (30+9)/200=19.5% · B: no views → null (last)
    expect(sortRecords(recs, "er", "desc").map(r => r.code)).toEqual(["C", "A", "B"]);
  });
  it("does not mutate input", () => {
    const before = recs.map(r => r.code);
    sortRecords(recs, "likes", "desc");
    expect(recs.map(r => r.code)).toEqual(before);
  });
});

describe("recordToCard", () => {
  it("maps a video record", () => {
    const c = recordToCard(recs[0]);
    expect(c).toMatchObject({ id: "A", username: "a", type: "video", hasVideo: true, likes: 10 });
    expect(c.permalink).toBe("https://www.instagram.com/p/A/");
  });
  it("falls back id to pk and username to unknown", () => {
    expect(recordToCard({ pk: "9", media_type: "photo" })).toMatchObject({ id: "9", username: "unknown", hasVideo: false });
  });
});

describe("filenames", () => {
  it("sanitizes unsafe chars", () => {
    expect(sanitizeFilenamePart('a/b:c*?"<>|d')).toBe("a_b_c_d");
  });
  it("builds base and indexed names", () => {
    expect(filenameFor({ username: "ivy", code: "X1" }, "mp4")).toBe("ig-ivy-X1.mp4");
    expect(filenameFor({ username: "ivy", code: "X1" }, "jpg", 2)).toBe("ig-ivy-X1_2.jpg");
  });
  it("derives extension", () => {
    expect(extFromUrl("https://x/y.mp4?a=1", "video")).toBe("mp4");
    expect(extFromUrl("https://x/y.webp", "image")).toBe("webp");
    expect(extFromUrl("https://x/y", "image")).toBe("jpg");
    expect(extFromUrl("https://x/y", "video")).toBe("mp4");
  });
});

describe("fmtCount", () => {
  it("formats magnitudes", () => {
    expect(fmtCount(3)).toBe("3");
    expect(fmtCount(964490)).toBe("964.5K");
    expect(fmtCount(1200000)).toBe("1.2M");
    expect(fmtCount(2000)).toBe("2K");
    expect(fmtCount(null)).toBe("—");
  });
});

describe("engagementRate", () => {
  it("computes (likes+comments)/views %", () => {
    expect(engagementRate({ play_count: 1000, like_count: 80, comment_count: 20 })).toBeCloseTo(10);
  });
  it("is null without a positive view count", () => {
    expect(engagementRate({ play_count: null, like_count: 5, comment_count: 5 })).toBe(null);
    expect(engagementRate({ play_count: 0, like_count: 5, comment_count: 5 })).toBe(null);
  });
});

describe("filterBySurface", () => {
  const recs = [
    { code: "1", username: "luxury_listings", surface: "profile:luxury_listings" },
    { code: "2", username: "theagencyre", surface: "profile:luxury_listings" }, // named other account → drop
    { code: "3", username: "someone", surface: "tag:tarot" },
    { code: "4", username: null, surface: "profile:luxury_listings" }, // owner reels-tab item (no username) → keep
  ];
  it("keeps owner + null-username posts, drops named other accounts", () => {
    expect(filterBySurface(recs, "profile:luxury_listings").map((r) => r.code)).toEqual(["1", "4"]);
  });
  it("matches owner case-insensitively", () => {
    expect(filterBySurface([{ code: "x", username: "Ivy", surface: "profile:ivy" }], "profile:ivy")).toHaveLength(1);
  });
  it("keeps all authors on a tag surface", () => {
    const tag = [
      { code: "a", username: "x", surface: "tag:tarot" },
      { code: "b", username: "y", surface: "tag:tarot" },
    ];
    expect(filterBySurface(tag, "tag:tarot").map((r) => r.code)).toEqual(["a", "b"]);
  });
  it("returns all records when no surface", () => {
    expect(filterBySurface(recs, null)).toHaveLength(4);
  });
});
