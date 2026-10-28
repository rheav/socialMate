import { useCallback, useEffect, useState } from "react";
import { Moon, RefreshCw, Settings, Sun } from "lucide-react";
import { Button } from "@/dashboard/ui/button";
import type { SpyCard } from "./api";
import { ProfileSheet, type RemovedSpyProfile } from "./spy/ProfileSheet";
import { SpyView } from "./spy/SpyView";
import type { TagMeta } from "./spy/TagPicker";
import { applyTheme, readTheme, type Theme } from "./theme";

// The Spy dashboard: the extension page that shows what the Spy measured. The
// data lives in this browser (src/hub-local/); the side panel collects it.
export function DashboardApp() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  useEffect(() => applyTheme(theme), [theme]);
  const [loading, setLoading] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [selected, setSelected] = useState<SpyCard | null>(null);
  const [removed, setRemoved] = useState<RemovedSpyProfile | null>(null);
  const [updated, setUpdated] = useState<SpyCard | null>(null);
  const [tags, setTags] = useState<TagMeta[]>([]);
  // There is no session here: the page is the extension's own.
  const noSession = useCallback(() => {}, []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-[var(--header-h)] max-w-wide items-center justify-between gap-6 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/icon-public.svg" alt="" width={32} height={32} className="size-8 shrink-0 rounded-lg" />
            <h1 className="text-base font-semibold">socialRadar</h1>
            <span className="text-sm text-muted-foreground">Spy</span>
          </div>
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => setReloadTrigger((v) => v + 1)} title="Recarregar">
              <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
            </Button>
            <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => setSettingsRequest((n) => n + 1)} title="Configurações">
              <Settings size={15} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              title={theme === "dark" ? "Tema claro" : "Tema escuro"}
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </Button>
          </div>
        </div>
      </header>

      <SpyView
        reloadTrigger={reloadTrigger}
        onLoadingChange={setLoading}
        onUnauthorized={noSession}
        onSelectProfile={setSelected}
        updatedProfile={updated}
        removedProfile={removed}
        onRemovalHandled={() => setRemoved(null)}
        tagsList={tags}
        onTagsUpdated={setTags}
        settingsRequest={settingsRequest}
      />

      <ProfileSheet
        key={selected?.id ?? "closed"}
        profile={selected}
        onClose={() => setSelected(null)}
        onUnauthorized={noSession}
        onProfileUpdate={(next) => {
          setSelected((current) => (current?.id === next.id ? next : current));
          setUpdated(next);
        }}
        onTagsUpdated={setTags}
        onProfileRemoved={(gone) => {
          setRemoved(gone);
          setSelected((current) => (current?.id === gone.card.id ? null : current));
        }}
        onProfileMerged={(kept) => {
          setSelected((current) => (current?.id === kept.id ? kept : current));
          setReloadTrigger((n) => n + 1);
        }}
      />
    </div>
  );
}
