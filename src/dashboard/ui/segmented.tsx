import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/dashboard/lib/utils";

export interface SegmentedOption<T extends string> {
  key: T;
  label: string;
  badge?: number;
  disabled?: boolean;
}

/**
 * Segmented control with ONE thumb that flows between options, the way the side
 * panel's does: the thumb is an absolutely positioned element whose `left` and
 * `width` are measured from the active button and transitioned in CSS. It is
 * deliberately not a layout animation — a measured thumb moves the same on every
 * machine, cannot be skipped when the tab is occluded, and is the exact
 * behaviour of the control this dashboard is the twin of.
 *
 * The thumb is a wash of the accent (15%) with a 30% ring, not a solid block:
 * at this width a solid accent reads as a filled button rather than as a
 * selection. The label stays in plain foreground — accent AS text does not clear
 * contrast over its own wash.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (key: T) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [thumb, setThumb] = useState({ left: 0, width: 0 });
  // The slide is enabled one frame after the first placement, so the thumb does
  // not fly in from the left edge on mount.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const btn = btnRefs.current[value];
    if (!track || !btn) return;

    const measure = () => {
      const t = track.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      setThumb({ left: b.left - t.left, width: b.width });
    };
    measure();
    const raf = requestAnimationFrame(() => setReady(true));

    // A ResizeObserver on the track, not a window listener: the row rewraps when
    // the search box grows or a count changes width, and `resize` never fires
    // for either — the thumb would silently sit under the wrong tab.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(track);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [value, options]);

  return (
    <div
      ref={trackRef}
      role="tablist"
      className="relative flex min-w-0 items-center gap-1 rounded-lg border bg-card p-1"
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1 bottom-1 rounded-md bg-primary/15 ring-1 ring-primary/35 ring-inset",
          ready && "transition-[left,width] duration-300 ease-[var(--sw-ease)]",
        )}
        style={{ left: thumb.left, width: thumb.width }}
      />
      {options.map((option) => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            ref={(el) => {
              btnRefs.current[option.key] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={option.disabled}
            onClick={() => onChange(option.key)}
            title={option.disabled ? `Nenhum registro de ${option.label} aqui` : undefined}
            className={cn(
              // min-w-0 matters: without it a long label pushes the control wider
              // than its container instead of truncating inside it.
              "relative z-10 flex min-w-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors duration-200 ease-[var(--sw-ease)]",
              // A tab that leads to an empty screen is a hole to fall into, and
              // the count beside it already says so. Not hidden — knowing the
              // platform exists and has nothing is information too.
              option.disabled
                ? "cursor-not-allowed text-muted-foreground/40"
                : cn(
                    "cursor-pointer",
                    active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  ),
            )}
          >
            <span className="truncate">{option.label}</span>
            {option.badge != null && (
              <span className={cn("text-[11px]", active ? "text-primary" : "text-muted-foreground")}>
                {option.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
