// The button machinery behind the injected page overlays: one icon vocabulary and
// one state machine. INLINED into content scripts — see src/lib/shared/README.md
// before editing (no imports allowed in this file).
//
// Instagram, TikTok and Pinterest each grew their own copy of both and the copies
// had already drifted: three stroke widths for the same lucide glyphs, two
// orderings of the same file-text paths, and 1200 / 1300 / 2500ms for the same
// "did it work?" flash.
//
// What is deliberately NOT here: the CSS and the render loops. Those are genuinely
// per-platform (different tile structures, different mutation patterns) and each
// overlay keeps its own button class — .sw-actbtn, .sw-ttbtn, .sw-pinbtn — so the
// state machine below only ever touches the element it is handed.

// lucide-style 24×24 stroked glyphs, rendered by overlayIcon().
export const OVERLAY_ICONS = {
  dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  save: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  img: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  tx: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  ok: '<polyline points="20 6 9 17 4 12"/>',
  err: '<line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>',
  // Instagram's stats rail only. Kept here so there is one place to look up a
  // glyph, rather than one shared map plus a private map for the odd ones out.
  eye: '<circle cx="12" cy="12" r="3"/><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  repost: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  cal: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  // Follower count — how big the account behind the post is.
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  // The sound a reel rides, so a trend can be traced to its audio.
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
};

// 15px is the tile-action button's glyph; the floating rails pass their own size.
// An unknown name renders an empty <svg> rather than the string "undefined".
export function overlayIcon(name, size = 15) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${OVERLAY_ICONS[name] || ""}</svg>`;
}

// How long ok/err feedback stays before the button goes back to idle. Pinterest's
// 2.5s is the one long enough to be read on a grid that is still mutating.
export const OVERLAY_FLASH_MS = 2500;

/**
 * busy / ok / err / idle for one overlay button. Only the STATE classes are
 * shared; the button's own class is the platform's business, so this takes the
 * element and never a class prefix.
 *
 * A button that names its idle glyph in `data-kind` also gets the glyph swapped
 * (Pinterest's spinner and ✓/✗); one that doesn't just recolours, which is what
 * the Instagram and TikTok rails have always done.
 */
export function setOverlayBtnState(btn, state) {
  // Clear any pending flash first. Without this a flash armed by an earlier click
  // fires mid-way through a later one, strips the `busy` class and defeats the
  // re-entrancy guard that class IS on Pinterest (pin-api.js checks it before
  // starting a download).
  if (btn.__swFlashTimer) {
    clearTimeout(btn.__swFlashTimer);
    btn.__swFlashTimer = null;
  }
  btn.classList.remove("busy", "ok", "err");
  if (state === "busy" || state === "ok" || state === "err") btn.classList.add(state);
  const kind = btn.dataset.kind;
  if (!kind) return;
  btn.innerHTML = overlayIcon(state === "ok" || state === "err" ? state : kind);
}

/**
 * Show how an action actually ended, then return the button to idle. The timer is
 * kept on the button so a second click restarts it — otherwise the first click's
 * timer resets a button the second one has just put back into busy.
 */
export function flashOverlayBtn(btn, state) {
  setOverlayBtnState(btn, state);
  clearTimeout(btn.__swFlashTimer);
  btn.__swFlashTimer = setTimeout(() => {
    if (btn.isConnected) setOverlayBtnState(btn, "idle");
  }, OVERLAY_FLASH_MS);
}
