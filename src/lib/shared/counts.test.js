// One count parser now serves seven former copies (five content scripts plus the
// private ones in content.js and ttMedia.js). Its separator handling is the part
// that kept getting re-derived slightly wrong, so it is pinned here.
import { describe, it, expect } from "vitest";
import { parseCount, fmtCount, COUNT_UNITS } from "./counts.js";

describe("parseCount separators", () => {
  it("one separator with NO unit word is digit grouping", () => {
    // ttMedia's private copy got this wrong: "1.234" is 1234 in pt-BR, and it read
    // 1.234 — undercounting by 1000×.
    expect(parseCount("1.234")).toBe(1234);
    expect(parseCount("76.800")).toBe(76800);
    expect(parseCount("1,234")).toBe(1234);
    expect(parseCount("222")).toBe(222);
  });

  it("one separator WITH a unit word is the decimal point", () => {
    expect(parseCount("76,8 mil")).toBe(76800);
    expect(parseCount("1.2M")).toBe(1200000);
    expect(parseCount("51.9M")).toBe(51900000);
    expect(parseCount("964.5K")).toBe(964500);
  });

  it("both separators: the LAST one is the decimal", () => {
    expect(parseCount("1.234,5")).toBe(1235); // pt-BR
    expect(parseCount("1,234.5")).toBe(1235); // en
  });

  it("tolerates a trailing abbreviation period", () => {
    expect(parseCount("1,2 mil.")).toBe(1200);
  });

  it("knows the locale unit words the page copies used to be missing", () => {
    // comments-scrape.js shipped with only 5 of these, so a real Indonesian /
    // Nordic / Polish count parsed to null on the page while tests stayed green.
    expect(parseCount("1,2 rb")).toBe(1200); // id
    expect(parseCount("3 jt")).toBe(3000000); // id
    expect(parseCount("2 tusen")).toBe(2000); // no/sv
    expect(parseCount("4 mln")).toBe(4000000); // pl
    expect(parseCount("5 mrd")).toBe(5000000000); // pl/de
    expect(parseCount("6 mn")).toBe(6000000);
  });

  it("passes numbers through and rejects non-counts", () => {
    expect(parseCount(51900000)).toBe(51900000);
    expect(parseCount(NaN)).toBeNull();
    expect(parseCount("")).toBeNull();
    expect(parseCount("abc")).toBeNull();
    expect(parseCount("12 potatoes")).toBeNull(); // unknown suffix
    expect(parseCount(null)).toBeNull();
    expect(parseCount(undefined)).toBeNull();
  });

  it("every unit in the map is reachable by the parser", () => {
    for (const [unit, mult] of Object.entries(COUNT_UNITS))
      expect(parseCount(`2${unit}`), unit).toBe(2 * mult);
  });
});

describe("fmtCount", () => {
  it("abbreviates and drops a trailing .0", () => {
    expect(fmtCount(964490)).toBe("964.5K");
    expect(fmtCount(2000)).toBe("2K");
    expect(fmtCount(1500000)).toBe("1.5M");
    expect(fmtCount(999)).toBe("999");
  });
  it("null is an em dash, not zero — unknown and zero are different facts", () => {
    expect(fmtCount(null)).toBe("—");
    expect(fmtCount(undefined)).toBe("—");
    expect(fmtCount(0)).toBe("0");
  });
  it("round-trips through parseCount for representative values", () => {
    for (const n of [0, 7, 999, 1000, 2500, 76800, 1200000])
      expect(parseCount(fmtCount(n)), String(n)).toBe(n);
  });
});
