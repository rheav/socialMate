import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ANALYSIS_RELAY_KEY, analysisWsUrl, createAnalysisRelay } from "./analysisRelay.js";

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.sent = [];
    FakeSocket.all.push(this);
  }
  addEventListener(t, fn) {
    (this.listeners[t] ||= []).push(fn);
  }
  emit(t, ev) {
    for (const fn of this.listeners[t] || []) fn(ev);
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  receive(msg) {
    this.emit("message", { data: JSON.stringify(msg) });
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

function storageStub() {
  const data = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (obj) => Object.assign(data, structuredClone(obj)),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const job = { type: "job", taskId: "t1", runId: "r1", stage: "post", attempt: 1, leaseToken: "lease-1", leaseMs: 120000, payload: { code: "CCC" } };

let storage;
let settings;
let collect;
let relay;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  storage = storageStub();
  settings = { url: "https://hub.example/", token: "sync-token" };
  collect = {
    preparePost: vi.fn(async () => ({ ok: true, result: { evidenceHash: "h1" } })),
    cancelPrepare: vi.fn(async () => true),
  };
  relay = createAnalysisRelay({ WebSocketImpl: FakeSocket, settings: async () => settings, storage, collect, version: "1.14.0", random: () => 0.5 });
});

afterEach(() => {
  relay.close();
  vi.useRealTimers();
});

async function connected() {
  await relay.ensure();
  const ws = FakeSocket.all.at(-1);
  ws.open();
  await flush();
  ws.receive({ type: "welcome", role: "extension" });
  await flush();
  return ws;
}

describe("analysisWsUrl", () => {
  it("turns the Acervo URL into its extension socket", () => {
    expect(analysisWsUrl("https://hub.example/")).toBe("wss://hub.example/ws/socialmate-extension");
    expect(analysisWsUrl("http://localhost:3000")).toBe("ws://localhost:3000/ws/socialmate-extension");
  });
});

describe("connection", () => {
  it("says hello with the sync token in the first frame, never in the URL, and a stable instance id", async () => {
    const ws = await connected();
    expect(ws.url).toBe("wss://hub.example/ws/socialmate-extension");
    expect(ws.url).not.toMatch(/token/);
    const [hello] = ws.sent;
    expect(hello).toMatchObject({ type: "hello", role: "extension", token: "sync-token", version: "1.14.0" });
    expect(hello.instanceId).toMatch(/^ext-/);
    expect(storage.data[ANALYSIS_RELAY_KEY].instanceId).toBe(hello.instanceId);
    relay.close();
    const again = await connected();
    expect(again.sent[0].instanceId).toBe(hello.instanceId);
  });

  it("answers pings and does nothing without a configured Acervo", async () => {
    const ws = await connected();
    ws.receive({ type: "ping", at: 1 });
    expect(ws.types()).toContain("pong");
    relay.close();
    settings = { url: "https://hub.example", token: "" };
    await relay.ensure();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("reconnects with backoff, but waits for a new token after a refusal", async () => {
    const ws = await connected();
    ws.close(1006);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.all).toHaveLength(2);
    const second = FakeSocket.all[1];
    second.open();
    second.close(1008);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await relay.ensure();
    expect(FakeSocket.all).toHaveLength(2);
    settings = { ...settings, token: "new-token" };
    await relay.ensure();
    expect(FakeSocket.all).toHaveLength(3);
  });
});

describe("jobs", () => {
  it("prepares the post, keeps the lease alive while working, and reports the result once", async () => {
    let finish;
    collect.preparePost.mockImplementation((_job, { progress }) => {
      progress("collect_page_read");
      return new Promise((r) => (finish = r));
    });
    const ws = await connected();
    ws.receive(job);
    await flush();
    expect(collect.preparePost).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", leaseToken: "lease-1", payload: { code: "CCC" } }), expect.any(Object));
    expect(ws.sent.find((m) => m.type === "progress")).toEqual({ type: "progress", taskId: "t1", leaseToken: "lease-1", code: "collect_page_read" });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(ws.sent.filter((m) => m.type === "heartbeat")).toHaveLength(2);
    finish({ ok: true, result: { evidenceHash: "h1" } });
    await flush();
    expect(ws.sent.at(-1)).toEqual({ type: "result", taskId: "t1", leaseToken: "lease-1", result: { evidenceHash: "h1" } });
    ws.receive({ type: "ping", at: 2 }); // the line stays up; the heartbeats stop with the job
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.sent.filter((m) => m.type === "heartbeat")).toHaveLength(2);
  });

  it("carries what the collector is doing in its heartbeats, sending a new phase at once", async () => {
    let live;
    collect.preparePost.mockImplementation((_job, opts) => {
      live = opts.live;
      return new Promise(() => {});
    });
    const ws = await connected();
    ws.receive(job);
    await flush();
    live({ phase: "comments", detail: "até 200" });
    const first = ws.sent.filter((m) => m.type === "heartbeat").at(-1);
    expect(first.live).toMatchObject({ phase: "comments", detail: "até 200", stepStartedAt: expect.any(Number) });
    live({ phase: "comments", detail: "mais" });
    expect(ws.sent.filter((m) => m.type === "heartbeat")).toHaveLength(1);
    ws.receive({ type: "ping", at: 1 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.sent.filter((m) => m.type === "heartbeat").at(-1).live).toMatchObject({ phase: "comments", detail: "mais" });
  });

  it("reports a failure with its code", async () => {
    collect.preparePost.mockResolvedValue({ ok: false, code: "rate_limited" });
    const ws = await connected();
    ws.receive(job);
    await flush();
    expect(ws.sent.at(-1)).toEqual({ type: "error", taskId: "t1", leaseToken: "lease-1", code: "rate_limited" });
  });

  it("keeps an unacknowledged result across a reconnect (and a worker restart) and sends it again", async () => {
    const ws = await connected();
    ws.receive(job);
    await flush();
    ws.close(1006);
    expect(storage.data[ANALYSIS_RELAY_KEY].pending).toMatchObject({ type: "result", taskId: "t1" });
    // A new worker: same storage, fresh module.
    relay.close();
    relay = createAnalysisRelay({ WebSocketImpl: FakeSocket, settings: async () => settings, storage, collect, version: "1.14.0", random: () => 0.5 });
    const next = await connected();
    expect(next.sent.filter((m) => m.type === "result")).toHaveLength(1);
    next.receive({ type: "ack", taskId: "t1" });
    await flush();
    expect(storage.data[ANALYSIS_RELAY_KEY].pending).toBeNull();
  });

  it("passes a cancel to the collector and sends nothing for the cancelled task", async () => {
    let finish;
    collect.preparePost.mockImplementation(() => new Promise((r) => (finish = r)));
    const ws = await connected();
    ws.receive(job);
    await flush();
    ws.receive({ type: "cancel", taskId: "t1" });
    await flush();
    expect(collect.cancelPrepare).toHaveBeenCalledWith("t1");
    finish({ ok: false, code: "cancelled" });
    await flush();
    expect(ws.types().filter((t) => t === "result" || t === "error")).toEqual([]);
  });

  it("takes one job at a time", async () => {
    collect.preparePost.mockImplementation(() => new Promise(() => {}));
    const ws = await connected();
    ws.receive(job);
    await flush();
    ws.receive({ ...job, taskId: "t2", leaseToken: "lease-2" });
    await flush();
    expect(collect.preparePost).toHaveBeenCalledTimes(1);
    expect(ws.sent.at(-1)).toEqual({ type: "error", taskId: "t2", leaseToken: "lease-2", code: "busy" });
  });
});
