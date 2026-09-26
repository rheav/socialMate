import { describe, it, expect } from "vitest";
import { igSurfaceKey, igSurface } from "./igSurface.js";
import { makeSurfaceTracker, tallySurfaces, relatedSurface, relatedOrigin, ORPHAN_SURFACE } from "./surfaceTracker.js";

describe("igSurfaceKey", () => {
  // THE BUG THIS FILE EXISTS FOR. Measured live on 2026-09-22 against a logged-in
  // Instagram in the shared probe Chrome: /explore/tags/soulmate/ 302s to
  // /explore/search/keyword/?q=%23soulmate. The old key read only the pathname, so
  // it answered "explore" — the same bucket as the Explore recommendation feed.
  // 30 tarot posts came back stamped "explore" into a list that still held cars
  // and graduation photos from an earlier Explore visit.
  it("reads the hashtag out of the search route Instagram redirects to", () => {
    expect(igSurfaceKey("/explore/search/keyword/", "?q=%23soulmate")).toBe("tag:soulmate");
    expect(igSurfaceKey("/explore/search/top/", "?q=%23Tarot")).toBe("tag:tarot");
  });

  it("keeps a word search separate from a hashtag search", () => {
    // /explore/search/keyword/?q=tarot returns a different result set (it mixes in
    // accounts and audio), so pooling the two would re-create the bug in miniature.
    expect(igSurfaceKey("/explore/search/keyword/", "?q=tarot")).toBe("search:tarot");
    expect(igSurfaceKey("/explore/search/keyword/", "?q=%23tarot")).toBe("tag:tarot");
  });

  it("still handles the legacy tag route and a bare explore feed", () => {
    expect(igSurfaceKey("/explore/tags/soulmate/", "")).toBe("tag:soulmate");
    expect(igSurfaceKey("/explore/", "")).toBe("explore");
    expect(igSurfaceKey("/explore/people/", "")).toBe("explore");
    expect(igSurfaceKey("/explore/search/keyword/", "")).toBe("explore"); // no q= yet
  });

  it("names profiles, their tabs, the reels feed and the home feed", () => {
    expect(igSurfaceKey("/ivymoontarot7/", "")).toBe("profile:ivymoontarot7");
    expect(igSurfaceKey("/ivymoontarot7/reels/", "")).toBe("profile:ivymoontarot7");
    // Multi-author by definition: filterBySurface drops a `profile:` record whose
    // author isn't the owner, which would have emptied this tab entirely.
    expect(igSurfaceKey("/ivymoontarot7/tagged/", "")).toBe("tagged:ivymoontarot7");
    expect(igSurfaceKey("/ivymoontarot7/saved/all-posts/", "")).toBe("saved:ivymoontarot7");
    expect(igSurfaceKey("/reels/", "")).toBe("reels");
    // The player inside that feed, measured live. Singular /reel/<code>/ is a
    // permalink out of a grid and stays transparent — the two differ by one letter.
    expect(igSurfaceKey("/reels/Dcu31tTM_2b/", "")).toBe("reels");
    expect(igSurfaceKey("/reel/Dcu31tTM_2b/", "")).toBe(null);
    expect(igSurfaceKey("/", "")).toBe("feed");
  });

  it("never reads a reserved route as a username", () => {
    expect(igSurfaceKey("/explore/", "")).toBe("explore");
    expect(igSurfaceKey("/direct/inbox/", "")).toBe(null); // transparent, not a profile
  });

  it("treats a post or reel permalink as transparent", () => {
    expect(igSurfaceKey("/p/DNEq_P7KOOz/", "")).toBe(null);
    expect(igSurfaceKey("/reel/DNEq_P7KOOz/", "")).toBe(null);
    expect(igSurfaceKey("/stories/ivymoontarot7/123/", "")).toBe(null);
  });

  it("does not throw on a malformed query or escape", () => {
    expect(() => igSurfaceKey("/explore/search/keyword/", "?q=%E0%A4%A")).not.toThrow();
    expect(() => igSurfaceKey("/explore/tags/%E0%A4%A/", "")).not.toThrow();
  });
});

describe("the surface tracker", () => {
  // Measured live: clicking a tile on /explore/search/keyword/?q=%23soulmate
  // pushes /p/DNEq_P7KOOz/, which used to report "feed" — so the panel's surface
  // filter dropped all 30 hashtag records and the grid emptied until the post
  // was closed.
  it("keeps the grid you came from while a post is open", () => {
    const t = makeSurfaceTracker(igSurfaceKey);
    expect(t.read("/explore/search/keyword/", "?q=%23soulmate")).toEqual({
      view: "tag:soulmate",
      stamp: "tag:soulmate",
    });
    expect(t.read("/p/DNEq_P7KOOz/", "")).toEqual({
      view: "tag:soulmate",
      stamp: "related:tag:soulmate",
    });
    expect(t.read("/explore/search/keyword/", "?q=%23soulmate")).toEqual({
      view: "tag:soulmate",
      stamp: "tag:soulmate",
    });
  });

  it("falls back to the orphan bucket for a permalink opened cold", () => {
    const t = makeSurfaceTracker(igSurfaceKey);
    expect(t.read("/p/DNEq_P7KOOz/", "")).toEqual({
      view: ORPHAN_SURFACE,
      stamp: "related:post",
    });
  });

  it("does not nest related buckets", () => {
    expect(relatedSurface("related:tag:x")).toBe("related:tag:x");
    expect(relatedOrigin("related:tag:x")).toBe("tag:x");
    expect(relatedOrigin("tag:x")).toBe("tag:x");
  });

  it("exports a live tracker the content scripts share", () => {
    expect(typeof igSurface.view).toBe("function");
    expect(typeof igSurface.stamp).toBe("function");
    // Destructured, which is how the content scripts call it — a `this`-bound
    // method would throw here.
    const { view } = igSurface;
    expect(view("/explore/tags/x/", "")).toBe("tag:x");
  });
});

describe("tallySurfaces", () => {
  it("counts records per surface in first-sighting order", () => {
    expect(
      tallySurfaces([
        { surface: "tag:soulmate" },
        { surface: "explore" },
        { surface: "tag:soulmate" },
        { surface: "related:tag:soulmate" },
        { surface: null },
        {},
      ]),
    ).toEqual([
      { key: "tag:soulmate", count: 2 },
      { key: "explore", count: 1 },
      { key: "related:tag:soulmate", count: 1 },
    ]);
  });
});
