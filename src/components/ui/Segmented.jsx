import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Segmented control with a single accent-gradient thumb that FLOWS between
// options — the thumb's left/width transition (liquid slide) instead of snapping.
// The gradient is the themed accent (Smart blue in light, Brute red→yellow in
// dark), so switching tabs reads as one continuous motion of the brand color.
export default function Segmented({ value, onChange, items }) {
  const trackRef = useRef(null);
  const btnRefs = useRef({});
  const [thumb, setThumb] = useState({ left: 0, width: 0 });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const btn = btnRefs.current[value];
    if (!track || !btn) return;
    const move = () => {
      const t = track.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      setThumb({ left: b.left - t.left, width: b.width });
    };
    move();
    // enable the slide transition only after the first placement (no mount flash)
    const id = requestAnimationFrame(() => setReady(true));
    window.addEventListener("resize", move);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", move);
    };
  }, [value, items]);

  return (
    <div ref={trackRef} className="relative flex items-center gap-1 rounded-lg bg-muted p-1">
      <div
        className={cn(
          "pointer-events-none absolute top-1 bottom-1 rounded-md shadow-sm",
          ready && "transition-[left,width] duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)]"
        )}
        style={{ left: thumb.left, width: thumb.width, backgroundImage: "var(--sw-grad)" }}
      />
      {items.map(({ id, label, Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            ref={(el) => (btnRefs.current[id] = el)}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              "relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors duration-200",
              active
                ? "text-primary-foreground"
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
