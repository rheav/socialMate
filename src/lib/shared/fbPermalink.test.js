import { describe, it, expect } from "vitest";
import { fbVideoRef, fbPermalink, fbCardLink } from "./fbPermalink.js";

// VERIFIED against facebook.com on 2026-08-15 (server-side redirects, five real ids):
//
//   /watch/?v=<REEL id>   → redirects to bare "/reel/"  — the reels FEED, which then
//                           plays an arbitrary reel. This is the bug: a card opened a
//                           completely different video.
//   /watch/?v=<POST id>   → stays on /watch/?v=<id>     — correct for real video posts
//   /reel/<id>            → never redirects
//   /video.php?v=<id>     → redirects INTO /watch/?v=<id>, so it inherits the bug
//
// So a video id alone does not determine its permalink: the FORM the id was found in
// does. That is what these functions carry.

describe("fbVideoRef", () => {
  it("reads a reel id and remembers it was a reel", () => {
    expect(fbVideoRef("/reel/1846308513007203/")).toEqual({ id: "1846308513007203", kind: "reel" });
  });

  it("reads a video-post id from a /videos/ permalink", () => {
    expect(fbVideoRef("/mypage/videos/27498035496473176/")).toEqual({
      id: "27498035496473176",
      kind: "video",
    });
  });

  it("reads a video-post id from a watch link", () => {
    expect(fbVideoRef("https://www.facebook.com/watch/?v=4313343015570289")).toEqual({
      id: "4313343015570289",
      kind: "video",
    });
  });

  it("keeps the reel form even when the link carries query junk", () => {
    expect(fbVideoRef("/reel/123456789?fs=e&s=abc")).toEqual({ id: "123456789", kind: "reel" });
  });

  it("ignores links that name no video", () => {
    expect(fbVideoRef("/hashtag/tarot/")).toBe(null);
    expect(fbVideoRef("")).toBe(null);
    expect(fbVideoRef(null)).toBe(null);
  });
});

describe("fbPermalink", () => {
  it("builds a reel URL for a reel", () => {
    expect(fbPermalink({ id: "123", kind: "reel" })).toBe("https://www.facebook.com/reel/123");
  });

  it("builds a watch URL for a video post", () => {
    expect(fbPermalink({ id: "123", kind: "video" })).toBe("https://www.facebook.com/watch/?v=123");
  });

  it("prefers the reel form when the kind is unknown", () => {
    // An unknown id is far more likely to be a reel (that is what this extension
    // captures), and a wrong reel URL fails visibly instead of silently opening
    // somebody else's video.
    expect(fbPermalink({ id: "123" })).toBe("https://www.facebook.com/reel/123");
  });

  it("returns null without an id", () => {
    expect(fbPermalink({ kind: "reel" })).toBe(null);
    expect(fbPermalink(null)).toBe(null);
  });
});

describe("fbCardLink", () => {
  // A Library card links to what was stored. Legacy records (pre-0.75.1, captured
  // from a feed) stored /watch/?v=<id> for reels, and /watch/ is the route that
  // sometimes drops the viewer into the reels FEED — a different video entirely.
  // /reel/<id> addressed every id correctly in live checks (2026-08-15), including
  // ids whose record had been stored in watch form.
  it("keeps a stored reel link untouched", () => {
    expect(fbCardLink({ platform: "facebook", videoId: "1", sourceUrl: "https://www.facebook.com/reel/1" }))
      .toBe("https://www.facebook.com/reel/1");
  });

  it("rewrites a legacy watch link to the reel form", () => {
    expect(fbCardLink({ platform: "facebook", videoId: "1281558873921942", sourceUrl: "https://www.facebook.com/watch/?v=1281558873921942" }))
      .toBe("https://www.facebook.com/reel/1281558873921942");
  });

  it("leaves a watch link alone when there is no id to rebuild from", () => {
    const url = "https://www.facebook.com/watch/?v=999";
    expect(fbCardLink({ platform: "facebook", sourceUrl: url })).toBe(url);
  });

  it("never touches another platform's link", () => {
    const tt = "https://www.tiktok.com/@x/video/123";
    expect(fbCardLink({ platform: "tiktok", videoId: "123", sourceUrl: tt })).toBe(tt);
  });

  it("builds a reel link for a Facebook record that stored none", () => {
    expect(fbCardLink({ platform: "facebook", videoId: "77" })).toBe("https://www.facebook.com/reel/77");
  });

  it("returns null when there is nothing to link to", () => {
    expect(fbCardLink({ platform: "facebook" })).toBe(null);
  });
});

// videoKind is the difference between "legacy record, rebuild it" and "a real
// video post, whose URL is watch form BECAUSE that is what opens it".
describe("fbCardLink with a captured kind", () => {
  it("leaves a watch link alone when capture recorded it as a video post", () => {
    // /<page>/videos/<id> and the theater's ?v=<id> both store watch form on
    // purpose; rewriting them to /reel/<id> points the card at a non-reel.
    const url = "https://www.facebook.com/watch/?v=1281558873921942";
    expect(
      fbCardLink({
        platform: "facebook",
        videoId: "1281558873921942",
        sourceUrl: url,
        videoKind: "video",
      }),
    ).toBe(url);
  });

  it("still rebuilds a watch link a reel capture stored", () => {
    expect(
      fbCardLink({
        platform: "facebook",
        videoId: "77",
        sourceUrl: "https://www.facebook.com/watch/?v=77",
        videoKind: "reel",
      }),
    ).toBe("https://www.facebook.com/reel/77");
  });

  it("keeps rebuilding legacy records, which carry no kind at all", () => {
    expect(
      fbCardLink({
        platform: "facebook",
        videoId: "77",
        sourceUrl: "https://www.facebook.com/watch/?v=77",
      }),
    ).toBe("https://www.facebook.com/reel/77");
  });

  it("builds the watch form for a video record that stored no URL", () => {
    expect(fbCardLink({ platform: "facebook", videoId: "88", videoKind: "video" })).toBe(
      "https://www.facebook.com/watch/?v=88",
    );
  });
});
