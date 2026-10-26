import { cn } from "@/dashboard/lib/utils";
import type { DailyDay } from "./spyFormat";

const dayLabel = (d: Date) => d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });

/** One bar per day, oldest on the left. A day before the record starts is a
 *  dashed stub, never a zero; today and a day the record starts in are faded. */
export function DailyBars({ days, label, className, format = String }: {
  days: DailyDay[];
  label: string;
  className?: string;
  /** How a day's number reads in its tooltip. */
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...days.map((d) => d.count ?? 0));
  return (
    <div className={cn("flex items-end gap-[3px]", className)} role="img"
      aria-label={`${label} por dia nos últimos ${days.length} dias`}>
      {[...days].reverse().map((d) => (
        <div
          key={d.key}
          title={`${dayLabel(d.start)}: ${d.count == null ? "sem dados" : `${format(d.count)} ${label}`}${d.partial && d.count != null ? " (parcial)" : ""}`}
          className="flex h-full min-w-0 flex-1 items-end"
        >
          {d.count == null ? (
            <div className="h-px w-full border-t border-dashed border-muted-foreground/40" />
          ) : (
            <div
              className={cn("w-full rounded-[2px]", d.count ? "bg-primary" : "bg-muted-foreground/25", d.partial && "opacity-55")}
              style={{ height: d.count ? `${Math.max(12, (d.count / max) * 100)}%` : "2px" }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
