import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const data = {};
const alarms = {};
let messageListener = null;

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

  return stub;
}

let scheduleSpy, flushSpy, spyTick;

beforeAll(async () => {
  vi.stubGlobal("chrome", chromeStub());
  ({ scheduleSpy, flushSpy, spyTick } = await import("./background.js"));
});

beforeEach(() => {
  for (const k of Object.keys(data)) delete data[k];
  for (const k of Object.keys(alarms)) delete alarms[k];
});

function sendMessage(msg) {
  return new Promise((resolve) => {
    const handled = messageListener(msg, {}, resolve);
    if (!handled) resolve(undefined);
  });
}

describe("background spy area (phase E2)", () => {
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
            lastMeasuredAt: Date.now(), // measured today
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
});
