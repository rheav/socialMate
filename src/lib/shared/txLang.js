// The BR/EN transcription-language control that lives ON the page: the persisted
// choice, the little badge on a Transcribe button, and the two-item menu that opens
// when you press one. INLINED into content scripts — see src/lib/shared/README.md
// before editing (no imports allowed in this file).
//
// Facebook grew this first and Instagram/TikTok only got the storage half of it:
// they read `fbw_transcript_language` but had no way to SET it, so on Instagram the
// language was whatever the Facebook rail had last been left on. The three scripts
// also carried three hand-copied `normTxLang`/`getTxLang` pairs — the same drift
// this directory exists to stop.
//
// Deliberately NOT here: which button gets a badge, and when the badge is
// repainted. Each overlay has its own button class and its own render loop, so a
// platform opts a button in with enableTxBadge() and calls updateTxBadges() from
// whatever loop it already runs.

export const TX_LANG_KEY = "fbw_transcript_language";
export const TX_LANG_DEFAULT = "br";
export const TX_LANG_OPTIONS = [
  { value: "br", label: "Português", short: "BR" },
  { value: "en", label: "English", short: "EN" },
];

export function normTxLang(value) {
  const lang = String(value || "").trim().toLowerCase();
  if (lang === "en") return "en";
  if (lang === "br" || lang === "pt") return "br";
  return TX_LANG_DEFAULT;
}

export function txLangInfo(value) {
  const lang = normTxLang(value);
  return TX_LANG_OPTIONS.find((o) => o.value === lang) || TX_LANG_OPTIONS[0];
}

// Where the menu goes for a button at `rect`, inside a `view` of {width,height}.
//
// Preferred side is LEFT of the button — the Facebook rail sits on the video's left
// edge and a menu opening rightwards would cover the video. A button too close to
// the left edge for that (Instagram's tile actions sit at left:7px) flips to the
// right instead of being clamped into a strip overlapping itself.
export const TX_LANG_MENU_W = 124;
export function txLangMenuPos(rect, view) {
  const preferred = rect.left - 102;
  const left = preferred < 8 ? rect.right + 6 : preferred;
  return {
    top: Math.max(8, Math.min(view.height - 92, rect.top)),
    left: Math.max(8, Math.min(view.width - 132, left)),
  };
}

export const TX_LANG_CSS = `
.fbw-lang-host{position:relative}
.fbw-lang-badge{position:absolute;right:-5px;bottom:-5px;min-width:18px;height:14px;padding:0 3px;border-radius:5px;
  display:grid;place-items:center;background:rgba(15,23,42,.96);color:#dbeafe;border:1px solid rgba(150,185,255,.55);
  font:800 8px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;pointer-events:none}
.fbw-lang-menu{position:fixed;z-index:2147483600;display:grid;gap:4px;width:${TX_LANG_MENU_W}px;padding:6px;border-radius:9px;
  background:rgba(17,24,44,.98);border:1px solid rgba(150,185,255,.42);box-shadow:0 8px 24px rgba(0,0,0,.45);
  font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}
.fbw-lang-menu button{height:30px;border:0;border-radius:6px;background:transparent;color:#e5e7eb;text-align:left;
  padding:0 8px;cursor:pointer;font:inherit}
.fbw-lang-menu button:hover,.fbw-lang-menu button.active{background:rgba(59,130,246,.24);color:#fff}`;

// On <html>, not <body>: the menu itself is appended there (outside the page's
// React root, which reconciles <body> children away), so its rules must survive
// the same way.
export function ensureTxLangStyle() {
  if (document.getElementById("fbw-lang-style")) return;
  const s = document.createElement("style");
  s.id = "fbw-lang-style";
  s.textContent = TX_LANG_CSS;
  (document.head || document.documentElement).appendChild(s);
}

export let txLangCache = TX_LANG_DEFAULT;
// The buttons that asked for a badge. A Set (not a selector) because each overlay
// names its buttons differently, and pruning on the way past keeps rails that FB
// remounts constantly from leaking entries.
const txBadged = new Set();

export async function getTxLang() {
  try {
    const r = await chrome.storage.local.get(TX_LANG_KEY);
    txLangCache = normTxLang(r?.[TX_LANG_KEY]);
  } catch {
    /* storage gone (extension reloaded under us) — keep the cached value */
  }
  return txLangCache;
}

export async function setTxLang(value) {
  txLangCache = normTxLang(value);
  try {
    await chrome.storage.local.set({ [TX_LANG_KEY]: txLangCache });
  } catch {
    /* the caller still gets the normalized value for THIS job */
  }
  updateTxBadges();
  return txLangCache;
}

/** Opt a Transcribe button in: it gets the badge now and on every refresh. */
export function enableTxBadge(btn) {
  if (!btn) return;
  ensureTxLangStyle();
  btn.classList.add("fbw-lang-host");
  txBadged.add(btn);
  paintTxBadge(btn);
}

/** Repaint one button's badge — a no-op for buttons that never opted in, so a
 *  platform's shared "button changed state" hook can call it blindly. */
export function addTxBadge(btn) {
  if (btn && txBadged.has(btn)) paintTxBadge(btn);
}

function paintTxBadge(btn) {
  let badge = btn.querySelector(".fbw-lang-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "fbw-lang-badge";
    btn.appendChild(badge);
  }
  badge.textContent = txLangInfo(btn.dataset.lang || txLangCache).short;
}

/** Repaint every opted-in badge, dropping buttons whose rail has been torn down.
 *  Busy buttons are skipped: their glyph is a spinner the badge would sit on. */
export function updateTxBadges() {
  for (const btn of txBadged) {
    if (!btn.isConnected) {
      txBadged.delete(btn);
      continue;
    }
    if (!btn.classList.contains("busy")) paintTxBadge(btn);
  }
}

/** Load the stored choice and keep every badge in step with it — including when
 *  the OTHER platform's rail changes it in another tab. */
export function watchTxLang() {
  getTxLang().then(updateTxBadges).catch(() => {});
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local" || !changes[TX_LANG_KEY]) return;
    txLangCache = normTxLang(changes[TX_LANG_KEY].newValue);
    updateTxBadges();
  });
}

let txLangMenu = null;
let txLangOutside = null;

export function closeTxLangMenu() {
  if (txLangOutside) {
    document.removeEventListener("pointerdown", txLangOutside, true);
    window.removeEventListener("blur", closeTxLangMenu);
    window.removeEventListener("scroll", closeTxLangMenu, true);
    txLangOutside = null;
  }
  if (txLangMenu) {
    txLangMenu.remove();
    txLangMenu = null;
  }
}

/**
 * Open the BR/EN menu for `btn`; `onPick(lang)` runs after the choice is saved.
 * A busy button is ignored — its job is already in flight.
 */
export function openTxLangMenu(btn, onPick) {
  if (!btn || btn.classList.contains("busy")) return;
  ensureTxLangStyle();
  closeTxLangMenu();
  const pos = txLangMenuPos(btn.getBoundingClientRect(), {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const menu = document.createElement("div");
  menu.className = "fbw-lang-menu";
  menu.setAttribute("role", "menu");
  menu.style.top = `${pos.top}px`;
  menu.style.left = `${pos.left}px`;
  for (const opt of TX_LANG_OPTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = opt.value === txLangCache ? "active" : "";
    item.textContent = opt.label;
    // The host page (FB's reel player, IG's story viewer) toggles playback on the
    // pointer sequence, so the whole sequence is swallowed — not just the click.
    item.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    item.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const lang = await setTxLang(opt.value);
      btn.dataset.lang = lang;
      closeTxLangMenu();
      onPick(lang);
    });
    menu.appendChild(item);
  }
  txLangMenu = menu;
  document.documentElement.appendChild(menu);
  // Next tick: the click that OPENED the menu is still travelling, and a listener
  // armed synchronously would see it as an outside click and close immediately.
  setTimeout(() => {
    txLangOutside = (e) => {
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      closeTxLangMenu();
    };
    document.addEventListener("pointerdown", txLangOutside, true);
    window.addEventListener("blur", closeTxLangMenu, { once: true });
    window.addEventListener("scroll", closeTxLangMenu, { once: true, capture: true });
  }, 0);
}
