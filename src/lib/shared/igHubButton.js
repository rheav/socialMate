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
//
// socialMate 1.32: the same button on TikTok (after the profile's "…", a 44 px
// circle like its neighbours) and on Facebook (right after the profile's name),
// through startHubButton(). Not tracked, a sky dot sits where the green one will
// and pings three times when the button appears, so it is noticed; then it rests.

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

// @private
// The flame of public/icon.svg, on the same 128-unit grid.
const HUB_BTN_MARK =
  "M64 27C73 48 87 55 87 75C87 87.7 76.7 98 64 98C51.3 98 41 87.7 41 75C41 64.5 48 58 52.5 51.5C54.5 60 60 62 60 56C60 44 60 37 64 27Z";
// @end-private
// @public
// The radar of public/icon-public.svg, on the same 128-unit grid.
const HUB_BTN_MARK =
  "M64 25A39 39 0 1 1 63.99 25ZM64 32A32 32 0 1 0 64.01 32ZM64 60A4 4 0 1 1 63.99 60ZM61.2 61.2L87.7 34.7L93.3 40.3L66.8 66.8ZM82 74A6.5 6.5 0 1 1 81.99 74Z";
// @end-public

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
#${HUB_BTN_ID} .fbw-hub-dot,#${HUB_BTN_ID} .fbw-hub-ping{position:absolute;right:2px;top:3px;width:9px;height:9px;border-radius:50%;
  background:#22c55e;box-shadow:0 0 0 2px var(--fbw-hub-ring, rgb(var(--ig-primary-background, 255, 255, 255)));display:none}
#${HUB_BTN_ID}[data-state="tracked"] .fbw-hub-dot{display:block}
#${HUB_BTN_ID}[data-state="error"] .fbw-hub-dot{display:block;background:#ef4444}
#${HUB_BTN_ID}[data-state="idle"] .fbw-hub-dot{display:block;background:#8ecae6}
#${HUB_BTN_ID} .fbw-hub-ping{background:#8ecae6;box-shadow:none;pointer-events:none}
#${HUB_BTN_ID}[data-state="idle"] .fbw-hub-ping{display:block;animation:fbw-hub-ping 1.4s cubic-bezier(0,0,.2,1) 3 forwards}
@keyframes fbw-hub-ping{75%,100%{transform:scale(2.6);opacity:0}}
@media (prefers-reduced-motion: reduce){#${HUB_BTN_ID}[data-state="idle"] .fbw-hub-ping{display:none}}
#${HUB_BTN_ID}[data-site="tiktok"]{width:44px;height:44px;border-radius:50%;background:var(--fbw-hub-bg)}
#${HUB_BTN_ID}[data-site="tiktok"]:hover{background:var(--fbw-hub-bg);filter:brightness(1.3)}
#${HUB_BTN_ID}[data-site="tiktok"] .fbw-hub-dot,#${HUB_BTN_ID}[data-site="tiktok"] .fbw-hub-ping{right:6px;top:7px}
#${HUB_BTN_ID}[data-site="facebook"]{vertical-align:middle;margin-left:8px}
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

/** The extension's mark; its colours come from the state, in HUB_BTN_CSS. */
export function hubButtonSvg(doc) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 128 128");
  svg.setAttribute("aria-hidden", "true");
  const square = doc.createElementNS(ns, "rect");
  for (const [k, v] of [["x", 6], ["y", 6], ["width", 116], ["height", 116], ["rx", 28]]) square.setAttribute(k, String(v));
  const mark = doc.createElementNS(ns, "path");
  mark.setAttribute("d", HUB_BTN_MARK);
  svg.append(square, mark);
  return svg;
}

/**
 * Put the Hub button after the header's "…", or take it away.
 * `key`: the profile's username (lowercase), or null when this page is not a
 * profile. `state`: "idle" | "saving" | "tracked" | "error". `onClick(btn)` runs
 * on a click or Enter/Space. Idempotent: the state is a data attribute the CSS reads.
 * `place` (TikTok, Facebook): { anchor, site, bg?, ring? } — the element to follow,
 * the look, the circle's and the dot ring's colours; absent, Instagram's header.
 * Returns the button, or null when there is none.
 */
export function syncHubButton(doc, { key, state, onClick, place = null }) {
  const existing = doc.getElementById(HUB_BTN_ID);
  if (!key || (!place && isOwnIgProfile(doc))) {
    existing?.remove();
    return null;
  }
  const opt = place ? place.anchor : findIgOptionsButton(doc);
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
    const ping = doc.createElement("span");
    ping.className = "fbw-hub-ping";
    btn.append(hubButtonSvg(doc), ping, dot);
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
  if (place && btn.dataset.site !== place.site) btn.dataset.site = place.site;
  // Only on a change: the page may watch its own subtree for mutations.
  for (const [name, value] of [["--fbw-hub-bg", place?.bg], ["--fbw-hub-ring", place?.ring]]) {
    if (value && btn.style.getPropertyValue(name) !== value) btn.style.setProperty(name, value);
  }
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

/**
 * The Hub button on TikTok and Facebook (socialMate 1.32): the Spy list from
 * storage, the save on a click, and a 1 s loop that keeps the button in place
 * while the page re-renders. `placeOf()` → { key, anchor, site, bg?, ring? } when
 * the page is a profile someone else owns (anchor null while the header is not
 * drawn yet), else null. Returns stop(), for the content script's takeover.
 */
export function startHubButton(platform, placeOf) {
  let keys = new Set();
  let saving = null; // the key whose save is in flight
  let failed = null; // the key whose last save failed
  const read = (spy) => {
    keys = new Set(Object.values(spy?.profiles || {})
      .filter((p) => p.platform === platform && p.removedAt == null)
      .map((p) => String(p.key).toLowerCase()));
  };
  const sync = () => {
    const place = placeOf();
    if (!place?.key) { syncHubButton(document, { key: null }); return; }
    if (!place.anchor) return;
    const key = place.key;
    const state = keys.has(key) ? "tracked" : key === saving ? "saving" : key === failed ? "error" : "idle";
    syncHubButton(document, { key, state, onClick, place });
  };
  // A click on a tracked profile only says so: stopping a track stays in the panel
  // and the Hub, so a stray click cannot drop a profile's history.
  const onClick = (btn) => {
    const key = btn.dataset.key;
    if (!key || saving) return;
    if (keys.has(key)) { flashHubButtonTip(btn, HUB_BTN_TIPS.already); return; }
    saving = key;
    failed = null;
    sync();
    const done = (ok) => {
      saving = null;
      if (!ok) failed = key;
      sync(); // a saved profile turns tracked from the fbw_spy change
    };
    try {
      chrome.runtime.sendMessage({ type: "FBW_SPY_SAVE", platform, key }, (res) => {
        done(!chrome.runtime.lastError && !!res?.ok);
      });
    } catch { done(false); }
  };
  const onStorage = (changes, area) => {
    if (area === "local" && changes.fbw_spy) { read(changes.fbw_spy.newValue); sync(); }
  };
  chrome.storage.onChanged.addListener(onStorage);
  chrome.storage.local.get("fbw_spy", (r) => {
    if (!chrome.runtime.lastError) { read(r?.fbw_spy); sync(); }
  });
  const timer = setInterval(sync, 1000);
  return () => {
    clearInterval(timer);
    try { chrome.storage.onChanged.removeListener(onStorage); } catch { /* a dead world */ }
    document.getElementById(HUB_BTN_ID)?.remove();
  };
}
