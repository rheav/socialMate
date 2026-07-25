import { describe, it, expect } from "vitest";
import { matchesPlatform } from "./tabs.js";

describe("matchesPlatform — pinterest host regex", () => {
  it("accepts pinterest.com", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.com/board/123")).toBe(true);
  });
  it("accepts a country subdomain (br.pinterest.com)", () => {
    expect(matchesPlatform("pinterest", "https://br.pinterest.com/board/123")).toBe(true);
  });
  it("accepts a co.<cc> ccTLD (pinterest.co.uk)", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.co.uk/board/123")).toBe(true);
  });
  it("accepts a com.<cc> ccTLD (pinterest.com.au)", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.com.au/board/123")).toBe(true);
  });
  it("accepts a bare 2-letter ccTLD (pinterest.fr)", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.fr/board/123")).toBe(true);
  });
  it("rejects a lookalike domain (pinterest.evil.com)", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.evil.com/board/123")).toBe(false);
  });
});
