import { describe, it, expect } from "vitest";
import {
  engagementRate,
  fmtER,
  fmtCount,
  parseCount,
  sortComparator,
  sortRecords,
  recordToCard,
  filenameFor,
  extFromUrl,
  filterBySurface,
} from "./ttMedia.js";

const rec = (o = {}) => ({
  id: "1",
  username: "creator",
  play_count: 1000,
  digg_count: 100,
  comment_count: 10,
  share_count: 5,
  collect_count: 20,
  create_time: 1782319549,
  video: "https://cdn/x.mp4",
  cover: "https://cdn/x.jpg",
  ...o,
});

describe("engagementRate", () => {
  it("weights like1 comment4 share4 save2 over plays", () => {
    // (100*1 + 10*4 + 5*4 + 20*2) / 1000 * 100 = (100+40+20+40)/1000*100 = 20
    expect(engagementRate(rec())).toBeCloseTo(20, 5);
  });
  it("null when no plays", () => {
    expect(engagementRate(rec({ play_count: 0 }))).toBeNull();
    expect(engagementRate(rec({ play_count: null }))).toBeNull();
  });
  it("treats missing engagement fields as 0", () => {
    expect(engagementRate({ play_count: 100, digg_count: 10 })).toBeCloseTo(10, 5);
  });
});

describe("fmtER", () => {
  it("never collapses to 0.0%", () => {
    expect(fmtER(0)).toBe("0%");
    expect(fmtER(12.34)).toBe("12.3%");
    expect(fmtER(1.234)).toBe("1.23%");
    expect(fmtER(0.0123)).toBe("0.012%");
    expect(fmtER(null)).toBeNull();
  });
});

describe("fmtCount", () => {
  it("compacts", () => {
    expect(fmtCount(null)).toBe("—");
    expect(fmtCount(222)).toBe("222");
    expect(fmtCount(964490)).toBe("964.5K");
    expect(fmtCount(1200000)).toBe("1.2M");
    expect(fmtCount(51900000)).toBe("51.9M");
    expect(fmtCount(1000)).toBe("1K");
  });
});

describe("parseCount", () => {
  it("parses abbreviations and locales", () => {
    expect(parseCount("222")).toBe(222);
    expect(parseCount("51.9M")).toBe(51900000);
    expect(parseCount("964.5K")).toBe(964500);
    expect(parseCount("1,2 mil")).toBe(1200);
    expect(parseCount("1.2M")).toBe(1200000);
    expect(parseCount(51900000)).toBe(51900000);
    expect(parseCount("")).toBeNull();
    expect(parseCount("abc")).toBeNull();
  });
  it("handles mixed thousands+decimal", () => {
    expect(parseCount("1.234,5")).toBe(1235);
  });
});

describe("sortComparator / sortRecords", () => {
  const a = rec({ id: "a", play_count: 100, digg_count: 50, create_time: 200 });
  const b = rec({ id: "b", play_count: 300, digg_count: 10, create_time: 100 });
  const c = rec({ id: "c", play_count: null, digg_count: 5, create_time: 300 });

  it("sorts by views desc, nulls last", () => {
    const out = sortRecords([a, b, c], "views", "desc").map((r) => r.id);
    expect(out).toEqual(["b", "a", "c"]);
  });
  it("sorts by views asc, nulls still last", () => {
    const out = sortRecords([a, b, c], "views", "asc").map((r) => r.id);
    expect(out).toEqual(["a", "b", "c"]);
  });
  it("sorts by likes and date", () => {
    expect(sortRecords([a, b], "likes", "desc").map((r) => r.id)).toEqual(["a", "b"]);
    expect(sortRecords([a, b], "date", "desc").map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("default = capture order (stable copy)", () => {
    const input = [b, a, c];
    const out = sortRecords(input, "default");
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(out).not.toBe(input);
  });
  it("comparator handles both-null", () => {
    const cmp = sortComparator("views", "desc");
    expect(cmp({ play_count: null }, { play_count: null })).toBe(0);
  });
});

describe("recordToCard", () => {
  it("maps fields and builds permalink", () => {
    const c = recordToCard(rec());
    expect(c.id).toBe("1");
    expect(c.username).toBe("creator");
    expect(c.views).toBe(1000);
    expect(c.saves).toBe(20);
    expect(c.permalink).toBe("https://www.tiktok.com/@creator/video/1");
    expect(c.date).toBe("2026-06-24");
  });
  it("no permalink without username or id", () => {
    expect(recordToCard(rec({ username: null })).permalink).toBeNull();
  });
});

describe("filenameFor / extFromUrl", () => {
  it("builds sanitized filenames", () => {
    expect(filenameFor(rec({ username: "a/b:c" }), "mp4")).toBe("tt-a_b_c-1.mp4");
    expect(filenameFor(rec(), "jpg", 2)).toBe("tt-creator-1_2.jpg");
  });
  it("derives extension", () => {
    expect(extFromUrl("https://x/y.mp4?a=1", "video")).toBe("mp4");
    expect(extFromUrl("https://x/y.jpeg", "image")).toBe("jpg");
    expect(extFromUrl("https://x/nodot", "video")).toBe("mp4");
    expect(extFromUrl("https://x/nodot", "image")).toBe("jpg");
  });
});

describe("filterBySurface", () => {
  const p = (o) => ({ id: o.id, username: o.username, surface: o.surface });
  it("scopes to profile owner, keeps null-username records", () => {
    const recs = [
      p({ id: "1", username: "creator", surface: "profile:creator" }),
      p({ id: "2", username: "other", surface: "profile:creator" }),
      p({ id: "3", username: null, surface: "profile:creator" }),
      p({ id: "4", username: "creator", surface: "feed" }),
    ];
    const out = filterBySurface(recs, "profile:creator").map((r) => r.id);
    expect(out).toEqual(["1", "3"]);
  });
  it("multi-author surfaces pass on surface match", () => {
    const recs = [
      p({ id: "1", username: "a", surface: "tag:tarot" }),
      p({ id: "2", username: "b", surface: "tag:tarot" }),
      p({ id: "3", username: "c", surface: "feed" }),
    ];
    expect(filterBySurface(recs, "tag:tarot").map((r) => r.id)).toEqual(["1", "2"]);
  });
  it("no surface → passthrough", () => {
    const recs = [p({ id: "1", surface: "feed" })];
    expect(filterBySurface(recs, null)).toEqual(recs);
  });
});
