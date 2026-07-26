import { describe, it, expect } from "vitest";
import {
  shouldContinue,
  scheduleNextBreak,
  breakLengthMs,
  commitmentDwellMs,
  isStaleSession,
  serializeLedger,
  restoreLedger,
  LEDGER_ARRAY_FIELDS,
  LEDGER_MAP_FIELDS,
  LEDGER_SET_FIELDS,
  LEDGER_COUNTER_FIELDS,
} from "./sessionMath.js";

const NOW = 1_000_000_000;

describe("shouldContinue", () => {
  const base = { isRunning: true, willEndAt: NOW + 60_000, maxItems: 0, processed: 5 };
  it("continues while running, before clock, no cap", () => {
    expect(shouldContinue(base, NOW)).toBe(true);
  });
  it("stops when not running", () => {
    expect(shouldContinue({ ...base, isRunning: false }, NOW)).toBe(false);
  });
  it("stops at clock expiry (inclusive)", () => {
    expect(shouldContinue(base, NOW + 60_000)).toBe(false);
  });
  it("maxItems 0 = no cap", () => {
    expect(shouldContinue({ ...base, processed: 9999 }, NOW)).toBe(true);
  });
  it("stops when cap reached", () => {
    expect(shouldContinue({ ...base, maxItems: 10, processed: 10 }, NOW)).toBe(false);
    expect(shouldContinue({ ...base, maxItems: 10, processed: 9 }, NOW)).toBe(true);
  });
});

describe("scheduleNextBreak / breakLengthMs", () => {
  const prof = { everyMin: 300_000, everyMax: 540_000, lenMin: 60_000, lenMax: 180_000 };
  it("schedules within [everyMin, everyMax] of now", () => {
    expect(scheduleNextBreak(prof, NOW, () => 0)).toBe(NOW + 300_000);
    expect(scheduleNextBreak(prof, NOW, () => 0.999999)).toBeLessThanOrEqual(NOW + 540_000);
    expect(scheduleNextBreak(prof, NOW, () => 0.5)).toBe(NOW + 420_000);
  });
  it("length within [lenMin, lenMax]", () => {
    expect(breakLengthMs(prof, () => 0)).toBe(60_000);
    expect(breakLengthMs(prof, () => 0.5)).toBe(120_000);
    expect(breakLengthMs(prof, () => 0.999999)).toBeLessThanOrEqual(180_000);
  });
});

describe("commitmentDwellMs", () => {
  it("returns fraction of duration inside clamps", () => {
    // 0.5 × 60s = 30s, clamps [6s, 60s]
    expect(commitmentDwellMs(0.5, 60, 6000, 15000)).toBe(30_000);
  });
  it("clamps up to dwellMin for tiny targets", () => {
    // 0.15 × 10s = 1.5s → 6s floor
    expect(commitmentDwellMs(0.15, 10, 6000, 15000)).toBe(6000);
  });
  it("clamps down to 4×dwellMax for long videos", () => {
    // 0.9 × 1800s = 1620s → 60s ceiling (4 × 15s)
    expect(commitmentDwellMs(0.9, 1800, 6000, 15000)).toBe(60_000);
  });
  it("null when duration unusable", () => {
    expect(commitmentDwellMs(0.5, 0, 6000, 15000)).toBe(null);
    expect(commitmentDwellMs(0.5, NaN, 6000, 15000)).toBe(null);
    expect(commitmentDwellMs(0.5, Infinity, 6000, 15000)).toBe(null);
  });
});

describe("isStaleSession", () => {
  it("stale: running + savedAt older than threshold", () => {
    expect(isStaleSession({ isRunning: true, savedAt: NOW - 121_000 }, NOW)).toBe(true);
  });
  it("fresh: savedAt within threshold", () => {
    expect(isStaleSession({ isRunning: true, savedAt: NOW - 60_000 }, NOW)).toBe(false);
  });
  it("not running / missing → not stale", () => {
    expect(isStaleSession({ isRunning: false, savedAt: NOW - 999_999 }, NOW)).toBe(false);
    expect(isStaleSession(null, NOW)).toBe(false);
    expect(isStaleSession({ isRunning: true }, NOW)).toBe(false);
  });
  it("future breakUntil (+grace) counts as live", () => {
    expect(
      isStaleSession({ isRunning: true, savedAt: NOW - 150_000, breakUntil: NOW + 30_000 }, NOW),
    ).toBe(false);
    expect(
      isStaleSession({ isRunning: true, savedAt: NOW - 300_000, breakUntil: NOW - 61_000 }, NOW),
    ).toBe(true);
  });
});

// The bug these guard: persist() wrote the counters but not the safety ledger, and
// the resume path rebuilt it empty — so every navigation (which every Mode A run
// performs by design) silently reset the hourly like cap and the per-author
// throttles to zero. A round-trip through chrome.storage must be lossless.
describe("safety ledger round-trip", () => {
  const S = {
    likeTimes: [1000, 2000, 3000],
    authorLikes: { alice: 2, bob: 1 },
    commentTimes: [1500],
    authorComments: { alice: 1 },
    commentedIds: new Set(["reel1", "reel2"]),
    capturedIds: new Set(["post9"]),
    consecLikes: 4,
    consecFollows: 2,
    consecComments: 1,
    softFailStreak: 2,
    lastPhrase: "love this",
    // fields that are NOT part of the ledger must not leak into it
    processed: 12,
    tickTimer: 99,
  };

  it("survives a JSON round-trip (Sets included) with every field intact", () => {
    const stored = JSON.parse(JSON.stringify(serializeLedger(S)));
    const back = restoreLedger(stored);
    expect(back.likeTimes).toEqual([1000, 2000, 3000]);
    expect(back.authorLikes).toEqual({ alice: 2, bob: 1 });
    expect(back.commentTimes).toEqual([1500]);
    expect(back.authorComments).toEqual({ alice: 1 });
    expect(back.commentedIds).toBeInstanceOf(Set);
    expect([...back.commentedIds]).toEqual(["reel1", "reel2"]);
    expect(back.capturedIds).toBeInstanceOf(Set);
    expect([...back.capturedIds]).toEqual(["post9"]);
    expect(back.consecLikes).toBe(4);
    expect(back.consecFollows).toBe(2);
    expect(back.consecComments).toBe(1);
    expect(back.softFailStreak).toBe(2);
    expect(back.lastPhrase).toBe("love this");
  });

  it("serializes Sets as arrays (chrome.storage cannot carry a Set)", () => {
    const out = serializeLedger(S);
    expect(Array.isArray(out.commentedIds)).toBe(true);
    expect(Array.isArray(out.capturedIds)).toBe(true);
    expect(JSON.parse(JSON.stringify(out)).commentedIds).toEqual(["reel1", "reel2"]);
  });

  it("carries no state outside the ledger", () => {
    const out = serializeLedger(S);
    expect(out.processed).toBeUndefined();
    expect(out.tickTimer).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(
      [
        ...LEDGER_ARRAY_FIELDS,
        ...LEDGER_MAP_FIELDS,
        ...LEDGER_SET_FIELDS,
        ...LEDGER_COUNTER_FIELDS,
        "lastPhrase",
      ].sort(),
    );
  });

  it("every ledger field persist() writes is one restore() reads back", () => {
    // The drift guard: both directions must cover the identical key set.
    expect(Object.keys(restoreLedger(serializeLedger(S))).sort()).toEqual(
      Object.keys(serializeLedger(S)).sort(),
    );
  });

  it("a pre-0.68 session with no ledger restores to empty, not undefined", () => {
    const back = restoreLedger({ isRunning: true, processed: 3 });
    expect(back.likeTimes).toEqual([]);
    expect(back.authorLikes).toEqual({});
    expect(back.commentedIds).toBeInstanceOf(Set);
    expect(back.commentedIds.size).toBe(0);
    expect(back.consecLikes).toBe(0);
    expect(back.lastPhrase).toBeNull();
  });

  it("tolerates corrupt shapes instead of throwing mid-resume", () => {
    const back = restoreLedger({
      likeTimes: "not-an-array",
      authorLikes: null,
      commentedIds: null,
      consecLikes: undefined,
    });
    expect(back.likeTimes).toEqual([]);
    expect(back.authorLikes).toEqual({});
    expect(back.commentedIds.size).toBe(0);
    expect(back.consecLikes).toBe(0);
    expect(serializeLedger(undefined).likeTimes).toEqual([]);
  });
});
