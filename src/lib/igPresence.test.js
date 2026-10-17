import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createIgPresence, reconnectDelay } from "./igPresence.js";

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.listeners = {};
    FakeSocket.all.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code, reason });
  }
  // test helpers
  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
  serverSays(msg) {
    this.emit("message", { data: JSON.stringify(msg) });
  }
}

let destinations;
function presence(extra = {}) {
  return createIgPresence({
    WebSocketImpl: FakeSocket,
    destinations: async () => destinations,
    version: "1.14.0",
    stats: async (id) => ({ queueLen: id === "local" ? 3 : 0, sent: 7, failed: 1, lastError: "" }),
    random: () => 0.5,
    ...extra,
  });
}

const local = { id: "local", url: "http://localhost:3001", token: "tok-local" };
const prod = { id: "prod", url: "https://ig.example.com", token: "tok-prod" };

describe("reconnectDelay", () => {
  it("backs off from 2 s to a 60 s ceiling, with jitter inside the bounds", () => {
    expect(reconnectDelay(0, () => 0)).toBeGreaterThanOrEqual(2000);
    expect(reconnectDelay(0, () => 1)).toBeLessThanOrEqual(2500);
    expect(reconnectDelay(10, () => 1)).toBe(60_000);
    expect(reconnectDelay(10, () => 0)).toBeGreaterThanOrEqual(45_000);
  });
});

describe("igPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    destinations = [local];
  });
  afterEach(() => vi.useRealTimers());

  it("opens one socket per enabled destination and says hello as socialmate-extension", async () => {
    destinations = [local, prod];
    const p = presence();
    await p.ensure();
    expect(FakeSocket.all.map((s) => s.url)).toEqual([
      "ws://localhost:3001/ws/extension-relay",
      "wss://ig.example.com/ws/extension-relay",
    ]);
    FakeSocket.all[0].open();
    const hello = FakeSocket.all[0].sent[0];
    expect(hello).toMatchObject({ type: "hello", token: "tok-local", id: "socialmate-extension", version: "1.14.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all[0].sent[1]).toMatchObject({ type: "stats", queueLen: 3, sent: 7, failed: 1 });
    // ensure() again is a no-op for a live socket.
    await p.ensure();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("pings every 20 s and answers the server's ping", async () => {
    const p = presence();
    await p.ensure();
    const ws = FakeSocket.all[0];
    ws.open();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.sent.some((m) => m.type === "ping")).toBe(true);
    ws.serverSays({ type: "ping", at: 1 });
    expect(ws.sent.at(-1)).toMatchObject({ type: "pong" });
  });

  it("closes a silent socket after 60 s and reconnects", async () => {
    const p = presence();
    await p.ensure();
    const ws = FakeSocket.all[0];
    ws.open();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ws.readyState).toBe(FakeSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("a socket that keeps hearing from the server is not stale", async () => {
    const p = presence();
    await p.ensure();
    const ws = FakeSocket.all[0];
    ws.open();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      ws.serverSays({ type: "ping", at: i });
    }
    expect(ws.readyState).toBe(FakeSocket.OPEN);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("a refused token (1008) pauses until the configuration changes", async () => {
    const p = presence();
    await p.ensure();
    FakeSocket.all[0].close(1008, "invalid token");
    await vi.advanceTimersByTimeAsync(120_000);
    await p.ensure(); // the 1-minute alarm calls this
    expect(FakeSocket.all).toHaveLength(1);
    expect(p.status()[0]).toMatchObject({ id: "local", authFailed: true, connected: false });

    destinations = [{ ...local, token: "fixed" }];
    await p.ensure();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("disabling a destination closes its socket and stops reconnecting", async () => {
    destinations = [local, prod];
    const p = presence();
    await p.ensure();
    FakeSocket.all.forEach((s) => s.open());
    destinations = [local];
    await p.ensure();
    expect(FakeSocket.all[1].readyState).toBe(FakeSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.all.filter((s) => s.url.includes("ig.example.com"))).toHaveLength(1);
  });

  it("a dead worker's sockets are rebuilt by ensure() on wake", async () => {
    const first = presence();
    await first.ensure();
    // A new worker instance has no in-memory sockets; persistence of the
    // destination list is what brings the beacon back.
    const second = presence();
    await second.ensure();
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1].url).toBe("ws://localhost:3001/ws/extension-relay");
  });
});
