import { describe, it, expect } from "vitest";
import { sortSavedRecords, savedSortComparator, savedPostTimeMs, SAVED_SORT_OPTS } from "./savedSort.js";

const rec = (id, counts = {}, extra = {}) => ({
  videoId: id,
  platform: "instagram",
  counts: { like: null, comment: null, views: null, share: null, ...counts },
  updatedAt: 1000,
  ...extra,
});

describe("sortSavedRecords", () => {
  const list = [
    rec("A", { like: 10, views: 500, comment: 3 }, { updatedAt: 300 }),
    rec("B", { like: 50, views: 100, comment: 1 }, { updatedAt: 100 }),
    rec("C", { like: 20, views: 900, comment: 2 }, { updatedAt: 200 }),
  ];
  const ids = (l) => l.map((r) => r.videoId);

  it("keeps the store's own order for `default`, in either direction", () => {
    expect(ids(sortSavedRecords(list, "default", "desc"))).toEqual(["A", "B", "C"]);
    expect(ids(sortSavedRecords(list, "default", "asc"))).toEqual(["A", "B", "C"]);
  });

  it("sorts by each count, both ways", () => {
    expect(ids(sortSavedRecords(list, "likes", "desc"))).toEqual(["B", "C", "A"]);
    expect(ids(sortSavedRecords(list, "likes", "asc"))).toEqual(["A", "C", "B"]);
    expect(ids(sortSavedRecords(list, "views", "desc"))).toEqual(["C", "A", "B"]);
    expect(ids(sortSavedRecords(list, "comments", "desc"))).toEqual(["A", "C", "B"]);
  });

  it("sorts by when it was saved", () => {
    expect(ids(sortSavedRecords(list, "saved", "desc"))).toEqual(["A", "C", "B"]);
    expect(ids(sortSavedRecords(list, "saved", "asc"))).toEqual(["B", "C", "A"]);
  });

  it("does not mutate the input", () => {
    const before = ids(list);
    sortSavedRecords(list, "likes", "asc");
    expect(ids(list)).toEqual(before);
  });

  it("tolerates a non-array", () => {
    expect(sortSavedRecords(undefined, "likes", "desc")).toEqual([]);
  });
});

describe("savedSortComparator", () => {
  it("puts missing metrics last in BOTH directions", () => {
    const withV = rec("has", { views: 5 });
    const noV = rec("none");
    expect([noV, withV].sort(savedSortComparator("views", "desc"))[0]).toBe(withV);
    expect([noV, withV].sort(savedSortComparator("views", "asc"))[0]).toBe(withV);
  });

  it("reads pre-schema-2 records, whose counts are formatted strings", () => {
    const legacy = rec("legacy", { like: "8,3 mil" });
    const modern = rec("modern", { like: 900 });
    expect([modern, legacy].sort(savedSortComparator("likes", "desc"))[0]).toBe(legacy);
  });

  it("falls back to `saved` for an unknown key rather than throwing", () => {
    const a = rec("a", {}, { updatedAt: 2 });
    const b = rec("b", {}, { updatedAt: 9 });
    expect([a, b].sort(savedSortComparator("nonsense", "desc"))[0]).toBe(b);
  });
});

describe("savedPostTimeMs", () => {
  it("scales the stored seconds to ms", () => {
    expect(savedPostTimeMs({ platform: "facebook", takenAt: 1755000000 })).toBe(1755000000000);
  });

  it("decodes an Instagram pk when there is no takenAt", () => {
    // 3500000000000000000 >> 23 + IG epoch — a real-shaped snowflake.
    const ms = savedPostTimeMs({ platform: "instagram", pk: "3500000000000000000" });
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
  });

  it("does NOT decode a non-Instagram id — a Facebook id is numeric and means nothing here", () => {
    expect(savedPostTimeMs({ platform: "facebook", videoId: "1716496106168081" })).toBe(null);
  });

  it("is null when there is nothing to read", () => {
    expect(savedPostTimeMs({ platform: "instagram", videoId: "DcjsUy8lfEX" })).toBe(null);
    expect(savedPostTimeMs(null)).toBe(null);
  });
});

describe("SAVED_SORT_OPTS", () => {
  it("every option has a metric behind it (or is `default`)", () => {
    for (const o of SAVED_SORT_OPTS) {
      if (o.value === "default") continue;
      const sorted = sortSavedRecords([rec("a", { like: 1, views: 1, comment: 1 })], o.value, "desc");
      expect(sorted).toHaveLength(1);
    }
  });
});
