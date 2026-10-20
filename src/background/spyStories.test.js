import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStoriesPass, STORIES_ALARM } from "./spyStories.js";
import { parseStoriesHtml, reduceStory } from "../lib/spyStories.js";
import { SPY_KEY, SPY_QUEUE_KEY, SPY_STATE_KEY } from "../lib/spyStore.js";

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
let alarms;
beforeEach(() => {
  alarms = {};
  deps = {
    fetchImpl: fetchStub([]),
    storage: storageStub(),
    alarms: { create: (name, info) => { alarms[name] = info; }, clear: async (name) => { delete alarms[name]; } },
    readSyncSettings: async () => settings,
    logSpy: vi.fn(async () => {}),
    blockPlatform: vi.fn(async () => {}),
    isBlockedNow: () => false,
    serialize: (work) => work(),
    flush: vi.fn(async () => ({ ok: true })),
    makePoster: vi.fn(async () => new Blob(["p"], { type: "image/webp" })),
    sendStory: vi.fn(async () => "sent"),
    random: () => 0,
    now: () => Date.now(),
  };
});
afterEach(() => { vi.useRealTimers(); });

const tracked = (key, over = {}) => ({ id: `instagram:${key}`, platform: "instagram", key, userId: "7", removedAt: null, trackStories: true, storyPks: [], ...over });
async function seed(storage, profiles, state = {}) {
  await storage.set({ [SPY_KEY]: { profiles: Object.fromEntries(profiles.map((p) => [p.id, p])) }, [SPY_STATE_KEY]: { day: "", storiesSettings: { passesPerDay: 2, keepDays: 7 }, ...state } });
}
const history = () => deps.logSpy.mock.calls.map((c) => c[2]);
const readings = (storage) => Object.values(storage.data[SPY_QUEUE_KEY]?.readings || {});

describe("runPass", () => {
  it("reads the tracked profiles one at a time, 20–40 s apart, and logs one reading each", async () => {
    vi.useFakeTimers();
    const fetchImpl = fetchStub([["/stories/natgeo/", html(fixture)], ["/stories/nasa/", html(fixture, "https://www.instagram.com/stories/nasa/?r=1")]]);
    await seed(deps.storage, [tracked("natgeo"), tracked("nasa")]);
    const pass = createStoriesPass({ ...deps, fetchImpl, random: () => 0.5 });
    await pass.runPass({ source: "pass", slot: 0 });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["https://www.instagram.com/stories/natgeo/"]);
    expect(deps.sendStory).toHaveBeenCalledTimes(2);
    // The next step is also an alarm: a worker that stops between steps is woken for it.
    expect(alarms[STORIES_ALARM]).toEqual({ when: deps.storage.data[SPY_STATE_KEY].stories.job.nextAt });
    await vi.advanceTimersByTimeAsync(29_000); // 20 s + 0.5 × 20 s = 30 s between profiles
    expect(fetchImpl.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["https://www.instagram.com/stories/natgeo/", "https://www.instagram.com/stories/nasa/"]);
    expect(readings(deps.storage)).toEqual([
      expect.objectContaining({ profileId: "instagram:natgeo", kind: "stories", source: "pass", ok: true, reelsAdded: 2 }),
      expect.objectContaining({ profileId: "instagram:nasa", kind: "stories", source: "pass", ok: true, reelsAdded: 2 }),
    ]);
    expect(deps.flush).toHaveBeenCalled();
    expect(history()[0]).toBe("Stories: passada 1 de 2 · 2 contas");
    expect(history()).toContain("Stories de @natgeo: +2");
    expect(history().at(-1)).toMatch(/^Stories: 2 contas, 4 novos, 0 falhas · próxima passada às \d\d:\d\d$/);
    const state = deps.storage.data[SPY_STATE_KEY];
    expect(state.stories.job).toBeNull();
    expect(state.stories.daily.passes).toEqual([expect.objectContaining({ slot: 0, profiles: 2, added: 4, failed: 0 })]);
  });
  it("stops on a rate limit, blocks Instagram and says so", async () => {
    const fetchImpl = fetchStub([["/stories/natgeo/", { ok: false, status: 429, url: "", text: async () => "", json: async () => ({}) }], ["/stories/nasa/", html(fixture)]]);
    await seed(deps.storage, [tracked("natgeo"), tracked("nasa")]);
    await createStoriesPass({ ...deps, fetchImpl }).runPass({ source: "pass", slot: 0 });
    expect(deps.blockPlatform).toHaveBeenCalledWith("instagram", "rate_limited", "instagram:natgeo", { kind: "stories", source: "pass" });
    expect(fetchImpl.mock.calls.length).toBe(1);
    expect(deps.storage.data[SPY_STATE_KEY].stories.job).toBeNull();
    expect(history().at(-1)).toBe("Stories: parou, o Instagram limitou a leitura · tenta de novo na próxima passada");
  });
  it("reports a page without the reel as a failed reading and goes on", async () => {
    vi.useFakeTimers();
    const fetchImpl = fetchStub([["/stories/natgeo/", html(EMPTY_PAGE)], ["/api/v1/feed/reels_media/", { ok: true, status: 200, url: "", json: async () => ({}), text: async () => "" }], ["/stories/nasa/", html(fixture)]]);
    await seed(deps.storage, [tracked("natgeo"), tracked("nasa")]);
    await createStoriesPass({ ...deps, fetchImpl }).runPass({ source: "pass", slot: 0 });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(readings(deps.storage)[0]).toMatchObject({ profileId: "instagram:natgeo", ok: false, error: "no_reel" });
    expect(history()).toContain("Stories de @natgeo: a página não trouxe os stories");
    expect(fetchImpl.mock.calls.length).toBe(3);
  });
  it("records the slot only for an automatic pass", async () => {
    await seed(deps.storage, [tracked("natgeo")]);
    const fetchImpl = fetchStub([["/stories/natgeo/", html(fixture)]]);
    const report = vi.fn();
    await createStoriesPass({ ...deps, fetchImpl }).runPass({ source: "manual", report });
    expect(deps.storage.data[SPY_STATE_KEY].stories.daily.passes).toEqual([]);
    expect(report).toHaveBeenCalledWith({ done: 1, total: 1, added: 2, failed: 0, current: "natgeo" });
    expect(history()[0]).toBe("Stories: coleta pedida pelo hub · 1 conta");
  });
  it("answers busy while a pass is running", async () => {
    await seed(deps.storage, [tracked("natgeo")], { stories: { job: { source: "pass", profileIds: ["instagram:natgeo"], index: 0, added: 0, failed: 0, nextAt: Date.now() + 30_000, startedAt: Date.now() } } });
    const out = await createStoriesPass({ ...deps }).runPass({ source: "manual" });
    expect(out).toEqual({ ok: false, error: "busy" });
  });
});

describe("sendStory", () => {
  const reduced = () => reduceStory(parseStoriesHtml(fixture).items[0], "27143148638");
  const okJson = (json) => ({ ok: true, status: 200, url: "", json: async () => json, text: async () => "" });
  const bytes = (n, type) => ({ ok: true, status: 200, url: "", blob: async () => new Blob([new Uint8Array(n)], { type }), json: async () => ({}), text: async () => "" });

  it("sends metadata first, then the poster, then the media, one fetch of the media at a time", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push(`${init.method || "GET"} ${String(url)}`);
      if (String(url).includes("/api/sync/spy/stories/")) return okJson({ id: "4010802020595923127", bytes: 3, ready: String(url).endsWith("/media") });
      if (String(url).includes("story-video-720.mp4")) return bytes(3, "video/mp4");
      throw new Error("unexpected " + url);
    });
    const pass = createStoriesPass({ ...deps, fetchImpl, sendStory: undefined });
    const flushed = [];
    deps.flush.mockImplementation(async () => { flushed.push(structuredClone(deps.storage.data[SPY_QUEUE_KEY]?.stories)); return { ok: true }; });
    const out = await pass.sendStory(reduced(), "instagram:natgeo", settings);
    expect(out).toBe("sent");
    // A string key: a numeric literal this big loses digits.
    expect(flushed[0]).toEqual({ "4010802020595923127": expect.objectContaining({ profileId: "instagram:natgeo", id: "4010802020595923127", mediaType: 2 }) });
    expect(deps.makePoster).toHaveBeenCalledWith(expect.stringContaining("story-cover-640.jpg"));
    expect(calls).toEqual([
      "PUT https://hub/api/sync/spy/stories/4010802020595923127/poster",
      "GET https://scontent.example.net/o1/v/story-video-720.mp4",
      "PUT https://hub/api/sync/spy/stories/4010802020595923127/media",
    ]);
    expect(fetchImpl.mock.calls[0][1].headers["Content-Type"]).toBe("image/webp");
    expect(fetchImpl.mock.calls[2][1].headers["Content-Type"]).toBe("video/mp4");
  });
  it("a failed download goes to pendingMedia and the pass goes on", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("/poster")) return okJson({ ready: false });
      if (String(url).includes("story-video")) return { ok: false, status: 403, url: "", blob: async () => new Blob([]), json: async () => ({}), text: async () => "" };
      throw new Error("unexpected " + url);
    });
    const pass = createStoriesPass({ ...deps, fetchImpl, sendStory: undefined });
    expect(await pass.sendStory(reduced(), "instagram:natgeo", settings)).toBe("pending");
    const pending = deps.storage.data[SPY_STATE_KEY].stories.pendingMedia;
    expect(pending).toEqual([expect.objectContaining({ id: "4010802020595923127", profileId: "instagram:natgeo", tries: 1, media: { url: expect.stringContaining("story-video-720"), mime: "video/mp4" } })]);
  });
  it("skips a media above 25 MB with a plain line", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("/poster")) return okJson({ ready: false });
      if (String(url).includes("story-video")) return bytes(25 * 1024 * 1024 + 1, "video/mp4");
      throw new Error("unexpected " + url);
    });
    const pass = createStoriesPass({ ...deps, fetchImpl, sendStory: undefined });
    expect(await pass.sendStory(reduced(), "instagram:natgeo", settings)).toBe("skipped");
    expect(history().some((t) => t.includes("25 MB"))).toBe(true);
    expect(deps.storage.data[SPY_STATE_KEY]?.stories?.pendingMedia ?? []).toEqual([]);
  });
  it("retries a pending media up to 3 times within 30 h", async () => {
    const now = Date.now();
    const item = reduced();
    const entry = (id, tries, firstAt) => ({ id, profileId: "instagram:natgeo", cover: item.cover, media: item.media, tries, firstAt });
    await deps.storage.set({ [SPY_STATE_KEY]: { day: "", stories: { job: null, daily: { day: "", passes: [] }, jitter: {},
      pendingMedia: [entry("1", 2, now - 3_600_000), entry("2", 3, now - 3_600_000), entry("3", 1, now - 31 * 3_600_000)] } } });
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("/api/sync/spy/stories/")) return okJson({ ready: true });
      if (String(url).includes("story-video")) return bytes(3, "video/mp4");
      throw new Error("unexpected " + url);
    });
    const pass = createStoriesPass({ ...deps, fetchImpl, sendStory: undefined });
    const out = await pass.retryPending(settings);
    expect(out).toEqual({ sent: 1, dropped: 2 });
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://hub/api/sync/spy/stories/1/poster", "https://scontent.example.net/o1/v/story-video-720.mp4", "https://hub/api/sync/spy/stories/1/media",
    ]);
    expect(deps.storage.data[SPY_STATE_KEY].stories.pendingMedia).toEqual([]);
  });
});

describe("tick", () => {
  const day = new Date(2026, 9, 19, 0, 0, 0).getTime();
  it("runs a slot late only while its window is open", async () => {
    await seed(deps.storage, [tracked("natgeo")]);
    const fetchImpl = fetchStub([["/stories/natgeo/", html(fixture)]]);
    const late = createStoriesPass({ ...deps, fetchImpl, now: () => day + 10 * 3600_000 + 50 * 60_000 }); // 10:50, slot 0 (from 23:00) never ran
    expect((await late.tick()).ran).toBe(true);
    await seed(deps.storage, [tracked("natgeo")]);
    const closed = createStoriesPass({ ...deps, fetchImpl: fetchStub([]), now: () => day + 11 * 3600_000 + 5 * 60_000, random: () => 0.5 }); // 11:05
    expect(await closed.tick()).toEqual({ ran: false, reason: "not_due" });
  });
  it("re-arms the alarm for the next due time", async () => {
    await seed(deps.storage, [tracked("natgeo")]);
    const pass = createStoriesPass({ ...deps, now: () => day + 11 * 3600_000 + 5 * 60_000, random: () => 0.5 });
    expect(await pass.tick()).toEqual({ ran: false, reason: "not_due" });
    expect(alarms[STORIES_ALARM]).toEqual({ when: day + 11 * 3600_000 + 15 * 60_000 });
  });
  it("does nothing without a tracked profile", async () => {
    await seed(deps.storage, [tracked("natgeo", { trackStories: false })]);
    const fetchImpl = fetchStub([]);
    expect(await createStoriesPass({ ...deps, fetchImpl }).tick()).toEqual({ ran: false, reason: "nothing_tracked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("resumes a persisted job whose step is due", async () => {
    const fetchImpl = fetchStub([["/stories/nasa/", html(fixture)]]);
    await seed(deps.storage, [tracked("natgeo"), tracked("nasa")], { stories: { job: { source: "pass", slot: 0, profileIds: ["instagram:natgeo", "instagram:nasa"], index: 1, added: 2, failed: 0, nextAt: Date.now() - 1000, startedAt: Date.now() - 60_000 }, daily: { day: "", passes: [] }, pendingMedia: [], jitter: {} } });
    expect((await createStoriesPass({ ...deps, fetchImpl }).tick()).ran).toBe(true);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["https://www.instagram.com/stories/nasa/"]);
    expect(deps.storage.data[SPY_STATE_KEY].stories.job).toBeNull();
  });
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

describe("onCommand", () => {
  const reply = () => ({ progress: vi.fn(), result: vi.fn() });
  it("answers busy when a pass is running", async () => {
    await seed(deps.storage, [tracked("natgeo")], { stories: { job: { source: "pass", profileIds: ["instagram:natgeo"], index: 0, added: 0, failed: 0, nextAt: Date.now() + 30_000, startedAt: Date.now() } } });
    const fetchImpl = fetchStub([]);
    const r = reply();
    await createStoriesPass({ ...deps, fetchImpl }).onCommand({ requestId: "req-1", profileIds: ["instagram:natgeo"] }, r);
    expect(r.result).toHaveBeenCalledWith(false, { error: "busy" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("runs a manual pass for the given profiles and reports each one", async () => {
    await seed(deps.storage, [tracked("natgeo"), tracked("nasa")]);
    const fetchImpl = fetchStub([["/stories/natgeo/", html(fixture)]]);
    const r = reply();
    await createStoriesPass({ ...deps, fetchImpl }).onCommand({ requestId: "req-1", profileIds: ["instagram:natgeo"] }, r);
    expect(r.progress).toHaveBeenCalledWith({ done: 1, total: 1, added: 2, failed: 0, current: "natgeo" });
    expect(r.result).toHaveBeenCalledWith(true, { added: 2, failed: 0 });
    expect(deps.storage.data[SPY_STATE_KEY].stories.daily.passes).toEqual([]);
  });
  it("says why when nothing can run", async () => {
    await seed(deps.storage, [tracked("natgeo", { trackStories: false })]);
    const r = reply();
    await createStoriesPass({ ...deps }).onCommand({ requestId: "req-1" }, r);
    expect(r.result).toHaveBeenCalledWith(false, { error: "nothing_tracked" });
  });
});
