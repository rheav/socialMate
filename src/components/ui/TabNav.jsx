import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Icon tab bar with a single accent-gradient underline that FLOWS between tabs:
// the underline's left/width transition (liquid slide) rather than the active
// tab snapping its own border. The label expands on active/hover.
export default function TabNav({ value, onValueChange, tabs }) {
  const trackRef = useRef(null);
  const btnRefs = useRef({});
  const [bar, setBar] = useState({ left: 0, width: 0 });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const btn = btnRefs.current[value];
    if (!track || !btn) return;
    const move = () => {
      const t = track.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      setBar({ left: b.left - t.left, width: b.width });
    };
    move();
    const id = requestAnimationFrame(() => setReady(true));
    // ResizeObserver, not window resize: the label of the active tab expands and
    // collapses (max-w transition below), and sibling layout can change without
    // the window ever changing size — `resize` never fires for those, which
    // would leave the underline pointing at the tab's old width.
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(move);
      ro.observe(trackRef.current);
      if (btn) ro.observe(btn);
    }
    return () => {
      cancelAnimationFrame(id);
      ro?.disconnect();
    };
  }, [value, tabs]);

  return (
    <div ref={trackRef} className="relative flex w-full min-w-0 items-stretch gap-0.5 border-b border-border">
      <div
        className={cn(
          "pointer-events-none absolute -bottom-px h-0.5 rounded-full bg-sky",
          ready && "transition-[left,width] duration-300 ease-[var(--sw-ease)]"
        )}
        style={{ left: bar.left, width: bar.width }}
      />
      {tabs.map(({ id, label, Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            ref={(el) => (btnRefs.current[id] = el)}
            type="button"
            onClick={() => onValueChange(id)}
            title={label}
            // the label is hidden unless active/hovered, so the accessible name
            // has to come from here, not from the (often collapsed) text.
            aria-label={label}
            aria-pressed={active}
            className={cn(
              "group relative flex min-w-0 shrink-0 cursor-pointer items-center justify-center rounded-t-lg px-2.5 py-2.5 text-[11px] transition-colors duration-200 ease-[var(--sw-ease)]",
              active ? "text-fg [&_svg]:text-sky" : "text-fg/45 hover:text-fg/85"
            )}
          >
            <Icon size={15} className="shrink-0" />
            <span
              className={cn(
                "overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ease-[var(--sw-ease)]",
                active
                  ? "max-w-[72px] opacity-100 ml-1.5"
                  : "max-w-0 opacity-0 group-hover:max-w-[72px] group-hover:opacity-100 group-hover:ml-1.5"
              )}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
