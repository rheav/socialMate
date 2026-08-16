import { describe, it, expect } from "vitest";
import {
  activeMetrics,
  emptyRule,
  normalizeRule,
  passesRule,
  ruleKey,
} from "./feedFilter.js";

const rule = (over) => normalizeRule({ ...emptyRule(), ...over });

describe("normalizeRule", () => {
  it("keeps whole positive minimums and drops everything else", () => {
    const r = normalizeRule({
      on: 1,
      mode: "and",
      min: { likes: "2000", comments: 10.7, shares: "" },
    });
    expect(r).toEqual({ on: true, mode: "and", min: { likes: 2000, comments: 10, shares: null } });
  });

  it("degrades junk to a rule that filters nothing", () => {
    // A NaN threshold would compare false against every post and hide the feed.
    expect(normalizeRule({ min: { likes: "abc", comments: -5, shares: NaN } }).min).toEqual({
      likes: null,
      comments: null,
      shares: null,
    });
    expect(normalizeRule(null)).toEqual(emptyRule());
    expect(normalizeRule("nonsense")).toEqual(emptyRule());
  });

  it("defaults an unknown combinator to OR", () => {
    expect(normalizeRule({ mode: "xor" }).mode).toBe("or");
    expect(normalizeRule({ mode: "and" }).mode).toBe("and");
  });

  it("accepts a thousands-separated number typed into the panel", () => {
    expect(normalizeRule({ min: { comments: "2.000" } }).min.comments).toBe(2000);
  });
});

describe("activeMetrics", () => {
  it("counts only the fields the user filled in", () => {
    expect(activeMetrics(rule({ min: { comments: 10, shares: 20 } }))).toEqual([
      "comments",
      "shares",
    ]);
    expect(activeMetrics(emptyRule())).toEqual([]);
  });

  it("treats a zero minimum as active — 'at least 0' is still a stated rule", () => {
    expect(activeMetrics(rule({ min: { shares: 0 } }))).toEqual(["shares"]);
  });
});

describe("passesRule", () => {
  const counts = { likes: 4800, comments: 2000, shares: 252 };

  it("passes everything while no minimum is set", () => {
    expect(passesRule({ likes: 0, comments: 0, shares: 0 }, emptyRule())).toBe(true);
  });

  it("OR — any one metric clearing its minimum is enough", () => {
    const r = rule({ mode: "or", min: { comments: 10, shares: 20 } });
    expect(passesRule({ comments: 11, shares: 0 }, r)).toBe(true);
    expect(passesRule({ comments: 0, shares: 21 }, r)).toBe(true);
    expect(passesRule({ comments: 9, shares: 19 }, r)).toBe(false);
  });

  it("AND — every stated metric has to clear its minimum", () => {
    const r = rule({ mode: "and", min: { comments: 10, shares: 20 } });
    expect(passesRule({ comments: 11, shares: 21 }, r)).toBe(true);
    expect(passesRule({ comments: 11, shares: 19 }, r)).toBe(false);
    expect(passesRule({ comments: 9, shares: 21 }, r)).toBe(false);
  });

  it("ignores metrics the rule left blank", () => {
    // 4 reactions is nothing, but the rule never asked about reactions.
    const r = rule({ mode: "and", min: { comments: 2000 } });
    expect(passesRule({ likes: 4, comments: 2000, shares: 0 }, r)).toBe(true);
  });

  it("reads a missing count as zero, not as a pass", () => {
    // Facebook prints no number beside a control whose count is 0.
    const r = rule({ min: { comments: 1 } });
    expect(passesRule({ likes: 4, comments: null, shares: 2 }, r)).toBe(false);
    expect(passesRule({}, r)).toBe(false);
    expect(passesRule(null, r)).toBe(false);
  });

  it("is inclusive at the boundary — 'at least N' means N passes", () => {
    expect(passesRule(counts, rule({ min: { comments: 2000 } }))).toBe(true);
  });
});

describe("ruleKey", () => {
  it("changes with a threshold or the combinator", () => {
    const a = rule({ min: { comments: 10 } });
    expect(ruleKey(a)).not.toBe(ruleKey(rule({ min: { comments: 11 } })));
    expect(ruleKey(a)).not.toBe(ruleKey(rule({ mode: "and", min: { comments: 10 } })));
  });

  it("does NOT change with on/off — a verdict survives toggling the filter", () => {
    const min = { comments: 10, shares: 20 };
    expect(ruleKey(rule({ on: true, min }))).toBe(ruleKey(rule({ on: false, min })));
  });
});
