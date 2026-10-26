// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_BTN_ID, HUB_BTN_TIPS, flashHubButtonTip, syncHubButton } from "./igHubButton.js";

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
