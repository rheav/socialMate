// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CARD_POS_KEYS, cardSpotOf, cardAt, cardDropSpot, placeCard, makeCardDraggable } from "./cardDrag.js";

const pic = { left: 261, top: 0, width: 614, height: 1091 };

describe("card spot math", () => {
  it("round-trips a drop inside the picture", () => {
    const at = cardAt(pic, 338, 129, cardDropSpot(pic, 338, 129, 400, 500));
    expect(at.left).toBeCloseTo(400);
    expect(at.top).toBeCloseTo(500);
  });
  it("keeps a drop past the edges on the picture", () => {
    expect(cardAt(pic, 338, 129, cardDropSpot(pic, 338, 129, -50, 5000))).toEqual({ left: 261, top: 962 });
  });
  it("holds the same spot when the picture shrinks", () => {
    expect(cardAt({ left: 0, top: 0, width: 400, height: 700 }, 338, 129, { x: 1, y: 1 })).toEqual({ left: 62, top: 571 });
  });
  it("rejects what storage may hold that is not a spot", () => {
    for (const bad of [null, undefined, "x", {}, { x: 0.5 }, { x: NaN, y: 1 }]) expect(cardSpotOf(bad)).toBe(null);
    expect(cardSpotOf({ x: 0.2, y: 0.9 })).toEqual({ x: 0.2, y: 0.9 });
  });
  it("gives each platform its own key", () => {
    expect(new Set(Object.values(CARD_POS_KEYS)).size).toBe(3);
    expect(CARD_POS_KEYS.tiktok).toBe("sw_tt_card_pos"); // spots saved by 1.37.0 keep working
  });
});

describe("draggable card", () => {
  let card, store;
  beforeEach(() => {
    store = { set: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) };
    globalThis.chrome = { storage: { local: store } };
    document.body.replaceChildren();
    card = document.createElement("div");
    card.style.position = "fixed";
    document.body.appendChild(card);
    card.getBoundingClientRect = () => ({ left: 535, top: 655, width: 338, height: 129, right: 873, bottom: 784 });
  });
  const ptr = (type, x, y) => card.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));

  it("saves a drop under its own key and hands the spot over first", () => {
    const onSpot = vi.fn();
    makeCardDraggable(card, () => pic, CARD_POS_KEYS.instagram, onSpot);
    ptr("pointerdown", 600, 700);
    expect(placeCard(card, pic, null)).toBe(true); // a pass mid-drag leaves it alone
    ptr("pointermove", 400, 300);
    ptr("pointerup", 400, 300);
    const spot = onSpot.mock.calls[0][0];
    expect(store.set).toHaveBeenCalledWith({ sw_ig_card_pos: spot });
    expect(cardAt(pic, 338, 129, spot)).toEqual({ left: 335, top: 255 });
    expect(card.style.left).toBe("335px");
  });
  it("does not save a plain click, and a double-click resets", () => {
    const onSpot = vi.fn();
    makeCardDraggable(card, () => pic, CARD_POS_KEYS.facebook, onSpot);
    ptr("pointerdown", 600, 700);
    ptr("pointerup", 600, 700);
    expect(store.set).not.toHaveBeenCalled();
    card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onSpot).toHaveBeenCalledWith(null);
    expect(store.remove).toHaveBeenCalledWith("sw_fb_card_pos");
  });
  it("hands an un-moved card back to the platform, clearing its inline spot once", () => {
    placeCard(card, pic, { x: 0, y: 0 });
    expect(card.hasAttribute("data-sw-moved")).toBe(true);
    expect(placeCard(card, pic, null)).toBe(false);
    expect(card.hasAttribute("data-sw-moved")).toBe(false);
    expect(card.style.left).toBe("");
  });
});
