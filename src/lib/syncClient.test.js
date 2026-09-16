import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_SYNC_URL,
  isSyncConfigured,
  backoffDelay,
  batchRecords,
  isRetryable,
  isSyncReady,
  pingSync,
  postSync,
  syncSettings,
} from "./syncClient.js";

const rec = (id, pad = 0) => ({ videoId: id, platform: "instagram", thumb: "x".repeat(pad) });

describe("settings", () => {
  it("falls back to the shipped host and trims a trailing slash", () => {
    expect(syncSettings(null).url).toBe(DEFAULT_SYNC_URL);
    expect(syncSettings({ url: "https://h.example.com///" }).url).toBe("https://h.example.com");
  });

  it("is only ready to send BY ITSELF when the automatic switch is on", () => {
    expect(isSyncReady({ enabled: true, url: "https://h", token: "t" })).toBe(true);
    expect(isSyncReady({ enabled: false, url: "https://h", token: "t" })).toBe(false);
    expect(isSyncReady({ enabled: true, url: "https://h", token: "" })).toBe(false);
  });

  it("counts as configured without the automatic switch — a manual push still works", () => {
    expect(isSyncConfigured({ enabled: false, url: "https://h", token: "t" })).toBe(true);
    expect(isSyncConfigured({ enabled: true, url: "https://h", token: "" })).toBe(false);
    // An empty url is not "no hub": syncSettings falls back to the host the
    // extension ships with, so only the token can be genuinely missing.
    expect(isSyncConfigured({ enabled: true, url: "", token: "t" })).toBe(true);
  });
});

describe("batchRecords", () => {
  it("caps a batch by count", () => {
    const batches = batchRecords(Array.from({ length: 60 }, (_, i) => rec(String(i))), { maxItems: 25 });
    expect(batches.map((b) => b.length)).toEqual([25, 25, 10]);
  });

  it("caps a batch by serialized size — 25 thumbnails is not a small request", () => {
    const batches = batchRecords([rec("a", 3000), rec("b", 3000), rec("c", 3000)], { maxBytes: 7000 });
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });

  it("still sends a single oversized record instead of stranding it forever", () => {
    const batches = batchRecords([rec("huge", 50_000)], { maxBytes: 1000 });
    expect(batches).toHaveLength(1);
    expect(batches[0][0].videoId).toBe("huge");
  });

  it("is empty for nothing to send", () => {
    expect(batchRecords([])).toEqual([]);
    expect(batchRecords(null)).toEqual([]);
  });
});

describe("retry policy", () => {
  it("backs off exponentially and stops growing at 30s", () => {
    expect([0, 1, 2, 3, 9].map(backoffDelay)).toEqual([2000, 4000, 8000, 16_000, 30_000]);
  });

  it("retries the failures another attempt can fix, and only those", () => {
    expect(isRetryable(0)).toBe(true); // offline
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(401)).toBe(false); // wrong token, forever
    expect(isRetryable(400)).toBe(false);
  });
});

describe("requests", () => {
  it("sends the token as a header, not a cookie", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await postSync({ enabled: true, url: "https://h", token: "secret" }, { saved: [rec("a")] }, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://h/api/sync");
    expect(init.headers["X-Sync-Token"]).toBe("secret");
    expect(init.body).toContain('"saved"');
  });

  it("surfaces the status code so the caller can decide whether to retry", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }));
    await expect(pingSync({ url: "https://h", token: "bad" }, fetchImpl)).rejects.toMatchObject({ status: 401 });
  });
});
