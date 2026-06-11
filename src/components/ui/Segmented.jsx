import { cn } from "@/lib/utils";

// Lightweight segmented control (pills) — replaces the heavy bordered tab row for
// the per-platform mode (Reels / Feed / Keyword). Inset track, single raised thumb.
export default function Segmented({ value, onChange, items }) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
      {items.map(({ id, label, Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all",
              active
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon size={13} strokeWidth={active ? 2.25 : 1.75} />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
