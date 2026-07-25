import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Flame, Library as LibraryIcon, Moon, Sun } from "lucide-react";
import { PLATFORMS, PLATFORM_ORDER } from "@/lib/platforms";
import { toolsForPlatform, getTool } from "@/lib/tools";
import { detectActivePlatform, hasChromeTabs } from "@/lib/tabs";
import {
  NAV_KEY,
  LEGACY_NAV_KEY,
  emptyNav,
  migrateNav,
  toolIdFor,
  withPlatform,
  withToolId,
  withTab,
} from "@/lib/navState";
import Segmented from "@/components/ui/Segmented";
import ToolFrame from "@/components/ui/ToolFrame";
import PlatformSwitcher from "@/components/ui/PlatformSwitcher";
import LibraryTool from "@/components/tools/LibraryTool";

const THEME_KEY = "sw_theme";

// ---- per-platform identity retint ----
// Only the identity gradient is per-platform (logo squircle, wordmark, active
// switcher glyph + glow, segmented thumb, Start button, toggles — they all read
// --sw-grad / --sw-from / --sw-to / --sw-glow).
//
// Deliberately does NOT apply PLATFORMS[p].theme wholesale: that object spreads a
// NEUTRAL bundle carrying LIGHT-mode tokens (--primary: 240 6% 10%, --ring,
// --radius, --sw-wash). Inline-styling those on <html> would win over the .dark
// block and wreck dark mode. Identity vars only, so both themes stay intact.
const IDENTITY_VARS = ["--sw-from", "--sw-to", "--sw-grad", "--sw-glow"];
function applyPlatformIdentity(platform) {
  const root = document.documentElement.style;
  const theme = platform ? PLATFORMS[platform]?.theme : null;
  if (!theme) {
    // Home / unknown → drop the overrides so index.css :root (light) or .dark
    // (Brute) identity comes back.
    for (const v of IDENTITY_VARS) root.removeProperty(v);
    root.removeProperty("--primary-foreground");
    return;
  }
  for (const v of IDENTITY_VARS) if (theme[v]) root.setProperty(v, theme[v]);
  // Dark mode's --primary-foreground is BLACK, tuned for the Brute red→yellow
  // accent whose yellow end kills white text. A platform gradient needs white, and
  // light mode is already white, so pin it while a platform identity is active.
  root.setProperty("--primary-foreground", "0 0% 100%");
}

// Light/dark theme: toggle the `.dark` class on <html>. Defaults to the OS
// preference until the user picks, then persists their choice.
function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}
function useTheme() {
  // Seed from the class main.jsx already applied (OS preference) so the toggle
  // icon is right on first paint; then reconcile with a stored override.
  const [theme, setTheme] = useState(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    (async () => {
      if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
      try {
        const t = (await chrome.storage.local.get(THEME_KEY))?.[THEME_KEY];
        if (t && t !== theme) {
          setTheme(t);
          applyTheme(t);
        }
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    chrome?.storage?.local?.set({ [THEME_KEY]: next });
  };
  return [theme, toggle];
}

// Two top-level tabs: Warmer and Library.
//   Warmer  → one workspace PER PLATFORM. The panel mirrors the active browser
//             tab's platform (see useFollowActiveTab) and each platform remembers
//             which of its tools you were using, so switching tabs and coming back
//             resumes your work. A platform's tools show as a segmented sub-nav.
//   Library → saved posts · transcripts (cross-platform); never disturbed by a
//             browser tab switch.
export default function Shell() {
  const [nav, setNav] = useState(emptyNav);
  const [ready, setReady] = useState(false);

  // ---- load (migrating the legacy flat key) + land on the active tab's platform ----
  const ownWindowId = useRef(null);
  useEffect(() => {
    (async () => {
      let v3 = null;
      let v2 = null;
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        try {
          const r = await chrome.storage.local.get([NAV_KEY, LEGACY_NAV_KEY]);
          v3 = r?.[NAV_KEY];
          v2 = r?.[LEGACY_NAV_KEY];
        } catch {
          /* ignore */
        }
      }
      let next = migrateNav(v3, v2);
      // Remember our own window so tab events from other windows can't retarget
      // this panel (each window has its own side panel).
      try {
        ownWindowId.current = (await chrome.windows?.getCurrent())?.id ?? null;
      } catch {
        ownWindowId.current = null;
      }
      const plat = await detectActivePlatform();
      if (plat) next = withPlatform(next, plat);
      setNav(next);
      setReady(true);
    })();
  }, []);

  // ---- persist, debounced (a burst of tab switches writes once) ----
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      chrome.storage?.local?.set({ [NAV_KEY]: nav });
    }, 300);
    return () => clearTimeout(t);
  }, [nav, ready]);

  useFollowActiveTab(ready, ownWindowId, setNav);

  const [theme, toggleTheme] = useTheme();

  // Retint the identity gradient for the workspace on screen (and restore the
  // default at Home). Re-runs on light/dark toggle too, since that swaps which
  // --primary-foreground default we're overriding.
  useEffect(() => {
    applyPlatformIdentity(nav.platform);
  }, [nav.platform, theme]);

  const setPlatform = useCallback((p) => setNav((n) => withPlatform(n, p)), []);
  const setToolId = useCallback(
    (id) => setNav((n) => withToolId(n, n.platform, id)),
    [],
  );
  const setTab = useCallback((t) => setNav((n) => withTab(n, t)), []);
  // Header switcher: jump straight into a platform's workspace from anywhere.
  const pickPlatform = useCallback(
    (p) => setNav((n) => withPlatform(withTab(n, "warm"), p)),
    [],
  );

  if (!ready) return null;

  const { tab, platform } = nav;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-4 pt-4 pb-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            onClick={() => {
              setTab("warm");
              setPlatform(null);
            }}
            title="Home"
            className="flex items-center gap-2.5"
          >
            <div className="grad-identity grid size-7 place-items-center rounded-[9px]">
              <Flame className="size-[15px] text-white" fill="currentColor" strokeWidth={1.5} />
            </div>
            <h1 className="text-[15px] font-semibold grad-identity-text tracking-tight">
              socialMate
            </h1>
          </button>
          {/* always-visible platform nav — also shows which platform the panel follows */}
          <PlatformSwitcher value={platform} onValueChange={pickPlatform} />
        </div>
        <button
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          className="grid size-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </header>

      <div className="px-4">
        <Segmented
          value={tab}
          onChange={setTab}
          items={[
            { id: "warm", label: "Warmer", Icon: Flame },
            { id: "library", label: "Library", Icon: LibraryIcon },
          ]}
        />
      </div>

      <main className="flex-1 px-4 py-3 space-y-3">
        {tab === "library" ? (
          <LibraryTool />
        ) : (
          <WarmTab
            platform={platform}
            setPlatform={setPlatform}
            toolId={toolIdFor(nav, platform)}
            setToolId={setToolId}
          />
        )}
      </main>
    </div>
  );
}

// Keep the panel pointed at the active browser tab's platform.
//
// Listeners live here (not in the background service worker) so they cost nothing
// while the panel is closed and need no storage round-trip. Reliability notes:
//   • own-window filter — a side panel belongs to one window; tab events from other
//     windows must not retarget it (this is also why windows.onFocusChanged is NOT
//     used: another window gaining focus is not a change to OUR window's tab).
//   • onUpdated is pre-filtered to real navigations of the active tab, then the sync
//     is debounced, so a page load's event burst costs one tabs.query.
//   • a monotonic ticket drops out-of-order resolutions from rapid tab switching.
//   • a non-platform tab (gmail, localhost…) resolves to null and is ignored, so the
//     panel stays on your last workspace instead of blanking.
//   • withPlatform returns the same object when unchanged → no re-render.
function useFollowActiveTab(ready, ownWindowId, setNav) {
  useEffect(() => {
    if (!ready || !hasChromeTabs()) return;
    let timer = null;
    let dead = false;
    let ticket = 0;

    const sync = async () => {
      const mine = ++ticket;
      try {
        const p = await detectActivePlatform();
        if (dead || mine !== ticket || !p) return;
        setNav((n) => withPlatform(n, p));
      } catch {
        /* transient (window teardown) — the next event re-syncs */
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(sync, 150);
    };
    const ours = (windowId) =>
      ownWindowId.current == null || windowId === ownWindowId.current;

    const onActivated = (info) => {
      if (ours(info?.windowId)) schedule();
    };
    const onUpdated = (_tabId, change, tab) => {
      if (change?.url && tab?.active && ours(tab.windowId)) schedule();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      dead = true;
      clearTimeout(timer);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, ownWindowId, setNav]);
}

// Warmer tab: platform picker → platform workspace (segmented tools + panel).
function WarmTab({ platform, setPlatform, toolId, setToolId }) {
  if (!platform) {
    return (
      <div className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Pick a platform
        </p>
        <div className="space-y-2">
          {PLATFORM_ORDER.map((id) => {
            const { name, Glyph, theme } = PLATFORMS[id];
            const tools = toolsForPlatform(id)
              .map((t) => t.label)
              .join(" · ");
            return (
              <button
                key={id}
                onClick={() => setPlatform(id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent"
              >
                <span
                  className="grid size-10 place-items-center rounded-xl text-white shadow-sm"
                  style={{ backgroundImage: theme["--sw-grad"] }}
                >
                  <Glyph width={20} height={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {tools}
                  </span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const tools = toolsForPlatform(platform);
  // A remembered tool that no longer exists (renamed/removed) falls back to the
  // platform's first tool rather than rendering nothing.
  const activeId = tools.some((t) => t.id === toolId) ? toolId : tools[0].id;
  const Panel = getTool(activeId).Panel;

  return (
    <ToolFrame title="Platforms" onBack={() => setPlatform(null)}>
      {tools.length > 1 && (
        <Segmented
          value={activeId}
          onChange={setToolId}
          items={tools.map((t) => ({ id: t.id, label: t.label, Icon: t.Icon }))}
        />
      )}
      <Panel platform={platform} />
    </ToolFrame>
  );
}
