import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Run the actual import-free MAIN script: profile data can arrive at
// document_start, before the isolated bridge subscribes at document_idle.
describe("Instagram passive profile replay", () => {
  it("replays cached user stats to late and replacement bridges", () => {
    const delivered = [];
    const handlers = {};
    const page = {
      location: { pathname: "/nasa/", search: "", hash: "#socialmate-spy", origin: "https://www.instagram.com" },
      document: { visibilityState: "hidden", querySelectorAll: () => [], addEventListener: () => {} },
      setInterval: () => 1, setTimeout: () => 1, XMLHttpRequest: function () {}, URL,
    };
    page.XMLHttpRequest.prototype.setRequestHeader = () => {};
    page.window = page;
    page.postMessage = (message) => delivered.push(message);
    page.addEventListener = (event, listener) => { handlers[event] = listener; };
    const context = vm.createContext(page);
    vm.runInContext(readFileSync(new URL("./main-world.js", import.meta.url), "utf8"), context);
    vm.runInContext('JSON.parse(\'{"user":{"pk":"123","username":"nasa","follower_count":42}}\')', context);
    delivered.length = 0; // no bridge was listening to the original sighting
    page.relay = handlers.message;
    for (let bridge = 0; bridge < 2; bridge++) {
      vm.runInContext('relay({source:window,data:{__fbwIgReq:true}})', context);
      expect(delivered.at(-1)?.records || []).toContainEqual(expect.objectContaining({
        __kind: "user", userid: "123", username: "nasa", follower_count: 42,
      }));
      delivered.length = 0;
    }
  });
});

describe("Instagram grid posts for posts per day", () => {
  it("keeps the publication time, the surface and who pinned each post", () => {
    const delivered = [];
    const handlers = {};
    const page = {
      location: { pathname: "/nasa/", search: "", hash: "#socialmate-spy", origin: "https://www.instagram.com" },
      document: { visibilityState: "hidden", querySelectorAll: () => [], addEventListener: () => {} },
      setInterval: () => 1, setTimeout: () => 1, XMLHttpRequest: function () {}, URL,
    };
    page.XMLHttpRequest.prototype.setRequestHeader = () => {};
    page.window = page;
    page.postMessage = (message) => delivered.push(message);
    page.addEventListener = (event, listener) => { handlers[event] = listener; };
    const context = vm.createContext(page);
    vm.runInContext(readFileSync(new URL("./main-world.js", import.meta.url), "utf8"), context);
    const node = (code, pk, takenAt, pinned) => ({ code, pk, taken_at: takenAt, media_type: 1,
      image_versions2: { candidates: [{ url: "https://x/i.jpg" }] },
      timeline_pinned_user_ids: pinned, user: { pk: "123", username: "nasa" },
      coauthor_producers: [{ pk: "123", username: "nasa" }, { pk: "456", username: "partner" }] });
    const payload = { data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [
      { node: node("AAA", "3001", 1791000000, ["123"]) }, { node: node("BBB", "3002", 1791000100, []) }] } } };
    vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(payload))})`, context);
    page.relay = handlers.message;
    vm.runInContext('relay({source:window,data:{__fbwIgReq:true}})', context);
    const records = delivered.flatMap((m) => m.records || []);
    expect(records).toContainEqual(expect.objectContaining({ code: "AAA", pk: "3001", taken_at: 1791000000,
      pinned_by: ["123"], __surface: "profile:nasa", userid: "123",
      coauthors: [{ id: "123", username: "nasa" }, { id: "456", username: "partner" }] }));
    expect(records).toContainEqual(expect.objectContaining({ code: "BBB", pinned_by: [] }));
  });
});

describe("first reading: more grid pages from a hidden tab", () => {
  // A hidden tab never scrolls the grid, so the MAIN world asks for the next pages
  // itself with the query the page sent, its cursor and the page's own doc_id.
  function boot({ requireStub } = {}) {
    const delivered = [];
    const handlers = {};
    const fetches = [];
    const page = {
      location: { pathname: "/barbie.the.aries/", search: "", hash: "#socialmate-spy", origin: "https://www.instagram.com" },
      document: { visibilityState: "hidden", querySelectorAll: () => [], addEventListener: () => {} },
      setInterval: () => 1, setTimeout: (fn) => { Promise.resolve().then(fn); return 1; }, URL, URLSearchParams, Promise,
      Math: Object.create(Math, { random: { value: () => 0 } }),
    };
    page.XMLHttpRequest = function () {};
    page.XMLHttpRequest.prototype.open = function () {};
    page.XMLHttpRequest.prototype.send = function () {};
    page.XMLHttpRequest.prototype.setRequestHeader = function () {};
    page.window = page;
    page.require = requireStub;
    page.postMessage = (message) => delivered.push(message);
    page.addEventListener = (event, listener) => { handlers[event] = listener; };
    const pageOf = (n, cursor, hasNext, takenAt) => JSON.stringify({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
      edges: [{ node: { code: `C${n}`, pk: String(4000000000000000000 + n), taken_at: takenAt, media_type: 2,
        image_versions2: { candidates: [{ url: "u" }] }, video_versions: [{ url: "v" }],
        user: { pk: "27092017544", username: "barbie.the.aries" } } }],
      page_info: { end_cursor: cursor, has_next_page: hasNext } } } });
    let served = 1;
    page.fetch = async (url, init) => {
      fetches.push({ url, init });
      served += 1;
      return { ok: true, status: 200, text: async () => pageOf(served, `CUR${served}`, served < 3, 1791000000 - served * 86400) };
    };
    const context = vm.createContext(page);
    vm.runInContext(readFileSync(new URL("./main-world.js", import.meta.url), "utf8"), context);
    // The page's own first-page query, then its response.
    const variables = JSON.stringify({ data: { count: 12 }, username: "barbie.the.aries", __relay_internal__pv__X: true });
    const body = new URLSearchParams({ doc_id: "111", fb_api_req_friendly_name: "PolarisProfilePostsQuery", variables, lsd: "L" }).toString();
    vm.runInContext(`(() => { const x = new XMLHttpRequest(); x.open("POST", "/graphql/query"); x.setRequestHeader("X-FB-LSD", "L");
      x.setRequestHeader("X-FB-Friendly-Name", "PolarisProfilePostsQuery"); x.send(${JSON.stringify(body)}); })()`, context);
    vm.runInContext(`JSON.parse(${JSON.stringify(pageOf(1, "CUR1", true, 1791000000))})`, context);
    // Inside the context `window` is the contextified global, not `page` itself.
    return { page, win: vm.runInContext("window", context), handlers, delivered, fetches, context };
  }
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

  it("asks for the next pages with the cursor and the page's doc_id until there are no more", async () => {
    const t = boot({ requireStub: (name) => ({ params: { id: name.startsWith("PolarisProfilePostsTabContentQuery") ? "222" : "?" } }) });
    t.handlers.message({ source: t.win, data: { __fbwIgDeep: { username: "barbie.the.aries", maxPages: 4, untilSec: 0 } } });
    await settle();
    expect(t.fetches).toHaveLength(2); // page 3 says has_next_page: false
    const form = new URLSearchParams(t.fetches[0].init.body);
    expect(form.get("doc_id")).toBe("222");
    expect(form.get("fb_api_req_friendly_name")).toBe("PolarisProfilePostsTabContentQuery_connection");
    expect(form.get("lsd")).toBe("L");
    expect(JSON.parse(form.get("variables"))).toMatchObject({ after: "CUR1", first: 12, username: "barbie.the.aries",
      data: { count: 12 }, __relay_internal__pv__X: true });
    expect(JSON.parse(new URLSearchParams(t.fetches[1].init.body).get("variables")).after).toBe("CUR2");
    expect(t.fetches[0].init.headers).toMatchObject({ "X-FB-LSD": "L", "X-FB-Friendly-Name": "PolarisProfilePostsTabContentQuery_connection" });
    const done = t.delivered.find((m) => m.__fbwIgDeepDone);
    expect(done.__fbwIgDeepDone).toEqual({ username: "barbie.the.aries", ok: true, pages: 2, done: true });
    const codes = t.delivered.flatMap((m) => m.records || []).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["C2", "C3"]));
  });

  it("stops once the grid reaches the oldest day wanted, and falls back to the first query's doc_id", async () => {
    const t = boot({ requireStub: () => { throw new Error("not loaded"); } });
    t.handlers.message({ source: t.win, data: { __fbwIgDeep: { username: "barbie.the.aries", maxPages: 4, untilSec: 1791000000 - 2 * 86400 } } });
    await settle();
    expect(t.fetches).toHaveLength(1); // page 2 is already 2 days back
    expect(new URLSearchParams(t.fetches[0].init.body).get("doc_id")).toBe("111");
  });

  it("does nothing for another profile's grid", async () => {
    const t = boot();
    t.handlers.message({ source: t.win, data: { __fbwIgDeep: { username: "someone.else", maxPages: 4, untilSec: 0 } } });
    await settle();
    expect(t.fetches).toHaveLength(0);
    expect(t.delivered.find((m) => m.__fbwIgDeepDone).__fbwIgDeepDone).toMatchObject({ ok: false, error: "no_grid" });
  });
});

describe("a reading's Reels tab: views for the whole week", () => {
  const mintedAt = (pk) => Number(((BigInt(pk) >> 23n) + 1314220021721n) / 1000n);
  const PKS = ["4001511883701836730", "4000212975751592878", "3999464916472908097", "3998039909910548690"]; // 05/10 … 30/09
  it("opens the Reels tab, puts the batch hash back, and pages the reels back to the oldest day wanted", async () => {
    const delivered = []; const handlers = {}; const fetches = []; const replaced = [];
    const location = { pathname: "/barbie.the.aries/", search: "", hash: "#socialmate-spy", origin: "https://www.instagram.com" };
    const page = {
      location,
      document: { visibilityState: "hidden", querySelectorAll: () => [], addEventListener: () => {}, querySelector: () => null },
      history: { state: null, replaceState: (_s, _t, url) => { replaced.push(url); location.hash = url.slice(url.indexOf("#")); } },
      setInterval: () => 1, setTimeout: (fn) => { Promise.resolve().then(fn); return 1; }, URL, URLSearchParams,
    };
    page.XMLHttpRequest = function () {};
    page.XMLHttpRequest.prototype.open = function () {};
    page.XMLHttpRequest.prototype.send = function () {};
    page.XMLHttpRequest.prototype.setRequestHeader = function () {};
    page.window = page;
    page.require = (name) => ({ params: { id: name === "PolarisProfileReelsTabContentQuery_connection.graphql" ? "R2" : "G2" } });
    page.postMessage = (message) => delivered.push(message);
    page.addEventListener = (event, listener) => { handlers[event] = listener; };
    const reelsAnswer = (pks, cursor, hasNext) => JSON.stringify({ data: { fetch__XDTUserDict: { clips_connection: {
      edges: pks.map((pk) => ({ node: { media: { pk, code: `R${pk.slice(-4)}`, user: { pk: "27092017544" }, play_count: 1000,
        like_count: 10, image_versions2: { candidates: [{ url: "u" }] }, video_versions: [{ url: "v" }] } } })),
      page_info: { end_cursor: cursor, has_next_page: hasNext } } } } });
    page.fetch = async (url, init) => {
      fetches.push(init);
      return { ok: true, status: 200, text: async () => reelsAnswer([PKS[2], PKS[3]], "RC2", true) };
    };
    const context = vm.createContext(page);
    vm.runInContext(readFileSync(new URL("./main-world.js", import.meta.url), "utf8"), context);
    const win = vm.runInContext("window", context);
    // The grid: its own query and a last page.
    const gridVars = JSON.stringify({ data: { count: 12 }, username: "barbie.the.aries" });
    vm.runInContext(`(() => { const x = new XMLHttpRequest(); x.open("POST", "/graphql/query");
      x.send(${JSON.stringify(new URLSearchParams({ doc_id: "G1", fb_api_req_friendly_name: "PolarisProfilePostsQuery", variables: gridVars }).toString())}); })()`, context);
    vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: {
      edges: [], page_info: { end_cursor: null, has_next_page: false } } } }))})`, context);
    // Clicking the Reels link: Instagram navigates in-page (dropping the hash) and sends its reels query.
    const reelsVars = JSON.stringify({ data: { include_feed_video: true, page_size: 12, target_user_id: "27092017544" }, user_id: "27092017544", __relay_internal__pv__X: false });
    const link = { click: () => {
      location.pathname = "/barbie.the.aries/reels/"; location.hash = "";
      vm.runInContext(`(() => { const x = new XMLHttpRequest(); x.open("POST", "/graphql/query"); x.setRequestHeader("X-FB-LSD", "L");
        x.send(${JSON.stringify(new URLSearchParams({ doc_id: "R1", fb_api_req_friendly_name: "PolarisProfileReelsTabContentQuery", variables: reelsVars, lsd: "L" }).toString())}); })()`, context);
      vm.runInContext(`JSON.parse(${JSON.stringify(reelsAnswer([PKS[0], PKS[1]], "RC1", true))})`, context);
    } };
    page.document.querySelector = (sel) => (sel === 'a[href="/barbie.the.aries/reels/"]' ? link : null);
    handlers.message({ source: win, data: { __fbwIgDeep: { username: "barbie.the.aries",
      grid: { maxPages: 8, untilSec: 0 }, reels: { maxPages: 8, untilSec: mintedAt(PKS[3]) + 60 } } } });
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));

    expect(replaced).toEqual(["/barbie.the.aries/reels/#socialmate-spy"]);
    expect(fetches).toHaveLength(1); // page 2 reaches 30/09, past the oldest day wanted
    const form = new URLSearchParams(fetches[0].body);
    expect(form.get("doc_id")).toBe("R2");
    expect(JSON.parse(form.get("variables"))).toEqual({ after: "RC1", first: 12, id: "27092017544",
      data: { include_feed_video: true, page_size: 12, target_user_id: "27092017544" }, __relay_internal__pv__X: false });
    expect(fetches[0].headers).toMatchObject({ "X-FB-LSD": "L", "X-FB-Friendly-Name": "PolarisProfileReelsTabContentQuery_connection" });
    expect(delivered.find((m) => m.__fbwIgDeepDone).__fbwIgDeepDone).toMatchObject({ ok: true, pages: 0, reelsPages: 1 });
    const views = delivered.flatMap((m) => m.records || []).filter((r) => r.play_count === 1000).map((r) => r.pk);
    expect(views).toEqual(expect.arrayContaining(PKS));
  });
});
