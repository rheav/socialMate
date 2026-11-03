// How the page rails LOOK on Instagram and TikTok: the button capsule and the
// stats card. INLINED into content scripts — see this dir's README before editing
// (the only import allowed is a sibling, and every target inlines it first).
//
// Two styles, picked in Opções → Sobreposições (RAIL_STYLE_KEY):
//   "cartao" — the stats in a small card at the tile's corner; buttons always shown.
//   "faixa"  — the stats straight on the photo over a dark gradient at its foot;
//              on grid tiles the buttons only appear while the tile is hovered.
// Positions stay each platform's business (tile corners, the player layer);
// this file is skin, markup and the label beside each button.
//
// No backdrop-filter anywhere: on Instagram one blurred surface per tile cost
// 68ms a frame against 8ms without (ARCHITECTURE, Instagram). The glass is an
// 86%-opaque fill, a light border and a highlight along the top edge.
import { OVERLAY_FLASH_MS, overlayIcon } from "./overlayUi.js";

export const RAIL_STYLE_KEY = "sw_ovl_style";
export const RAIL_STYLES = ["cartao", "faixa"];

/** A stored style, or the default for anything unknown (including nothing stored). */
export function railStyleOf(value) {
  return RAIL_STYLES.includes(value) ? value : "cartao";
}

// The five reach tiers of REACH_TIERS, in the panel app's palette. REACH_TIERS
// keeps its own colours: the side panel prints them too, on a light theme where
// these pastels would not read.
export const RAIL_TIER_COLORS = {
  inside: "#aeb9cd",
  baseline: "#8ecae6",
  working: "#b2dba4",
  strong: "#f2cf94",
  breakout: "#f0a582",
};

/** The class list of a stats card. The platform keeps its own class beside it. */
export function railStatsClass(style, { player = false, compact = false } = {}) {
  return `sw-rs sw-rs-${railStyleOf(style)}${player ? " sw-rs-player" : ""}${compact ? " sw-rs-compact" : ""}`;
}

/**
 * The stats card's inner markup.
 *   hero  — the headline: { icon, text } (views; likes on a photo)
 *   reach — the graded views-per-follower chip: { key, text, title, label } or null
 *   rows  — the rest: [{ icon, text, title? }]; a row without text is dropped
 * Every text is a number, a date or a fixed label built by the caller.
 */
export function railStatsHTML({ hero, reach, rows = [] }) {
  const v = hero ? `<span class="sw-rs-v">${overlayIcon(hero.icon, 15)}<b>${hero.text}</b></span>` : "";
  const color = reach && (RAIL_TIER_COLORS[reach.key] || RAIL_TIER_COLORS.inside);
  const chip = reach
    ? `<span class="sw-rs-reach" style="--sw-t:${color}" title="${reach.title || ""}">${overlayIcon("tower", 11)}<b>${reach.text}</b></span>` +
      `<span class="sw-rs-tier" style="--sw-t:${color}">${reach.label || ""}</span>`
    : "";
  const list = rows
    .filter((r) => r && r.text != null && r.text !== "")
    .map((r) => `<span class="sw-rs-r"${r.title ? ` title="${r.title}"` : ""}>${overlayIcon(r.icon, 12)}<b>${r.text}</b></span>`)
    .join("");
  return `<div class="sw-rs-hero">${v}${chip}</div>${list ? `<div class="sw-rs-rows">${list}</div>` : ""}`;
}

/** The class list of an action capsule; tile capsules hide until hovered in "faixa". */
export function railActsClass(style, { player = false } = {}) {
  return `sw-ra${!player && railStyleOf(style) === "faixa" ? " sw-ra-hover" : ""}`;
}

/**
 * A rail button's visible name: the label that slides out beside it on hover.
 * Replaces the native `title` tooltip, which would show the same words twice.
 * Safe to call again after the button's content was rewritten (the voice button
 * swaps its glyph for a percentage).
 */
export function railLabel(btn, text) {
  btn.removeAttribute("title");
  btn.setAttribute("aria-label", text);
  btn.dataset.label = text;
  let lbl = btn.querySelector(":scope > .sw-rb-lbl");
  if (!lbl) {
    lbl = document.createElement("span");
    lbl.className = "sw-rb-lbl";
    lbl.setAttribute("aria-hidden", "true");
    btn.appendChild(lbl);
  }
  if (!btn.hasAttribute("data-flash")) lbl.textContent = text;
}

/**
 * Say how an action went in the button's label for a moment. `tone` colours the
 * button and its label: "ok", "dim", "warn", "err", or "" for plain progress.
 */
export function railSay(btn, text, tone = "", ms = OVERLAY_FLASH_MS) {
  const lbl = btn.querySelector(":scope > .sw-rb-lbl");
  if (!lbl) return;
  clearTimeout(btn.__swSayTimer);
  lbl.textContent = text;
  btn.setAttribute("data-flash", tone || "on");
  btn.__swSayTimer = setTimeout(() => {
    btn.removeAttribute("data-flash");
    lbl.textContent = btn.dataset.label || "";
  }, ms);
}

/** The thin line that sets the last button apart from the others. */
export function railSep() {
  const s = document.createElement("span");
  s.className = "sw-ra-sep";
  s.setAttribute("aria-hidden", "true");
  return s;
}

const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif';
const SURF = "rgba(34,39,50,.86)";
const LINE = "rgba(217,224,238,.16)";
const LIFT = "inset 0 1px 0 rgba(255,255,255,.07),0 6px 18px rgba(0,0,0,.32),0 1px 3px rgba(0,0,0,.3)";

// No backticks inside: this is one template literal.
export const RAIL_CSS = `
.sw-ra{display:flex;flex-direction:column;gap:2px;padding:3px;border-radius:16px;background:${SURF};
  border:1px solid ${LINE};box-shadow:${LIFT};font-family:${FONT};
  transition:opacity .18s ease-out,transform .18s cubic-bezier(.2,.8,.2,1)}
:not(:hover)>.sw-ra-hover:not(:has(.busy,.sw-voice-running,[data-flash])){opacity:0;transform:translateX(-4px);
  pointer-events:none;transition:opacity .12s ease-in,transform .12s ease-in}
.sw-ra-sep{height:1px;margin:2px 6px;background:${LINE}}
.sw-rb{position:relative;display:grid;place-items:center;width:30px;height:30px;min-width:0;margin:0;padding:0;border:0;
  border-radius:12px;background:transparent;box-shadow:none;color:#eceff4;cursor:pointer;font-family:inherit;
  font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;transition:background-color .12s,color .12s}
.sw-rb:hover{background:rgba(255,255,255,.09)}
.sw-rb:focus-visible{outline:2px solid #8ecae6;outline-offset:1px}
.sw-rb svg{display:block;width:16px;height:16px}
.sw-rb.sw-accent{color:#8ecae6}
.sw-rb:is(.sw-saved,.on){color:#f2cf94}
.sw-rb:is(.sw-saved,.on) svg{fill:currentColor}
.sw-rb.sw-voice-running{color:#8ecae6}
.sw-rb:is(.ok,[data-flash="ok"]){color:#b2dba4}
.sw-rb:is(.err,[data-flash="err"]){color:#e79aa4}
.sw-rb[data-flash="warn"]{color:#f2cf94}
.sw-rb[data-flash="dim"]{color:#aeb9cd}
.sw-rb.busy svg{display:none}
.sw-rb.busy::before{content:"";width:13px;height:13px;border-radius:50%;border:2px solid currentColor;
  border-right-color:transparent;animation:sw-rb-spin .7s linear infinite}
@keyframes sw-rb-spin{to{transform:rotate(360deg)}}
.sw-rb .fbw-lang-badge{right:1px;bottom:2px;min-width:0;height:auto;padding:1.5px 2.5px;border:0;border-radius:4px;
  background:#8ecae6;color:#232833;font-size:7.5px;letter-spacing:.02em}
.sw-rb-lbl{position:absolute;left:calc(100% + 12px);top:50%;z-index:1;transform:translate(-4px,-50%);opacity:0;
  pointer-events:none;white-space:nowrap;padding:7px 10px;border-radius:9px;background:rgba(35,40,51,.97);
  border:1px solid ${LINE};box-shadow:${LIFT};color:#eceff4;font:600 12px/1 ${FONT};letter-spacing:0;text-shadow:none;
  transition:opacity .1s ease-in,transform .1s ease-in}
.sw-rb:is(:hover,:focus-visible,[data-flash]) .sw-rb-lbl{opacity:1;transform:translate(0,-50%);
  transition:opacity .16s ease-out,transform .16s cubic-bezier(.2,.8,.2,1)}
.sw-rb[data-flash="ok"] .sw-rb-lbl{color:#b2dba4}
.sw-rb[data-flash="warn"] .sw-rb-lbl{color:#f2cf94}
.sw-rb[data-flash="err"] .sw-rb-lbl{color:#e79aa4}
.sw-rb[data-flash="dim"] .sw-rb-lbl{color:#aeb9cd}

.sw-rs{z-index:5;pointer-events:none;color:#eceff4;font-family:${FONT};line-height:1;text-align:left}
.sw-rs b{font-weight:inherit}
.sw-rs svg{display:block;flex:none}
.sw-rs-tier{display:none}
.sw-rs-reach{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;
  font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.sw-rs-reach svg{width:11px;height:11px}
.sw-rs-r{display:flex;align-items:center;gap:5px;font-size:11.5px;color:#aeb9cd;white-space:nowrap}
.sw-rs-r b{color:#eceff4;font-weight:600;font-variant-numeric:tabular-nums}
.sw-rs-r svg{width:12px;height:12px}
.sw-rs-v{display:flex;align-items:center;font-variant-numeric:tabular-nums;white-space:nowrap}

.sw-rs-cartao{position:absolute;right:8px;bottom:8px;padding:9px 11px 9px 10px;border-radius:13px;background:${SURF};
  border:1px solid ${LINE};box-shadow:${LIFT}}
.sw-rs-cartao .sw-rs-hero{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px}
.sw-rs-cartao .sw-rs-v{gap:5px;font-size:15px;font-weight:650;letter-spacing:-.01em}
.sw-rs-cartao .sw-rs-v svg{width:15px;height:15px;color:#aeb9cd}
.sw-rs-cartao .sw-rs-reach{color:var(--sw-t);background:color-mix(in oklab,var(--sw-t) 17%,transparent);
  border:1px solid color-mix(in oklab,var(--sw-t) 35%,transparent)}
.sw-rs-cartao .sw-rs-rows{display:grid;grid-template-columns:auto auto;gap:6px 14px;margin-top:8px}
.sw-rs-cartao.sw-rs-player .sw-rs-tier{display:block;flex-basis:100%;font-size:11.5px;font-weight:600;color:var(--sw-t)}
.sw-rs-cartao.sw-rs-compact{right:6px;bottom:6px;padding:6px 8px;border-radius:10px}
.sw-rs-cartao.sw-rs-compact .sw-rs-v{font-size:13px}
.sw-rs-cartao.sw-rs-compact .sw-rs-rows{gap:4px 10px;margin-top:6px}
.sw-rs-compact .sw-rs-r{font-size:10.5px}

.sw-rs-faixa{position:absolute;left:0;right:0;bottom:0;padding:46px 12px 10px;
  background:linear-gradient(to top,rgba(10,12,18,.86) 0%,rgba(10,12,18,.55) 52%,transparent);text-shadow:0 1px 2px rgba(0,0,0,.5)}
.sw-rs-faixa .sw-rs-hero{display:flex;align-items:center;gap:8px}
.sw-rs-faixa .sw-rs-v{gap:6px;font-size:21px;font-weight:700;letter-spacing:-.02em}
.sw-rs-faixa .sw-rs-v svg{width:17px;height:17px;opacity:.8}
.sw-rs-faixa .sw-rs-reach{color:#232833;background:var(--sw-t);text-shadow:none}
.sw-rs-faixa .sw-rs-rows{display:flex;flex-wrap:wrap;gap:4px 11px;margin-top:6px}
.sw-rs-faixa .sw-rs-r{color:rgba(236,239,244,.86);font-weight:600}
.sw-rs-faixa .sw-rs-r b{color:inherit}
.sw-rs-faixa .sw-rs-r svg{opacity:.75}
.sw-rs-faixa.sw-rs-compact{padding:34px 8px 7px}
.sw-rs-faixa.sw-rs-compact .sw-rs-v{font-size:16px}
.sw-rs-faixa.sw-rs-player{width:214px;padding:16px 12px 16px 46px;transform:translateY(-35%);
  background:radial-gradient(120% 90% at 100% 50%,rgba(10,12,18,.72),transparent 72%)}
.sw-rs-faixa.sw-rs-player :is(.sw-rs-hero,.sw-rs-rows){justify-content:flex-end}
.sw-rs-faixa.sw-rs-player .sw-rs-hero{flex-wrap:wrap}
.sw-rs-faixa.sw-rs-player .sw-rs-rows{flex-direction:column;align-items:flex-end;gap:6px}
.sw-rs-faixa.sw-rs-player .sw-rs-tier{display:block;flex-basis:100%;margin-top:2px;text-align:right;
  font-size:11.5px;font-weight:600;color:var(--sw-t)}`;
