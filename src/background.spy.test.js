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

let scheduleSpy, flushSpy, spyTick, measureFbProfile;

beforeAll(async () => {
  vi.stubGlobal("chrome", chromeStub());
  ({ scheduleSpy, flushSpy, spyTick, measureFbProfile } = await import("./background.js"));
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
