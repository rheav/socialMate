import { describe, it, expect } from "vitest";
import { stripRegions } from "./stripRegions.js";

const src = [
  "a();",
  "// @private",
  "hub();",
  "// @end-private",
  "  /* @public */",
  "  local();",
  "  /* @end-public */",
  "{/* @private */}",
  "<Warm />",
  "{/* @end-private */}",
  "b();",
].join("\n");

describe("stripRegions", () => {
  it("drops the other variant's regions and blanks every marker, keeping line count", () => {
    const pub = stripRegions(src, "private");
    expect(pub.split("\n")).toEqual(["a();", "", "", "", "", "  local();", "", "", "", "", "b();"]);
    const priv = stripRegions(src, "public");
    expect(priv.split("\n")).toEqual(["a();", "", "hub();", "", "", "", "", "", "<Warm />", "", "b();"]);
  });

  it("leaves files without markers untouched", () => {
    expect(stripRegions("x // mentions @private in prose", "private")).toBe("x // mentions @private in prose");
  });

  it("refuses unbalanced or nested regions", () => {
    expect(() => stripRegions("// @private\nx", "private")).toThrow(/never closed/);
    expect(() => stripRegions("x\n// @end-public", "private")).toThrow(/without/);
    expect(() => stripRegions("// @private\n// @public\n// @end-public\n// @end-private", "private")).toThrow(/inside/);
  });
});
