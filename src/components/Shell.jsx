import { useEffect, useState } from "react";
import { ChevronRight, Flame, Library as LibraryIcon, Moon, Sun } from "lucide-react";
import { PLATFORMS, PLATFORM_ORDER } from "@/lib/platforms";
import { toolsForPlatform, getTool } from "@/lib/tools";
import { detectActivePlatform } from "@/lib/tabs";
import Segmented from "@/components/ui/Segmented";
import ToolFrame from "@/components/ui/ToolFrame";
import LibraryTool from "@/components/tools/LibraryTool";

const NAV_KEY = "sw_nav2";
const THEME_KEY = "sw_theme";

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
//   Warmer  → pick a platform, then that platform's workspace. A platform's tools
//             (Warm always; Instagram adds Sort + Download and Stories) show as a
//             segmented sub-nav inside the workspace — that's where the IG tools live.
//   Library → saved posts · transcripts · run history (cross-platform).
// The active tab's platform theme retints the whole panel.
export default function Shell() {
  const [tab, setTab] = useState("warm"); // "warm" | "library"
  const [platform, setPlatform] = useState(null); // selected platform in the Warmer tab
  const [toolId, setToolId] = useState(null); // selected platform tool
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      let saved = null;
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        try {
          saved = (await chrome.storage.local.get(NAV_KEY))?.[NAV_KEY] || null;
        } catch {
          /* ignore */
        }
      }
      // Land on the active tab's platform when there is one; else restore.
      const plat = await detectActivePlatform();
      if (plat) {
        setTab("warm");
        setPlatform(plat);
        setToolId(saved?.platform === plat ? saved?.toolId || null : null);
      } else if (saved) {
        setTab(saved.tab || "warm");
        setPlatform(saved.platform || null);
        setToolId(saved.toolId || null);
      }
      setReady(true);
    })();
  }, []);
  useEffect(() => {
    if (ready)
      chrome.storage?.local?.set({ [NAV_KEY]: { tab, platform, toolId } });
  }, [tab, platform, toolId, ready]);

  const [theme, toggleTheme] = useTheme();

  if (!ready) return null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-4 pt-4 pb-2.5">
        <button
          onClick={() => {
            setTab("warm");
            setPlatform(null);
          }}
          title="Home"
          className="flex items-center gap-2.5"
        >
          <div className="grad-identity size-7 rounded-[9px]" />
          <h1 className="text-[15px] font-semibold grad-identity-text tracking-tight">
            socialMate
          </h1>
        </button>
        <button
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          className="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
            toolId={toolId}
            setToolId={setToolId}
          />
        )}
      </main>
    </div>
  );
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
                onClick={() => {
                  setPlatform(id);
                  setToolId(null);
                }}
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
  const activeId = tools.some((t) => t.id === toolId) ? toolId : tools[0].id;
  const tool = getTool(activeId);
  const Panel = tool.Panel;
  const swap = (p) => {
    setPlatform(p);
    setToolId(null);
  };

  return (
    <ToolFrame
      title="Platforms"
      onBack={() => setPlatform(null)}
      platform={platform}
      onSwapPlatform={swap}
    >
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
