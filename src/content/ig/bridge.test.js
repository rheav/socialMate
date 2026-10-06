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
// The real decoder, as the overlay uses it.
const pkSeconds = (pk) => Number(((BigInt(String(pk).split("_")[0]) >> 23n) + 1314220021721n) / 1000n);

describe("posts per day from a saved profile's grid", () => {
  const OWNER = "27092017544";
  const rec = (pk, extra = {}) => ({ pk, code: `c${pk}`, taken_at: 1791000000 + Number(pk.slice(-4)), media_type: "video",
    surface: "profile:barbie.the.aries", username: "barbie.the.aries", userid: OWNER, pinned_by: [], ...extra });
  const ids = (out) => out.map((p) => p.id);

  it("takes only the profile's own posts: the home feed Instagram loads beside the grid is someone else's", () => {
    const records = [
      rec("4001511883701836730"),
      rec("4001498513720370557", { username: "marcusorion163", userid: "999" }), // home feed, same page
      rec("3998560495161365668", { username: "elementsbrasil", userid: "888", media_type: "photo" }), // an ad
      rec("4001383583737411084", { username: "barbie.the.aries", userid: "777" }), // relabelled by surface, wrong id
    ];
    expect(ids(spyGridPosts(records, "barbie.the.aries", OWNER, new Map(), pkSeconds))).toEqual(["4001511883701836730"]);
  });

  it("counts a collab for each co-author and matches by handle while the id is unknown", () => {
    const collab = rec("4000000000000000001", { username: "partner", userid: "555",
      coauthors: [{ id: "555", username: "partner" }, { id: OWNER, username: "barbie.the.aries" }] });
    expect(ids(spyGridPosts([collab], "barbie.the.aries", OWNER, new Map(), pkSeconds))).toEqual(["4000000000000000001"]);
    const own = rec("4000000000000000002", { userid: null });
    expect(ids(spyGridPosts([own], "Barbie.The.Aries", null, new Map(), pkSeconds))).toEqual(["4000000000000000002"]);
  });

  it("dates a Reels-tab item that has no taken_at from its id, and prefers taken_at", () => {
    const [noTime, withTime] = spyGridPosts([
      rec("4000212975751592878", { taken_at: null }), rec("4000129946038190881", { taken_at: 1791072704 }),
    ], "barbie.the.aries", OWNER, new Map(), pkSeconds);
    expect(noTime).toMatchObject({ id: "4000212975751592878", createdAt: 1791082568 });
    expect(noTime.createdAt).toBe(pkSeconds("4000212975751592878"));
    expect([noTime.exactDate, withTime.exactDate]).toEqual([false, true]);
    expect(withTime.createdAt).toBe(1791072704);
  });

  it("skips what was already sent, other grids and ids that are not media ids", () => {
    const records = [rec("4000000000000000003"), rec("4000000000000000004", { surface: "profile:other" }),
      rec("4000000000000000005", { surface: "related:profile:barbie.the.aries" }), rec("abc")];
    const sent = new Map([["4000000000000000003", "|||1791000003"]]);
    expect(ids(spyGridPosts(records, "barbie.the.aries", OWNER, sent, pkSeconds))).toEqual([]);
  });

  it("marks a post pinned only when this profile pinned it", () => {
    const records = [rec("4000000000000000006", { pinned_by: [OWNER] }), rec("4000000000000000007", { pinned_by: ["999"] })];
    expect(spyGridPosts(records, "barbie.the.aries", OWNER, new Map(), pkSeconds).map((p) => p.pinned)).toEqual([true, false]);
  });
});

describe("the week's numbers for the top 3", () => {
  const OWNER = "27092017544";
  const reel = (extra = {}) => ({ pk: "4001511883701836730", code: "DeIOdt4jVu6", taken_at: 1791237442, media_type: "video",
    surface: "profile:barbie.the.aries", username: "barbie.the.aries", userid: OWNER, pinned_by: [],
    play_count: 528, like_count: 12, comment_count: 13, thumb: "https://cdn/t.jpg", ...extra });

  it("sends views, likes, comments, the link code and the image address", () => {
    const [{ sig, ...post }] = spyGridPosts([reel()], "barbie.the.aries", OWNER, new Map(), pkSeconds);
    expect(sig).toBe("528|12|13|1791237442");
    expect([post]).toEqual([{
      id: "4001511883701836730", createdAt: 1791237442, exactDate: true, mediaType: "video", pinned: false, code: "DeIOdt4jVu6",
      views: 528, likes: 12, comments: 13, thumbUrl: "https://cdn/t.jpg",
    }]);
  });

  it("sends a post again when its numbers move, and not otherwise", () => {
    const sent = new Map();
    const [first] = spyGridPosts([reel()], "barbie.the.aries", OWNER, sent, pkSeconds);
    sent.set(first.id, first.sig);
    expect(spyGridPosts([reel()], "barbie.the.aries", OWNER, sent, pkSeconds)).toEqual([]);
    expect(spyGridPosts([reel({ play_count: 600 })], "barbie.the.aries", OWNER, sent, pkSeconds)).toHaveLength(1);
  });
});
