import { LayoutGrid, Grid3x3 } from "lucide-react";
import { cn } from "@/dashboard/lib/utils";

/**
 * How tightly a card grid packs. The grid itself is `.card-grid` (styles.css):
 * as many columns as fit at the card's minimum width, so a bigger screen gets
 * more columns on its own. Density only moves that minimum, which is why it is
 * a choice that still works on any screen, unlike a fixed column count.
 */
export type GridDensity = "comfortable" | "compact";

export function loadGridDensity(key: string): GridDensity {
  try {
    return localStorage.getItem(key) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function saveGridDensity(key: string, density: GridDensity): void {
  try {
    localStorage.setItem(key, density);
  } catch {
    /* private window or blocked storage: the choice lasts for this visit */
  }
}

const OPTIONS = [
  { key: "comfortable", label: "Confortável", Icon: LayoutGrid },
  { key: "compact", label: "Compacto", Icon: Grid3x3 },
] as const;

/** Hidden on a phone: the grid is one or two columns there whatever the choice. */
export function GridDensityToggle({ value, onChange }: { value: GridDensity; onChange: (density: GridDensity) => void }) {
  return (
    <div role="group" aria-label="Densidade da grade" className="hidden h-8 shrink-0 items-center gap-0.5 rounded-md border border-input bg-background p-0.5 sm:flex">
      {OPTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          aria-label={label}
          title={key === "compact" ? "Compacto: cards menores, mais por linha" : "Confortável: cards maiores"}
          onClick={() => onChange(key)}
          className={cn(
            "inline-flex h-full w-7 cursor-pointer items-center justify-center rounded transition-colors",
            value === key ? "bg-primary/15 text-foreground ring-1 ring-inset ring-primary/35" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
