import { describe, it, expect } from "vitest";
import { parseCount, sortComparator, sortRecords, recordToCard, filenameFor } from "./fbReels.js";

describe("parseCount", () => {
  it("parses pt-br 'mil' (thousand)", () => {
    expect(parseCount("14 mil")).toBe(14000);
    expect(parseCount("100 mil")).toBe(100000);
    expect(parseCount("213 mil")).toBe(213000);
  });
  it("parses pt-br decimal comma with a unit", () => {
    expect(parseCount("1,5 mil")).toBe(1500);
    expect(parseCount("2,3 mi")).toBe(2300000);
  });
  it("parses english K/M/B suffixes", () => {
    expect(parseCount("1.2M")).toBe(1200000);
    expect(parseCount("14K")).toBe(14000);
    expect(parseCount("3B")).toBe(3000000000);
    expect(parseCount("1.5k")).toBe(1500);
  });
  it("parses plain integers, stripping thousands separators", () => {
    expect(parseCount("543")).toBe(543);
    expect(parseCount("1.234")).toBe(1234); // pt-br thousands dot
    expect(parseCount("1,234")).toBe(1234); // en thousands comma
  });
  it("returns null on junk / unknown units / empty", () => {
    expect(parseCount("")).toBeNull();
    expect(parseCount(null)).toBeNull();
    expect(parseCount("Prévia do reel")).toBeNull();
    expect(parseCount("12 xyz")).toBeNull();
  });
});

const rec = (o) => ({ id: "r", thumb: "t", views: null, comments: null, shares: null, taken_at: null, ...o });

describe("sortComparator", () => {
  it("sorts by views desc, nulls last", () => {
    const list = [rec({ id: "a", views: 100 }), rec({ id: "b", views: null }), rec({ id: "c", views: 900 })];
    const out = [...list].sort(sortComparator("views", "desc")).map((r) => r.id);
    expect(out).toEqual(["c", "a", "b"]);
  });
  it("sorts by views asc, nulls still last", () => {
    const list = [rec({ id: "a", views: 100 }), rec({ id: "b", views: null }), rec({ id: "c", views: 900 })];
    const out = [...list].sort(sortComparator("views", "asc")).map((r) => r.id);
    expect(out).toEqual(["a", "c", "b"]);
  });
  it("sorts by comments and shares", () => {
    const list = [rec({ id: "a", comments: 5, shares: 1 }), rec({ id: "b", comments: 50, shares: 0 })];
    expect([...list].sort(sortComparator("comments", "desc"))[0].id).toBe("b");
    expect([...list].sort(sortComparator("shares", "desc"))[0].id).toBe("a");
  });
});

describe("sortRecords", () => {
  it("default preserves capture order", () => {
    const list = [rec({ id: "a", views: 1 }), rec({ id: "b", views: 9 })];
    expect(sortRecords(list, "default").map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("recordToCard", () => {
  it("builds a permalink and formats the date", () => {
    const c = recordToCard(rec({ id: "123", taken_at: 1700000000 }));
    expect(c.permalink).toBe("https://www.facebook.com/reel/123");
    expect(c.date).toBe("2023-11-14");
  });
});

describe("filenameFor", () => {
  it("sanitizes the owner and includes the id", () => {
    expect(filenameFor("Primordial Witch", "123")).toBe("fb-Primordial Witch-123.jpg");
    expect(filenameFor("bad/name:*", "1")).toBe("fb-bad_name-1.jpg");
  });
});
