import { AnimatePresence, m } from "motion/react";
import {
  Check,
  Hash,
  LayoutPanelLeft,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { NORD_TAG_COLORS } from "../../hub-local/shared/tag-colors.js";
import { Button } from "@/dashboard/ui/button";
import { Input } from "@/dashboard/ui/input";
import { MOTION } from "@/dashboard/ui/motion";
import { Separator } from "@/dashboard/ui/separator";
import { Switch } from "@/dashboard/ui/switch";
import { cn } from "@/dashboard/lib/utils";
import { ApiError, api, isUnauthorized, type SpyCard } from "../api";
import { StoriesSettingsSection } from "./stories/StoriesSettingsSection";
import { Images } from "lucide-react";
import { OptionChip } from "./OptionChip";
import { useSpyDialog } from "./useSpyDialog";
import type { TagMeta } from "./TagPicker";
import {
  DEFAULT_SPY_CARD_FIELDS,
  SPY_CARD_FIELD_DEFS,
  type IntelLayout,
  type SpyCardFields,
} from "./spySettings";

export type SpySettingsTab = "fields" | "tags" | "layout" | "stories";

interface SpySettingsDialogProps {
  open: boolean;
  onClose: () => void;
  fields: SpyCardFields;
  onFieldsChange: (fields: SpyCardFields) => void;
  profiles: SpyCard[];
  allTags: TagMeta[];
  onTagsUpdated: (tags: TagMeta[]) => void;
  onCatalogChange: (from: string, to?: string) => void;
  onUnauthorized: () => void;
  initialTab?: SpySettingsTab;
  layout: IntelLayout;
  onLayoutChange: (layout: IntelLayout) => void;
}

export function SpySettingsDialog({
  open,
  onClose,
  fields,
  onFieldsChange,
  profiles,
  allTags,
  onTagsUpdated,
  onCatalogChange,
  onUnauthorized,
  initialTab = "fields",
  layout,
  onLayoutChange,
}: SpySettingsDialogProps) {
  const [tab, setTab] = useState<SpySettingsTab>(initialTab);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    }
  }, [open, initialTab]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useSpyDialog(open, dialogRef, onClose);
  // The active tab's place, for the sliding underline.
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [underline, setUnderline] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const bar = tabsRef.current;
    const active = bar?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (!bar || !active) return;
    setUnderline({ left: active.offsetLeft, width: active.offsetWidth });
  }, [open, tab]);

  if (!open) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop */}
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        />

        {/* Modal Window */}
        <m.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Configurações da Inteligência"
          tabIndex={-1}
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 10 }}
          transition={MOTION.view}
          className="relative z-10 flex h-full max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-border/80 bg-card shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <header className="flex items-center justify-between border-b px-6 py-4 bg-card/90">
            <div>
              <h2 className="text-base font-bold text-foreground">Configurações da Inteligência</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Personalize os campos dos cards, as tags, o layout da página, a agenda da análise e o motor das leituras.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
              title="Fechar"
            >
              <X size={18} />
            </button>
          </header>

          {/* Tabs bar: one underline slides to the active tab (measured once per change). */}
          <div ref={tabsRef} className="relative flex border-b bg-secondary/30 px-6 pt-2">
            <span className="fx-underline" aria-hidden="true" style={{ transform: `translateX(${underline.left}px)`, width: underline.width }} />
            <button
              type="button"
              data-tab="fields"
              onClick={() => setTab("fields")}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors cursor-pointer",
                tab === "fields"
                  ? "border-transparent text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <SlidersHorizontal size={14} />
              <span>Campos do Card</span>
            </button>

            <button
              type="button"
              data-tab="tags"
              onClick={() => setTab("tags")}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors cursor-pointer",
                tab === "tags"
                  ? "border-transparent text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Tags size={14} />
              <span>Tags ({allTags.length})</span>
            </button>

            <button
              type="button"
              data-tab="layout"
              onClick={() => setTab("layout")}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors cursor-pointer",
                tab === "layout"
                  ? "border-transparent text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <LayoutPanelLeft size={14} />
              <span>Layout</span>
            </button>



            <button
              type="button"
              data-tab="stories"
              onClick={() => setTab("stories")}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors cursor-pointer",
                tab === "stories"
                  ? "border-transparent text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Images size={14} />
              <span>Stories</span>
            </button>

          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {tab === "fields" ? (
              <FieldsSettingsSection
                fields={fields}
                onFieldsChange={onFieldsChange}
              />
            ) : tab === "layout" ? (
              <LayoutSettingsSection layout={layout} onLayoutChange={onLayoutChange} />
            ) : tab === "stories" ? (
              <StoriesSettingsSection onUnauthorized={onUnauthorized} />
            ) : (
              <div className="space-y-6">
                <TagsSettingsSection
                  allTags={allTags}
                  profiles={profiles}
                  onTagsUpdated={onTagsUpdated}
                  onCatalogChange={onCatalogChange}
                  onUnauthorized={onUnauthorized}
                />
              </div>
            )}
          </div>
        </m.div>
      </div>
    </AnimatePresence>
  );
}

// ----------------------------------------------------
// TAB 3: LAYOUT DA PÁGINA
// ----------------------------------------------------
const LAYOUTS: { key: IntelLayout; label: string; description: string }[] = [
  { key: "sidebar", label: "Barra lateral", description: "Seções, tags e “Adicionar perfil” numa coluna à esquerda, sempre à vista." },
  { key: "tabs", label: "Abas no topo", description: "Seções em abas no topo da página; cada seção traz suas ferramentas." },
];

/** A small drawing of each layout: header, analysis panel, then the sections. */
function LayoutSketch({ layout }: { layout: IntelLayout }) {
  const bar = "rounded-[3px] bg-muted-foreground/25";
  return (
    <div aria-hidden className="flex h-24 w-full flex-col gap-1.5 overflow-hidden rounded-lg border bg-background/60 p-2">
      <div className={cn(bar, "h-2 w-full")} />
      {layout === "sidebar" ? (
        <div className="flex min-h-0 flex-1 gap-1.5">
          <div className="flex w-1/4 flex-col gap-1 border-r border-border/60 pr-1.5">
            <div className="h-2 rounded-[3px] bg-sky/60" />
            <div className={cn(bar, "h-1.5")} />
            <div className={cn(bar, "h-1.5")} />
            <div className={cn(bar, "h-1.5")} />
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-3.5 rounded-[3px] border border-border/70" />
            <div className="grid flex-1 grid-cols-3 gap-1">
              <div className={bar} />
              <div className={bar} />
              <div className={bar} />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          <div className="h-3.5 rounded-[3px] border border-border/70" />
          <div className="flex gap-2 border-b border-border/60 pb-1">
            <div className="h-1.5 w-6 rounded-[3px] bg-sky/60" />
            <div className={cn(bar, "h-1.5 w-6")} />
            <div className={cn(bar, "h-1.5 w-6")} />
          </div>
          <div className="grid flex-1 grid-cols-4 gap-1">
            <div className={bar} />
            <div className={bar} />
            <div className={bar} />
            <div className={bar} />
          </div>
        </div>
      )}
    </div>
  );
}

function LayoutSettingsSection({ layout, onLayoutChange }: { layout: IntelLayout; onLayoutChange: (layout: IntelLayout) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Layout da página</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">As mesmas seções (Top, Perfis e Leituras), em dois arranjos. Vale para este navegador.</p>
      </div>
      <div role="radiogroup" aria-label="Layout da página" className="grid grid-cols-2 gap-3">
        {LAYOUTS.map((option) => {
          const active = layout === option.key;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onLayoutChange(option.key)}
              className={cn(
                "flex cursor-pointer flex-col gap-2.5 rounded-xl border p-3 text-left transition-colors",
                active ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border/70 hover:bg-secondary/40"
              )}
            >
              <LayoutSketch layout={option.key} />
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                {active && <Check size={14} className="text-primary" />}
                {option.label}
              </span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------
// TAB 1: CAMPOS DO CARD
// ----------------------------------------------------
function FieldsSettingsSection({
  fields,
  onFieldsChange,
}: {
  fields: SpyCardFields;
  onFieldsChange: (fields: SpyCardFields) => void;
}) {
  const toggle = (key: keyof SpyCardFields, checked: boolean) => {
    onFieldsChange({
      ...fields,
      [key]: checked,
    });
  };

  const handleResetDefaults = () => {
    onFieldsChange({ ...DEFAULT_SPY_CARD_FIELDS });
  };

  const groups = ["Métricas", "Informações", "Status"] as const;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Campos visíveis no card</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Defina o que você quer ver rapidamente em cada card de perfil sem precisar abrir o painel lateral.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleResetDefaults}
          className="gap-1.5 text-xs h-8 cursor-pointer"
        >
          <RotateCcw size={12} />
          Restaurar padrão
        </Button>
      </div>

      <div className="space-y-5">
        {groups.map((group) => {
          const groupFields = SPY_CARD_FIELD_DEFS.filter((f) => f.group === group);
          return (
            <div key={group} className="space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group}
              </span>
              <div className="divide-y divide-border/50 rounded-xl border border-border/70 bg-card overflow-hidden">
                {groupFields.map((field) => (
                  <label
                    key={field.key}
                    className="flex cursor-pointer items-center justify-between gap-4 p-3 transition-colors hover:bg-secondary/40 select-none"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-foreground">
                        {field.label}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {field.description}
                      </div>
                    </div>
                    <Switch
                      checked={!!fields[field.key]}
                      onCheckedChange={(checked) => toggle(field.key, checked)}
                      aria-label={`Mostrar ${field.label}`}
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------
// TAB 2: GERENCIAMENTO DE TAGS (ESTILO GESTAO / COPY-HUB)
// ----------------------------------------------------
function TagsSettingsSection({
  allTags,
  profiles,
  onTagsUpdated,
  onCatalogChange,
  onUnauthorized,
}: {
  allTags: TagMeta[];
  profiles: SpyCard[];
  onTagsUpdated: (tags: TagMeta[]) => void;
  onCatalogChange: (from: string, to?: string) => void;
  onUnauthorized: () => void;
}) {
  const [newTagInput, setNewTagInput] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [activeColorPicker, setActiveColorPicker] = useState<string | null>(null);
  const [colorPickerUp, setColorPickerUp] = useState(false);
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<string | null>(null);

  const usageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tag of allTags) {
      const lower = tag.name.toLowerCase();
      counts[lower] = profiles.filter((p) =>
        p.tags.some((t) => t.toLowerCase() === lower)
      ).length;
    }
    return counts;
  }, [allTags, profiles]);

  const handleAddTag = async (e: FormEvent) => {
    e.preventDefault();
    const raw = newTagInput.trim();
    if (!raw || busyRef.current) return;

    // Support comma-separated tags
    const names = raw
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!names.length) return;

    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      const spent = allTags.map((t) => t.color);
      const toAdd = names.map((name, i) => ({
        name,
        color: NORD_TAG_COLORS[(spent.length + i) % NORD_TAG_COLORS.length],
      }));

      const res = await api.spy.tags.add(toAdd);
      onTagsUpdated(res.tags);
      setNewTagInput("");
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setError("Não consegui salvar a alteração das tags. Tente novamente.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleRecolor = async (name: string, nextColor: string) => {
    setActiveColorPicker(null);
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.spy.tags.recolor(name, nextColor);
      onTagsUpdated(allTags.map((t) => t.name.toLowerCase() === name.toLowerCase() ? { ...t, color: nextColor } : t));
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setError("Não consegui alterar a cor. Tente novamente.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleStartRename = (tag: TagMeta) => {
    setEditingTagName(tag.name);
    setRenameInput(tag.name);
    setConfirmDeleteTag(null);
  };

  const handleSaveRename = async (originalName: string) => {
    const trimmed = renameInput.trim();
    if (!trimmed || trimmed === originalName) {
      setEditingTagName(null);
      return;
    }

    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      const renamed = await api.spy.tags.rename(originalName, trimmed);
      onCatalogChange(originalName, renamed.name);
      const remaining = allTags.filter((tag) => tag.name.toLowerCase() !== originalName.toLowerCase() && tag.name.toLowerCase() !== renamed.name.toLowerCase());
      onTagsUpdated([...remaining, { name: renamed.name, color: renamed.color }]);
      setEditingTagName(null);
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setError("Não consegui salvar a alteração das tags. Tente novamente.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      await api.spy.tags.remove(name);
      onCatalogChange(name);
      onTagsUpdated(allTags.filter((tag) => tag.name.toLowerCase() !== name.toLowerCase()));
      setConfirmDeleteTag(null);
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else if (err instanceof ApiError && err.status === 409) setError("Esta tag está na regra dos relatórios. Tire-a de lá antes de excluir.");
      else setError("Não consegui salvar a alteração das tags. Tente novamente.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Tags dos perfis</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Todas as tags cadastradas no Hub. Ao renomear ou trocar a cor, todos os perfis atualizam imediatamente.
        </p>
      </div>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {/* Add tag form */}
      <form onSubmit={handleAddTag} className="flex gap-2">
        <Input
          value={newTagInput}
          onChange={(e) => setNewTagInput(e.target.value)}
          placeholder="Nova tag — separe por vírgula para criar várias"
          className="text-xs h-9"
          disabled={busy}
        />
        <Button
          type="submit"
          disabled={busy || !newTagInput.trim()}
          size="sm"
          className="gap-1.5 text-xs h-9 shrink-0 cursor-pointer"
        >
          <Plus size={14} />
          <span>Criar tag</span>
        </Button>
      </form>

      <fieldset disabled={busy} className="min-w-0">
      {/* Tag list */}
      {allTags.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-xs text-muted-foreground">
          Nenhuma tag cadastrada ainda. Crie uma acima ou direto pelo card de perfil.
        </div>
      ) : (
        <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
          {allTags.map((tag) => {
            const count = usageCounts[tag.name.toLowerCase()] ?? 0;
            const isEditing = editingTagName?.toLowerCase() === tag.name.toLowerCase();
            const isConfirmingDelete = confirmDeleteTag?.toLowerCase() === tag.name.toLowerCase();

            return (
              <div
                key={tag.name}
                className="flex items-center justify-between gap-3 p-3 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-secondary/30"
              >
                {/* Left: Color chip + Name / Rename input */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {/* Color picker popover trigger */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        // Near the bottom of the scrolling body the swatches open upward, or the dialog edge cuts them.
                        const scroller = e.currentTarget.closest(".overflow-y-auto");
                        setColorPickerUp(
                          !!scroller &&
                            scroller.getBoundingClientRect().bottom - e.currentTarget.getBoundingClientRect().bottom < 56
                        );
                        setActiveColorPicker(
                          activeColorPicker === tag.name ? null : tag.name
                        );
                      }}
                      className="size-5 rounded-full shrink-0 border border-black/20 shadow-xs transition-transform hover:scale-110 cursor-pointer"
                      style={{ backgroundColor: tag.color }}
                      title="Trocar cor"
                    />

                    {activeColorPicker === tag.name && (
                      <div
                        className={cn(
                          "absolute left-0 z-50 flex gap-1 rounded-xl border border-border/80 bg-popover p-2 shadow-xl backdrop-blur-md",
                          colorPickerUp ? "bottom-full mb-1.5" : "top-full mt-1.5"
                        )}
                      >
                        {NORD_TAG_COLORS.map((c) => (
                          <button
                            key={c}
                            disabled={busy}
                            aria-label={`Cor ${c}`}
                            type="button"
                            onClick={() => handleRecolor(tag.name, c)}
                            className={cn(
                              "size-5 rounded-full transition-transform hover:scale-125 cursor-pointer relative",
                              tag.color === c && "ring-2 ring-primary ring-offset-1"
                            )}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {isEditing ? (
                    <div className="flex items-center gap-1.5 flex-1 max-w-sm">
                      <Input
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        autoFocus
                        className="text-xs h-7"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleSaveRename(tag.name);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setEditingTagName(null);
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        onClick={() => handleSaveRename(tag.name)}
                        className="h-7 px-2 text-xs"
                      >
                        <Check size={12} />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingTagName(null)}
                        className="h-7 px-2 text-xs"
                      >
                        <X size={12} />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 min-w-0">
                      <OptionChip value={tag.name} color={tag.color} />
                      <button
                        type="button"
                        onClick={() => handleStartRename(tag)}
                        className="p-1 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer rounded"
                        title="Renomear tag"
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Right: Usage count + Delete action */}
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] text-muted-foreground/80 tabular-nums">
                    {count === 1 ? "1 perfil" : `${count} perfis`}
                  </span>

                  {isConfirmingDelete ? (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(tag.name)}
                        disabled={busy}
                        className="h-6 px-2 text-[11px]"
                      >
                        Confirmar
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDeleteTag(null)}
                        className="h-6 px-1.5 text-[11px]"
                      >
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteTag(tag.name)}
                      className="p-1 text-muted-foreground/50 transition-colors hover:text-destructive cursor-pointer rounded"
                      title="Excluir tag"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </fieldset>
    </div>
  );
}
