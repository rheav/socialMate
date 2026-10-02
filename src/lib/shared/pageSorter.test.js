// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makePageSorter } from "./pageSorter.js";

const FIELDS = {
  views: { label: "Visualizações", kind: "number", get: (r) => r.views },
  likes: { label: "Curtidas", kind: "number", get: (r) => r.likes },
  date: { label: "Data", kind: "date", get: (r) => r.date },
};

function fakeStorage(initial = {}) {
  const data = { ...initial };
  const listeners = [];
  return {
    data,
    get: async (k) => ({ [k]: data[k] }),
    set: (obj) => {
      const changes = {};
      for (const k in obj) { changes[k] = { newValue: obj[k] }; data[k] = obj[k]; }
      listeners.forEach((fn) => fn(changes));
    },
    onChanged: (fn) => listeners.push(fn),
    fire(k, v) { data[k] = v; listeners.forEach((fn) => fn({ [k]: { newValue: v } })); },
  };
}

const RECS = { a: { views: 10, likes: 1 }, b: { views: 30, likes: 3 }, c: { views: 20, likes: 9 } };
const keyOf = (a) => (a.getAttribute("href").match(/\/p\/(\w+)/) || [])[1] || null;
const order = () => [...document.querySelectorAll(".cell a")].map(keyOf);
const flush = () => new Promise((r) => setTimeout(r, 0));

const live = [];
function mount(storage, recs = RECS, extra = {}) {
  document.body.innerHTML = `<main><div class="row">${["a", "b", "c", "x"]
    .map((k) => `<div class="cell"><a href="/p/${k}/"><img></a></div>`)
    .join("")}</div></main>`;
  return track(makePageSorter({
    storage,
    storageKey: "q",
    fields: FIELDS,
    linkSelector: 'a[href*="/p/"]',
    keyOf,
    recordOf: (k) => recs[k] || null,
    ...extra,
  }));
}
// A sorter outlives its test otherwise, and its pending pass redraws ITS bar into
// the next test's document.
function track(ps) { live.push(ps); return ps; }

describe("makePageSorter", () => {
  it('resets sort when a platform surface changes only its query string', async () => {
    let surface = 'profile:123';
    const st = fakeStorage({});
    const ps = mount(st, RECS, { routeKey: () => surface });
    await flush(); ps.applyNow();
    st.fire('q', { sorts: [{key:'views',dir:'desc'}] }); ps.applyNow();
    expect(order()).toEqual(['b','c','a','x']);
    surface = 'profile:456'; ps.applyNow();
    expect(ps.getQuery().sorts).toEqual([]);
    expect(order()).toEqual(['a','b','c','x']);
  });
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(() => { while (live.length) live.pop().destroy(); });

  it("reorders the grid by the query, tiles without a record last", async () => {
    const st = fakeStorage({});
    const ps = mount(st);
    await flush();
    ps.applyNow();
    st.fire("q", { sorts: [{ key: "views", dir: "desc" }] });
    ps.applyNow();
    expect(order()).toEqual(["b", "c", "a", "x"]);
  });

  it("follows a change made elsewhere (the side panel)", async () => {
    const st = fakeStorage({});
    const ps = mount(st);
    await flush();
    ps.applyNow();
    st.fire("q", { sorts: [{ key: "views", dir: "desc" }] });
    ps.applyNow();
    st.fire("q", { sorts: [{ key: "likes", dir: "desc" }] });
    ps.applyNow();
    expect(order()).toEqual(["c", "b", "a", "x"]);
  });

  it("puts the site's own order back when the query is cleared", async () => {
    const st = fakeStorage({});
    const ps = mount(st);
    await flush();
    ps.applyNow();
    st.fire("q", { sorts: [{ key: "views", dir: "asc" }] });
    ps.applyNow();
    expect(order()).toEqual(["a", "c", "b", "x"]);
    st.fire("q", { sorts: [] });
    ps.applyNow();
    expect(order()).toEqual(["a", "b", "c", "x"]);
  });

  it("hides what a filter rejects and keeps unknown tiles visible", async () => {
    const st = fakeStorage({ q: { filters: [{ field: "views", op: "gte", value: 20 }] } });
    const ps = mount(st);
    await flush();
    ps.applyNow();
    const hidden = [...document.querySelectorAll(".cell")].filter((c) => c.style.display === "none").map((c) => keyOf(c.querySelector("a")));
    expect(hidden).toEqual(["a"]);
  });

  it("the bar's select writes the query back to storage", async () => {
    const st = fakeStorage({});
    const ps = mount(st);
    await flush();
    ps.applyNow();
    const sel = document.querySelector('#sw-psort [data-ps="key"]');
    sel.value = "likes";
    sel.dispatchEvent(new Event("change"));
    expect(st.data.q.sorts).toEqual([{ key: "likes", dir: "desc" }]);
    ps.applyNow();
    expect(order()).toEqual(["c", "b", "a", "x"]);
  });

  it("shows no bar off a grid route", async () => {
    const st = fakeStorage({});
    document.body.innerHTML = "";
    const ps = track(makePageSorter({ storage: st, storageKey: "q", fields: FIELDS, linkSelector: "a", keyOf, recordOf: () => null, routeOk: () => false }));
    await flush();
    ps.applyNow();
    expect(document.getElementById("sw-psort")).toBe(null);
  });

  it("opens every grid page in the site's own order, even if a sort was stored", async () => {
    const st = fakeStorage({ q: { sorts: [{ key: "views", dir: "desc" }], filters: [{ field: "views", op: "gte", value: 1 }] } });
    const ps = mount(st);
    await flush();
    ps.applyNow();
    expect(order()).toEqual(["a", "b", "c", "x"]);
    expect(st.data.q.sorts).toEqual([]);
    expect(st.data.q.filters).toHaveLength(1); // filters survive
  });

  it("hopping to another grid page starts over at the site's order", async () => {
    const st = fakeStorage({});
    const ps = mount(st);
    await flush();
    ps.applyNow();
    st.fire("q", { sorts: [{ key: "views", dir: "desc" }] });
    ps.applyNow();
    expect(order()).toEqual(["b", "c", "a", "x"]);
    history.pushState({}, "", "/another-profile/");
    ps.applyNow();
    expect(st.data.q.sorts).toEqual([]);
    expect(order()).toEqual(["a", "b", "c", "x"]);
    history.pushState({}, "", "/");
  });
});
