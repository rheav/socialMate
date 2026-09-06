// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { isTtTileMedia, isTtPlayerSurface, TT_TILE_LINK } from "./ttPlayerHost.js";

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
