// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { isIgTileMedia, isIgPlayerMedia, onIgPlayerRoute, onIgRailSurface, IG_TILE_LINK } from "./igPlayerHost.js";

// Fixture mirrors the live DOM measured on
// instagram.com/explore/search/keyword/?q=%23auralytrend → click a result
// (2026-08-25): the grid stays mounted behind the post modal, so the page holds
// 24 tile players plus the one real player inside the dialog, all on /p/<code>/.
function grid({ tiles = 24, withDialog = true } = {}) {
  document.body.replaceChildren();
  const hosts = [];
  for (let i = 0; i < tiles; i++) {
    const a = document.createElement("a");
    a.setAttribute("href", `/p/TILE${i}/`);
    const host = document.createElement("div");
    host.setAttribute("role", "presentation");
    host.appendChild(document.createElement("video"));
    a.appendChild(host);
    document.body.appendChild(a);
    hosts.push(host);
  }
  let player = null;
  if (withDialog) {
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    player = document.createElement("div");
    player.setAttribute("role", "presentation");
    player.appendChild(document.createElement("video"));
    dlg.appendChild(player);
    document.body.appendChild(dlg);
  }
  return { hosts, player };
}

describe("onIgPlayerRoute", () => {
  it("matches the post and reel routes", () => {
    for (const p of ["/p/DbrWBt5v4Tu/", "/reel/DbrWBt5v4Tu/", "/reels/DaBFBcgxZIi/"])
      expect(onIgPlayerRoute(p)).toBe(true);
  });
  it("rejects grid and profile routes", () => {
    for (const p of ["/explore/search/keyword/", "/explore/tags/auralytrend/", "/nasa/", "/"])
      expect(onIgPlayerRoute(p)).toBe(false);
  });
  it("treats a missing pathname as not-a-player-route", () => {
    expect(onIgPlayerRoute(undefined)).toBe(false);
    expect(onIgPlayerRoute(null)).toBe(false);
  });
});

describe("isIgTileMedia", () => {
  it("is true for media wrapped in its own permalink", () => {
    const { hosts } = grid({ tiles: 1, withDialog: false });
    expect(isIgTileMedia(hosts[0])).toBe(true);
    expect(isIgTileMedia(hosts[0].querySelector("video"))).toBe(true);
  });
  it("is false for the media inside the post modal", () => {
    const { player } = grid({ tiles: 1 });
    expect(isIgTileMedia(player)).toBe(false);
  });
  it("is false for a link that is not a media permalink", () => {
    document.body.replaceChildren();
    const a = document.createElement("a");
    a.setAttribute("href", "/nasa/");
    const host = document.createElement("div");
    a.appendChild(host);
    document.body.appendChild(a);
    expect(isIgTileMedia(host)).toBe(false);
  });
  it("survives being handed nothing", () => {
    expect(isIgTileMedia(null)).toBe(false);
    expect(isIgTileMedia(undefined)).toBe(false);
    expect(isIgTileMedia({})).toBe(false);
  });
});

describe("isIgPlayerMedia", () => {
  // The regression: 25 candidates on /p/<code>/, exactly one of them the player.
  it("picks only the modal player out of a grid left mounted behind it", () => {
    const { hosts, player } = grid();
    const path = "/p/DbrWBt5v4Tu/";
    const players = [...hosts, player].filter((el) => isIgPlayerMedia(el, path));
    expect(players).toEqual([player]);
  });
  it("accepts a standalone post or reel player with no grid around it", () => {
    document.body.replaceChildren();
    const host = document.createElement("div");
    host.appendChild(document.createElement("video"));
    document.body.appendChild(host);
    expect(isIgPlayerMedia(host, "/p/DbrWBt5v4Tu/")).toBe(true);
    expect(isIgPlayerMedia(host, "/reels/DaBFBcgxZIi/")).toBe(true);
  });
  it("draws no player rail at all on a grid route", () => {
    const { hosts, player } = grid();
    const path = "/explore/search/keyword/";
    expect([...hosts, player].some((el) => isIgPlayerMedia(el, path))).toBe(false);
  });
});

describe("IG_TILE_LINK", () => {
  it("selects post and reel permalinks and nothing else", () => {
    document.body.replaceChildren();
    document.body.innerHTML =
      '<a href="/p/A/"></a><a href="/reel/B/"></a><a href="/nasa/"></a><a href="/explore/"></a>';
    expect(document.querySelectorAll(IG_TILE_LINK).length).toBe(2);
  });
});

// Hovercard fixture, measured live on /p/<code>/ → hover the post author
// (2026-08-31): a portal outside <main> holding three 120x120 permalink tiles.
describe("onIgRailSurface", () => {
  function page() {
    document.body.replaceChildren();
    const main = document.createElement("main");
    const gridTile = document.createElement("a");
    gridTile.setAttribute("href", "/p/GRID/");
    main.appendChild(gridTile);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const player = document.createElement("div");
    dialog.appendChild(player);
    const card = document.createElement("div");
    const cardTile = document.createElement("a");
    cardTile.setAttribute("href", "/p/CARD/");
    card.appendChild(cardTile);
    document.body.append(main, dialog, card);
    return { gridTile, player, cardTile };
  }
  it("is true for a grid tile inside <main>", () => {
    expect(onIgRailSurface(page().gridTile)).toBe(true);
  });
  it("is true for the post modal's player, which is outside <main>", () => {
    expect(onIgRailSurface(page().player)).toBe(true);
  });
  it("is false for a hovercard tile, which is in neither", () => {
    expect(onIgRailSurface(page().cardTile)).toBe(false);
  });
  it("tolerates junk", () => {
    expect(onIgRailSurface(null)).toBe(false);
    expect(onIgRailSurface({})).toBe(false);
  });
});
