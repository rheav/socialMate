// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { IG_RESERVED_SEGMENTS } from "../../lib/shared/igSurface.js";
import { makePageSorter } from "../../lib/shared/pageSorter.js";

// The bridge is a classic content script, so execute its route predicate verbatim
// without starting its capture, observers, or Chrome messaging in the test.
const bridge = readFileSync("src/content/ig/bridge.js", "utf8");
const routeSource = bridge.match(/  function igGridRoute\(p\) \{[\s\S]*?\n  \}/)[0];
const routeOk = new Function("IG_RESERVED_SEGMENTS", `${routeSource}; return igGridRoute;`)(IG_RESERVED_SEGMENTS);

let sorter;
afterEach(() => {
  sorter?.destroy();
  document.body.innerHTML = "";
  history.replaceState({}, "", "/");
});

describe("Instagram grid routes", () => {
  it.each([
    "/jeanniejonh?stkn=NDY2YzJ0c21laHFx",
    "/jeanniejonh/",
  ])("shows the sort bar on profile %s", async (path) => {
    history.replaceState({}, "", path);
    document.body.innerHTML = '<main><a href="/p/first/">First</a><a href="/p/second/">Second</a></main>';
    sorter = makePageSorter({
      storage: { get: async () => ({}), set() {}, onChanged() {} },
      storageKey: "sw_ig_query",
      fields: {},
      linkSelector: 'main a[href*="/p/"]',
      keyOf: (a) => a.getAttribute("href").split("/")[2],
      recordOf: () => null,
      routeOk,
    });
    await Promise.resolve();
    sorter.applyNow();
    expect(document.querySelector('#sw-psort select')).not.toBeNull();
  });

  it.each([
    "/name.with_dots", "/jeanniejonh/reels", "/jeanniejonh/reels/",
    "/jeanniejonh/tagged/", "/jeanniejonh/saved/all-posts/",
    "/explore/search/keyword/", "/explore/tags/art/", "/explore/locations/123/",
  ])("keeps supported grids sortable: %s", (path) => {
    expect(routeOk(path)).toBe(true);
  });

  it.each([
    "/", "/explore", "/explore/", "/reels", "/reels/", "/p/first/",
    "/reel/first/", "/stories/jeanniejonh/", "/direct/inbox/",
    "/jeanniejonh/unknown/", "/jeanniejonh//reels/",
  ])("rejects non-grid routes: %s", (path) => {
    expect(routeOk(path)).toBe(false);
  });
});

const gridSource = bridge.match(/^function spyGridPosts\([^)]*\) \{[\s\S]*?\n\}/m)[0];
const spyGridPosts = new Function(`${gridSource}; return spyGridPosts;`)();

describe("posts per day from a saved profile's grid", () => {
  const rec = (pk, extra = {}) => ({ pk, code: `c${pk}`, taken_at: 1791000000 + Number(pk), media_type: "photo",
    surface: "profile:nasa", pinned_by: [], ...extra });

  it("takes the grid's posts with a time, once, and a collab by whoever owns it", () => {
    const sent = new Set(["3009"]);
    const records = [rec("3001"), rec("3002", { username: "partner" }), rec("3009"),
      rec("3003", { surface: "profile:other" }), rec("3004", { surface: "related:profile:nasa" }),
      rec("3005", { taken_at: null }), rec("abc")];
    expect(spyGridPosts(records, "nasa", "123", sent)).toEqual([
      { id: "3001", createdAt: 1791003001, mediaType: "photo", pinned: false },
      { id: "3002", createdAt: 1791003002, mediaType: "photo", pinned: false },
    ]);
  });

  it("marks a post pinned only when this profile pinned it", () => {
    const records = [rec("3001", { pinned_by: ["123"] }), rec("3002", { pinned_by: ["999"] })];
    expect(spyGridPosts(records, "nasa", "123", new Set()).map((p) => p.pinned)).toEqual([true, false]);
    // Owner id not known yet: any pin counts.
    expect(spyGridPosts(records, "NASA", null, new Set()).map((p) => p.pinned)).toEqual([true, true]);
  });
});
