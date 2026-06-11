import { useRef } from "react";
import { cn } from "@/lib/utils";

// macOS-dock-style bottom nav: a floating tinted bar whose icon tiles magnify and
// lift toward the cursor (distance-based scale, no framer-motion needed). The
// active tile is filled with the platform's blue→cyan gradient (--sw-grad).
export default function BottomNav({ value, onChange, items, pulse }) {
  const iconRefs = useRef([]);

  const onMove = (e) => {
    const FALLOFF = 96; // px from a tile's center where magnification fades out
    iconRefs.current.forEach((el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dist = Math.abs(e.clientX - (r.left + r.width / 2));
      const t = Math.max(0, 1 - dist / FALLOFF); // 1 at cursor → 0 past falloff
      el.style.transform = `translateY(${-t * 11}px) scale(${1 + t * 0.55})`;
    });
  };
  const reset = () => iconRefs.current.forEach((el) => el && (el.style.transform = ""));

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 pb-2.5 pt-1">
      <nav
        onMouseMove={onMove}
        onMouseLeave={reset}
        style={{ backdropFilter: "blur(22px) saturate(180%)", WebkitBackdropFilter: "blur(22px) saturate(180%)" }}
        className="bottom-dock pointer-events-auto flex w-full items-end justify-around rounded-2xl border border-white/50 px-2 pb-1.5 pt-2.5"
      >
        {items.map(({ id, label, Icon }, i) => {
          const active = value === id;
          return (
            <button key={id} type="button" onClick={() => onChange(id)} className="group flex flex-col items-center px-2">
              <span
                ref={(el) => (iconRefs.current[i] = el)}
                className={cn(
                  "dock-icon relative flex h-10 w-10 items-center justify-center rounded-xl will-change-transform",
                  active && "dock-active text-white shadow-md"
                )}
                style={active ? { backgroundImage: "var(--sw-grad)" } : undefined}
              >
                <Icon size={18} strokeWidth={active ? 2.4 : 1.9} className={active ? "" : "text-muted-foreground group-hover:text-[color:var(--sw-from)]"} />
                {pulse === id && !active && (
                  <span className="ember-pulse absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full" style={{ background: "hsl(var(--sw-ember))" }} />
                )}
              </span>
              <span
                className={cn("mt-1 text-[10px] font-semibold transition-colors", !active && "text-foreground/80 group-hover:text-foreground")}
                style={{ textShadow: "0 1px 2px rgba(255,255,255,0.75)", ...(active ? { color: "var(--sw-from)" } : {}) }}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
