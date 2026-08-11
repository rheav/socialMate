import { describe, it, expect, beforeAll, vi } from "vitest";

// ============================================================================
// reviveTab's recovery ladder.
//
// WHY THESE ARE UNIT TESTS AND NOT A LIVE CHECK. reviveTab climbs three rungs —
// `alive` (the tab answered a ping), `inject` (chrome.scripting put the content
// scripts back), `reload` (the tab had to be reloaded) — and only the first is
// reachable on demand in a real browser. Chrome heals the tab first, every time:
// a discarded tab resurrects on the very first sendMessage, and an extension
// reload re-injects every content script from its own onInstalled handler. Three
// live attempts to force `inject`/`reload` on a real Facebook tab all came back
// `{ ok: true, method: "alive" }`. So the ladder was given a seam — reviveWith()
// takes its four steps as an argument — and the branches are driven from here.
// The seam is the only change: order, retry counts and every return value are
// exactly what the inlined version returned.
//
// Importing background.js runs the whole service worker module (listener
// registrations plus one syncBadge()), so `chrome` is stubbed with a permissive
// self-expanding proxy: every property is a function that answers a resolved
// promise, which is enough for `x.onFoo.addListener(...)` and for the storage
// read at module scope. Nothing in this file depends on that stub's behaviour —
// the steps under test are all injected explicitly.
// ============================================================================

function chromeStub() {
  const node = () => {
    const fn = () => Promise.resolve();
    return new Proxy(fn, {
      get(target, prop) {
        if (prop === "then") return undefined; // never look like a thenable
        if (!(prop in target)) target[prop] = node();
        return target[prop];
      },
      apply: () => Promise.resolve(),
    });
  };
  return node();
}

let reviveWith, offscreenTranscribeMessage;

beforeAll(async () => {
  vi.stubGlobal("chrome", chromeStub());
  ({ reviveWith, offscreenTranscribeMessage } = await import("./background.js"));
});

// A recording set of steps. `ping` and `waitForPing` answer from scripted
// queues, so each rung of the ladder can be made to succeed or fail on demand.
function steps({ ping = [false], waits = [false, false], reloadThrows = null, reinjectThrows = null } = {}) {
  const calls = [];
  const pings = [...ping];
  const waitQueue = [...waits];
  return {
    calls,
    ping: async (tabId) => {
      calls.push(["ping", tabId]);
      return pings.length > 1 ? pings.shift() : pings[0];
    },
    reinject: async (tabId) => {
      calls.push(["reinject", tabId]);
      if (reinjectThrows) throw new Error(reinjectThrows);
      return 1;
    },
    waitForPing: async (tabId, attempts, delayMs) => {
      calls.push(["waitForPing", tabId, attempts, delayMs]);
      return waitQueue.length > 1 ? waitQueue.shift() : waitQueue[0];
    },
    reload: async (tabId) => {
      calls.push(["reload", tabId]);
      if (reloadThrows) throw new Error(reloadThrows);
    },
  };
}

const names = (s) => s.calls.map((c) => c[0]);

describe("reviveWith — the recovery ladder", () => {
  it("refuses a missing tab without touching anything", async () => {
    const s = steps();
    expect(await reviveWith(s, null)).toEqual({ ok: false, error: "nenhuma aba para reconectar" });
    expect(await reviveWith(s, undefined)).toEqual({ ok: false, error: "nenhuma aba para reconectar" });
    expect(s.calls).toEqual([]);
  });

  it("method 'alive': a tab that answers is left completely alone", async () => {
    // The only rung that ever ran live. Re-injecting a healthy tab would be a
    // pointless risk to whatever the user has on screen, so nothing else fires.
    const s = steps({ ping: [true] });
    expect(await reviveWith(s, 7)).toEqual({ ok: true, method: "alive" });
    expect(names(s)).toEqual(["ping"]);
    expect(s.calls[0]).toEqual(["ping", 7]);
  });

  it("method 'inject': re-injection revives it, and the tab is never reloaded", async () => {
    // The point of this rung: the page keeps its scroll position, its open reel
    // and any half-typed comment. Asserting `reload` is absent is asserting that.
    const s = steps({ ping: [false], waits: [true] });
    expect(await reviveWith(s, 7)).toEqual({ ok: true, method: "inject" });
    expect(names(s)).toEqual(["ping", "reinject", "waitForPing"]);
    expect(s.calls[2]).toEqual(["waitForPing", 7, 6, 250]); // ≤1.5s for an injection
  });

  it("method 'reload': falls back only after the injection wait runs out", async () => {
    const s = steps({ ping: [false], waits: [false, true] });
    expect(await reviveWith(s, 7)).toEqual({ ok: true, method: "reload" });
    expect(names(s)).toEqual(["ping", "reinject", "waitForPing", "reload", "waitForPing"]);
    // The second wait is the long one — ≤10s covers a cold facebook.com load.
    expect(s.calls[4]).toEqual(["waitForPing", 7, 20, 500]);
  });

  it("a failing re-injection is not fatal — it falls through to the reload", async () => {
    // executeScript throws for exactly the tabs that need the blunt fallback
    // (discarded, or opened before the extension had its host permission).
    const s = steps({ ping: [false], waits: [false, true], reinjectThrows: "Cannot access contents of the page" });
    expect(await reviveWith(s, 7)).toEqual({ ok: true, method: "reload" });
    expect(names(s)).toEqual(["ping", "reinject", "waitForPing", "reload", "waitForPing"]);
  });

  it("reports the reload's own failure verbatim", async () => {
    const s = steps({ ping: [false], waits: [false], reloadThrows: "No tab with id: 7." });
    expect(await reviveWith(s, 7)).toEqual({ ok: false, error: "No tab with id: 7." });
    expect(names(s)).toEqual(["ping", "reinject", "waitForPing", "reload"]); // no second wait
  });

  it("reports a tab that stays silent after a successful reload", async () => {
    // A failed recovery has to be as visible as a successful one — the panel
    // prints this string.
    const s = steps({ ping: [false], waits: [false, false] });
    expect(await reviveWith(s, 7)).toEqual({ ok: false, error: "a aba não respondeu depois de recarregar" });
    expect(names(s)).toEqual(["ping", "reinject", "waitForPing", "reload", "waitForPing"]);
  });

  it("tab id 0 is a real tab, not a missing one", async () => {
    const s = steps({ ping: [true] });
    expect(await reviveWith(s, 0)).toEqual({ ok: true, method: "alive" });
  });
});

describe("offscreen transcription requests", () => {
  it("carries the requested Whisper language to the offscreen document", () => {
    expect(offscreenTranscribeMessage("123", "https://cdn/audio.mp4", "br")).toEqual({
      action: "transcribeFromAudioUrl",
      videoId: "123",
      audioUrl: "https://cdn/audio.mp4",
      language: "pt",
    });
    expect(offscreenTranscribeMessage("123", "https://cdn/audio.mp4", "en")).toEqual({
      action: "transcribeFromAudioUrl",
      videoId: "123",
      audioUrl: "https://cdn/audio.mp4",
      language: "en",
    });
  });

  it("defaults invalid or missing language to Portuguese", () => {
    expect(offscreenTranscribeMessage("123", "https://cdn/audio.mp4", "es").language).toBe("pt");
    expect(offscreenTranscribeMessage("123", "https://cdn/audio.mp4").language).toBe("pt");
  });
});
