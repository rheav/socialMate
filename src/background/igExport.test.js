import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createIgExport, IG_EXPORT_ALARM } from "./igExport.js";
import { IG_DESTINATIONS_KEY } from "../lib/igDestinations.js";
import { IG_OUTBOX_KEY } from "../lib/igOutbox.js";

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FakeSocket.all.push(this);
  }
  addEventListener(t, fn) {
    (this.listeners[t] ||= []).push(fn);
  }
  send() {}
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const fn of this.listeners.close || []) fn({ code });
  }
}

function chromeStub() {
  const data = {};
  const listeners = { changed: [], startup: [] };
  const alarms = {};
  return {
    data,
    listeners,
    alarmMap: alarms,
    storage: {
      local: {
        get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) changes[k] = { newValue: v };
          Object.assign(data, structuredClone(obj));
          for (const fn of listeners.changed) fn(changes, "local");
        },
      },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
    runtime: { onStartup: { addListener: (fn) => listeners.startup.push(fn) } },
    alarms: {
      get: async (name) => alarms[name] || undefined,
      create: (name, opts) => {
        alarms[name] = opts;
      },
    },
  };
}

const both = {
  local: { enabled: true, url: "http://localhost:3001", token: "a" },
  prod: { enabled: true, url: "https://ig.example.com", token: "b" },
};

describe("igExport wiring", () => {
  let chrome;
  let fetchImpl;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    chrome = chromeStub();
    fetchImpl = vi.fn(async () => {
      throw new TypeError("offline");
    });
  });
  afterEach(() => vi.useRealTimers());

  it("registers its listeners and the backstop alarm once", async () => {
    const ex = createIgExport({ chrome, WebSocketImpl: FakeSocket, fetchImpl });
    ex.init();
    ex.init();
    await vi.advanceTimersByTimeAsync(0);
    expect(chrome.listeners.changed).toHaveLength(1);
    expect(chrome.listeners.startup).toHaveLength(1);
    expect(chrome.alarmMap[IG_EXPORT_ALARM]).toEqual({ periodInMinutes: 1 });
  });

  it("captures go only to the destinations enabled at that moment", async () => {
    chrome.data[IG_DESTINATIONS_KEY] = { ...both, prod: { ...both.prod, enabled: false } };
    const ex = createIgExport({ chrome, WebSocketImpl: FakeSocket, fetchImpl });
    const r = await ex.enqueueIgEvents([{ eventId: "e1", kind: "post", observedAt: "x", record: {} }]);
    expect(r.destinations).toEqual(["local"]);
    expect(Object.keys(chrome.data[IG_OUTBOX_KEY].dest)).toEqual(["local"]);
  });

  it("disabling a destination closes its beacon and keeps its queue", async () => {
    chrome.data[IG_DESTINATIONS_KEY] = both;
    const ex = createIgExport({ chrome, WebSocketImpl: FakeSocket, fetchImpl });
    ex.init();
    await vi.advanceTimersByTimeAsync(0);
    await ex.enqueueIgEvents([{ eventId: "e1", kind: "post", observedAt: "x", record: {} }]);
    expect(FakeSocket.all.map((s) => s.url)).toEqual([
      "ws://localhost:3001/ws/extension-relay",
      "wss://ig.example.com/ws/extension-relay",
    ]);

    await chrome.storage.local.set({ [IG_DESTINATIONS_KEY]: { ...both, prod: { ...both.prod, enabled: false } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all[1].readyState).toBe(3);
    expect(chrome.data[IG_OUTBOX_KEY].dest.prod.e1).toBeDefined();

    // Flushes after the change never reach the disabled destination.
    fetchImpl.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    const hosts = fetchImpl.mock.calls.map(([url]) => new URL(url).host);
    expect(hosts).not.toContain("ig.example.com");
  });

  it("a retryable failure backs off and does not spin", async () => {
    chrome.data[IG_DESTINATIONS_KEY] = { local: both.local };
    const ex = createIgExport({ chrome, WebSocketImpl: FakeSocket, fetchImpl });
    await ex.enqueueIgEvents([{ eventId: "e1", kind: "post", observedAt: "x", record: {} }]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // debounce + 4 backoff retries; the alarm (not running in this stub) is the backstop.
    expect(fetchImpl.mock.calls.length).toBe(5);
    expect(chrome.data[IG_OUTBOX_KEY].dest.local.e1).toBeDefined();
  });
});
