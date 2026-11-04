// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { isTtTileMedia, isTtPlayerSurface, ttPaintedRect, ttCardSpotOf, ttCardAt, ttCardSpot, TT_TILE_LINK } from "./ttPlayerHost.js";

/** A grid tile: a preview <video> wrapped in the post's own permalink. */
function tileVideo(id = "7668715391899716886") {
  document.body.replaceChildren();
  const a = document.createElement("a");
  a.setAttribute("href", `/@someone/video/${id}`);
  const v = document.createElement("video");
  a.appendChild(v);
  document.body.appendChild(a);
  return v;
}

/** The real player on a /video/ page: no permalink around it. */
function playerVideo() {
  document.body.replaceChildren();
  const box = document.createElement("div");
  const v = document.createElement("video");
  box.appendChild(v);
  document.body.appendChild(box);
  return v;
}

describe("isTtTileMedia", () => {
  it("is true for a preview inside its own permalink", () => {
    expect(isTtTileMedia(tileVideo())).toBe(true);
  });
  it("is false for the player on a video page", () => {
    expect(isTtTileMedia(playerVideo())).toBe(false);
  });
  it("survives being handed nothing", () => {
    for (const v of [null, undefined, {}]) expect(isTtTileMedia(v)).toBe(false);
  });
});

describe("isTtPlayerSurface", () => {
  // The regression: a search grid autoplays one tile preview, and that single
  // <video> used to be enough to hang the floating action rail on the page.
  it("is false on a search grid, even while a tile preview is playing", () => {
    expect(isTtPlayerSurface("/search/video", tileVideo())).toBe(false);
  });

  it("is false on the other grid surfaces", () => {
    for (const p of ["/search/video", "/explore", "/@someuser", "/tag/auralytrend"])
      expect(isTtPlayerSurface(p, tileVideo())).toBe(false);
  });

  it("is true on the single-video routes, with or without a video resolved yet", () => {
    for (const p of ["/@someone/video/7668715391899716886", "/foryou", "/"]) {
      expect(isTtPlayerSurface(p, playerVideo())).toBe(true);
      expect(isTtPlayerSurface(p, null)).toBe(true);
    }
  });

  // A player that is genuinely not in a tile still counts, even on a route this
  // does not know about — that is what the old `|| !!centered` was reaching for,
  // and it stays, minus the tiles.
  it("accepts an unwrapped player on an unrecognised route", () => {
    expect(isTtPlayerSurface("/some/new/surface", playerVideo())).toBe(true);
  });

  it("needs a video when the route does not say player", () => {
    expect(isTtPlayerSurface("/search/video", null)).toBe(false);
    expect(isTtPlayerSurface("/explore", undefined)).toBe(false);
  });

  it("treats a missing pathname as not-a-player-route", () => {
    expect(isTtPlayerSurface(null, null)).toBe(false);
    expect(isTtPlayerSurface(undefined, tileVideo())).toBe(false);
  });
});

describe("TT_TILE_LINK", () => {
  it("selects video permalinks and nothing else", () => {
    document.body.replaceChildren();
    document.body.innerHTML =
      '<a href="/@a/video/1"></a><a href="/@b/video/2"></a><a href="/@c"></a><a href="/explore"></a>';
    expect(document.querySelectorAll(TT_TILE_LINK).length).toBe(2);
  });
});

describe("ttPaintedRect", () => {
  const stage = { left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 };
  it("centres a 9:16 picture letterboxed in a wide contain box", () => {
    expect(ttPaintedRect(stage, 720, 1280, "contain")).toEqual(
      { left: 546.875, top: 0, width: 506.25, height: 900, right: 1053.125, bottom: 900 });
  });
  it("leaves the box alone for cover/fill or before metadata", () => {
    expect(ttPaintedRect(stage, 720, 1280, "cover")).toBe(stage);
    expect(ttPaintedRect(stage, 0, 0, "contain")).toBe(stage);
  });
});

describe("dragged card spot", () => {
  const pic = { left: 261, top: 0, width: 614, height: 1091 };
  it("round-trips a drop inside the picture", () => {
    const spot = ttCardSpot(pic, 338, 129, 400, 500);
    const at = ttCardAt(pic, 338, 129, spot);
    expect(at.left).toBeCloseTo(400);
    expect(at.top).toBeCloseTo(500);
  });
  it("keeps a drop past the edges on the picture", () => {
    expect(ttCardAt(pic, 338, 129, ttCardSpot(pic, 338, 129, -50, 5000))).toEqual({ left: 261, top: 962 });
  });
  it("holds the same spot when the picture shrinks", () => {
    const spot = { x: 1, y: 1 }; // bottom-right corner
    expect(ttCardAt({ left: 0, top: 0, width: 400, height: 700 }, 338, 129, spot)).toEqual({ left: 62, top: 571 });
  });
  it("rejects what storage may hold that is not a spot", () => {
    for (const bad of [null, undefined, "x", {}, { x: 0.5 }, { x: NaN, y: 1 }]) expect(ttCardSpotOf(bad)).toBe(null);
    expect(ttCardSpotOf({ x: 0.2, y: 0.9 })).toEqual({ x: 0.2, y: 0.9 });
  });
});
