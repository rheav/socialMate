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
    const sent = new Map([["4000000000000000003", "|||1791000003|"]]);
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
    expect(sig).toBe("528|12|13|1791237442|");
    expect([post]).toEqual([{
      id: "4001511883701836730", createdAt: 1791237442, exactDate: true, mediaType: "video", pinned: false, code: "DeIOdt4jVu6",
      views: 528, likes: 12, comments: 13, durationS: null, observedAt: expect.any(Number), thumbUrl: "https://cdn/t.jpg",
    }]);
  });

  it("sends a post again when its numbers move, and not otherwise", () => {
    const sent = new Map();
    const [first] = spyGridPosts([reel()], "barbie.the.aries", OWNER, sent, pkSeconds);
    sent.set(first.id, first.sig);
    expect(spyGridPosts([reel()], "barbie.the.aries", OWNER, sent, pkSeconds)).toEqual([]);
    expect(spyGridPosts([reel({ play_count: 600 })], "barbie.the.aries", OWNER, sent, pkSeconds)).toHaveLength(1);
  });

  it("forwards video duration and observes duration enrichment even with unchanged counts", () => {
    const sent = new Map();
    const [first] = spyGridPosts([reel()], "barbie.the.aries", OWNER, sent, pkSeconds);
    sent.set(first.id, first.sig);
    const [enriched] = spyGridPosts([reel({ duration: 42.5 })], "barbie.the.aries", OWNER, sent, pkSeconds);
    expect(enriched).toMatchObject({ durationS: 42.5, observedAt: expect.any(Number) });
    expect(spyGridPosts([reel({ duration: -2 })], "barbie.the.aries", OWNER, new Map(), pkSeconds)[0].durationS).toBeNull();
  });
});

const exportSource = bridge.match(/^function igExportMessages\([^)]*\) \{[\s\S]*?\n\}/m)[0];
const igExportMessages = new Function(`${exportSource}; return igExportMessages;`)();

describe("research export messages", () => {
  const post = { code: "CCC", pk: "3003", username: "nasa" };

  it("sends posts and the comments whose post is known, with that post's owner", () => {
    const held = new Map([["9001", { cid: "9001", post: "CCC", text: "oi", __queuedAt: 0 }]]);
    const [msg] = igExportMessages([post], held, { CCC: post }, 1000);
    expect(msg).toEqual({
      type: "FBW_IG_CAPTURE",
      posts: [post],
      comments: [{ cid: "9001", post: "CCC", text: "oi" }],
      postsByCode: { CCC: { code: "CCC", pk: "3003", username: "nasa" } },
    });
    expect(held.size).toBe(0);
  });

  it("holds a comment until its post is known, then gives up after ten minutes", () => {
    const held = new Map([["9001", { cid: "9001", post: "DDD", text: "oi", __queuedAt: 0 }]]);
    expect(igExportMessages([], held, {}, 60_000)).toEqual([]);
    expect(held.size).toBe(1);
    expect(igExportMessages([], held, {}, 11 * 60_000)).toEqual([]);
    expect(held.size).toBe(0);
  });

  it("splits large captures into messages of at most 500 records", () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ ...post, code: `C${i}`, pk: String(4000 + i) }));
    const msgs = igExportMessages(many, new Map(), {}, 0);
    expect(msgs.map((m) => m.posts.length)).toEqual([500, 500, 200]);
  });
});

const collectSource = bridge.match(/^async function igAnalysisCollect\([^)]*\) \{[\s\S]*?\n\}/m)[0];
const metaSource = bridge.match(/^function igTranscriptMeta\([^)]*\) \{[\s\S]*?\n\}/m)[0];
const igAnalysisCollect = new Function(`${metaSource}; ${collectSource}; return igAnalysisCollect;`)();
const buttonSource = bridge.match(/^function igExpandButton\([^)]*\) \{[\s\S]*?\n\}/m)[0];

describe("analysis tab collection", () => {
  const rec = { code: "CCC", pk: "3003", username: "nasa", caption: "curta", comment_count: 3, duration: 41, media_type: "video",
    coauthors: [{ username: "nasa" }, { username: "partner" }] };
  function env(over = {}) {
    let clock = 0;
    const comments = [{ cid: "1", text: "oi" }];
    return {
      currentCode: () => "CCC",
      url: () => "https://www.instagram.com/p/CCC/",
      recordOf: (code) => (code === "CCC" ? rec : null),
      captionOf: () => "curta mas inteira",
      variantsOf: () => [{ w: 720, h: 1280, url: "https://x/720.mp4" }],
      commentsOf: () => comments,
      expand: async ({ count }) => ({ stopReason: "exhausted", captured: count(), expansions: 0 }),
      findButton: () => null,
      click: async () => {},
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      cancelled: () => false,
      requestReplay: () => {},
      ...over,
    };
  }

  it("answers for the post the URL names, with its full caption, renditions and comments", async () => {
    const out = await igAnalysisCollect({ code: "CCC", mediaPk: "3003", comments: true }, env());
    expect(out).toMatchObject({
      ok: true, code: "CCC", pk: "3003", url: "https://www.instagram.com/p/CCC/",
      caption: { text: "curta mas inteira", full: true },
      variants: [{ w: 720, h: 1280 }], durationS: 41, authors: ["nasa", "partner"],
      comments: { items: [{ cid: "1" }], stopReason: "exhausted", order: "page", reportedTotal: 3 },
    });
  });

  it("hands over the post's author, picture, numbers and date, as the overlay's Transcrever does", async () => {
    const full = { ...rec, image: "https://cdn/thumb.jpg", like_count: 42, play_count: 1100, repost: 3, taken_at: 1792037451, user_follower_count: 9000 };
    const out = await igAnalysisCollect({ code: "CCC", mediaPk: "3003" }, env({ recordOf: () => full }));
    expect(out.meta).toEqual({
      author: { name: "nasa", url: "/nasa/" },
      thumb: "https://cdn/thumb.jpg",
      counts: { like: 42, comment: 3, views: 1100, share: 3 },
      takenAt: 1792037451,
      followers: 9000,
    });
  });

  it("refuses another page, another media under the same code, and a post that never shows", async () => {
    expect(await igAnalysisCollect({ code: "DDD", mediaPk: "3003" }, env())).toEqual({ ok: false, error: "other_page" });
    expect(await igAnalysisCollect({ code: "CCC", mediaPk: "9999" }, env())).toEqual({ ok: false, error: "post_mismatch" });
    const late = env({ recordOf: () => null });
    expect(await igAnalysisCollect({ code: "CCC", mediaPk: "3003", waitMs: 5000 }, late)).toEqual({ ok: false, error: "post_not_found" });
  });

  it("marks a caption known only by its 500-character preview as partial", async () => {
    const long = { ...rec, caption: "x".repeat(500) };
    const out = await igAnalysisCollect({ code: "CCC", mediaPk: "3003" }, env({ recordOf: () => long, captionOf: () => null }));
    expect(out.caption).toEqual({ text: "x".repeat(500), full: false });
    expect(out.comments).toBeNull();
  });

  it("stops when cancelled while waiting for the post", async () => {
    let n = 0;
    const out = await igAnalysisCollect({ code: "CCC", mediaPk: "3003" }, env({ recordOf: () => null, cancelled: () => ++n > 2 }));
    expect(out).toEqual({ ok: false, error: "cancelled" });
  });
});

describe("thread buttons the analysis tab presses", () => {
  const igExpandButton = new Function("isExpandLabel", `${buttonSource}; return igExpandButton;`)(
    (label) => /^(view replies|load more comments)/i.test(label.replace(/^[^a-z]+/i, "")),
  );

  it("finds reply and load-more buttons, never the hide or reply ones, and gives up on one that keeps coming back", () => {
    document.body.innerHTML = `<main>
      <button id="hide">Hide replies</button>
      <div role="button" id="reply">Reply</div>
      <button id="more"><div></div><span>—— View replies (3)</span></button>
      <div role="button" id="plus"><svg aria-label="Load more comments"></svg></div>
    </main>`;
    const clicks = new Map();
    expect(igExpandButton(document.body, clicks).id).toBe("more");
    clicks.set(document.getElementById("more"), 3);
    expect(igExpandButton(document.body, clicks).id).toBe("plus");
    clicks.set(document.getElementById("plus"), 3);
    expect(igExpandButton(document.body, clicks)).toBeNull();
  });
});
