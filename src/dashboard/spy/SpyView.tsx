import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/dashboard/ui/button";
import { EmptyState } from "@/dashboard/ui/empty-state";
import { Input } from "@/dashboard/ui/input";
import { Skeleton } from "@/dashboard/ui/skeleton";
import { Plus, Search, X } from "lucide-react";
import { cn } from "@/dashboard/lib/utils";
import { api, ApiError, isUnauthorized, type CollectionCheck, type SpyCard } from "../api";
import type { RemovedSpyProfile } from "./ProfileSheet";
import { ProfileCard } from "./ProfileCard";
import type { TagMeta } from "./TagPicker";
import { CardProperties } from "./CardProperties";
import { ReadingsView } from "./ReadingsView";
import { TopPostsSection } from "./TopPostsSection";
import { SpySettingsDialog, type SpySettingsTab } from "./SpySettingsDialog";
import {
  loadIntelLayout,
  loadSectionOrder,
  loadSpyCardFields,
  loadSpySort,
  moveSection,
  saveIntelLayout,
  saveSectionOrder,
  saveSpyCardFields,
  saveSpySort,
  type IntelLayout,
  type IntelSection,
  type SpyCardFields,
} from "./spySettings";
import { filterSortProfiles, SPY_SORT_LABELS, type SpySort } from "./spyFormat";
import { GridDensityToggle, loadGridDensity, saveGridDensity, type GridDensity } from "../GridDensity";

const DENSITY_KEY = "socialmate_spy_density";

interface SpyViewProps {
  reloadTrigger: number;
  onLoadingChange: (loading: boolean) => void;
  onUnauthorized: () => void;
  onSelectProfile: (profile: SpyCard) => void;
  updatedProfile?: SpyCard | null;
  removedProfile?: RemovedSpyProfile | null;
  onRemovalHandled?: () => void;
  tagsList?: TagMeta[];
  onTagsUpdated?: (tags: TagMeta[]) => void;
  /** Bumped by the header's gear: opens Configurações. */
  settingsRequest?: number;
}

// The Spy page. The Top holds the top posts and the posting hours; Perfis, the
// grid; Stories, the swipe file. Leituras (the extension's log) is looked up, not
// read every day, so it sits apart: at the foot of the column, or at the end of the
// tabs. Two layouts of the same sections, picked in Configurações (the header's
// gear): a column on the left, or tabs.

// The swipe file is its own chunk: posters, decks and the viewer load only
// when the section opens (lightness budget, spec §9).
const StoriesSection = lazy(() => import("./stories/StoriesSection"));
type Section = "top" | "profiles" | "stories" | "readings";

const SECTIONS: { key: Section; label: string; hash: string }[] = [
  { key: "top", label: "Top", hash: "#spy" },
  { key: "profiles", label: "Perfis", hash: "#spy/perfis" },
  { key: "stories", label: "Stories", hash: "#spy/stories" },
  { key: "readings", label: "Leituras", hash: "#spy/leituras" },
];

interface Place {
  section: Section;
  /** #spy/stories/<profileId>: one account's stories. */
  storiesProfile: string | null;
}

/** #spy → the Top; #spy/perfis, #spy/stories[/<profileId>], #spy/leituras. */
function readPlace(): Place {
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  const stories = /^#spy\/stories\/((?:instagram|facebook):[a-z0-9._]{1,64})$/.exec(hash);
  if (stories) return { section: "stories", storiesProfile: stories[1] };
  return { section: SECTIONS.find((x) => x.hash === hash)?.key ?? "top", storiesProfile: null };
}

export function SpyView({
  reloadTrigger,
  onLoadingChange,
  onUnauthorized,
  onSelectProfile,
  updatedProfile,
  removedProfile,
  onRemovalHandled,
  tagsList: tagsListProp,
  onTagsUpdated: onTagsUpdatedProp,
  settingsRequest = 0,
}: SpyViewProps) {
  const [profiles, setProfiles] = useState<SpyCard[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  // The profile just removed, while its history is still kept (7 days):
  // "desfazer" saves it again and the server brings everything back.
  const [removed, setRemoved] = useState<RemovedSpyProfile | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [urlInput, setUrlInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [internalTagsList, setInternalTagsList] = useState<TagMeta[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Every section lives in the URL, so the analysis button, a link or the back
  // button can open it.
  const [place, setPlace] = useState<Place>(readPlace);
  const [health, setHealth] = useState<CollectionCheck[] | null>(null);
  useEffect(() => {
    const onHash = () => setPlace(readPlace());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const goTo = (section: Section) => {
    const hash = SECTIONS.find((x) => x.key === section)!.hash;
    setPlace({ section, storiesProfile: null });
    if (window.location.hash !== hash) window.location.hash = hash;
  };
  const focusStories = (profileId: string | null) => {
    const hash = profileId ? `#spy/stories/${profileId}` : "#spy/stories";
    setPlace({ section: "stories", storiesProfile: profileId });
    if (window.location.hash !== hash) window.location.hash = hash;
  };
  const [layout, setLayout] = useState<IntelLayout>(loadIntelLayout);
  const changeLayout = (next: IntelLayout) => {
    setLayout(next);
    saveIntelLayout(next);
  };
  // The sections in the order the owner dragged them into (Leituras stays at the foot).
  const [order, setOrder] = useState<IntelSection[]>(loadSectionOrder);
  const [dragging, setDragging] = useState<IntelSection | null>(null);
  const navButtons = useRef(new Map<IntelSection, HTMLButtonElement>());
  const movedByKey = useRef<IntelSection | null>(null);
  // A drag move not drawn yet: the browser can repeat dragover on the old layout, which would undo it.
  const moveDrawn = useRef(true);
  useEffect(() => {
    moveDrawn.current = true;
    saveSectionOrder(order);
    // A section moved with Alt+arrows keeps the focus, so the next press moves it again.
    if (movedByKey.current) navButtons.current.get(movedByKey.current)?.focus();
    movedByKey.current = null;
  }, [order]);
  const [adding, setAdding] = useState(false);
  const [sort, setSort] = useState<SpySort>(loadSpySort);

  const [fields, setFields] = useState<SpyCardFields>(loadSpyCardFields);
  const [density, setDensity] = useState<GridDensity>(() => loadGridDensity(DENSITY_KEY));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SpySettingsTab>("fields");
  // Only a new press of the gear opens it: coming back from the Acervo remounts
  // this page with the header's count already above zero.
  const settingsSeen = useRef(settingsRequest);
  useEffect(() => {
    if (settingsRequest === settingsSeen.current) return;
    settingsSeen.current = settingsRequest;
    setSettingsTab("fields");
    setSettingsOpen(true);
  }, [settingsRequest]);

  const effectiveTagsList = tagsListProp ?? internalTagsList;

  const handleTagsUpdated = useCallback(
    (newTags: TagMeta[]) => {
      setInternalTagsList(newTags);
      onTagsUpdatedProp?.(newTags);
    },
    [onTagsUpdatedProp]
  );

  const handleFieldsChange = (nextFields: SpyCardFields) => {
    setFields(nextFields);
    saveSpyCardFields(nextFields);
  };

  const pendingMutations = useRef(0);
  const requestPending = useRef(false);
  const inflight = useRef<AbortController | null>(null);
  const callbacksRef = useRef({ onLoadingChange, onUnauthorized });
  callbacksRef.current = { onLoadingChange, onUnauthorized };

  const load = useCallback(async (quiet = false) => {
    if (quiet && (pendingMutations.current > 0 || (requestPending.current && !inflight.current?.signal.aborted))) return;
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    requestPending.current = true;

    if (!quiet) setLoadError(null);
    if (!quiet) {
      setLoading(true);
      callbacksRef.current.onLoadingChange(true);
    }

    try {
      const res = await api.spy.list(ac.signal);
      if (ac.signal.aborted) return;
      setLoadError(null);
      setProfiles(res.profiles ?? []);

      api.spy.tags
        .list(ac.signal)
        .then((tagsRes) => {
          if (!ac.signal.aborted) handleTagsUpdated(tagsRes.tags);
        })
        .catch(() => {});
      api.spy.health(ac.signal).then((h) => { if (!ac.signal.aborted) setHealth(h.checks); }).catch(() => {});
    } catch (err) {
      if (ac.signal.aborted) return;
      if (isUnauthorized(err)) {
        callbacksRef.current.onUnauthorized();
        return;
      }
      if (!quiet) setLoadError("Não consegui carregar os perfis. Tente novamente.");
    } finally {
      if (inflight.current === ac) requestPending.current = false;
      if (!ac.signal.aborted) {
        setLoading(false);
        callbacksRef.current.onLoadingChange(false);
      }
    }
  }, [handleTagsUpdated]);

  const cancelLoad = useCallback(() => {
    inflight.current?.abort();
    setLoading(false);
    callbacksRef.current.onLoadingChange(false);
  }, []);

  const handleCatalogChange = (from: string, to?: string) => {
    cancelLoad();
    setProfiles((current) => current.map((p) => ({
      ...p,
      tags: [...new Set(p.tags.flatMap((tag) => tag.toLowerCase() === from.toLowerCase() ? (to ? [to] : []) : [tag]))],
    })));
    setSelectedTag((selected) => selected?.toLowerCase() === from.toLowerCase() ? to ?? null : selected);
  };

  useEffect(() => {
    if (!updatedProfile) return;
    cancelLoad();
    setProfiles((prev) =>
      prev.map((p) => (p.id === updatedProfile.id ? updatedProfile : p))
    );
    api.spy.tags
      .list()
      .then((res) => handleTagsUpdated(res.tags))
      .catch(() => {});
  }, [updatedProfile, handleTagsUpdated, cancelLoad]);

  useEffect(() => {
    load();
    return () => inflight.current?.abort();
  }, [load, reloadTrigger]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    const timer = setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const handleAddProfile = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    cancelLoad();
    pendingMutations.current++;
    setSubmitting(true);
    setSubmitError(null);

    try {
      // The server answers with the card itself; reading `.profile` off it was
      // undefined, and the next render crashed the whole panel.
      const newCard = await api.spy.add({ url: trimmed });
      cancelLoad();
      setUrlInput("");
      setAdding(false);
      setProfiles((prev) => {
        const next = [newCard, ...prev.filter((p) => p.id !== newCard.id)];
        return next;
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      if (err instanceof ApiError) {
        if (err.status === 400 || err.code === "invalid_profile") {
          setSubmitError(
            "Não reconheci esse link. Cole o endereço do perfil no Instagram ou no Facebook."
          );
        } else if (err.status === 409 || err.code === "limit_reached") {
          setSubmitError("Limite de 100 perfis. Remova um para salvar outro.");
        } else {
          setSubmitError("Não consegui salvar. Tente de novo.");
        }
      } else {
        setSubmitError("Não consegui salvar. Tente de novo.");
      }
    } finally {
      pendingMutations.current--;
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!removedProfile) return;
    cancelLoad();
    setMutationError(null);
    setRemoved(removedProfile);
    setProfiles((prev) => prev.filter((p) => p.id !== removedProfile.card.id));
    onRemovalHandled?.();
  }, [removedProfile, cancelLoad, onRemovalHandled]);

  const handleUndo = async () => {
    if (!removed || undoing) return;
    pendingMutations.current++;
    cancelLoad();
    setUndoing(true);
    setMutationError(null);
    try {
      const card = await api.spy.add({ platform: removed.card.platform, handle: removed.card.key });
      setProfiles((prev) => [card, ...prev.filter((p) => p.id !== card.id)]);
      setRemoved(null);
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else if (err instanceof ApiError && err.status === 409) setMutationError("Limite de 100 perfis. Remova outro para trazer este de volta.");
      else setMutationError("Não consegui desfazer. Salve o perfil de novo pelo link para recuperar o histórico.");
    } finally {
      pendingMutations.current--;
      setUndoing(false);
    }
  };

  const tagColorsMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const t of effectiveTagsList) {
      map[t.name.toLowerCase()] = t.color;
    }
    return map;
  }, [effectiveTagsList]);

  // The top posts load again when a reading of an Instagram profile lands, not on
  // every 15-second refresh of the list.
  const hasInstagram = profiles.some((p) => p.platform === "instagram");
  const topPostsKey = useMemo(() => {
    const read = profiles.reduce((max, p) => p.platform !== "instagram" ? max
      : Math.max(max, p.daily?.readAt ?? 0, p.views?.at ?? 0), 0);
    return `${reloadTrigger}:${read}`;
  }, [profiles, reloadTrigger]);

  const displayedProfiles: SpyCard[] = useMemo(
    () => filterSortProfiles(profiles, { query, sort, tag: selectedTag }),
    [profiles, query, sort, selectedTag]
  );

  // A card keeps the tags, notes and bio slots open even when its own are empty,
  // so cards in a row line up. When no saved profile has any, the slot is only
  // blank space on every card: drop it. Decided over the whole list, not the
  // filtered one, so typing a search does not make the cards jump.
  // No reports here, so no report tag rule: every card is in.
  const reportTags: string[] = [];

  const cardFields: SpyCardFields = useMemo(() => ({
    ...fields,
    tags: fields.tags && profiles.some((p) => p.tags.length > 0 || (p.sameAccountAs ?? []).length > 0),
    notes: fields.notes && profiles.some((p) => !!p.notes?.trim()),
    bio: fields.bio && profiles.some((p) => !!p.bio?.trim()),
  }), [fields, profiles]);

  const gridClass = cn("card-grid", density === "compact" ? "[--card-min:240px]" : "[--card-min:280px]");
  const sidebar = layout === "sidebar";

  const openSettings = (tab: SpySettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };
  const closeAdd = () => {
    setAdding(false);
    setUrlInput("");
    setSubmitError(null);
  };
  const tagCount = (name: string) => profiles.filter((p) => p.tags.some((t) => t.toLowerCase() === name.toLowerCase())).length;
  const pickTag = (name: string | null) => {
    setSelectedTag(name);
    if (place.section !== "profiles") goTo("profiles");
  };

  // "Adicionar perfil": a button that opens the link field in place. In the
  // column the field and its buttons stack.
  const addProfile = adding ? (
    <form
      onSubmit={handleAddProfile}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          closeAdd();
        }
      }}
      className={cn("space-y-1.5", sidebar ? "w-full" : "w-full max-w-md")}
    >
      <div className={cn("flex gap-2", sidebar && "flex-col")}>
        <Input
          autoFocus
          aria-label="Link do perfil"
          name="profileUrl"
          type="text"
          value={urlInput}
          onChange={(e) => {
            setUrlInput(e.target.value);
            if (submitError) setSubmitError(null);
          }}
          placeholder={sidebar ? "Link do Instagram ou Facebook" : "Colar o link do perfil (Instagram ou Facebook)"}
          className="h-8 flex-1 text-xs"
          disabled={submitting}
        />
        <div className="flex gap-1.5">
          <Button type="submit" size="sm" disabled={submitting || !urlInput.trim()} className={cn("h-8 cursor-pointer", sidebar && "flex-1")}>
            {submitting ? "salvando…" : "salvar"}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-8 cursor-pointer" aria-label="Cancelar" onClick={closeAdd}>
            <X size={14} />
          </Button>
        </div>
      </div>
      {submitError && <p className="text-xs text-destructive">{submitError}</p>}
    </form>
  ) : (
    <Button
      type="button"
      size="sm"
      variant={sidebar ? "outline" : "default"}
      className={cn("h-8 cursor-pointer gap-1.5", sidebar && "w-full justify-start border-dashed bg-transparent")}
      onClick={() => setAdding(true)}
    >
      <Plus size={14} /> Adicionar perfil
    </Button>
  );

  const tagPills = effectiveTagsList.length > 0 && (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => setSelectedTag(null)}
        className={cn(
          "inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium transition-colors cursor-pointer select-none",
          selectedTag === null
            ? "bg-primary text-primary-foreground font-semibold"
            : "border border-border/70 bg-card text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
        )}
      >
        Todas <span className="ml-1 opacity-70 tabular-nums">{profiles.length}</span>
      </button>
      {effectiveTagsList.map((tag) => {
        const isSelected = selectedTag?.toLowerCase() === tag.name.toLowerCase();
        return (
          <button
            key={tag.name}
            type="button"
            onClick={() => setSelectedTag(isSelected ? null : tag.name)}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors cursor-pointer select-none border",
              isSelected
                ? "border-primary bg-primary/20 text-foreground font-semibold ring-1 ring-primary"
                : "border-border/60 bg-card text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            )}
          >
            <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
            <span>{tag.name}</span>
            <span className="opacity-60 text-[11px] tabular-nums">{tagCount(tag.name)}</span>
          </button>
        );
      })}
    </div>
  );

  const gridTools = profiles.length > 1 && (
    <>
      <label className="relative min-w-0">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          name="profileSearch"
          aria-label="Buscar perfis"
          placeholder="Buscar nome, @ ou nota"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 w-48 pl-7 text-xs"
        />
      </label>
      <select
        aria-label="Ordenar perfis"
        value={sort}
        onChange={(e) => {
          const next = e.target.value as SpySort;
          setSort(next);
          saveSpySort(next);
        }}
        className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground"
      >
        {(Object.keys(SPY_SORT_LABELS) as SpySort[]).map((key) => (
          <option key={key} value={key}>{SPY_SORT_LABELS[key]}</option>
        ))}
      </select>
      <GridDensityToggle
        value={density}
        onChange={(next) => {
          setDensity(next);
          saveGridDensity(DENSITY_KEY, next);
        }}
      />
    </>
  );

  // Each section shows only its own tools: the grid's sit right above the grid.
  const profilesSection = (
    <>
      <section aria-label="Ferramentas dos perfis" className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        {sidebar ? (
          <h2 className="text-sm font-semibold text-foreground">
            Perfis
            <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
              {selectedTag ? `${displayedProfiles.length} de ${profiles.length} · ${selectedTag}` : profiles.length}
            </span>
          </h2>
        ) : (
          <>
            {addProfile}
            {tagPills}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {gridTools}
          <CardProperties fields={fields} onChange={handleFieldsChange} onOpenSettings={() => openSettings("fields")} />
        </div>
      </section>

      {/* Grid / Skeletons / EmptyState */}
      {loading && profiles.length === 0 ? (
        <div className={gridClass}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-[var(--radius-card)]" />
          ))}
        </div>
      ) : displayedProfiles.length > 0 ? (
        <div
          className={cn(
            "transition-opacity duration-200",
            loading && "opacity-50"
          )}
        >
          {/* The entrance is CSS (effects.css), one class per card instead of a
              Motion instance per card. */}
          <div className={gridClass}>
            {displayedProfiles.map((profile, i) => (
              <div key={profile.id} className="fx-fade" style={{ "--i": i } as CSSProperties}>
                <ProfileCard
                  profile={profile}
                  tagColors={tagColorsMap}
                  fields={cardFields}
                  density={density}
                  reportTags={reportTags}
                  onOpen={() => onSelectProfile(profile)}
                />
              </div>
            ))}
          </div>
        </div>
      ) : profiles.length > 0 && query.trim() ? (
        <EmptyState
          title={`Nenhum perfil encontrado para “${query.trim()}”`}
          description="A busca olha nome, @ e anotações. Limpe o campo para ver todos."
        />
      ) : profiles.length > 0 && selectedTag ? (
        <EmptyState
          title={`Nenhum perfil com a tag “${selectedTag}”`}
          description="Selecione outra tag ou clique em 'Todas' para ver todos os perfis salvos."
        />
      ) : loadError ? null : (
        <EmptyState
          title="Nenhum perfil salvo"
          description="Use “Adicionar perfil” com o link de um perfil do Instagram ou do Facebook, ou salve pelo painel da extensão. A extensão mede os seguidores uma vez por dia."
        />
      )}
    </>
  );

  const topSection = hasInstagram ? (
    <TopPostsSection refreshKey={topPostsKey} onUnauthorized={onUnauthorized} onOpenSettings={() => openSettings("tags")} />
  ) : (
    <EmptyState
      title="Nenhum perfil do Instagram ainda"
      description="O Top mostra os posts com mais visualizações dos perfis do Instagram salvos. Salve um perfil para começar."
    />
  );

  const notices = (
    <>
      {loadError && <p role="alert" className="mb-4 text-sm text-destructive">{loadError} <button type="button" className="underline" onClick={() => void load()}>Tentar novamente</button></p>}
      {mutationError && <p role="alert" className="mb-4 text-sm text-destructive">{mutationError}</p>}
      {removed && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-xs">
          <span className="text-foreground">
            {removed.card.platform === "instagram" ? `@${removed.card.key}` : removed.card.name || removed.card.key} saiu da lista.
          </span>
          <span className="text-muted-foreground">
            Histórico, tags e notas ficam guardados até {new Date(removed.until).toLocaleDateString("pt-BR", { day: "numeric", month: "long" })}.
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button type="button" size="sm" variant="outline" className="h-7 cursor-pointer text-xs" disabled={undoing} onClick={() => void handleUndo()}>
              {undoing ? "desfazendo…" : "desfazer"}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 cursor-pointer text-xs" onClick={() => setRemoved(null)} aria-label="Fechar aviso">
              ok
            </Button>
          </span>
        </div>
      )}
    </>
  );

  const storiesSection = (
    <Suspense fallback={<Skeleton className="h-64 rounded-[var(--radius-card)]" />}>
      <StoriesSection profiles={profiles} profileId={place.storiesProfile} onFocusChange={focusStories}
        onSelectProfile={onSelectProfile} onUnauthorized={onUnauthorized} refreshKey={reloadTrigger} />
    </Suspense>
  );
  const content = place.section === "top" ? topSection
    : place.section === "readings" ? <ReadingsView health={health} onUnauthorized={onUnauthorized} />
    : place.section === "stories" ? storiesSection
    : profilesSection;
  const broken = health?.filter((c) => c.status === "broken").length ?? 0;
  const count = (section: Section): ReactNode =>
    section === "profiles" ? <span className="text-xs font-normal tabular-nums text-muted-foreground">{profiles.length}</span>
    : section === "readings" && broken > 0 && <span role="img" aria-label="coleta quebrada" className="size-2 self-center rounded-full bg-destructive" />;
  const data = order.map((key) => SECTIONS.find((x) => x.key === key)!);
  const foot = SECTIONS.filter((x) => x.key === "readings");

  const tab = (x: (typeof SECTIONS)[number]) => {
    const active = place.section === x.key;
    return (
      <button
        key={x.key}
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => goTo(x.key)}
        className={cn(
          "-mb-px flex cursor-pointer items-baseline gap-1.5 border-b-2 pb-2.5 pt-1 text-sm transition-colors",
          active ? "border-sky font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
        )}
      >
        {x.label}
        {count(x.key)}
      </button>
    );
  };
  const item = (x: (typeof SECTIONS)[number], movable?: IntelSection) => {
    const active = place.section === x.key;
    return (
      <button
        key={x.key}
        ref={movable ? (node) => { if (node) navButtons.current.set(movable, node); else navButtons.current.delete(movable); } : undefined}
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => goTo(x.key)}
        {...(movable && {
          title: "Arraste ou use Alt+↑/↓ para mudar a ordem",
          "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
          onKeyDown: (e: KeyboardEvent) => {
            if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            movedByKey.current = movable;
            setOrder((cur) => moveSection(cur, movable, cur.indexOf(movable) + (e.key === "ArrowUp" ? -1 : 1)));
          },
        })}
        className={cn(
          "flex w-full cursor-pointer items-baseline justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
          active ? "bg-secondary font-semibold text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
        )}
      >
        {x.label}
        {count(x.key)}
      </button>
    );
  };

  const dialog = (
    <SpySettingsDialog
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      fields={fields}
      onFieldsChange={handleFieldsChange}
      profiles={profiles}
      allTags={effectiveTagsList}
      onTagsUpdated={handleTagsUpdated}
      onCatalogChange={handleCatalogChange}
      onUnauthorized={onUnauthorized}
      initialTab={settingsTab}
      layout={layout}
      onLayoutChange={changeLayout}
    />
  );

  // The dialog sits outside the layout's tree: picking the other layout in it
  // rebuilds the page around it, and it must stay open on the same tab.
  const page = !sidebar ? (
    <main className="mx-auto max-w-wide px-4 pb-6 pt-5">
      <nav aria-label="Seções do Spy" className="mb-5 flex items-end gap-6 border-b">
        {data.map(tab)}
        <div className="ml-auto flex gap-6">{foot.map(tab)}</div>
      </nav>
      {notices}
      {content}
    </main>
  ) : (
    // The column stays put under the header while the page scrolls.
    <div className="mx-auto grid max-w-wide grid-cols-[220px_minmax(0,1fr)] gap-6 px-4">
      <aside aria-label="Seções do Spy" className="sticky top-[var(--header-h)] flex h-[calc(100vh-var(--header-h))] flex-col self-start overflow-y-auto border-r py-5 pr-4">
        <div className="mb-4">{addProfile}</div>
        <nav className="flex flex-col gap-0.5">
          {data.map((x) => {
            const key = x.key as IntelSection;
            return (
              // Native drag and drop: the panel's Motion bundle has no drag (LazyMotion, domAnimation).
              <div
                key={x.key}
                draggable
                onDragStart={(e) => {
                  setDragging(key);
                  e.dataTransfer?.setData("text/plain", key);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  if (dragging === key || !moveDrawn.current) return;
                  moveDrawn.current = false;
                  setOrder((cur) => moveSection(cur, dragging, cur.indexOf(key)));
                }}
                onDrop={(e) => e.preventDefault()}
                onDragEnd={() => setDragging(null)}
                className={cn("group relative", dragging === key && "opacity-50")}
              >
                {/* The handle sits in the button's own left padding: the labels stay lined up with Leituras and the tags. */}
                <span aria-hidden className="pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 select-none text-[11px] leading-none text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">⠿</span>
                {item(x, key)}
              </div>
            );
          })}
        </nav>
        {effectiveTagsList.length > 0 && (
          <div className="mt-6">
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</div>
            {[{ name: null as string | null, color: null as string | null, n: profiles.length }, ...effectiveTagsList.map((t) => ({ name: t.name as string | null, color: t.color as string | null, n: tagCount(t.name) }))].map((t) => {
              const active = t.name === null ? selectedTag === null : selectedTag?.toLowerCase() === t.name.toLowerCase();
              return (
                <button
                  key={t.name ?? "*"}
                  type="button"
                  aria-pressed={active}
                  onClick={() => pickTag(t.name === null || active ? null : t.name)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors",
                    active ? "bg-secondary/70 font-semibold text-foreground" : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground"
                  )}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", t.color === null && "bg-foreground/70")} style={t.color ? { backgroundColor: t.color } : undefined} />
                  <span className="min-w-0 flex-1 truncate">{t.name ?? "Todas"}</span>
                  <span className="tabular-nums opacity-70">{t.n}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-auto flex flex-col gap-0.5 border-t pt-3">{foot.map((x) => item(x))}</div>
      </aside>
      <main className="min-w-0 py-5">
        {notices}
        {content}
      </main>
    </div>
  );

  return (
    <>
      {page}
      {dialog}
    </>
  );
}
