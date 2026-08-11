import { describe, it, expect } from "vitest";
import { mergeMeta } from "./metaMerge.js";

// A transcript record is written twice (content script at request time, background
// at job start) and patched later by the backfill. A later write that scraped
// NOTHING must never erase what an earlier one already captured — that is exactly
// how a reel ended up in the Library with `counts: null` next to a good author,
// caption and thumbnail.
describe("mergeMeta", () => {
  it("keeps the existing counts when the incoming patch carries none", () => {
    const prev = { counts: { like: "8,1 mil", comment: "3,2 mil" }, caption: "hi" };
    expect(mergeMeta(prev, { counts: null }).counts).toEqual({
      like: "8,1 mil",
      comment: "3,2 mil",
    });
  });

  it("takes the incoming value when the patch has one", () => {
    const prev = { counts: { like: "8,1 mil" } };
    expect(mergeMeta(prev, { counts: { like: "9 mil" } }).counts).toEqual({ like: "9 mil" });
  });

  it("keeps existing text when the patch sends an empty string", () => {
    expect(mergeMeta({ caption: "real caption" }, { caption: "" }).caption).toBe("real caption");
  });

  it("adds fields the previous record never had", () => {
    expect(mergeMeta({ caption: "c" }, { thumb: "data:," })).toEqual({
      caption: "c",
      thumb: "data:,",
    });
  });

  it("passes through explicit falsy values that are meaningful", () => {
    // `status`/`error` are state, not scraped metadata: a patch that clears the
    // error must actually clear it.
    expect(mergeMeta({ error: "boom" }, { error: null }, { clear: ["error"] }).error).toBe(null);
  });

  it("does not mutate the record it was given", () => {
    const prev = { counts: { like: "1" } };
    mergeMeta(prev, { counts: null, caption: "x" });
    expect(prev).toEqual({ counts: { like: "1" } });
  });
});
