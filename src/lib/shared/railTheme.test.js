// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setOverlayBtnState } from "./overlayUi.js";
import { RAIL_CSS, railActsClass, railLabel, railSay, railStatsClass, railStatsHTML, railStyleOf } from "./railTheme.js";

describe("rail style", () => {
  it("reads anything unknown as the card", () => {
    expect([railStyleOf("faixa"), railStyleOf("cartao"), railStyleOf(undefined), railStyleOf("x")]).toEqual(["faixa", "cartao", "cartao", "cartao"]);
  });

  it("hides the buttons until hover only on faixa grid tiles", () => {
    expect(railActsClass("faixa")).toBe("sw-ra sw-ra-hover");
    expect(railActsClass("faixa", { player: true })).toBe("sw-ra");
    expect(railActsClass("cartao")).toBe("sw-ra");
    expect(railStatsClass("faixa", { player: true, compact: true })).toBe("sw-rs sw-rs-faixa sw-rs-player sw-rs-compact");
  });

  it("has no backtick that would end the stylesheet literal", () => {
    expect(RAIL_CSS).not.toContain("`");
    expect(RAIL_CSS).not.toMatch(/backdrop-filter/);
  });
});

describe("stats markup", () => {
  it("puts the headline and the graded chip on top and drops empty rows", () => {
    document.body.innerHTML = railStatsHTML({
      hero: { icon: "eye", text: "1.2M" },
      reach: { key: "strong", text: "25×", label: "Alcance forte", title: "Alcance forte — 25×" },
      rows: [{ icon: "trend", text: null }, false, { icon: "heart", text: "84.3K" }, { icon: "cal", text: "" }],
    });
    expect(document.querySelector(".sw-rs-v").textContent).toBe("1.2M");
    const chip = document.querySelector(".sw-rs-reach");
    expect([chip.textContent, chip.title, chip.style.getPropertyValue("--sw-t")]).toEqual(["25×", "Alcance forte — 25×", "#f2cf94"]);
    expect([...document.querySelectorAll(".sw-rs-r")].map((r) => r.textContent)).toEqual(["84.3K"]);
  });

  it("draws no rows block and no chip when there is only a headline", () => {
    document.body.innerHTML = railStatsHTML({ hero: { icon: "eye", text: "2.1M" } });
    expect(document.querySelector(".sw-rs-reach")).toBeNull();
    expect(document.querySelector(".sw-rs-rows")).toBeNull();
  });
});

describe("button label", () => {
  afterEach(() => vi.useRealTimers());

  it("replaces the native tooltip and survives a content rewrite", () => {
    const b = document.createElement("button");
    b.title = "old";
    railLabel(b, "Baixar vídeo");
    expect([b.hasAttribute("title"), b.getAttribute("aria-label"), b.querySelector(".sw-rb-lbl").textContent]).toEqual([false, "Baixar vídeo", "Baixar vídeo"]);
    b.textContent = "42%";
    railLabel(b, "Separando voz");
    expect(b.querySelectorAll(".sw-rb-lbl")).toHaveLength(1);
  });

  it("says the outcome for a while, then goes back to the button's name", () => {
    vi.useFakeTimers();
    const b = document.createElement("button");
    railLabel(b, "Mandar a foto às Fontes");
    railSay(b, "Nas Fontes", "ok", 1000);
    expect([b.dataset.flash, b.querySelector(".sw-rb-lbl").textContent]).toEqual(["ok", "Nas Fontes"]);
    railLabel(b, "outro nome"); // a relabel mid-flash keeps the message on screen
    expect(b.querySelector(".sw-rb-lbl").textContent).toBe("Nas Fontes");
    vi.advanceTimersByTime(1000);
    expect([b.hasAttribute("data-flash"), b.querySelector(".sw-rb-lbl").textContent]).toEqual([false, "outro nome"]);
  });

  it("keeps the label when a state swaps the glyph (Pinterest)", () => {
    const b = document.createElement("button");
    b.dataset.kind = "dl";
    railLabel(b, "Baixar");
    setOverlayBtnState(b, "ok");
    expect([b.querySelector("svg") != null, b.querySelector(".sw-rb-lbl")?.textContent]).toEqual([true, "Baixar"]);
  });
});
