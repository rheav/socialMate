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
