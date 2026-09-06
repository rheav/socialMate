import { describe, it, expect } from "vitest";
import {
  DEFAULT_UI_PREFS,
  normalizeUiPrefs,
  resolveTab,
  visibleTabs,
} from "./uiPrefs.js";

describe("normalizeUiPrefs", () => {
  it("defaults to showing everything", () => {
    expect(normalizeUiPrefs(undefined)).toEqual(DEFAULT_UI_PREFS);
    expect(normalizeUiPrefs(null)).toEqual({ showWarm: true });
    expect(normalizeUiPrefs("nonsense")).toEqual({ showWarm: true });
  });
  it("keeps an explicit false and drops unknown keys", () => {
    expect(normalizeUiPrefs({ showWarm: false, bogus: 1 })).toEqual({ showWarm: false });
  });
  it("ignores a non-boolean rather than reading it as off", () => {
    expect(normalizeUiPrefs({ showWarm: 0 })).toEqual({ showWarm: true });
    expect(normalizeUiPrefs({ showWarm: "false" })).toEqual({ showWarm: true });
  });
});

describe("visibleTabs", () => {
  it("lists all three by default, in nav order", () => {
    expect(visibleTabs().map((t) => t.id)).toEqual(["research", "warm", "library"]);
  });
  it("drops the warmer when it is switched off", () => {
    expect(visibleTabs({ showWarm: false }).map((t) => t.id)).toEqual([
      "research",
      "library",
    ]);
  });
});

describe("resolveTab", () => {
  it("leaves a visible tab alone", () => {
    expect(resolveTab("library", { showWarm: false })).toBe("library");
    expect(resolveTab("warm", { showWarm: true })).toBe("warm");
  });
  it("falls back when the tab was just hidden underneath the user", () => {
    expect(resolveTab("warm", { showWarm: false })).toBe("research");
  });
  it("falls back for an unknown tab id", () => {
    expect(resolveTab("ferramenta-que-nao-existe", {})).toBe("research");
  });
});
