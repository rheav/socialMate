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
    window.addEventListener("resize", move);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", move);
    };
  }, [value, tabs]);

  return (
    <div ref={trackRef} className="relative flex w-full items-stretch gap-0.5 border-b border-border">
      <div
        className={cn(
          "pointer-events-none absolute -bottom-px h-0.5 rounded-full",
          ready && "transition-[left,width] duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)]"
        )}
        style={{ left: bar.left, width: bar.width, backgroundImage: "var(--sw-grad)" }}
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
            className={cn(
              "group relative flex cursor-pointer items-center justify-center rounded-t-lg px-2.5 py-2.5 text-[11px] transition-colors duration-200",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon size={15} className="shrink-0" />
            <span
              className={cn(
                "overflow-hidden whitespace-nowrap transition-all duration-200 ease-out",
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
