// Pure, DOM-free side-panel navigation state. Unit-tested.
//
// The panel keeps ONE workspace per platform so switching browser tabs (and coming
// back) resumes where you were. Shape:
//
//   { tab: "warm"|"library",            // top-level tab — GLOBAL, not per-platform
//     platform: "facebook"|"instagram"|"tiktok"|null,
//     perPlatform: { <platform>: { toolId } } }
//
// IMPORTANT — every `with*` helper returns the SAME object reference when nothing
// would change. Shell calls these from tab-event handlers, so an unchanged result
// means React bails out (Object.is) and there is no re-render. That is what keeps a
// burst of chrome.tabs events free.

export const NAV_KEY = "sw_nav3";
export const LEGACY_NAV_KEY = "sw_nav2"; // read once for migration, then ignored

export const NAV_PLATFORMS = ["facebook", "instagram", "tiktok"];
const isPlatform = (p) => NAV_PLATFORMS.includes(p);
const isTab = (t) => t === "warm" || t === "library";

export function emptyNav() {
  return { tab: "warm", platform: null, perPlatform: {} };
}

// Defensive: anything unexpected in storage degrades to a sane default rather than
// throwing or rendering a broken shell.
export function normalizeNav(n) {
  if (!n || typeof n !== "object") return emptyNav();
  const out = {
    tab: isTab(n.tab) ? n.tab : "warm",
    platform: isPlatform(n.platform) ? n.platform : null,
    perPlatform: {},
  };
  const src = n.perPlatform && typeof n.perPlatform === "object" ? n.perPlatform : {};
  for (const p of NAV_PLATFORMS) {
    const entry = src[p];
    if (entry && typeof entry === "object" && typeof entry.toolId === "string" && entry.toolId)
      out.perPlatform[p] = { toolId: entry.toolId };
  }
  return out;
}

// Prefer the v3 value; otherwise seed from the legacy flat v2 value so an existing
// user keeps their last platform + tool instead of landing at Home.
export function migrateNav(v3, v2) {
  if (v3 && typeof v3 === "object" && v3.perPlatform) return normalizeNav(v3);
  const base = emptyNav();
  if (v2 && typeof v2 === "object") {
    if (isTab(v2.tab)) base.tab = v2.tab;
    if (isPlatform(v2.platform)) {
      base.platform = v2.platform;
      if (typeof v2.toolId === "string" && v2.toolId)
        base.perPlatform[v2.platform] = { toolId: v2.toolId };
    }
  }
  return base;
}

export function toolIdFor(nav, platform) {
  if (!nav || !platform) return null;
  const entry = nav.perPlatform && nav.perPlatform[platform];
  return (entry && entry.toolId) || null;
}

export function withPlatform(nav, platform) {
  const next = isPlatform(platform) ? platform : null;
  if (nav.platform === next) return nav; // no-op → no re-render
  return { ...nav, platform: next };
}

export function withToolId(nav, platform, toolId) {
  if (!isPlatform(platform) || !toolId) return nav;
  if (toolIdFor(nav, platform) === toolId) return nav; // no-op → no re-render
  return {
    ...nav,
    perPlatform: {
      ...nav.perPlatform,
      [platform]: { ...(nav.perPlatform && nav.perPlatform[platform]), toolId },
    },
  };
}

export function withTab(nav, tab) {
  if (!isTab(tab) || nav.tab === tab) return nav; // no-op → no re-render
  return { ...nav, tab };
}
