import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRANSCRIPT_CAP,
  UNLIMITED,
  idsOverCap,
  normalizeTranscriptCap,
} from "./transcriptCap.js";

const store = (...ids) => Object.fromEntries(ids.map((id, i) => [id, { updatedAt: i + 1 }]));

describe("normalizeTranscriptCap", () => {
  it("keeps a sane number and floors it", () => {
    expect(normalizeTranscriptCap(100)).toBe(100);
    expect(normalizeTranscriptCap("50")).toBe(50);
    expect(normalizeTranscriptCap(20.9)).toBe(20);
  });

  it("treats 0 as unlimited — and only 0", () => {
    expect(normalizeTranscriptCap(0)).toBe(UNLIMITED);
    expect(normalizeTranscriptCap("0")).toBe(UNLIMITED);
    expect(normalizeTranscriptCap(-5)).toBe(DEFAULT_TRANSCRIPT_CAP);
  });

  it("falls back to the default, never to unlimited, for a corrupt value", () => {
    expect(normalizeTranscriptCap(undefined)).toBe(DEFAULT_TRANSCRIPT_CAP);
    expect(normalizeTranscriptCap("muitos")).toBe(DEFAULT_TRANSCRIPT_CAP);
    expect(normalizeTranscriptCap({})).toBe(DEFAULT_TRANSCRIPT_CAP);
  });

  it("has a hard ceiling — the store is one object re-serialized on every write", () => {
    expect(normalizeTranscriptCap(999_999)).toBe(2000);
  });
});

describe("idsOverCap", () => {
  it("drops the oldest by updatedAt and keeps the newest", () => {
    expect(idsOverCap(store("a", "b", "c", "d"), 2)).toEqual(["b", "a"]);
  });

  it("drops nothing while the store is within its cap", () => {
    expect(idsOverCap(store("a", "b"), 2)).toEqual([]);
    expect(idsOverCap({}, 20)).toEqual([]);
  });

  it("drops nothing at all when unlimited", () => {
    expect(idsOverCap(store("a", "b", "c"), UNLIMITED)).toEqual([]);
  });
});
