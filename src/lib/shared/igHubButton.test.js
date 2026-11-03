// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_BTN_ID, HUB_BTN_TIPS, flashHubButtonTip, startHubButton, syncHubButton } from "./igHubButton.js";

// The profile header as measured on 2026-10-22: username row, then the "…".
const HEADER = `<header><section><div><div>
  <div class="name">nasa</div>
  <div role="button" class="opt"><svg aria-label="Opções" width="16" height="16"></svg></div>
</div></div></section></header>`;

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.getElementById("fbw-hub-btn-style")?.remove();
});

describe("syncHubButton", () => {
  it("puts one button right after the header's options button", () => {
    document.body.innerHTML = HEADER;
    const btn = syncHubButton(document, { key: "nasa", state: "idle", onClick() {} });
    expect(btn.previousElementSibling.className).toBe("opt");
    syncHubButton(document, { key: "nasa", state: "idle", onClick() {} });
    expect(document.querySelectorAll(`#${HUB_BTN_ID}`)).toHaveLength(1);
    expect(btn.dataset.tip).toBe(HUB_BTN_TIPS.idle);
  });

  it("marks a tracked profile through its state, keeping one mark", () => {
    document.body.innerHTML = HEADER;
    syncHubButton(document, { key: "nasa", state: "idle", onClick() {} });
    const btn = syncHubButton(document, { key: "nasa", state: "tracked", onClick() {} });
    expect(btn.dataset.state).toBe("tracked");
    expect(btn.querySelectorAll("svg")).toHaveLength(1);
    expect(btn.querySelector(".fbw-hub-dot")).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe(HUB_BTN_TIPS.tracked);
  });

  it("moves back after the options button when Instagram re-renders the row", () => {
    document.body.innerHTML = HEADER;
    const btn = syncHubButton(document, { key: "nasa", state: "idle", onClick() {} });
    document.body.appendChild(btn); // detached from its place
    syncHubButton(document, { key: "nasa", state: "idle", onClick() {} });
    expect(btn.previousElementSibling.className).toBe("opt");
  });

  it("calls the latest click handler", () => {
    document.body.innerHTML = HEADER;
    const first = vi.fn();
    const second = vi.fn();
    syncHubButton(document, { key: "nasa", state: "idle", onClick: first });
    const btn = syncHubButton(document, { key: "nasa", state: "idle", onClick: second });
    btn.click();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(btn);
  });

  it("is absent off a profile, on your own profile, and without an options button", () => {
    document.body.innerHTML = HEADER;
    syncHubButton(document, { key: "nasa", state: "idle", onClick() {} });
    expect(syncHubButton(document, { key: null, state: "idle", onClick() {} })).toBeNull();
    expect(document.getElementById(HUB_BTN_ID)).toBeNull();

    document.body.innerHTML = HEADER.replace("</section>", '<a href="/accounts/edit/">Editar perfil</a></section>');
    expect(syncHubButton(document, { key: "me", state: "idle", onClick() {} })).toBeNull();

    document.body.innerHTML = HEADER.replace("Opções", "Verificado");
    expect(syncHubButton(document, { key: "nasa", state: "idle", onClick() {} })).toBeNull();
  });

  it("flashes a tip and goes back to the state's own", () => {
    vi.useFakeTimers();
    document.body.innerHTML = HEADER;
    const btn = syncHubButton(document, { key: "nasa", state: "tracked", onClick() {} });
    flashHubButtonTip(btn, HUB_BTN_TIPS.already);
    expect(btn.dataset.tip).toBe(HUB_BTN_TIPS.already);
    vi.advanceTimersByTime(2100);
    expect(btn.dataset.tip).toBe(HUB_BTN_TIPS.tracked);
  });
});

// socialMate 1.32: the same button on TikTok (after the "…" circle) and Facebook (after the name).
describe("the Hub button on TikTok and Facebook", () => {
  const TT = `<div class="row"><div class="circle"><button data-e2e="user-more">…</button></div></div>`;
  function chromeStub(spy) {
    const listeners = [];
    const sent = [];
    return {
      sent, listeners,
      runtime: { lastError: null, sendMessage: (msg, cb) => { sent.push(msg); cb({ ok: true }); } },
      storage: {
        local: { get: (_k, cb) => cb({ fbw_spy: spy }) },
        onChanged: { addListener: (f) => listeners.push(f), removeListener: (f) => listeners.splice(listeners.indexOf(f), 1) },
      },
    };
  }
  afterEach(() => vi.unstubAllGlobals());

  it("follows the anchor it is given, with the site's look and a sky dot that pings while not tracked", () => {
    document.body.innerHTML = TT;
    const circle = document.querySelector(".circle");
    const btn = syncHubButton(document, { key: "happymindmentor", state: "idle", onClick() {},
      place: { anchor: circle, site: "tiktok", bg: "rgba(255, 255, 255, 0.13)", ring: "rgb(0, 0, 0)" } });
    expect(btn.previousElementSibling).toBe(circle);
    expect(btn.dataset.site).toBe("tiktok");
    expect(btn.style.getPropertyValue("--fbw-hub-bg")).toBe("rgba(255, 255, 255, 0.13)");
    expect(btn.querySelector(".fbw-hub-ping")).not.toBeNull();
    const css = document.getElementById("fbw-hub-btn-style").textContent;
    expect(css).toContain('[data-state="idle"] .fbw-hub-ping{display:block;animation:fbw-hub-ping 1.4s cubic-bezier(0,0,.2,1) 3 forwards}');
    expect(css).toContain("prefers-reduced-motion");
  });

  it("reads the Spy list, saves a profile on a click and stops cleanly", () => {
    vi.useFakeTimers();
    document.body.innerHTML = TT;
    const chrome = chromeStub({ profiles: { "tiktok:other": { platform: "tiktok", key: "other", removedAt: null } } });
    vi.stubGlobal("chrome", chrome);
    let key = "happymindmentor";
    const stop = startHubButton("tiktok", () => (key ? { key, anchor: document.querySelector(".circle"), site: "tiktok" } : null));
    const btn = document.getElementById(HUB_BTN_ID);
    expect(btn.dataset.state).toBe("idle");
    btn.click();
    expect(chrome.sent).toEqual([{ type: "FBW_SPY_SAVE", platform: "tiktok", key: "happymindmentor" }]);
    chrome.listeners[0]({ fbw_spy: { newValue: { profiles: { "tiktok:other": { platform: "tiktok", key: "other", removedAt: null },
      "tiktok:happymindmentor": { platform: "tiktok", key: "happymindmentor", removedAt: null } } } } }, "local");
    expect(btn.dataset.state).toBe("tracked");
    key = null; // navigated off the profile
    vi.advanceTimersByTime(1000);
    expect(document.getElementById(HUB_BTN_ID)).toBeNull();
    key = "other";
    vi.advanceTimersByTime(1000);
    expect(document.getElementById(HUB_BTN_ID).dataset.state).toBe("tracked");
    stop();
    expect(document.getElementById(HUB_BTN_ID)).toBeNull();
    expect(chrome.listeners).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(document.getElementById(HUB_BTN_ID)).toBeNull();
  });
});
