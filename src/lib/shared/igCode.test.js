import { describe, it, expect } from "vitest";
import { igIdBase, igCodeFromPk, igPkFromCode, igRefMatches } from "./igCode.js";

// Both pairs were read off live pages on 2026-08-31: the first from a profile
// grid post opened in the modal, the second from the /reels/ player.
const PAIRS = [
  ["3964608873797160540", "DcFHsPsCo5c"],
  ["3974000808306592589", "DcmfK4UOstN"],
];

describe("igIdBase", () => {
  it("drops Instagram's owner suffix", () => {
    expect(igIdBase("3964608873797160540_52341")).toBe("3964608873797160540");
  });
  it("leaves a bare id alone and tolerates junk", () => {
    expect(igIdBase("DcFHsPsCo5c")).toBe("DcFHsPsCo5c");
    expect(igIdBase(null)).toBe("");
    expect(igIdBase(undefined)).toBe("");
  });
});

describe("igCodeFromPk / igPkFromCode", () => {
  for (const [pk, code] of PAIRS) {
    it(`round-trips ${code}`, () => {
      expect(igCodeFromPk(pk)).toBe(code);
      expect(igPkFromCode(code)).toBe(pk);
    });
  }
  it("reads a pk that still carries its owner suffix", () => {
    expect(igCodeFromPk(`${PAIRS[0][0]}_52341`)).toBe(PAIRS[0][1]);
  });
  it("refuses what is not a pk / not a shortcode", () => {
    expect(igCodeFromPk("DcFHsPsCo5c")).toBe(null);
    expect(igCodeFromPk("")).toBe(null);
    expect(igCodeFromPk(null)).toBe(null);
    expect(igPkFromCode("Dc/HsP?Co5c")).toBe(null);
    expect(igPkFromCode("")).toBe(null);
  });
});

describe("igRefMatches", () => {
  const [pk, code] = PAIRS[0];
  it("matches a code-only record against the pk a player was stamped with", () => {
    expect(igRefMatches({ code }, pk)).toBe(true);
  });
  it("matches a pk-only record against a shortcode", () => {
    expect(igRefMatches({ pk }, code)).toBe(true);
  });
  it("matches through the owner suffix, either side", () => {
    expect(igRefMatches({ pk: `${pk}_52341` }, pk)).toBe(true);
    expect(igRefMatches({ pk }, `${pk}_52341`)).toBe(true);
    expect(igRefMatches({ id: `${pk}_52341` }, code)).toBe(true);
  });
  it("is false for another media, and for junk", () => {
    expect(igRefMatches({ code }, PAIRS[1][0])).toBe(false);
    expect(igRefMatches({ code: PAIRS[1][1] }, pk)).toBe(false);
    expect(igRefMatches(null, pk)).toBe(false);
    expect(igRefMatches({ code }, "")).toBe(false);
    expect(igRefMatches({}, pk)).toBe(false);
  });
});
