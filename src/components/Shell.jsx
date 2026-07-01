import { useEffect, useState } from "react";
import { ChevronRight, Bookmark } from "lucide-react";
import { PLATFORMS, PLATFORM_ORDER } from "@/lib/platforms";
import { toolsForPlatform, globalTools, getTool } from "@/lib/tools";
import { detectActivePlatform } from "@/lib/tabs";
import Launcher from "@/components/ui/Launcher";
import ToolFrame from "@/components/ui/ToolFrame";

const NAV_KEY = "sw_nav";

// The swiss-knife launcher shell: Home (platform grid + Library) → platform hub
// (tool grid) → tool. Nav location is persisted so the panel reopens where you
// left off; the active platform's theme retints the whole panel.
export default function Shell() {
  const [nav, setNav] = useState({ screen: "home", platform: null, tool: null });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      let saved = null;
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        try {
          const r = await chrome.storage.local.get(NAV_KEY);
          saved = r?.[NAV_KEY] || null;
        } catch {
          /* ignore */
        }
      }
      // Land on the active tab's platform: restore the last tool if it was on
      // this same platform, otherwise drop into that platform's hub. Off-platform
      // (e.g. a google.com tab) falls back to the saved location, then home.
      const plat = await detectActivePlatform();
      if (plat) {
        if (saved && saved.platform === plat && saved.screen) setNav(saved);
        else setNav({ screen: "hub", platform: plat, tool: null });
      } else if (saved) {
        setNav(saved);
      }
      setReady(true);
    })();
  }, []);
  useEffect(() => {
    if (ready) chrome.storage?.local?.set({ [NAV_KEY]: nav });
  }, [nav, ready]);

  useEffect(() => {
    if (!nav.platform || !PLATFORMS[nav.platform]) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(PLATFORMS[nav.platform].theme))
      root.style.setProperty(k, v);
  }, [nav.platform]);

  if (!ready) return null;

  const goHome = () => setNav({ screen: "home", platform: null, tool: null });
  const goSaved = () => setNav({ screen: "tool", platform: null, tool: "library" });

  // HOME — brand-tinted platform rows + a distinct Library row
  if (nav.screen === "home") {
    return (
      <Chrome onSaved={goSaved}>
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
                onClick={() => setNav({ screen: "hub", platform: id, tool: null })}
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

        <div className="pt-1">
          {globalTools().map((t) => {
            const Icon = t.Icon;
            return (
              <button
                key={t.id}
                onClick={() => setNav({ screen: "tool", platform: null, tool: t.id })}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-muted/40 p-3 text-left transition-colors hover:bg-accent"
              >
                <span className="grid size-10 place-items-center rounded-xl bg-foreground text-background">
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{t.label}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Saved · Transcripts · History
                  </span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      </Chrome>
    );
  }

  // HUB — a platform's tools
  if (nav.screen === "hub") {
    const items = toolsForPlatform(nav.platform).map((t) => ({
      id: t.id,
      label: t.label,
      Icon: t.Icon,
    }));
    return (
      <Chrome onSaved={goSaved}>
        <ToolFrame title={PLATFORMS[nav.platform].name} onBack={goHome} platform={null}>
          <Launcher items={items} onPick={(tid) => setNav({ ...nav, screen: "tool", tool: tid })} />
        </ToolFrame>
      </Chrome>
    );
  }

  // TOOL
  const tool = getTool(nav.tool);
  if (!tool) {
    goHome();
    return null;
  }
  const Panel = tool.Panel;
  const isGlobal = tool.platforms === "global";
  const backTo = isGlobal
    ? goHome
    : () => setNav({ screen: "hub", platform: nav.platform, tool: null });
  const onSwap = (p) => {
    if (toolsForPlatform(p).some((t) => t.id === tool.id))
      setNav({ screen: "tool", platform: p, tool: tool.id });
    else setNav({ screen: "hub", platform: p, tool: null });
  };
  return (
    <Chrome>
      <ToolFrame
        title={tool.label}
        onBack={backTo}
        platform={isGlobal ? null : nav.platform}
        onSwapPlatform={onSwap}
      >
        <Panel platform={nav.platform} />
      </ToolFrame>
    </Chrome>
  );
}

// Shared header chrome (logo squircle + wordmark).
function Chrome({ children, onSaved }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-4 pt-4 pb-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="grad-identity size-7 rounded-[9px]" />
            <h1 className="text-[15px] font-semibold grad-identity-text tracking-tight">
              socialWarmer
            </h1>
          </div>
          {onSaved && (
            <button
              onClick={onSaved}
              title="Saved (all platforms)"
              className="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Bookmark className="size-4" />
            </button>
          )}
        </div>
      </header>
      <main className="flex-1 px-4 py-3 space-y-3">{children}</main>
    </div>
  );
}
