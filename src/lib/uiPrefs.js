// Panel-wide UI preferences: which parts of the panel the user wants to see at
// all. Pure (DOM-free, component-free) so the Shell's behaviour can be tested
// without React — same split as navState.js / toolsFilter.js.
//
// Today it holds one switch. The warmer is the loudest thing in the panel (its
// own top-level tab, a flame in the header of every screen) and someone whose
// week is about SCRAPING wants it out of the way — hidden, not uninstalled: the
// engine, its sessions and its stored pacing all stay exactly as they were, and
// flipping the switch back returns the tab with its workspace intact.

export const UI_PREFS_KEY = "sw_ui_prefs";

/** Every top-level tab, in nav order. `optional` ones can be switched off. */
export const TOP_TABS = [
  { id: "research", label: "Pesquisa" },
  { id: "warm", label: "Aquecer", optional: true },
  { id: "library", label: "Arquivo" },
];

export const DEFAULT_UI_PREFS = { showWarm: true };

/**
 * A stored blob (or anything at all) read as prefs.
 *
 * Unknown keys are dropped and every value is coerced, so a hand-edited or
 * half-written storage entry can never hide a tab by accident — only an explicit
 * `false` does.
 */
export function normalizeUiPrefs(raw) {
  const out = { ...DEFAULT_UI_PREFS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULT_UI_PREFS))
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  return out;
}

/** The tabs to render, in nav order. */
export function visibleTabs(prefs) {
  const p = normalizeUiPrefs(prefs);
  return TOP_TABS.filter((t) => t.id !== "warm" || p.showWarm);
}

/**
 * The tab to actually show.
 *
 * Hiding the warmer while standing IN it would otherwise leave the panel on a
 * tab with no way back to it, so a hidden tab falls back to the first visible
 * one — and an unknown id (a rename, a stale stored nav) lands there too.
 */
export function resolveTab(tab, prefs) {
  const tabs = visibleTabs(prefs);
  return tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
}
