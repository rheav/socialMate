// The player's stats card, draggable: drop it anywhere on the picture and the spot
// is saved per platform, so it holds for every video of that platform and at any
// window size. A double-click (or Opções → "Voltar ao padrão") puts it back.
// INLINED into the TikTok, Instagram and Facebook reel content scripts — see
// src/lib/shared/README.md before editing (no imports allowed in this file).
//
// Coordinates: `picture` rects are viewport rects (getBoundingClientRect). The card
// itself may be fixed (TikTok's and Instagram's top-level layers) or absolute inside
// the player (Facebook's reel); putCard converts through its offsetParent.

/** One storage key per platform: a drag on one never moves the others. */
export const CARD_POS_KEYS = {
  tiktok: "sw_tt_card_pos",
  instagram: "sw_ig_card_pos",
  facebook: "sw_fb_card_pos",
};

/**
 * A stored spot — `{ x, y }`, each 0..1 of the room the card has inside the
 * picture — or null for anything storage hands back that is not one.
 */
export function cardSpotOf(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** A spot → the viewport top-left of a `cw`×`ch` card inside picture `r`. */
export function cardAt(r, cw, ch, spot) {
  return {
    left: r.left + clamp01(spot.x) * Math.max(0, r.width - cw),
    top: r.top + clamp01(spot.y) * Math.max(0, r.height - ch),
  };
}

/** The inverse: the spot for a card whose top-left was dropped at `left`/`top`. */
export function cardDropSpot(r, cw, ch, left, top) {
  const rx = r.width - cw, ry = r.height - ch;
  return { x: rx > 0 ? clamp01((left - r.left) / rx) : 0, y: ry > 0 ? clamp01((top - r.top) / ry) : 0 };
}

/** Where the card goes: grab cursor, and a dragged one drops Faixa's centring nudge. */
export function cardDragCss(sel) {
  return `${sel}{pointer-events:auto;cursor:grab;user-select:none}${sel}:active{cursor:grabbing}` +
    `${sel}[data-sw-moved]{transform:none}`;
}

// Writes only on change: an unchanged inline write still costs a style pass, and
// Facebook's tick calls this every 700 ms.
function setPx(card, prop, v) {
  if (card.style[prop] !== v) card.style[prop] = v;
}

/** Pin the card's top-left at viewport `left`/`top`, whatever it is positioned against. */
function putCard(card, left, top) {
  const p = card.offsetParent; // null for position:fixed
  const o = p ? p.getBoundingClientRect() : null;
  if (!card.hasAttribute("data-sw-moved")) card.setAttribute("data-sw-moved", "");
  setPx(card, "right", "auto");
  setPx(card, "bottom", "auto");
  setPx(card, "left", Math.round(left - (o ? o.left + p.clientLeft : 0)) + "px");
  setPx(card, "top", Math.round(top - (o ? o.top + p.clientTop : 0)) + "px");
}

/**
 * Place a draggable card for this pass. True when it is handled here — being
 * dragged, or at a saved spot — and the platform's own placement must be skipped.
 * False hands the card back to the platform (its inline position cleared once).
 */
export function placeCard(card, r, spot) {
  if (card.hasAttribute("data-sw-dragging")) return true;
  if (!spot) {
    if (card.hasAttribute("data-sw-moved")) {
      card.removeAttribute("data-sw-moved");
      for (const k of ["left", "top", "right", "bottom"]) card.style[k] = "";
    }
    return false;
  }
  const at = cardAt(r, card.offsetWidth, card.offsetHeight, spot);
  putCard(card, at.left, at.top);
  return true;
}

/**
 * Make `card` draggable inside `picture()` (a viewport rect, read at press time).
 * A drop is saved under `key`; a double-click removes it. `onSpot(spot | null)`
 * runs first, so the platform's next pass already knows where the card belongs.
 */
export function makeCardDraggable(card, picture, key, onSpot) {
  card.title = "Arraste para mover · duplo clique volta ao lugar";
  // The players toggle playback on the pointer sequence: cut it at the card.
  for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"])
    card.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); });
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = picture();
    const c = card.getBoundingClientRect(); // the visual box, Faixa's nudge included
    const dx = e.clientX - c.left, dy = e.clientY - c.top;
    const spotAt = (ev) => cardDropSpot(r, c.width, c.height, ev.clientX - dx, ev.clientY - dy);
    let moved = false;
    card.setAttribute("data-sw-dragging", "");
    card.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const at = cardAt(r, c.width, c.height, spotAt(ev));
      moved = true;
      putCard(card, at.left, at.top);
    };
    const up = (ev) => {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", up);
      card.removeAttribute("data-sw-dragging");
      if (!moved) return; // a plain click (or a double-click) is not a drop
      const spot = spotAt(ev);
      onSpot(spot);
      chrome.storage.local.set({ [key]: spot }).catch(() => {});
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", up);
  });
  card.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onSpot(null);
    chrome.storage.local.remove(key).catch(() => {});
  });
}
