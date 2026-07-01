import { useEffect, useState } from "react";
import { PLATFORMS, PLATFORM_ORDER } from "@/lib/platforms";
import { toolsForPlatform, globalTools, getTool } from "@/lib/tools";
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
    if (typeof chrome === "undefined" || !chrome?.storage?.local) {
      setReady(true);
      return;
    }
    chrome.storage.local.get(NAV_KEY).then((r) => {
      if (r?.[NAV_KEY]) setNav(r[NAV_KEY]);
      setReady(true);
    });
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

  // HOME — platform cards + a Library (global tools) card
  if (nav.screen === "home") {
    const platformItems = PLATFORM_ORDER.map((id) => ({
      id,
      name: PLATFORMS[id].name,
      Glyph: PLATFORMS[id].Glyph,
    }));
    const libraryItems = globalTools().map((t) => ({
      id: `tool:${t.id}`,
      label: t.label,
      Icon: t.Icon,
    }));
    return (
      <Chrome>
        <Launcher
          items={platformItems}
          onPick={(id) => setNav({ screen: "hub", platform: id, tool: null })}
        />
        <div className="mt-3">
          <Launcher
            items={libraryItems}
            onPick={(pid) =>
              setNav({ screen: "tool", platform: null, tool: pid.replace("tool:", "") })
            }
          />
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
      <Chrome>
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
function Chrome({ children }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-4 pt-4 pb-2.5">
        <div className="flex items-center gap-2.5">
          <div className="grad-identity size-7 rounded-[9px]" />
          <h1 className="text-[15px] font-semibold grad-identity-text tracking-tight">
            socialWarmer
          </h1>
        </div>
      </header>
      <main className="flex-1 px-4 py-3 space-y-3">{children}</main>
    </div>
  );
}
