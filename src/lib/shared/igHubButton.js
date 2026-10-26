// The Hub button on an Instagram profile: the socialMate mark after the header's
// "…" (Opções), which saves the profile to the Spy list (and so to the Hub)
// without opening the panel. INLINED into the Instagram bridge — see
// src/lib/shared/README.md before editing (no imports allowed in this file).
//
// The bridge decides the profile and the state; this file only owns the button.
// It sits in the header row Instagram renders next to the username (measured
// 2026-10-22: a 32×32 div[role=button] holding a 16 px svg aria-label="Opções").
// Not tracked, the mark is an outline in the row's text colour, so it follows
// Instagram's light and dark themes; tracked, it is the extension's own icon (the
// Nord sky square with the flame) with a green dot.

// The header's "…" by its accessible name. Exact membership, like the other
// localized dictionaries: the name follows the SITE language, not the panel's.
export const IG_OPTIONS_LABELS = new Set(["Opções", "Options", "Opciones", "Optionen", "Opzioni", "Opties"]);

export const HUB_BTN_ID = "fbw-hub-btn";
export const HUB_BTN_STYLE_ID = "fbw-hub-btn-style";

// state -> what the button says. "tracked" is a profile in the Spy list.
export const HUB_BTN_TIPS = {
  // @private
  idle: "Trackear no Hub",
  saving: "Salvando no Hub…",
  tracked: "Trackeado no Hub",
  already: "Já trackeado no Hub",
  // @end-private
  // @public
  idle: "Salvar no Spy",
  saving: "Salvando no Spy…",
  tracked: "Salvo no Spy",
  already: "Já está no Spy",
  // @end-public
  error: "Não deu para salvar. Clique para tentar de novo.",
};

// The flame of public/icon.svg, on the same 128-unit grid.
const HUB_BTN_FLAME =
  "M64 27C73 48 87 55 87 75C87 87.7 76.7 98 64 98C51.3 98 41 87.7 41 75C41 64.5 48 58 52.5 51.5C54.5 60 60 62 60 56C60 44 60 37 64 27Z";

// Instagram keeps its theme colours as bare "r, g, b" triplets
// (--ig-primary-background: "12, 16, 20" in dark, measured), hence rgb(var()).
export const HUB_BTN_CSS = `
#${HUB_BTN_ID}{position:relative;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;
  flex:none;border-radius:8px;cursor:pointer;color:inherit;background:none;border:0;padding:0}
#${HUB_BTN_ID}:hover{background:rgba(128,128,128,.16)}
#${HUB_BTN_ID}:focus-visible{outline:2px solid #2e6ead;outline-offset:2px}
#${HUB_BTN_ID} svg{width:20px;height:20px;display:block}
#${HUB_BTN_ID} rect{fill:none;stroke:currentColor;stroke-width:10}
#${HUB_BTN_ID} path{fill:currentColor}
#${HUB_BTN_ID}[data-state="tracked"] rect{fill:#8ecae6;stroke:#8ecae6}
#${HUB_BTN_ID}[data-state="tracked"] path{fill:#232833}
#${HUB_BTN_ID}[data-state="saving"] svg{animation:fbw-hub-pulse .9s ease-in-out infinite}
@keyframes fbw-hub-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){#${HUB_BTN_ID}[data-state="saving"] svg{animation:none;opacity:.5}}
#${HUB_BTN_ID} .fbw-hub-dot{position:absolute;right:2px;top:3px;width:9px;height:9px;border-radius:50%;
  background:#22c55e;box-shadow:0 0 0 2px rgb(var(--ig-primary-background, 255, 255, 255));display:none}
#${HUB_BTN_ID}[data-state="tracked"] .fbw-hub-dot{display:block}
#${HUB_BTN_ID}[data-state="error"] .fbw-hub-dot{display:block;background:#ef4444}
#${HUB_BTN_ID}::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);
  z-index:10;white-space:nowrap;pointer-events:none;padding:6px 10px;border-radius:6px;background:#262626;color:#f5f5f5;
  font:500 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;transition:opacity .12s}
#${HUB_BTN_ID}:hover::after,#${HUB_BTN_ID}.fbw-hub-tip::after{opacity:1}`;

/** The header's "…" button, or null when this page has none we recognise. */
export function findIgOptionsButton(doc) {
  for (const svg of doc.querySelectorAll("header svg[aria-label]")) {
    if (!IG_OPTIONS_LABELS.has((svg.getAttribute("aria-label") || "").trim())) continue;
    const btn = svg.closest('[role="button"]');
    if (btn && btn.id !== HUB_BTN_ID) return btn;
  }
  return null;
}

/** The viewer's own profile: its header links to "Editar perfil". */
export function isOwnIgProfile(doc) {
  return !!doc.querySelector('header a[href="/accounts/edit/"]');
}

/** The socialMate mark; its colours come from the state, in HUB_BTN_CSS. */
export function hubButtonSvg(doc) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 128 128");
  svg.setAttribute("aria-hidden", "true");
  const square = doc.createElementNS(ns, "rect");
  for (const [k, v] of [["x", 6], ["y", 6], ["width", 116], ["height", 116], ["rx", 28]]) square.setAttribute(k, String(v));
  const flame = doc.createElementNS(ns, "path");
  flame.setAttribute("d", HUB_BTN_FLAME);
  svg.append(square, flame);
  return svg;
}

/**
 * Put the Hub button after the header's "…", or take it away.
 * `key`: the profile's username (lowercase), or null when this page is not a
 * profile. `state`: "idle" | "saving" | "tracked" | "error". `onClick(btn)` runs
 * on a click or Enter/Space. Idempotent: the state is a data attribute the CSS reads.
 * Returns the button, or null when there is none.
 */
export function syncHubButton(doc, { key, state, onClick }) {
  const existing = doc.getElementById(HUB_BTN_ID);
  if (!key || isOwnIgProfile(doc)) {
    existing?.remove();
    return null;
  }
  const opt = findIgOptionsButton(doc);
  if (!opt || !opt.parentElement) return null;
  // Rewritten when it differs: an extension update must not keep the old rules.
  let style = doc.getElementById(HUB_BTN_STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = HUB_BTN_STYLE_ID;
    (doc.head || doc.documentElement).appendChild(style);
  }
  if (style.textContent !== HUB_BTN_CSS) style.textContent = HUB_BTN_CSS;
  // A button another isolated world made (the bridge before an extension reload)
  // carries that world's listener, whose chrome.* is dead: replace it.
  let btn = existing && existing.__fbwHubFire ? existing : null;
  if (existing && !btn) existing.remove();
  if (!btn) {
    btn = doc.createElement("div");
    btn.id = HUB_BTN_ID;
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    const dot = doc.createElement("span");
    dot.className = "fbw-hub-dot";
    btn.append(hubButtonSvg(doc), dot);
    const fire = (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.__fbwHubClick?.(btn);
    };
    btn.__fbwHubFire = fire;
    btn.addEventListener("click", fire);
    btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fire(e); });
  }
  btn.__fbwHubClick = onClick;
  if (btn.previousElementSibling !== opt) opt.insertAdjacentElement("afterend", btn);
  if (btn.dataset.key !== key || btn.dataset.state !== state) {
    btn.dataset.key = key;
    btn.dataset.state = state;
    btn.dataset.tip = HUB_BTN_TIPS[state] || HUB_BTN_TIPS.idle;
    btn.setAttribute("aria-label", btn.dataset.tip);
  }
  return btn;
}

/** Show `text` under the button for a moment (a click on a tracked profile). */
export function flashHubButtonTip(btn, text) {
  btn.dataset.tip = text;
  btn.classList.add("fbw-hub-tip");
  clearTimeout(btn.__fbwTipTimer);
  btn.__fbwTipTimer = setTimeout(() => {
    btn.classList.remove("fbw-hub-tip");
    btn.dataset.tip = HUB_BTN_TIPS[btn.dataset.state] || HUB_BTN_TIPS.idle;
  }, 2000);
}
