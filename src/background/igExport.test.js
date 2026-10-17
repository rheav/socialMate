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

import { acceptIgCapture } from "./igExport.js";

describe("acceptIgCapture", () => {
  const sender = { id: "ext-id", tab: { id: 4, url: "https://www.instagram.com/p/CCC/" } };
  const msg = {
    type: "FBW_IG_CAPTURE",
    posts: [{ code: "CCC", pk: "3003", username: "nasa" }],
    comments: [{ cid: "9001", post: "CCC", text: "oi" }],
    postsByCode: { CCC: { code: "CCC", pk: "3003", username: "nasa" } },
  };

  it("accepts a capture from an Instagram tab of this extension", () => {
    expect(acceptIgCapture(msg, sender, "ext-id")).toEqual({
      posts: msg.posts,
      comments: msg.comments,
      postsByCode: msg.postsByCode,
    });
  });

  it("refuses another extension, a non-Instagram tab or no tab", () => {
    expect(acceptIgCapture(msg, { ...sender, id: "other" }, "ext-id")).toBeNull();
    expect(acceptIgCapture(msg, { ...sender, tab: { url: "https://evil.example/instagram.com/" } }, "ext-id")).toBeNull();
    expect(acceptIgCapture(msg, { ...sender, tab: { url: "https://instagram.com.evil.example/" } }, "ext-id")).toBeNull();
    expect(acceptIgCapture(msg, { id: "ext-id" }, "ext-id")).toBeNull();
  });

  it("refuses malformed or oversized payloads", () => {
    expect(acceptIgCapture({ ...msg, posts: "x" }, sender, "ext-id")).toBeNull();
    expect(acceptIgCapture({ ...msg, posts: new Array(1001).fill({}) }, sender, "ext-id")).toBeNull();
    expect(acceptIgCapture({ ...msg, comments: [null] }, sender, "ext-id")).toBeNull();
  });
});

describe("testing a destination", () => {
  const settings = { local: { enabled: false, url: "http://localhost:3001", token: "a" } };
  function withFetch(impl) {
    const chrome = chromeStub();
    chrome.data[IG_DESTINATIONS_KEY] = settings;
    return createIgExport({ chrome, WebSocketImpl: FakeSocket, fetchImpl: impl });
  }

  it("sends an empty batch, so a test stores nothing, and reads the answer", async () => {
    const calls = [];
    const ex = withFetch(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ acceptedIds: [], rejected: [] }) };
    });
    expect(await ex.testDestination("local")).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ url: "http://localhost:3001/ingest/socialmate", auth: "Bearer a" });
    expect(calls[0].body.items).toEqual([]);
  });

  it("names the failures a person can act on", async () => {
    expect(await withFetch(async () => ({ ok: false, status: 401 })).testDestination("local")).toEqual({ ok: false, error: "token recusado" });
    expect(await withFetch(async () => ({ ok: false, status: 404 })).testDestination("local")).toEqual({
      ok: false,
      error: "o backend não tem /ingest/socialmate (versão antiga)",
    });
    expect(await withFetch(async () => { throw new TypeError("x"); }).testDestination("local")).toEqual({ ok: false, error: "sem conexão" });
    expect(await withFetch(async () => ({ ok: true })).testDestination("prod")).toEqual({ ok: false, error: "endereço e token primeiro" });
  });
});
