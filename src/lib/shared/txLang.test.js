// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TX_LANG_KEY,
  TX_LANG_OPTIONS,
  normTxLang,
  txLangInfo,
  txLangMenuPos,
  ensureTxLangStyle,
  enableTxBadge,
  addTxBadge,
  updateTxBadges,
  setTxLang,
  getTxLang,
  openTxLangMenu,
  closeTxLangMenu,
} from "./txLang.js";

const store = {};
function stubChrome() {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (patch) => Object.assign(store, patch),
      },
      onChanged: { addListener: () => {} },
    },
  });
}

function btnAt(rect) {
  const b = document.createElement("button");
  b.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height });
  document.body.appendChild(b);
  return b;
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  document.documentElement.innerHTML = "<head></head><body></body>";
  stubChrome();
  closeTxLangMenu();
});

describe("page language control", () => {
  it("accepts only the two product values, legacy pt included", () => {
    expect(normTxLang("en")).toBe("en");
    expect(normTxLang("EN")).toBe("en");
    expect(normTxLang("pt")).toBe("br");
    expect(normTxLang("br")).toBe("br");
    expect(normTxLang("es")).toBe("br");
    expect(normTxLang()).toBe("br");
    expect(txLangInfo("pt").short).toBe("BR");
    expect(txLangInfo("en").label).toBe("English");
    expect(TX_LANG_OPTIONS.map((o) => o.value)).toEqual(["br", "en"]);
  });

  // The numbers here are Facebook's, unchanged: the rail sits on the video's left
  // edge, so the menu opens leftwards and must not cover the video.
  it("opens to the left of the button, and flips when there is no room", () => {
    const view = { width: 1200, height: 900 };
    expect(txLangMenuPos({ left: 140, right: 176, top: 300 }, view)).toEqual({ top: 300, left: 38 });
    // Instagram's tile actions sit at left:7 — clamping would put the menu on top
    // of its own button, so it flips to the right edge instead.
    expect(txLangMenuPos({ left: 7, right: 43, top: 120 }, view)).toEqual({ top: 120, left: 49 });
    // Never off-screen, in either axis.
    expect(txLangMenuPos({ left: 1190, right: 1226, top: 880 }, view)).toEqual({ top: 808, left: 1068 });
    expect(txLangMenuPos({ left: 140, right: 176, top: -50 }, view)).toEqual({ top: 8, left: 38 });
  });

  it("badges only the buttons that opted in", () => {
    const tx = btnAt({ left: 100, width: 30, top: 100, height: 30 });
    const dl = btnAt({ left: 100, width: 30, top: 140, height: 30 });
    enableTxBadge(tx);
    addTxBadge(dl); // the platform's state hook calls this for EVERY button
    expect(tx.querySelector(".fbw-lang-badge")?.textContent).toBe("BR");
    expect(dl.querySelector(".fbw-lang-badge")).toBe(null);
    expect(document.getElementById("fbw-lang-style")).toBeTruthy();
  });

  it("repaints badges when the language changes and forgets removed buttons", async () => {
    const a = btnAt({ left: 100, width: 30, top: 100, height: 30 });
    const b = btnAt({ left: 100, width: 30, top: 140, height: 30 });
    enableTxBadge(a);
    enableTxBadge(b);
    b.remove(); // FB remounts rails constantly
    await setTxLang("en");
    expect(a.querySelector(".fbw-lang-badge").textContent).toBe("EN");
    expect(store[TX_LANG_KEY]).toBe("en");
    // A busy button keeps its spinner glyph — repainting would sit a badge on it.
    a.classList.add("busy");
    await setTxLang("br");
    expect(a.querySelector(".fbw-lang-badge").textContent).toBe("EN");
    a.classList.remove("busy");
    updateTxBadges();
    expect(a.querySelector(".fbw-lang-badge").textContent).toBe("BR");
  });

  it("saves the pick and hands it to the caller before the job starts", async () => {
    const tx = btnAt({ left: 200, width: 30, top: 100, height: 30 });
    enableTxBadge(tx);
    const picked = [];
    openTxLangMenu(tx, (lang) => picked.push(lang));
    const menu = document.querySelector(".fbw-lang-menu");
    expect([...menu.querySelectorAll("button")].map((x) => x.textContent)).toEqual(["Português", "English"]);
    [...menu.querySelectorAll("button")].find((x) => x.textContent === "English").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(picked).toEqual(["en"]);
    expect(store[TX_LANG_KEY]).toBe("en");
    expect(await getTxLang()).toBe("en");
    expect(document.querySelector(".fbw-lang-menu")).toBe(null); // closed after picking
    expect(tx.querySelector(".fbw-lang-badge").textContent).toBe("EN");
  });

  it("refuses to open on a button whose job is already running", () => {
    const tx = btnAt({ left: 200, width: 30, top: 100, height: 30 });
    tx.classList.add("busy");
    openTxLangMenu(tx, () => {});
    expect(document.querySelector(".fbw-lang-menu")).toBe(null);
  });
});
