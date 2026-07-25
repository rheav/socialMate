import { describe, it, expect } from "vitest";
import {
  INITIAL_LINK,
  LINK_NO_TAB,
  LINK_OK,
  LINK_UNREACHABLE,
  MISS_THRESHOLD,
  PLATFORM_HOME,
  linkCopy,
  linkErrorText,
  nextLinkState,
} from "./contentLink.js";
import { PLATFORM_HOST, matchesPlatform } from "./tabs.js";

// Fold a list of events, the way the hook does over a session.
const run = (...events) => events.reduce(nextLinkState, INITIAL_LINK);

describe("nextLinkState — poll misses vs user actions", () => {
  it("starts healthy and silent", () => {
    expect(INITIAL_LINK.status).toBe(LINK_OK);
    expect(INITIAL_LINK.error).toBeNull();
  });

  it("tolerates a run of poll misses below the threshold (SPA navigation)", () => {
    const s = run({ kind: "miss", error: "boom" }, { kind: "miss", error: "boom" });
    expect(MISS_THRESHOLD).toBe(3);
    expect(s.status).toBe(LINK_OK);
    expect(s.misses).toBe(2);
  });

  it("reports unreachable once the misses reach the threshold", () => {
    const s = run(
      { kind: "miss", error: "boom" },
      { kind: "miss", error: "boom" },
      { kind: "miss", error: "Receiving end does not exist." },
    );
    expect(s.status).toBe(LINK_UNREACHABLE);
    expect(s.error).toBe("Receiving end does not exist.");
  });

  it("reports a USER ACTION failure on the very first miss", () => {
    const s = run({
      kind: "miss",
      error: "Could not establish connection.",
      userAction: true,
      action: "iniciar o aquecimento",
    });
    expect(s.status).toBe(LINK_UNREACHABLE);
    expect(s.misses).toBe(1);
    expect(s.action).toBe("iniciar o aquecimento");
  });

  it("keeps reporting unreachable while later poll misses accumulate", () => {
    const s = run(
      { kind: "miss", userAction: true, error: "x" },
      { kind: "miss", error: "x" },
    );
    expect(s.status).toBe(LINK_UNREACHABLE);
  });

  it("a successful send clears everything, including a pending action", () => {
    const s = run(
      { kind: "miss", userAction: true, error: "x", action: "parar" },
      { kind: "ok" },
    );
    expect(s.status).toBe(LINK_OK);
    expect(s.misses).toBe(0);
    expect(s.error).toBeNull();
    expect(s.action).toBeNull();
    expect(s.proven).toBe(true);
  });

  it("only carries an action label when the user actually asked for something", () => {
    const s = run({ kind: "miss", error: "x", action: "coletar" });
    expect(s.action).toBe("coletar");
    const t = run({ kind: "miss", error: "x" });
    expect(t.action).toBeNull();
  });
});

describe("nextLinkState — no-tab", () => {
  it("reports no-tab and forgets accumulated misses", () => {
    const s = run({ kind: "miss", error: "x" }, { kind: "no-tab" });
    expect(s.status).toBe(LINK_NO_TAB);
    expect(s.misses).toBe(0);
  });

  it("carries the action label so the banner can name what failed", () => {
    const s = run({ kind: "no-tab", action: "iniciar o aquecimento" });
    expect(s.action).toBe("iniciar o aquecimento");
  });
});

describe("nextLinkState — the background's fbw_need_reload flag", () => {
  it("raises the banner on a LIVE transition when we have no first-hand evidence", () => {
    const s = run({ kind: "flag", value: true });
    expect(s.status).toBe(LINK_UNREACHABLE);
    expect(s.flagged).toBe(true);
  });

  it("does NOT raise the banner from the value already in storage at mount", () => {
    // Age unknown — the first poll settles it a tick later, and a banner that
    // blinks on every panel open is a banner people stop reading.
    const s = run({ kind: "flag", value: true, initial: true });
    expect(s.status).toBe(LINK_OK);
    expect(s.flagged).toBe(true); // still recorded, so a good send can clear it
  });

  it("cannot override a send that has already gone through (sticky-true)", () => {
    const s = run({ kind: "ok" }, { kind: "flag", value: true });
    expect(s.status).toBe(LINK_OK);
    expect(s.flagged).toBe(true); // still recorded, so it can be cleared
  });

  it("speaks again after a confirmed break retires the old proof", () => {
    const s = run(
      { kind: "ok" },
      { kind: "miss", userAction: true, error: "x" },
      { kind: "ok" },
      { kind: "miss", userAction: true, error: "x" },
      { kind: "flag", value: true },
    );
    expect(s.status).toBe(LINK_UNREACHABLE);
  });

  it("does not turn no-tab into unreachable", () => {
    const s = run({ kind: "no-tab" }, { kind: "flag", value: true });
    expect(s.status).toBe(LINK_NO_TAB);
  });

  it("a false flag never overrides a real failure", () => {
    const s = run(
      { kind: "miss", userAction: true, error: "x" },
      { kind: "flag", value: false },
    );
    expect(s.status).toBe(LINK_UNREACHABLE);
    expect(s.flagged).toBe(false);
  });
});

describe("nextLinkState — reset and unknown events", () => {
  it("reset returns to the initial state", () => {
    expect(run({ kind: "miss", userAction: true, error: "x" }, { kind: "reset" })).toEqual(
      INITIAL_LINK,
    );
  });
  it("ignores an unknown event rather than corrupting state", () => {
    const before = run({ kind: "miss", error: "x" });
    expect(nextLinkState(before, { kind: "nonsense" })).toBe(before);
  });
  it("is safe with no arguments at all", () => {
    expect(nextLinkState()).toEqual(INITIAL_LINK);
  });
});

describe("linkCopy — pt-BR wording", () => {
  it("renders nothing while the link is healthy", () => {
    expect(linkCopy(LINK_OK, "Facebook")).toBeNull();
  });

  it("names the platform and offers to open it when no tab is open", () => {
    const c = linkCopy(LINK_NO_TAB, "Instagram");
    expect(c.title).toBe("Nenhuma aba do Instagram está aberta.");
    expect(c.action).toBe("Abrir o Instagram");
  });

  it("explains a lost connection and offers to reconnect", () => {
    const c = linkCopy(LINK_UNREACHABLE, "Facebook");
    expect(c.title).toBe("A aba do Facebook perdeu a conexão com a extensão.");
    expect(c.action).toBe("Reconectar aba");
    expect(c.detail).toMatch(/recarregada/);
  });

  it("names the failed action when the user was mid-click", () => {
    const c = linkCopy(LINK_UNREACHABLE, "Facebook", "iniciar o aquecimento");
    expect(c.title).toBe(
      "Não foi possível iniciar o aquecimento: a aba do Facebook perdeu a conexão com a extensão.",
    );
  });

  it("speaks Brazilian Portuguese, not English", () => {
    for (const status of [LINK_NO_TAB, LINK_UNREACHABLE]) {
      const c = linkCopy(status, "TikTok", "coletar");
      for (const text of [c.title, c.detail, c.action, c.hint]) {
        expect(text).toMatch(/[a-z]/);
        expect(text).not.toMatch(/\b(tab|reload|please|the|failed)\b/i);
      }
    }
  });
});

describe("linkErrorText", () => {
  it("translates the two chrome errors we actually see", () => {
    expect(linkErrorText("Could not establish connection. Receiving end does not exist.")).toBe(
      "A aba não respondeu — o script da extensão não está ativo nela.",
    );
    expect(linkErrorText("The message port closed before a response was received.")).toBe(
      "A aba fechou a conexão antes de responder.",
    );
  });
  it("translates a closed tab and a blocked page", () => {
    expect(linkErrorText("No tab with id: 42.")).toBe("A aba foi fechada.");
    expect(linkErrorText("Cannot access contents of the page")).toBe(
      "A extensão não tem permissão para agir nesta aba.",
    );
  });
  it("passes an unknown failure through instead of hiding it", () => {
    expect(linkErrorText("kaboom 0x1234")).toBe("kaboom 0x1234");
  });
  it("returns null for nothing", () => {
    expect(linkErrorText(null)).toBeNull();
    expect(linkErrorText("   ")).toBeNull();
  });
});

describe("PLATFORM_HOME", () => {
  it("covers exactly the platforms the panel can bind a tab for", () => {
    expect(Object.keys(PLATFORM_HOME).sort()).toEqual(Object.keys(PLATFORM_HOST).sort());
  });
  it("every recovery URL is actually adopted by its own platform", () => {
    // A typo here would open a tab the panel then refuses to recognise, leaving
    // the banner up forever — the exact dead end this feature exists to remove.
    for (const [platform, url] of Object.entries(PLATFORM_HOME))
      expect(matchesPlatform(platform, url)).toBe(true);
  });
});
