import { describe, expect, it } from "vitest";

import { FONTES_MIN_SIDE, fontesBestUrl, fontesOrigin } from "./fontesPick.js";

describe("fontesBestUrl", () => {
  it("takes the widest srcset entry, whatever the order", () => {
    const srcset = "https://cdn/a_640.jpg?x=1 640w, https://cdn/a_1080.jpg?x=1 1080w, https://cdn/a_750.jpg 750w";
    expect(fontesBestUrl(srcset, "https://cdn/a_320.jpg")).toBe("https://cdn/a_1080.jpg?x=1");
  });
  it("keeps commas that live inside a url", () => {
    expect(fontesBestUrl("https://cdn/a.jpg?s=1,2 320w, https://cdn/b.jpg?s=3,4 1440w", null)).toBe("https://cdn/b.jpg?s=3,4");
  });
  it("falls back to x descriptors, then to the src", () => {
    expect(fontesBestUrl("https://cdn/a.jpg 1x, https://cdn/a@2.jpg 2x", null)).toBe("https://cdn/a@2.jpg");
    expect(fontesBestUrl("", "https://p16.tiktokcdn.com/photo.jpeg")).toBe("https://p16.tiktokcdn.com/photo.jpeg");
  });
  it("never hands out an address the worker cannot fetch", () => {
    expect(fontesBestUrl("", "blob:https://www.instagram.com/1234")).toBeNull();
    expect(fontesBestUrl("", "data:image/png;base64,AAAA")).toBeNull();
    expect(fontesBestUrl(null, null)).toBeNull();
  });
});

describe("fontesOrigin", () => {
  it("names Instagram and TikTok, nothing else", () => {
    expect(fontesOrigin("www.instagram.com")).toBe("instagram");
    expect(fontesOrigin("www.tiktok.com")).toBe("tiktok");
    expect(fontesOrigin("notinstagram.com")).toBeNull();
    expect(fontesOrigin("www.facebook.com")).toBeNull();
  });
  it("calls 160 px the smallest photo", () => expect(FONTES_MIN_SIDE).toBe(160));
});
