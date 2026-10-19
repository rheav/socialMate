import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createStoriesPass } from "./spyStories.js";
import { parseStoriesHtml } from "../lib/spyStories.js";

// The stories pass, service-worker side: one profile at a time, the page first,
// the API as a fallback, every network call through the injected fetch.
const fixture = readFileSync(new URL("../lib/fixtures/ig-stories-page.html", import.meta.url), "utf8");
const settings = { enabled: true, url: "https://hub", token: "t" };
const profile = { id: "instagram:natgeo", key: "natgeo", userId: "7", storyPks: [] };
const apiFixture = () => {
  const reel = parseStoriesHtml(fixture);
  return { reels: { 7: { id: reel.reelId, user: { username: "claire_mayaus" }, items: reel.items } } };
};

function fetchStub(routes) {
  return vi.fn(async (url, init) => {
    for (const [match, answer] of routes) if (String(url).includes(match)) return typeof answer === "function" ? answer(url, init) : answer;
    throw new Error("unexpected " + url);
  });
}
const html = (body, url = "https://www.instagram.com/stories/natgeo/?r=1") =>
  ({ ok: true, status: 200, url, text: async () => body, json: async () => ({}) });
const EMPTY_PAGE = '<html><script type="application/json">{"a":1}</script></html>';

function storageStub() {
  const data = {};
  return {
    data,
    get: async (key) => {
      const keys = typeof key === "string" ? [key] : key;
      const out = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    set: async (obj) => { Object.assign(data, structuredClone(obj)); },
  };
}

let deps;
beforeEach(() => {
  deps = {
    fetchImpl: fetchStub([]),
    storage: storageStub(),
    readSyncSettings: async () => settings,
    logSpy: vi.fn(async () => {}),
    blockPlatform: vi.fn(async () => {}),
    isBlockedNow: () => false,
    serialize: (work) => work(),
    flush: vi.fn(async () => ({ ok: true })),
    makePoster: vi.fn(async () => new Blob(["p"], { type: "image/webp" })),
    random: () => 0,
    now: () => Date.now(),
  };
});

describe("readProfile", () => {
  it("fetches the stories page with the session and reduces the new items", async () => {
    const fetchImpl = fetchStub([["/stories/natgeo/", html(fixture)]]);
    const out = await createStoriesPass({ ...deps, fetchImpl }).readProfile(profile, settings);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://www.instagram.com/stories/natgeo/");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: "include" });
    expect(out.ok).toBe(true);
    expect(out.items.map((i) => i.input.id)).toEqual(["4010802020595923127", "4010802020595923128"]);
  });
  it("skips the pks the hub already has", async () => {
    const pass = createStoriesPass({ ...deps, fetchImpl: fetchStub([["/stories/natgeo/", html(fixture)]]) });
    const out = await pass.readProfile({ ...profile, storyPks: ["4010802020595923127"] }, settings);
    expect(out.items.map((i) => i.input.id)).toEqual(["4010802020595923128"]);
  });
  it("answers no items when the account has no story now", async () => {
    const page = '<html><script type="application/json">{"data":{"xdt_api__v1__feed__reels_media":{"reels_media":[]}}}</script></html>';
    const fetchImpl = fetchStub([["/stories/natgeo/", html(page)]]);
    const out = await createStoriesPass({ ...deps, fetchImpl }).readProfile(profile, settings);
    expect(out).toEqual({ ok: true, items: [], reelId: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("falls back to the reels_media API when the page has no reel", async () => {
    const fetchImpl = fetchStub([
      ["/stories/natgeo/", html(EMPTY_PAGE)],
      ["/api/v1/feed/reels_media/", { ok: true, status: 200, url: "", json: async () => apiFixture(), text: async () => "" }],
    ]);
    const out = await createStoriesPass({ ...deps, fetchImpl }).readProfile(profile, settings);
    expect(out.ok).toBe(true);
    expect(out.items.length).toBe(2);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=7");
    expect(fetchImpl.mock.calls[1][1].headers["x-ig-app-id"]).toBe("936619743392459");
  });
  it("reports a page without the reel as a failure, not as empty", async () => {
    const fetchImpl = fetchStub([
      ["/stories/natgeo/", html(EMPTY_PAGE)],
      ["/api/v1/feed/reels_media/", { ok: true, status: 200, url: "", json: async () => ({}), text: async () => "" }],
    ]);
    expect(await createStoriesPass({ ...deps, fetchImpl }).readProfile(profile, settings)).toEqual({ ok: false, error: "no_reel" });
  });
  it("names a login wall and a rate limit", async () => {
    const limited = fetchStub([["/stories/", { ok: false, status: 429, url: "", text: async () => "", json: async () => ({}) }]]);
    expect((await createStoriesPass({ ...deps, fetchImpl: limited }).readProfile(profile, settings)).error).toBe("rate_limited");
    const wall = fetchStub([["/stories/", html("", "https://www.instagram.com/accounts/login/?next=%2Fstories%2Fnatgeo%2F")]]);
    expect((await createStoriesPass({ ...deps, fetchImpl: wall }).readProfile(profile, settings)).error).toBe("login_required");
    const down = fetchStub([["/stories/", () => { throw new TypeError("Failed to fetch"); }]]);
    expect((await createStoriesPass({ ...deps, fetchImpl: down }).readProfile(profile, settings)).error).toBe("network");
  });
});
