import { Check, Palette, Plus, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { NORD_TAG_COLORS, pickTagColor, pickTagColors } from "../../hub-local/shared/tag-colors.js";
import { OptionChip } from "./OptionChip";
import { cn } from "@/dashboard/lib/utils";

export interface TagMeta {
  name: string;
  color: string;
  count?: number;
}

interface TagPickerProps {
  selected: string[];
  allTags: TagMeta[];
  onChange: (tags: string[]) => void;
  onCreateTag?: (tag: { name: string; color: string }) => void | Promise<void>;
  onRecolorTag?: (name: string, nextColor: string) => void;
  className?: string;
  disabled?: boolean;
}

export function TagPicker({
  selected,
  allTags,
  onChange,
  onCreateTag,
  onRecolorTag,
  className,
  disabled = false,
}: TagPickerProps) {
  const [creating, setCreating] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: globalThis.MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    } else {
      setQuery("");
    }
  }, [open]);

  const spentColors = useMemo(() => allTags.map((t) => t.color), [allTags]);
  const nextColor = useMemo(() => pickTagColor(spentColors), [spentColors]);

  const knownNames = useMemo(
    () => [
      ...allTags.map((t) => t.name),
      ...selected.filter((s) => !allTags.some((t) => t.name.toLowerCase() === s.toLowerCase())),
    ],
    [allTags, selected]
  );

  const fresh = query.trim();
  const existingMatch = fresh
    ? knownNames.find((name) => name.toLowerCase() === fresh.toLowerCase())
    : null;

  const filteredTags = useMemo(() => {
    if (!fresh) return allTags;
    return allTags.filter((t) =>
      t.name.toLowerCase().includes(fresh.toLowerCase())
    );
  }, [allTags, fresh]);

  const toggle = (tagName: string) => {
    const isSelected = selected.some(
      (t) => t.toLowerCase() === tagName.toLowerCase()
    );
    if (isSelected) {
      onChange(selected.filter((t) => t.toLowerCase() !== tagName.toLowerCase()));
    } else {
      onChange([...selected, tagName]);
    }
  };

  const create = async (text: string) => {
    if (disabled || creating) return;
    const parts = text
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p.length <= 100);

    if (parts.length === 0) return;

    const toCreate: string[] = [];
    const toSelect: string[] = [];

    for (const part of parts) {
      const match = knownNames.find(
        (k) => k.toLowerCase() === part.toLowerCase()
      );
      if (match) {
        toSelect.push(match);
      } else {
        toCreate.push(part);
        toSelect.push(part);
      }
    }

    setCreating(true);
    try {
    if (toCreate.length > 0) {
      const colors = pickTagColors(toCreate.length, spentColors);
      for (const [idx, name] of toCreate.entries()) {
        await onCreateTag?.({ name, color: colors[idx] ?? nextColor });
      }
    }

    const nextSelected = [
      ...selected,
      ...toSelect.filter(
        (name) => !selected.some((s) => s.toLowerCase() === name.toLowerCase())
      ),
    ];
    onChange(nextSelected);
    setQuery("");
    } catch { /* parent reports the mutation failure */ }
    finally { setCreating(false); }
  };

  const handleRecolor = (e: MouseEvent, tagName: string, currentColor: string) => {
    e.stopPropagation();
    const curr = currentColor.toLowerCase();
    const idx = (NORD_TAG_COLORS as readonly string[]).indexOf(curr);
    const next = NORD_TAG_COLORS[(idx + 1) % NORD_TAG_COLORS.length]!;
    onRecolorTag?.(tagName, next);
  };

  return (
    <div className={cn("relative inline-block", className)} ref={popoverRef}>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled || creating}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-5 items-center gap-1 rounded-full border border-dashed border-border/80 bg-background/50 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-secondary/60 hover:text-foreground cursor-pointer select-none"
        title="Gerenciar tags"
      >
        <Plus size={11} className="opacity-70" />
        <span>Tag</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-64 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl">
          <div className="px-1.5 pt-1 pb-1.5">
            <input
              ref={inputRef}
              disabled={disabled || creating}
              aria-label="Buscar ou criar tag"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && fresh && !existingMatch) {
                  e.preventDefault();
                  void create(fresh);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  triggerRef.current?.focus();
                }
              }}
              placeholder="Buscar ou criar…"
              className="w-full rounded-md border border-input/60 bg-muted/40 px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/60 focus:bg-background"
            />
          </div>

          <div className="max-h-48 overflow-y-auto px-1 py-0.5 space-y-0.5">
            {filteredTags.map((tag) => {
              const isSelected = selected.some(
                (s) => s.toLowerCase() === tag.name.toLowerCase()
              );
              return (
                <div
                  key={tag.name}
                  className={cn(
                    "flex items-center justify-between gap-1.5 rounded-lg px-2 py-1 text-xs cursor-pointer select-none transition-colors",
                    isSelected
                      ? "bg-secondary text-secondary-foreground"
                      : "hover:bg-muted text-foreground"
                  )}
                >
                  <button type="button" disabled={disabled || creating} aria-pressed={isSelected} onClick={() => toggle(tag.name)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                    <span
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded-sm border transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border/80"
                      )}
                    >
                      {isSelected && <Check size={10} strokeWidth={3} />}
                    </span>
                    <OptionChip
                      value={tag.name}
                      color={tag.color}
                      className="max-w-[130px]"
                    />
                  </button>

                  <button
                    type="button"
                    disabled={disabled || creating}
                    onClick={(e) => handleRecolor(e, tag.name, tag.color)}
                    className="p-1 rounded-md text-muted-foreground hover:bg-background hover:text-foreground opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
                    title="Trocar cor da tag"
                  >
                    <Palette size={12} />
                  </button>
                </div>
              );
            })}

            {fresh && !existingMatch && (
              <button type="button" disabled={disabled || creating}
                onClick={() => void create(fresh)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted text-foreground cursor-pointer transition-colors"
              >
                <Plus size={13} className="opacity-60" />
                <span className="min-w-0 flex-1 truncate">
                  Criar “<strong>{fresh}</strong>”
                </span>
                <span
                  className="size-3 shrink-0 rounded-full border border-background/50 shadow-xs"
                  style={{ backgroundColor: nextColor }}
                />
              </button>
            )}

            {filteredTags.length === 0 && !fresh && (
              <div className="py-4 text-center text-xs text-muted-foreground">
                Nenhuma tag ainda. Digite acima para criar.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
