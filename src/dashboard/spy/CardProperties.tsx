import { Eye, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/dashboard/ui/button";
import { Separator } from "@/dashboard/ui/separator";
import { Switch } from "@/dashboard/ui/switch";
import {
  SPY_CARD_FIELD_DEFS,
  type SpyCardFields,
} from "./spySettings";

interface CardPropertiesProps {
  fields: SpyCardFields;
  onChange: (fields: SpyCardFields) => void;
  onOpenSettings?: () => void;
}

export function CardProperties({
  fields,
  onChange,
  onOpenSettings,
}: CardPropertiesProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close when clicked outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const activeCount = Object.values(fields).filter(Boolean).length;

  const toggle = (key: keyof SpyCardFields, checked: boolean) => {
    onChange({
      ...fields,
      [key]: checked,
    });
  };

  return (
    <div className="relative inline-block text-left" ref={popoverRef}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        className="gap-1.5 h-8 text-xs font-medium cursor-pointer"
        aria-label={`Propriedades ${activeCount} ativas no card`}
      >
        <Eye size={13} className="shrink-0 text-muted-foreground" />
        <span>Propriedades</span>
        <span className="text-muted-foreground/80 tabular-nums">{activeCount}</span>
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-40 w-72 rounded-xl border border-border/70 bg-card p-0 shadow-xl backdrop-blur-md animate-in fade-in-0 zoom-in-95">
          <div className="px-3.5 py-2.5">
            <p className="text-xs font-semibold text-foreground">Mostrar no card</p>
            <p className="text-[11px] text-muted-foreground">
              O que aparece na face do card, sem precisar abri-lo.
            </p>
          </div>
          <Separator />

          <div className="max-h-80 overflow-y-auto p-1.5 space-y-0.5">
            {SPY_CARD_FIELD_DEFS.map((field) => (
              <label
                key={field.key}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-secondary/70 select-none"
              >
                <div className="min-w-0 flex-1">
                  <span className="truncate block font-medium">{field.label}</span>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground/70 mr-1.5">
                  {field.group}
                </span>
                <Switch
                  checked={!!fields[field.key]}
                  onCheckedChange={(checked) => toggle(field.key, checked)}
                  aria-label={`Mostrar ${field.label} no card`}
                />
              </label>
            ))}
          </div>

          {onOpenSettings && (
            <>
              <Separator />
              <div className="p-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer text-left"
                >
                  <SlidersHorizontal size={13} />
                  <span>Configurações do Spy…</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
