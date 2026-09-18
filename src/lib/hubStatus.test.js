import { describe, expect, it } from "vitest";
import { hubStatus, timeAgo } from "./hubStatus.js";

const NOW = 1_000_000_000;

describe("hub connection status", () => {
  it("is off when sync isn't configured", () => {
    expect(hubStatus({ configured: false, ping: { at: NOW, ok: true }, state: {}, now: NOW }).tone).toBe("off");
  });

  it("is checking until something has answered", () => {
    expect(hubStatus({ configured: true, ping: null, state: {}, now: NOW }).tone).toBe("checking");
  });

  it("is ok after a good ping", () => {
    const s = hubStatus({ configured: true, ping: { at: NOW - 20_000, ok: true }, state: {}, now: NOW });
    expect(s.tone).toBe("ok");
    expect(s.title).toBe("Acervo conectado · verificado há 20 s");
  });

  it("warns after a failed ping and names the cause", () => {
    const s = hubStatus({
      configured: true,
      ping: { at: NOW, ok: false, error: "sync HTTP 401", status: 401 },
      state: { lastOkAt: NOW - 2 * 3600_000 },
      now: NOW,
    });
    expect(s.tone).toBe("warn");
    expect(s.title).toBe("Acervo com problema: token recusado (401) · último contato ok há 2 h");
  });

  it("reads a network failure as no answer", () => {
    const s = hubStatus({
      configured: true,
      ping: { at: NOW, ok: false, error: "Failed to fetch" },
      state: {},
      now: NOW,
    });
    expect(s.title).toBe("Acervo com problema: sem resposta do servidor");
  });

  it("lets the most recent signal win — a real sync counts as much as a ping", () => {
    const failedSyncAfterPing = hubStatus({
      configured: true,
      ping: { at: NOW - 30_000, ok: true },
      state: { error: "sync HTTP 503", errorAt: NOW - 1_000 },
      now: NOW,
    });
    expect(failedSyncAfterPing.tone).toBe("warn");
    expect(failedSyncAfterPing.title).toContain("503");

    const syncedAfterFailedPing = hubStatus({
      configured: true,
      ping: { at: NOW - 30_000, ok: false, error: "Failed to fetch" },
      state: { lastOkAt: NOW - 1_000 },
      now: NOW,
    });
    expect(syncedAfterFailedPing.tone).toBe("ok");
  });

  it("ignores an error with no timestamp (written before errorAt existed)", () => {
    const s = hubStatus({ configured: true, ping: { at: NOW, ok: true }, state: { error: "old" }, now: NOW });
    expect(s.tone).toBe("ok");
  });
});

describe("timeAgo", () => {
  it("speaks in the largest whole unit", () => {
    expect(timeAgo(NOW - 3_000, NOW)).toBe("agora");
    expect(timeAgo(NOW - 45_000, NOW)).toBe("há 45 s");
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe("há 5 min");
    expect(timeAgo(NOW - 3 * 3600_000, NOW)).toBe("há 3 h");
    expect(timeAgo(NOW - 2 * 86400_000, NOW)).toBe("há 2 d");
  });
});
