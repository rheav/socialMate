import { describe, expect, it } from "vitest";
import {
  parseProfileUrl,
  profileUrl,
  spyId,
  storiesUrl,
} from "./spyProfile.js";

describe("spy profile utilities (section 3)", () => {
  const table = [
    { input: "https://www.instagram.com/jeanniejonh?stkn=abc", hint: undefined, expected: { platform: "instagram", key: "jeanniejonh" } },
    { input: "https://www.instagram.com/JeannieJonh/", hint: undefined, expected: { platform: "instagram", key: "jeanniejonh" } },
    { input: "instagram.com/a.b_c/reels/", hint: undefined, expected: { platform: "instagram", key: "a.b_c" } },
    { input: "https://www.instagram.com/stories/nasa/3712345/", hint: undefined, expected: { platform: "instagram", key: "nasa" } },
    { input: "https://www.instagram.com/p/DZ-dSUgSRiy/", hint: undefined, expected: null },
    { input: "https://www.instagram.com/explore/tags/tarot/", hint: undefined, expected: null },
    { input: "@nasa", hint: "instagram", expected: { platform: "instagram", key: "nasa" } },
    { input: "nasa", hint: undefined, expected: null },
    { input: "https://www.facebook.com/NASA", hint: undefined, expected: { platform: "facebook", key: "nasa" } },
    { input: "https://m.facebook.com/NASA/followers/", hint: undefined, expected: { platform: "facebook", key: "nasa" } },
    { input: "https://www.facebook.com/profile.php?id=100092403319843&sk=reels_tab", hint: undefined, expected: { platform: "facebook", key: "100092403319843" } },
    { input: "https://www.facebook.com/profile.php", hint: undefined, expected: null },
    { input: "https://www.facebook.com/reel/2030018604348103", hint: undefined, expected: null },
    { input: "https://www.facebook.com/search/top?q=manifestation", hint: undefined, expected: null },
    { input: "https://www.tiktok.com/@nasa", hint: undefined, expected: null },
    { input: "", hint: undefined, expected: null },
    { input: null, hint: undefined, expected: null },
    { input: "   ", hint: undefined, expected: null },
  ];

  for (const { input, hint, expected } of table) {
    it(`parses ${JSON.stringify(input)} (hint: ${hint})`, () => {
      expect(parseProfileUrl(input, hint)).toEqual(expected);
    });
  }

  it("spyId builds stable id", () => {
    expect(spyId("instagram", "JeannieJonh")).toBe("instagram:jeanniejonh");
    expect(spyId("facebook", "NASA")).toBe("facebook:nasa");
  });

  it("profileUrl formats platform urls correctly", () => {
    expect(profileUrl("instagram", "nasa")).toBe("https://www.instagram.com/nasa/");
    expect(profileUrl("facebook", "nasa")).toBe("https://www.facebook.com/nasa");
    expect(profileUrl("facebook", "100092403319843")).toBe("https://www.facebook.com/profile.php?id=100092403319843");
  });

  it("storiesUrl formats stories urls or null", () => {
    expect(storiesUrl({ platform: "instagram", key: "nasa" })).toBe("https://www.instagram.com/stories/nasa/");
    expect(storiesUrl({ platform: "facebook", key: "nasa", storyRef: "123197747437002" })).toBe("https://www.facebook.com/stories/123197747437002/");
    expect(storiesUrl({ platform: "facebook", key: "nasa", story_ref: "123197747437002" })).toBe("https://www.facebook.com/stories/123197747437002/");
    expect(storiesUrl({ platform: "facebook", key: "nasa" })).toBeNull();
  });
});
