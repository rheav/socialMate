import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const data = {};
const alarms = {};
let messageListener = null;
let tabsUpdatedListener = null;
let igResponseListener = null;
const tabListeners = [];

function chromeStub() {
  const node = () => {
    const fn = () => Promise.resolve();
    return new Proxy(fn, {
      get(target, prop) {
        if (prop === "then") return undefined;
        if (!(prop in target)) target[prop] = node();
        return target[prop];
      },
      apply: () => Promise.resolve(),
    });
  };
  const stub = node();

  stub.storage.local.get = (key) =>
    new Promise((r) => {
      const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
      const out = {};
      for (const k of keys) {
        if (k in data) out[k] = structuredClone(data[k]);
      }
      r(out);
    });

  stub.storage.local.set = (obj) =>
    new Promise((r) => {
      Object.assign(data, structuredClone(obj));
      r();
    });

  stub.alarms.create = (name, opts) => {
    alarms[name] = opts;
  };

  stub.alarms.clear = (name) => {
    delete alarms[name];
    return Promise.resolve(true);
  };

  stub.runtime.onMessage.addListener = (fn) => {
    messageListener = fn;
  };

  stub.tabs.onUpdated.addListener = (fn) => {
    tabListeners.push(fn);
    tabsUpdatedListener = (...args) => tabListeners.forEach((f) => f(...args));
  };

  stub.webRequest.onCompleted.addListener = (fn) => { igResponseListener = fn; };
  return stub;
}

let scheduleSpy, flushSpy, spyTick, measureFbProfile, advanceReelsJob;

beforeAll(async () => {
  vi.stubGlobal("chrome", chromeStub());
  ({ scheduleSpy, flushSpy, spyTick, measureFbProfile, advanceReelsJob } = await import("./background.js"));
});

beforeEach(() => {
  for (const k of Object.keys(data)) delete data[k];
  for (const k of Object.keys(alarms)) delete alarms[k];
});

function sendMessage(msg, sender = {}) {
  return new Promise((resolve) => {
    const handled = messageListener(msg, sender, resolve);
    if (!handled) resolve(undefined);
  });
}

describe("background spy area (phase E2/E3)", () => {
  describe("scheduleSpy", () => {
    it("clears alarm if sync is not configured", async () => {
      data.fbw_sync = { enabled: true, url: "", token: "" };
      data.fbw_spy_prefs = { daily: true };
      alarms["fbw-spy-tick"] = { delayInMinutes: 1 };

      await scheduleSpy();
      expect(alarms["fbw-spy-tick"]).toBeUndefined();
    });

    it("clears alarm if daily pass is switched off", async () => {
      data.fbw_sync = { enabled: true, url: "https://hub", token: "secret" };
      data.fbw_spy_prefs = { daily: false };
      alarms["fbw-spy-tick"] = { delayInMinutes: 1 };

      await scheduleSpy();
      expect(alarms["fbw-spy-tick"]).toBeUndefined();
    });

    it("schedules 1 min when profiles are due", async () => {
      data.fbw_sync = { enabled: true, url: "https://hub", token: "secret" };
      data.fbw_spy_prefs = { daily: true };
      data.fbw_spy = {
        profiles: {
          "instagram:nasa": {
            id: "instagram:nasa",
            platform: "instagram",
            key: "nasa",
            removedAt: null,
            lastMeasuredAt: null,
          },
        },
      };

      await scheduleSpy();
      expect(alarms["fbw-spy-tick"]).toEqual({ delayInMinutes: 1 });
    });

    it("does not postpone a tick already due within the minute", async () => {
      // Each capture rewrites the list and re-enters scheduleSpy every 20–40 s.
      data.fbw_sync = { enabled: true, url: "https://hub", token: "secret" };
      data.fbw_spy = { profiles: { "instagram:nasa": { id: "instagram:nasa", platform: "instagram", key: "nasa",
        removedAt: null, lastMeasuredAt: null } } };
      const get = chrome.alarms.get;
      chrome.alarms.get = async () => ({ name: "fbw-spy-tick", scheduledTime: Date.now() + 30000 });
      try {
        await scheduleSpy();
        expect(alarms["fbw-spy-tick"]).toBeUndefined();
      } finally { chrome.alarms.get = get; }
    });

    it("schedules next day random delay when no profiles are due", async () => {
      data.fbw_sync = { enabled: true, url: "https://hub", token: "secret" };
      data.fbw_spy_prefs = { daily: true };
      data.fbw_spy = {
        profiles: {
          "instagram:nasa": {
            id: "instagram:nasa",
            platform: "instagram",
            key: "nasa",
            removedAt: null,
            lastMeasuredAt: Date.now(),
          },
        },
      };

      await scheduleSpy();
      expect(alarms["fbw-spy-tick"]).toBeDefined();
      expect(alarms["fbw-spy-tick"].when).toBeGreaterThan(Date.now());
    });
  });

  describe("message handling", () => {
    it("FBW_SPY_SAVE queues op and sets optimistic active profile", async () => {
      data.fbw_sync = { enabled: true, url: "https://hub", token: "secret" };
      const res = await sendMessage({
        type: "FBW_SPY_SAVE",
        platform: "instagram",
        key: "NASA",
      });

      expect(res).toEqual({ ok: true, id: "instagram:nasa" });
      expect(data.fbw_spy_queue.ops).toHaveLength(1);
      expect(data.fbw_spy_queue.ops[0]).toMatchObject({
        op: "save",
        id: "instagram:nasa",
        platform: "instagram",
        key: "NASA",
      });
      expect(data.fbw_spy.profiles["instagram:nasa"]).toMatchObject({
        id: "instagram:nasa",
        platform: "instagram",
        key: "nasa",
        removedAt: null,
      });
    });

    it("FBW_SPY_SAVE parses profile URLs directly", async () => {
      const res = await sendMessage({
        type: "FBW_SPY_SAVE",
        url: "https://www.facebook.com/NASA",
      });

      expect(res).toEqual({ ok: true, id: "facebook:nasa" });
      expect(data.fbw_spy.profiles["facebook:nasa"]).toMatchObject({
        id: "facebook:nasa",
        platform: "facebook",
        key: "nasa",
      });
    });

    it("FBW_SPY_SAVE rejects invalid profiles", async () => {
      const res = await sendMessage({
        type: "FBW_SPY_SAVE",
        url: "https://tiktok.com/@nasa",
      });

      expect(res).toEqual({ ok: false, error: "invalid_profile" });
    });

    it("FBW_SPY_REMOVE queues op and optimistically removes from fbw_spy", async () => {
      data.fbw_spy = {
        profiles: {
          "instagram:nasa": { id: "instagram:nasa", key: "nasa" },
        },
      };

      const res = await sendMessage({
        type: "FBW_SPY_REMOVE",
        id: "instagram:nasa",
      });

      expect(res).toEqual({ ok: true });
      expect(data.fbw_spy_queue.ops[0]).toMatchObject({
        op: "remove",
        id: "instagram:nasa",
      });
      expect(data.fbw_spy.profiles["instagram:nasa"]).toBeUndefined();
    });
  });

  describe("measureFbProfile", () => {
    it("measures Facebook profile successfully and queues snapshot", async () => {
      const fakeHtml = `
        "profile_social_context": {
          "content": [{ "text": { "text": "28M followers" } }]
        }
        "actors": [{ "id": "100044561550831", "name": "NASA" }]
      `;
      const fakeFetch = vi.fn(async () => ({
        status: 200,
        text: async () => fakeHtml,
      }));

      const profile = { id: "facebook:nasa", platform: "facebook", key: "nasa", hasAvatar: true };
      const res = await measureFbProfile(profile, "daily", fakeFetch);

      expect(res.ok).toBe(true);
      expect(res.snapshot).toMatchObject({
        profileId: "facebook:nasa",
        followers: 28_000_000,
        followersApprox: true,
        source: "daily",
      });
      expect(data.fbw_spy_queue.snapshots["facebook:nasa|" + res.snapshot.day]).toBeDefined();
    });

    it("blocks Facebook for 12 hours on 429 response", async () => {
      const fakeFetch = vi.fn(async () => ({
        status: 429,
        text: async () => "",
      }));

      const profile = { id: "facebook:nasa", platform: "facebook", key: "nasa" };
      const res = await measureFbProfile(profile, "daily", fakeFetch);

      expect(res.ok).toBe(false);
      expect(res.error).toBe("rate_limited");
      expect(data.fbw_spy_state.blocked.facebook).toBeGreaterThan(Date.now());
      expect(data.fbw_spy_queue.errors["facebook:nasa"]).toMatchObject({
        error: "rate_limited",
      });
    });

    it("records not_found without blocking on 404 response", async () => {
      const fakeFetch = vi.fn(async () => ({
        status: 404,
        text: async () => "",
      }));

      const profile = { id: "facebook:ghost", platform: "facebook", key: "ghost" };
      const res = await measureFbProfile(profile, "daily", fakeFetch);

      expect(res.ok).toBe(false);
      expect(res.error).toBe("not_found");
      expect(data.fbw_spy_state?.blocked?.facebook).toBeUndefined();
      expect(data.fbw_spy_queue.errors["facebook:ghost"]).toMatchObject({
        error: "not_found",
      });
    });
  });

  describe("on-visit trigger", () => {
    it("triggers visit measurement for saved FB profile when not measured in last 6h", async () => {
      data.fbw_spy = {
        profiles: {
          "facebook:nasa": {
            id: "facebook:nasa",
            platform: "facebook",
            key: "nasa",
            removedAt: null,
            lastMeasuredAt: Date.now() - 7 * 3600 * 1000,
          },
        },
      };

      const fakeFetch = vi.fn(async () => ({
        status: 200,
        text: async () => '"profile_social_context":{"content":[{"text":{"text":"28M followers"}}]}',
      }));
      vi.stubGlobal("fetch", fakeFetch);

      tabsUpdatedListener(1, { url: "https://www.facebook.com/NASA" });

      await new Promise((r) => setTimeout(r, 60));
      expect(fakeFetch).toHaveBeenCalled();
    });

    it("ignores visit if measured recently", async () => {
      data.fbw_spy = {
        profiles: {
          "facebook:nasa": {
            id: "facebook:nasa",
            platform: "facebook",
            key: "nasa",
            removedAt: null,
            lastMeasuredAt: Date.now() - 1 * 3600 * 1000,
          },
        },
      };

      const fakeFetch = vi.fn();
      vi.stubGlobal("fetch", fakeFetch);

      tabsUpdatedListener(1, { url: "https://www.facebook.com/NASA" });
      await new Promise((r) => setTimeout(r, 60));
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  });
});


describe("Instagram path B", () => {
  const now = new Date(2026, 9, 3, 12).getTime();
  const profile = (key, lastMeasuredAt = null) => ({ id: `instagram:${key}`, platform: "instagram", key,
    lastMeasuredAt, hasAvatar: true, removedAt: null });
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    data.fbw_sync = { url: "https://hub", token: "secret" };
    data.fbw_spy = { fetchedAt: now, profiles: { "instagram:nasa": profile("nasa") } };
    data.fbw_spy_state = { day: "2026-10-03", attempts: {}, blocked: {}, igBatch: null };
    chrome.tabs.create = vi.fn(async (opts) => ({ id: 90, ...opts }));
    chrome.tabs.update = vi.fn(async (id, opts) => ({ id, ...opts }));
    chrome.tabs.get = vi.fn(async (id) => ({ id, url: "https://www.instagram.com/#socialmate-spy" }));
    chrome.tabs.remove = vi.fn(async () => {});
    chrome.tabs.sendMessage = vi.fn(async () => ({ ok: true, spy: true }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("starts a private background tab and persists the oldest-first batch capped at 20", async () => {
    data.fbw_spy.profiles = Object.fromEntries(Array.from({ length: 25 }, (_, i) => {
      const p = profile(`p${i}`, now - (i + 1) * 86400000); return [p.id, p];
    }));
    await spyTick();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://www.instagram.com/#socialmate-spy", active: false });
    expect(data.fbw_spy_state.igBatch).toMatchObject({ own: true, tabId: 90, current: "p24" });
    expect(data.fbw_spy_state.igBatch.pending).toHaveLength(20);
    expect(chrome.tabs.update).toHaveBeenCalledWith(90, { url: "https://www.instagram.com/p24/#socialmate-spy" });
  });

  it("queues visits with the hub metadata contract and throttles across tabs for ten minutes", async () => {
    const msg = { type: "FBW_SPY_OBSERVE", platform: "instagram", key: "nasa",
      data: { userid: "123", username: "nasa", follower_count: 42, full_name: "NASA", is_private: false } };
    const sender = { tab: { id: 1 }, url: "https://www.instagram.com/nasa/", frameId: 0 };
    expect(await sendMessage(msg, sender)).toMatchObject({ ok: true });
    expect(data.fbw_spy_queue.snapshots["instagram:nasa|2026-10-03"]).toMatchObject({ followers: 42, source: "visit" });
    expect(data.fbw_spy_queue.profiles["instagram:nasa"]).toMatchObject({ at: now, userId: "123", name: "NASA", private: false });
    await sendMessage({ ...msg, data: { ...msg.data, follower_count: 50 } }, { ...sender, tab: { id: 2 } });
    expect(data.fbw_spy_queue.snapshots["instagram:nasa|2026-10-03"].followers).toBe(42);
    vi.setSystemTime(now + 600000);
    await sendMessage({ ...msg, data: { ...msg.data, follower_count: 51 } }, sender);
    expect(data.fbw_spy_queue.snapshots["instagram:nasa|2026-10-03"].followers).toBe(51);
  });

  it("records owned-tab captures as daily, closes it, and preserves the daily navigation budget", async () => {
    await spyTick();
    const result = await sendMessage({ type: "FBW_SPY_OBSERVE", platform: "instagram", key: "nasa",
      data: { userid: "123", username: "nasa", follower_count: 42 } },
      { tab: { id: 90 }, url: "https://www.instagram.com/nasa/#socialmate-spy", frameId: 0 });
    expect(result).toMatchObject({ ok: true });
    expect(data.fbw_spy_queue.snapshots["instagram:nasa|2026-10-03"].source).toBe("daily");
    expect(Object.values(data.fbw_spy_queue.readings)).toEqual([expect.objectContaining({
      profileId: "instagram:nasa", kind: "followers", source: "daily", ok: true, followers: 42 })]);
    expect(data.fbw_spy_state.igBatch).toBeNull();
    expect(data.fbw_spy_state.igDaily.count).toBe(1);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(90);
  });

  it("does not start after twenty navigations even if more profiles are due", async () => {
    data.fbw_spy_state.igDaily = { day: "2026-10-03", count: 20 };
    await spyTick();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(alarms["fbw-spy-tick"].when).toBeGreaterThan(now);
  });

  it("stops an expired batch, counts pending attempts, and only closes its own tab", async () => {
    data.fbw_spy_state.igBatch = { tabId: 90, own: true, startedAt: now - 900001, pending: ["nasa"] };
    await spyTick();
    expect(data.fbw_spy_state.igBatch).toBeNull();
    expect(data.fbw_spy_state.attempts["instagram:nasa"].n).toBe(1);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(90);
  });

  it("waits between navigations and can resume from persisted state", async () => {
    data.fbw_spy.profiles["instagram:second"] = profile("second");
    await spyTick();
    const nextAt = data.fbw_spy_state.igBatch.nextAt;
    expect(nextAt - now).toBeGreaterThanOrEqual(20000);
    expect(nextAt - now).toBeLessThanOrEqual(40000);
    await sendMessage({ type: "FBW_SPY_OBSERVE", platform: "instagram", key: "nasa",
      data: { username: "nasa", follower_count: 42 } },
      { tab: { id: 90 }, url: "https://www.instagram.com/nasa/#socialmate-spy", frameId: 0 });
    vi.clearAllTimers(); // suspension loses timers, not storage
    vi.setSystemTime(nextAt - 1);
    await spyTick();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    vi.clearAllTimers(); vi.setSystemTime(nextAt);
    await spyTick();
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(90, { url: "https://www.instagram.com/second/#socialmate-spy" });
    expect(data.fbw_spy_state.igDaily.count).toBe(2);
  });

  it("stops on a 429 from the owned tab and never navigates the next profile", async () => {
    data.fbw_spy.profiles["instagram:second"] = profile("second");
    await spyTick();
    igResponseListener({ tabId: 90, statusCode: 429 });
    await spyTick(); // serialize behind the response handler
    expect(data.fbw_spy_state.blocked.instagram).toBeGreaterThan(now);
    expect(data.fbw_spy_state.igBatch).toBeNull();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(90);
  });

  it("does not navigate if 429 arrives during the ownership check", async () => {
    data.fbw_spy.profiles["instagram:second"] = profile("second");
    await spyTick();
    vi.clearAllTimers(); vi.setSystemTime(data.fbw_spy_state.igBatch.nextAt);
    chrome.tabs.get = vi.fn(async () => {
      igResponseListener({ tabId: 90, statusCode: 429 });
      return { id: 90, url: "https://www.instagram.com/nasa/#socialmate-spy" };
    });
    await spyTick();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(data.fbw_spy_state.igBatch).toBeNull();
  });

  it("a concurrent confirmed removal wins over passive capture and remains queued", async () => {
    data.fbw_sync = {}; // keep the pending operation visible, with no upload
    const originalGet = chrome.storage.local.get;
    let removal;
    chrome.storage.local.get = async (keys) => {
      const value = await originalGet(keys);
      if (!removal && Array.isArray(keys) && keys[0] === "fbw_spy" && keys.includes("fbw_spy_queue") && keys.includes("fbw_spy_state")) {
        removal = sendMessage({ type: "FBW_SPY_REMOVE", id: "instagram:nasa" });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      return value;
    };
    try {
      await sendMessage({ type: "FBW_SPY_OBSERVE", platform: "instagram", key: "nasa",
        data: { username: "nasa", follower_count: 9 } },
        { tab: { id: 1 }, url: "https://www.instagram.com/nasa/" });
      expect(await removal).toEqual({ ok: true });
      expect(data.fbw_spy.profiles["instagram:nasa"]).toBeUndefined();
      expect(data.fbw_spy_queue.ops).toContainEqual(expect.objectContaining({ op: "remove", platform: "instagram", key: "nasa" }));
    } finally { chrome.storage.local.get = originalGet; }
  });

  it("relinquishes a tab the user repurposed instead of navigating or closing it", async () => {
    data.fbw_spy_state.igBatch = { tabId: 90, own: true, startedAt: now, pending: ["nasa"], nextAt: now };
    chrome.tabs.get = vi.fn(async () => ({ id: 90, url: "https://example.com/" }));
    await spyTick();
    expect(data.fbw_spy_state.igBatch).toBeNull();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it("does no automatic work when daily is disabled", async () => {
    data.fbw_spy_prefs = { daily: false };
    await spyTick();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("rejects foreign senders and ignores unknown profiles", async () => {
    const msg = { type: "FBW_SPY_OBSERVE", platform: "instagram", key: "nasa", data: { username: "nasa", follower_count: 9 } };
    await sendMessage(msg, { tab: { id: 1 }, url: "https://example.com/" });
    expect(data.fbw_spy_queue).toBeUndefined();
    await sendMessage({ ...msg, key: "other" }, { tab: { id: 1 }, url: "https://www.instagram.com/" });
    expect(data.fbw_spy_queue).toBeUndefined();
  });
});


describe("Instagram posts per day", () => {
  const now = new Date(2026, 9, 3, 12).getTime();
  const sender = { tab: { id: 7 }, url: "https://www.instagram.com/nasa/", frameId: 0 };
  const posts = [{ id: "3001", createdAt: 1791000000, mediaType: "photo", pinned: false },
    { id: "3002", createdAt: 1791000100, mediaType: "video", pinned: true }];
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    data.fbw_sync = { url: "https://hub", token: "secret" };
    data.fbw_spy = { fetchedAt: now, profiles: { "instagram:nasa": { id: "instagram:nasa", platform: "instagram",
      key: "nasa", removedAt: null } } };
    data.fbw_spy_state = { day: "2026-10-03", attempts: {}, blocked: {} };
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("queues the grid's posts of a saved profile and sends them to the hub", async () => {
    expect(await sendMessage({ type: "FBW_SPY_POSTS", platform: "instagram", key: "nasa", posts }, sender))
      .toEqual({ ok: true, queued: 2 });
    expect(Object.keys(data.fbw_spy_queue.posts)).toEqual(["instagram:nasa|3001", "instagram:nasa|3002"]);
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetcher);
    await flushSpy();
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.posts).toEqual(posts.map((p) => ({ profileId: "instagram:nasa", ...p })));
    expect(data.fbw_spy_queue.posts).toEqual({});
  });

  it("refuses posts from another site, a subframe or for a profile that is not saved", async () => {
    const msg = { type: "FBW_SPY_POSTS", platform: "instagram", key: "nasa", posts };
    expect(await sendMessage(msg, { ...sender, url: "https://example.com/" })).toMatchObject({ ok: false });
    expect(await sendMessage(msg, { ...sender, frameId: 3 })).toMatchObject({ ok: false });
    expect(await sendMessage({ ...msg, key: "other" }, sender)).toMatchObject({ ok: false });
    expect(data.fbw_spy_queue).toBeUndefined();
  });
});

describe("spy queue acknowledgement", () => {
  it("has one upload owner even when two callers enter before storage resolves", async () => {
    data.fbw_sync = { url: "https://hub", token: "secret" };
    data.fbw_spy_queue = { ops: [{ op: "save", platform: "instagram", key: "nasa", at: 1 }], profiles: {}, snapshots: {}, errors: {} };
    const bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }));
    const [first, second] = await Promise.all([flushSpy(), flushSpy()]);
    expect(first.ok).toBe(true);
    expect(second.skipped).toBe("busy");
    expect(bodies).toHaveLength(1);
  });

  it("removes acknowledged cloned entries while retaining captures arriving during upload", async () => {
    data.fbw_sync = { url: "https://hub", token: "secret" };
    data.fbw_spy_queue = { ops: [], profiles: { old: { id: "old", at: 1 } },
      snapshots: { "instagram:nasa|2026-10-03": { profileId: "instagram:nasa", day: "2026-10-03", measuredAt: 1, followers: 1 } },
      errors: { old: { id: "old", error: "network", at: 1 } } };
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      expect(JSON.parse(options.body).errors[0]).toMatchObject({ profileId: "old" });
      data.fbw_spy_queue.snapshots["instagram:nasa|2026-10-03"].measuredAt = 2;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }));
    expect((await flushSpy()).ok).toBe(true);
    expect(data.fbw_spy_queue.profiles).toEqual({});
    expect(data.fbw_spy_queue.errors).toEqual({});
    expect(data.fbw_spy_queue.snapshots["instagram:nasa|2026-10-03"].measuredAt).toBe(2);
  });
});

// Regression coverage for the 2026-10-03 Spy review. Chrome and HTTP are the
// external boundaries; the worker, persistent queue and scheduling run for real.
describe("Spy collection and synchronization regressions", () => {
  const now = new Date(2026, 9, 3, 8).getTime();
  const fb = { id: "facebook:nasa", platform: "facebook", key: "nasa", removedAt: null,
    listUpdatedAt: 1, lastMeasuredAt: null };
  const emptyQueue = () => ({ ops: [], profiles: {}, snapshots: {}, errors: {} });
  const html = '"profile_social_context":{"text":"42 followers"}';
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    data.fbw_sync = { url: "https://hub", token: "secret" };
    data.fbw_spy = { fetchedAt: now, profiles: { [fb.id]: { ...fb } } };
    data.fbw_spy_state = { day: "2026-10-03", attempts: {}, blocked: {} };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it.each([
    [404, "", "not_found"], [200, "<html>no stats</html>", "parse_failed"],
    [429, "", "rate_limited"],
  ])("counts HTTP %s failures once before allowing another attempt", async (status, body, error) => {
    const fetcher = vi.fn(async () => ({ status, text: async () => body }));
    expect(await measureFbProfile(fb, "daily", fetcher)).toMatchObject({ ok: false, error });
    expect(data.fbw_spy_state.attempts[fb.id]).toEqual({ n: 1, at: now });
    expect((await measureFbProfile(fb, "daily", fetcher)).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous manual and daily Facebook measurements", async () => {
    let release;
    const started = new Promise((resolve) => { release = resolve; });
    let requested;
    const request = new Promise((resolve) => { requested = resolve; });
    const fetcher = vi.fn(async () => { requested(); await started; return { status: 200, text: async () => html }; });
    const first = measureFbProfile(fb, "daily", fetcher);
    await request;
    const second = measureFbProfile(fb, "visit", fetcher);
    release();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(data.fbw_spy_state.attempts[fb.id].n).toBe(1);
  });

  it("lets an explicit measure-one bypass the daily cooldown but not a platform block", async () => {
    data.fbw_spy_state.attempts = { [fb.id]: { n: 2, at: now - 60000 } };
    const fetcher = vi.fn(async () => ({ status: 200, text: async () => html }));
    vi.stubGlobal("fetch", fetcher);
    expect(await sendMessage({ type: "FBW_SPY_MEASURE_ONE", id: fb.id })).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    data.fbw_spy_state.blocked = { facebook: now + 3600000 };
    expect(await sendMessage({ type: "FBW_SPY_MEASURE_ONE", id: fb.id })).toMatchObject({ ok: false, code: "cooldown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores loading and title updates and collects once on completion", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, text: async () => html }));
    vi.stubGlobal("fetch", fetcher);
    const tab = { id: 4, url: "https://www.facebook.com/nasa" };
    tabsUpdatedListener(4, { status: "loading" }, tab);
    tabsUpdatedListener(4, { title: "NASA" }, tab);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    tabsUpdatedListener(4, { status: "complete" }, tab);
    for (let i = 0; i < 60; i++) await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resets yesterday's attempts even when a visit precedes the daily tick", async () => {
    data.fbw_spy_state = { day: "2026-10-02", attempts: {
      "facebook:other": { n: 2, at: now - 86400000 },
    }, blocked: {} };
    await measureFbProfile(fb, "visit", async () => ({ status: 200, text: async () => html }));
    expect(data.fbw_spy_state.day).toBe("2026-10-03");
    expect(data.fbw_spy_state.attempts).toEqual({ [fb.id]: { n: 1, at: now } });
  });

  it.each([
    [{ attempts: { [fb.id]: { n: 1, at: now } } }, now + 6 * 3600000],
    [{ blocked: { facebook: now + 12 * 3600000 } }, now + 12 * 3600000],
  ])("schedules the earliest retry or unblock within today", async (state, expected) => {
    Object.assign(data.fbw_spy_state, state);
    await scheduleSpy();
    expect(alarms["fbw-spy-tick"]).toEqual({ when: expected });
  });

  it("keeps a sync wakeup when a removal arrives during upload with daily disabled", async () => {
    data.fbw_spy_prefs = { daily: false };
    data.fbw_spy_queue = { ...emptyQueue(), ops: [{ op: "save", ...fb, at: 1 }] };
    let respond, requested;
    const request = new Promise((resolve) => { requested = resolve; });
    const bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) { requested(); return new Promise((resolve) => { respond = resolve; }); }
      return { ok: true, json: async () => ({ ok: true, profiles: [{ ...fb, removedAt: now, listUpdatedAt: now }] }) };
    }));
    const first = flushSpy(); await request;
    expect(await sendMessage({ type: "FBW_SPY_REMOVE", id: fb.id })).toEqual({ ok: true });
    respond({ ok: true, json: async () => ({ ok: true, profiles: [fb] }) });
    await first;
    expect(alarms["fbw-spy-sync"]).toBeDefined();
    await vi.advanceTimersByTimeAsync(4000);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].ops[0]).toMatchObject({ op: "remove", id: fb.id });
    expect(data.fbw_spy_queue.ops).toEqual([]);
    expect(alarms["fbw-spy-sync"]).toBeUndefined();
  });

  it("splits a large offline backlog of snapshots into bounded requests", async () => {
    const pad = "x".repeat(1_500_000);
    data.fbw_spy_queue = { ...emptyQueue(), ops: [{ op: "save", ...fb, at: 1 }], snapshots: Object.fromEntries(
      [1, 2, 3, 4].map((d) => [`${fb.id}|2026-09-0${d}`, { profileId: fb.id, day: `2026-09-0${d}`, measuredAt: d, followers: d, note: pad }]),
    ) };
    const sizes = [];
    const bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      sizes.push(options.body.length); bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, profiles: [fb] }) };
    }));
    expect((await flushSpy()).ok).toBe(true);
    expect(bodies.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(4_100_000);
    expect(bodies[0].ops).toHaveLength(1);
    expect(bodies.flatMap((b) => b.snapshots || [])).toHaveLength(4);
    expect(data.fbw_spy_queue.snapshots).toEqual({});
  });

  it("keeps the local list when a metadata-only upload reaches a hub that does not know it", async () => {
    data.fbw_spy_queue = { ...emptyQueue(), snapshots: { [`${fb.id}|2026-10-03`]: { profileId: fb.id, day: "2026-10-03", measuredAt: now, followers: 1 } } };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, profiles: [] }) })));
    await flushSpy();
    expect(data.fbw_spy.profiles[fb.id]).toBeDefined();
  });

  it("rolls back an unaccepted save and reports rejection instead of a phantom profile", async () => {
    const existing = { id: "instagram:existing", platform: "instagram", key: "existing", listUpdatedAt: 1, removedAt: null };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true,
      results: { ops: { applied: 0, skipped: 0, invalid: 1 } }, max: 1, profiles: [existing] }) })));
    const result = await sendMessage({ type: "FBW_SPY_SAVE", platform: "instagram", key: "overflow" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(data.fbw_spy.profiles["instagram:overflow"]).toBeUndefined();
    expect(data.fbw_spy_queue.ops).toEqual([]);
  });

  it("returns an actionable error for individual Instagram measurement", async () => {
    data.fbw_spy.profiles["instagram:nasa"] = { id: "instagram:nasa", platform: "instagram", key: "nasa" };
    const result = await sendMessage({ type: "FBW_SPY_MEASURE_ONE", id: "instagram:nasa" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abr[ai]/i);
  });
});

describe("Facebook reels in the daily reading", () => {
  const now = new Date(2026, 9, 3, 8).getTime();
  const fb = { id: "facebook:61589642519378", platform: "facebook", key: "61589642519378", removedAt: null,
    listUpdatedAt: 1, lastMeasuredAt: null, reels: { status: "done", count: 2, recent: ["2209826979599001"] } };
  const reelNode = (id, created) => ({ profile_reel_node: { node: { __typename: "Story", creation_time: created, actors: [{ id: "6" }],
    attachments: [{ media: { __typename: "Video", id, created_time: created, play_count_reduced: "1.2K" } }] } } });
  const reelsHtml = (ids) => `"profile_social_context":{"text":"1.5M followers"}<script type="application/json" data-sjs>${JSON.stringify({
    x: { aggregated_fb_shorts: { edges: ids.map((id, i) => reelNode(id, 1791000000 - i)), page_info: { end_cursor: "C", has_next_page: true } } },
  })}</script>`;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    data.fbw_sync = { url: "https://hub", token: "secret" };
    data.fbw_spy = { fetchedAt: now, profiles: { [fb.id]: { ...fb } } };
    data.fbw_spy_state = { day: "2026-10-03", attempts: {}, blocked: {} };
    data.fbw_spy_queue = undefined;
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("reads followers and the newest reels from the reels tab in one request", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, text: async () => reelsHtml(["2209826979599002", "2209826979599001"]) }));
    expect((await measureFbProfile(fb, "daily", fetcher)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://www.facebook.com/profile.php?id=61589642519378&sk=reels_tab");
    const q = data.fbw_spy_queue;
    expect(Object.keys(q.reels).sort()).toEqual([`${fb.id}|2209826979599001`, `${fb.id}|2209826979599002`]);
    expect(Object.values(q.snapshots)[0]).toMatchObject({ followers: 1_500_000 });
    const readings = Object.values(q.readings).map((r) => [r.kind, r.source, r.ok, r.followers ?? r.reelsAdded]);
    expect(readings).toEqual(expect.arrayContaining([["followers", "daily", true, 1_500_000], ["reels", "daily", true, 1]]));
  });

  it("records a failed reading with its reason and origin", async () => {
    await measureFbProfile(fb, "visit", async () => ({ status: 404, text: async () => "" }));
    expect(Object.values(data.fbw_spy_queue.readings)).toEqual([
      expect.objectContaining({ profileId: fb.id, kind: "followers", source: "visit", ok: false, error: "not_found" }),
    ]);
  });

  it("sends reels, reading states and readings to the hub and clears them", async () => {
    data.fbw_spy_queue = { ops: [], profiles: {}, snapshots: {}, errors: {},
      reels: { [`${fb.id}|2209826979599002`]: { profileId: fb.id, id: "2209826979599002", createdAt: 1, duration: null, views: 5 } },
      reelsStatus: { [fb.id]: { profileId: fb.id, status: "running", at: 1 } },
      readings: { [`${fb.id}|1|reels`]: { profileId: fb.id, at: 1, kind: "reels", source: "initial", ok: true, reelsAdded: 1 } } };
    const bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true, profiles: [fb] }) }; }));
    expect((await flushSpy()).ok).toBe(true);
    expect(bodies[0]).toMatchObject({ reels: [expect.objectContaining({ id: "2209826979599002" })],
      reelsStatus: [{ profileId: fb.id, status: "running", at: 1 }], readings: [expect.objectContaining({ kind: "reels" })] });
    expect(data.fbw_spy_queue).toMatchObject({ reels: {}, reelsStatus: {}, readings: {} });
  });
});

describe("Facebook first full reels reading", () => {
  const now = new Date(2026, 9, 3, 8).getTime();
  const pid = "facebook:61589642519378";
  const fb = (reels) => ({ id: pid, platform: "facebook", key: "61589642519378", removedAt: null, listUpdatedAt: 1,
    lastMeasuredAt: now, reels });
  const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ id: String(2209826979590000 + from + i), createdAt: 1, duration: null, views: 1 }));
  let pages;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    data.fbw_sync = { url: "https://hub", token: "secret" };
    data.fbw_spy_state = { day: "2026-10-03", attempts: {}, blocked: {} };
    data.fbw_spy_queue = undefined;
    pages = [];
    chrome.tabs.create = vi.fn(async (opts) => ({ id: 77, ...opts }));
    chrome.tabs.get = vi.fn(async (id) => ({ id, url: "https://www.facebook.com/profile.php?id=61589642519378&sk=reels_tab#socialmate-reels" }));
    chrome.tabs.remove = vi.fn(async () => {});
    chrome.tabs.sendMessage = vi.fn(async (_tab, msg) => { pages.push(msg); return pages.length <= script.length ? script[pages.length - 1] : { ok: false, error: "x" }; });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  let script = [];
  const run = async (steps) => { for (let i = 0; i < steps; i++) { await advanceReelsJob(); vi.setSystemTime(Date.now() + 41_000); } };

  it("pages through every reel in its own tab, slowly, and marks the reading done", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { [pid]: fb({ status: "pending", count: 0, recent: [] }) } };
    script = [
      { ok: true, rows: rows(0, 10), hasNext: true, cursor: "C1", collectionId: "COLL" },
      { ok: true, rows: rows(10, 10), hasNext: true, cursor: "C2", collectionId: "COLL" },
      { ok: true, rows: rows(20, 3), hasNext: false, cursor: null, collectionId: "COLL" },
    ];
    await run(5);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ active: false,
      url: "https://www.facebook.com/profile.php?id=61589642519378&sk=reels_tab#socialmate-reels" }));
    expect(pages.map((m) => [m.type, m.cursor ?? null, m.collectionId ?? null])).toEqual([
      ["FBW_SPY_REELS_PAGE", null, null], ["FBW_SPY_REELS_PAGE", "C1", "COLL"], ["FBW_SPY_REELS_PAGE", "C2", "COLL"],
    ]);
    const q = data.fbw_spy_queue;
    expect(Object.keys(q.reels)).toHaveLength(23);
    expect(q.reelsStatus[pid]).toMatchObject({ status: "done" });
    expect(Object.values(q.readings)).toEqual([expect.objectContaining({ kind: "reels", source: "initial", ok: true, reelsAdded: 23, pages: 3 })]);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(77);
    expect(data.fbw_spy_state.reelsJob).toBeNull();
  });

  it("waits at least twenty seconds between pages", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { [pid]: fb({ status: "pending", count: 0, recent: [] }) } };
    script = [{ ok: true, rows: rows(0, 10), hasNext: true, cursor: "C1", collectionId: "COLL" }, { ok: true, rows: rows(10, 1), hasNext: false }];
    await advanceReelsJob();
    await advanceReelsJob();
    vi.setSystemTime(now + 19_000);
    await advanceReelsJob();
    expect(pages).toHaveLength(1);
  });

  it("stops for the day after thirty pages and resumes from the saved cursor", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { [pid]: fb({ status: "pending", count: 0, recent: [] }) } };
    script = Array.from({ length: 40 }, (_, i) => ({ ok: true, rows: rows(i * 10, 10), hasNext: true, cursor: `C${i + 1}`, collectionId: "COLL" }));
    await run(40);
    expect(pages).toHaveLength(30);
    expect(data.fbw_spy_state.reelsJob).toBeNull();
    expect(data.fbw_spy_state.reelsProgress[pid]).toEqual({ cursor: "C30", collectionId: "COLL" });
    expect(Object.values(data.fbw_spy_queue.readings)[0]).toMatchObject({ ok: true, pages: 30, reelsAdded: 300 });
    vi.setSystemTime(new Date(2026, 9, 4, 8).getTime());
    pages = []; script = [{ ok: true, rows: rows(900, 2), hasNext: false }];
    await run(3);
    expect(pages[0]).toMatchObject({ cursor: "C30", collectionId: "COLL" });
  });

  it("catches up after a busy day and stops at the first reel it already had", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { [pid]: fb({ status: "done", count: 50, recent: [String(2209826979590015)] }) } };
    data.fbw_spy_state.reelsCatchup = { [pid]: true };
    script = [
      { ok: true, rows: rows(0, 10), hasNext: true, cursor: "C1", collectionId: "COLL" },
      { ok: true, rows: rows(10, 10), hasNext: true, cursor: "C2", collectionId: "COLL" },
    ];
    await run(5);
    expect(pages).toHaveLength(2);
    expect(Object.values(data.fbw_spy_queue.readings)[0]).toMatchObject({ kind: "reels", source: "catchup", ok: true, reelsAdded: 19 });
    expect(data.fbw_spy_state.reelsCatchup[pid]).toBeUndefined();
  });

  it("pauses Facebook and logs the failure when the session is gone", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { [pid]: fb({ status: "pending", count: 0, recent: [] }) } };
    script = [{ ok: false, error: "login_required" }];
    await run(3);
    expect(data.fbw_spy_state.blocked.facebook).toBeGreaterThan(now);
    expect(Object.values(data.fbw_spy_queue.readings)).toEqual([expect.objectContaining({ kind: "reels", ok: false, error: "login_required" })]);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(77);
  });

  it("keeps the worker waking every minute while reels are still to be read", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { [pid]: fb({ status: "pending", count: 0, recent: [] }) } };
    await scheduleSpy();
    expect(alarms["fbw-spy-tick"]).toEqual({ delayInMinutes: 1 });
  });

  it("does not measure followers again when the reels tab it opened loads", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { [pid]: { ...fb({ status: "running", count: 0, recent: [] }), lastMeasuredAt: null } } };
    const fetcher = vi.fn(async () => ({ status: 200, text: async () => "" }));
    vi.stubGlobal("fetch", fetcher);
    tabsUpdatedListener(77, { status: "complete" }, { id: 77, url: "https://www.facebook.com/profile.php?id=61589642519378&sk=reels_tab#socialmate-reels" });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks for a catch-up when every reel of the daily page is new", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { [pid]: fb({ status: "done", count: 9, recent: ["2209826979500000"] }) } };
    const node = (id) => ({ profile_reel_node: { node: { __typename: "Story", creation_time: 1, actors: [{ id: "6" }],
      attachments: [{ media: { __typename: "Video", id, created_time: 1 } }] } } });
    const html = `"profile_social_context":{"text":"10 followers"}<script type="application/json">${JSON.stringify({ x: { id: "COLL",
      aggregated_fb_shorts: { edges: rows(0, 10).map((r) => node(r.id)), page_info: { end_cursor: "C", has_next_page: true } } } })}</script>`;
    await measureFbProfile({ ...fb(), lastMeasuredAt: null, reels: data.fbw_spy.profiles[pid].reels }, "daily", async () => ({ status: 200, text: async () => html }));
    expect(data.fbw_spy_state.reelsCatchup).toEqual({ [pid]: true });
  });
});

describe("Medir agora measures every profile on demand", () => {
  const now = new Date(2026, 9, 3, 15).getTime();
  const ig = (key, lastMeasuredAt) => ({ id: `instagram:${key}`, platform: "instagram", key, lastMeasuredAt,
    hasAvatar: true, removedAt: null });
  const fb = (key, lastMeasuredAt) => ({ id: `facebook:${key}`, platform: "facebook", key, lastMeasuredAt,
    removedAt: null, reels: { status: "done", count: 0, recent: [] } });
  const observe = (key) => sendMessage({ type: "FBW_SPY_OBSERVE", platform: "instagram", key,
    data: { username: key, follower_count: 42 } },
    { tab: { id: 90 }, url: `https://www.instagram.com/${key}/#socialmate-spy`, frameId: 0 });
  let fbRequests;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    data.fbw_sync = { url: "https://hub", token: "secret" };
    data.fbw_spy_state = { day: "2026-10-03", attempts: {}, blocked: {}, igBatch: null };
    chrome.tabs.create = vi.fn(async (opts) => ({ id: 90, ...opts }));
    chrome.tabs.update = vi.fn(async (id, opts) => ({ id, ...opts }));
    chrome.tabs.get = vi.fn(async (id) => ({ id, url: "https://www.instagram.com/#socialmate-spy" }));
    chrome.tabs.remove = vi.fn(async () => {});
    chrome.tabs.sendMessage = vi.fn(async () => ({ ok: true, spy: true }));
    fbRequests = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("facebook.com")) {
        fbRequests.push(String(url));
        return { status: 200, url, text: async () => '"profile_social_context":{"text":"42 followers"}' };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("re-reads Instagram profiles already measured today or waiting for a retry", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: {
      "instagram:nasa": ig("nasa", now - 3600000), "instagram:natgeo": ig("natgeo", now - 7200000) } };
    data.fbw_spy_state.attempts = { "instagram:nasa": { n: 2, at: now - 60000 } };
    await spyTick({ manual: true });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(data.fbw_spy_state.igBatch.pending).toEqual(["natgeo", "nasa"]);
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(90, { url: "https://www.instagram.com/natgeo/#socialmate-spy" });
  });

  it("keeps going through the batch and records the reading as manual", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: {
      "instagram:nasa": ig("nasa", now - 3600000), "instagram:natgeo": ig("natgeo", now - 7200000) } };
    await spyTick({ manual: true });
    expect(await observe("natgeo")).toMatchObject({ ok: true });
    expect(Object.values(data.fbw_spy_queue.readings)).toEqual([expect.objectContaining({
      profileId: "instagram:natgeo", source: "manual", ok: true })]);
    vi.clearAllTimers(); vi.setSystemTime(data.fbw_spy_state.igBatch.nextAt);
    await spyTick();
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(90, { url: "https://www.instagram.com/nasa/#socialmate-spy" });
    expect(await observe("nasa")).toMatchObject({ ok: true });
    expect(data.fbw_spy_state.igBatch).toBeNull();
  });

  it("widens a running daily batch instead of ignoring the click", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: {
      "instagram:nasa": ig("nasa", null), "instagram:natgeo": ig("natgeo", now - 3600000) } };
    await spyTick();
    expect(data.fbw_spy_state.igBatch.pending).toEqual(["nasa"]);
    await spyTick({ manual: true });
    expect(data.fbw_spy_state.igBatch.pending).toEqual(["nasa", "natgeo"]);
    expect(await observe("nasa")).toMatchObject({ ok: true });
    vi.clearAllTimers(); vi.setSystemTime(data.fbw_spy_state.igBatch.nextAt);
    await spyTick();
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(90, { url: "https://www.instagram.com/natgeo/#socialmate-spy" });
  });

  it("still respects an Instagram pause and the daily navigation cap", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { "instagram:nasa": ig("nasa", now - 3600000) } };
    data.fbw_spy_state.blocked = { instagram: now + 3600000 };
    await spyTick({ manual: true });
    data.fbw_spy_state.blocked = {};
    data.fbw_spy_state.igDaily = { day: "2026-10-03", count: 20 };
    await spyTick({ manual: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  const log = () => (data.fbw_spy_activity || []).map((e) => `${e.platform}|${e.tone}|${e.text}`);

  it("tells the panel each step of a manual pass, with counts and outcomes", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { "instagram:nasa": ig("nasa", now - 3600000),
      "facebook:a": { ...fb("a", now - 3600000), name: "Página A" } } };
    await spyTick({ manual: true });
    await observe("nasa");
    vi.clearAllTimers();
    expect(log()).toEqual([
      "null|info|Medir agora: pedido recebido",
      "facebook|info|1 perfil na fila · 1 por minuto",
      "facebook|ok|Página A: 42 seguidores · Medir agora",
      "instagram|info|Lote manual com 1 perfil · abrindo aba do Instagram em segundo plano, 1 perfil a cada 20–40 s",
      "instagram|info|Abrindo @nasa (1 de 1)",
      "instagram|ok|@nasa: 42 seguidores · Medir agora",
      "instagram|ok|Lote concluído · 1 de 1 perfis (1 lido) · aba fechada",
    ]);
  });

  it("counts a profile whose page never answered as a failure, by its handle", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: {
      "instagram:nasa": { ...ig("nasa", now - 3600000), name: "NASA" }, "instagram:natgeo": ig("natgeo", now - 7200000) } };
    await spyTick({ manual: true });
    vi.clearAllTimers(); vi.setSystemTime(data.fbw_spy_state.igBatch.nextAt);
    await spyTick();
    expect(data.fbw_spy_state.igBatch.failed).toBe(1);
    await observe("nasa");
    expect(log()).toContain("instagram|warn|@natgeo: a página abriu mas não trouxe os números");
    expect(log().at(-1)).toBe("instagram|warn|Lote concluído · 2 de 2 perfis (1 lido, 1 com falha) · aba fechada");
  });

  it("uses the daily Instagram cap set in Options", async () => {
    data.fbw_spy_prefs = { daily: true, igLimit: 1 };
    data.fbw_spy = { fetchedAt: now, profiles: { "instagram:nasa": ig("nasa", now - 3600000),
      "instagram:natgeo": ig("natgeo", now - 7200000) } };
    await spyTick({ manual: true });
    expect(data.fbw_spy_state.igBatch.pending).toEqual(["natgeo"]);
    expect(log()).toContain("instagram|info|Lote manual com 1 perfil (1 fica para amanhã: limite de 1 por dia, ajustável em Opções) · abrindo aba do Instagram em segundo plano, 1 perfil a cada 20–40 s");
    await observe("natgeo");
    data.fbw_spy_prefs = { daily: true, igLimit: 3 };
    vi.setSystemTime(now + 60000);
    await spyTick({ manual: true });
    expect(data.fbw_spy_state.igBatch.pending).toEqual(["nasa", "natgeo"]);
  });

  it("explains why a click did not open Instagram", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { "instagram:nasa": ig("nasa", now - 3600000) } };
    data.fbw_spy_state.igDaily = { day: "2026-10-03", count: 20 };
    await spyTick({ manual: true });
    expect(log()).toContain("instagram|warn|Limite de 20 leituras do Instagram hoje já atingido · Medir agora volta amanhã (o limite se ajusta em Opções)");
    data.fbw_spy_state.blocked = { instagram: now + 3600000 };
    data.fbw_spy_state.blockedReason = { instagram: "login_required" };
    await spyTick({ manual: true });
    expect(log().at(-1)).toMatch(/^instagram\|warn\|Medir agora não abriu o Instagram: em pausa até \d\d:\d\d \(a rede pediu login/);
  });

  it("says when the batch tab never answered", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { "instagram:nasa": ig("nasa", now - 3600000) } };
    chrome.tabs.sendMessage = vi.fn(async () => { throw new Error("no receiver"); });
    const tick = spyTick({ manual: true });
    await vi.advanceTimersByTimeAsync(21000);
    await tick;
    expect(log().at(-1)).toBe("instagram|warn|Lote encerrado · 0 de 1 perfis (0 lidos) — a aba do Instagram não respondeu em 20 s; abra o Instagram neste Chrome e confira se está logado");
  });

  it("records the hub upload result and logs only the first failure and the recovery", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: {} };
    data.fbw_spy_queue = { ops: [], profiles: {}, snapshots: {}, errors: {}, readings: { r: { profileId: "x", at: 1 } } };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await flushSpy({ attempt: 9 });
    await flushSpy({ attempt: 9 });
    expect(data.fbw_spy_hub).toMatchObject({ ok: false, status: 0, at: now });
    expect(log()).toEqual(["hub|error|Envio ao hub falhou (hub fora do ar ou sem rede) · os registros ficam guardados e o envio é tentado de novo"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await flushSpy();
    expect(data.fbw_spy_hub).toMatchObject({ ok: true, sent: 1 });
    expect(log().at(-1)).toBe("hub|ok|Envio ao hub voltou a funcionar · 1 registro enviado");
  });

  it("runs every account even with the daily pass switched off, and only what the click queued", async () => {
    data.fbw_spy_prefs = { daily: false };
    data.fbw_spy = { fetchedAt: now, profiles: { "instagram:nasa": ig("nasa", now - 3600000),
      "instagram:natgeo": ig("natgeo", now - 7200000), "facebook:a": fb("a", now - 3600000), "facebook:b": fb("b", now - 3600000) } };
    await spyTick({ manual: true });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(fbRequests).toHaveLength(1);
    await scheduleSpy();
    expect(alarms["fbw-spy-tick"]).toEqual({ delayInMinutes: 1 });
    expect(log()).toContain("null|info|Medição diária desligada em Opções · o Medir agora roda mesmo assim");
    expect(await observe("natgeo")).toMatchObject({ ok: true });
    vi.clearAllTimers(); vi.setSystemTime(data.fbw_spy_state.igBatch.nextAt);
    await spyTick();
    expect(fbRequests).toHaveLength(2);
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(90, { url: "https://www.instagram.com/nasa/#socialmate-spy" });
    expect(await observe("nasa")).toMatchObject({ ok: true });
    await spyTick();
    expect(fbRequests).toHaveLength(2);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    await scheduleSpy();
    expect(alarms["fbw-spy-tick"]).toBeUndefined();
  });

  it("measures every Facebook profile, one per tick, even when all were measured today", async () => {
    data.fbw_spy = { fetchedAt: now, profiles: { "facebook:a": fb("a", now - 3600000), "facebook:b": fb("b", now - 3600000) } };
    await spyTick({ manual: true });
    expect(fbRequests).toHaveLength(1);
    expect(alarms["fbw-spy-tick"]).toEqual({ delayInMinutes: 1 });
    await spyTick();
    expect(fbRequests).toHaveLength(2);
    expect(fbRequests.map((u) => u.match(/facebook\.com\/(\w+)/)[1]).sort()).toEqual(["a", "b"]);
    await spyTick();
    expect(fbRequests).toHaveLength(2);
    expect(data.fbw_spy_state.fbManual ?? null).toBeNull();
  });
});
