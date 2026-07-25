import { describe, it, expect } from "vitest";
import { matchesPlatform } from "./tabs.js";

describe("matchesPlatform — pinterest host regex", () => {
  it("accepts pinterest.com", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.com/board/123")).toBe(true);
  });
  it("accepts a country subdomain (br.pinterest.com)", () => {
    expect(matchesPlatform("pinterest", "https://br.pinterest.com/board/123")).toBe(true);
  });
  // ccTLDs match the "pinterest" platform conceptually, but manifest.config.js only
  // ships pin-api.js on *://*.pinterest.com/* (Chrome match patterns can't wildcard a
  // TLD) — so these must now be REJECTED, or the panel would adopt a tab it can't
  // actually talk to and hang on "Reading the page…" forever. See the comment on
  // PLATFORM_HOST.pinterest in tabs.js.
  it("rejects a co.<cc> ccTLD (pinterest.co.uk) — no content script ships there", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.co.uk/board/123")).toBe(false);
  });
  it("rejects a com.<cc> ccTLD (pinterest.com.au) — no content script ships there", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.com.au/board/123")).toBe(false);
  });
  it("rejects a bare 2-letter ccTLD (pinterest.fr) — no content script ships there", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.fr/board/123")).toBe(false);
  });
  it("rejects a lookalike domain (pinterest.evil.com)", () => {
    expect(matchesPlatform("pinterest", "https://pinterest.evil.com/board/123")).toBe(false);
  });
  it("rejects a lookalike domain (notpinterest.com)", () => {
    expect(matchesPlatform("pinterest", "https://notpinterest.com/board/123")).toBe(false);
  });
});
