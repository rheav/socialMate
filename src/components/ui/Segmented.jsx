import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { TipCarrier } from "@/components/ui/ToolBar";
import { cn } from "@/lib/utils";

// Per-button metrics, mirrored from the classes below. Used to compute how wide
// the track WOULD have to be to show every label, without ever laying that out.
const PAD_X = 16; // px-2 → 8px each side
const ICON = 13; // <Icon size={13} />
const ICON_GAP = 6; // gap-1.5 between icon and label
const BTN_GAP = 4; // gap-1 between buttons
const TRACK_PAD = 8; // p-1 on the track

// Segmented control with a single accent-gradient thumb that FLOWS between
// options — the thumb's left/width transition (liquid slide) instead of snapping.
// The gradient is the themed accent (Smart blue in light, Brute red→yellow in
// dark), so switching tabs reads as one continuous motion of the brand color.
//
// Narrow panels: TikTok has FIVE tools, and pt-BR labels ("Comentários",
// "Playlists") are long. Rather than clip the last tab, the control measures
// whether the labels fit and degrades to ICONS ONLY when they don't.
//
// In that icon-only state each button gets the shared CSS bubble (TipCarrier +
// `.sw-tips` on the track — the one implementation, see index.css); when the
// labels are showing it gets nothing, because a tooltip repeating a visible
// label is noise. That is also why the native `title` is gone: it could not be
// conditioned on the collapsed state and fired at every width. `aria-label` is
// on every button at every width, so the announced name never changed.
//
// Segmented is the one host that can gate the carrier in JS honestly: unlike
// ToolBar — where the collapse is a container query React cannot see — `compact`
// IS the collapsed state, measured right here. No second source of truth.
export default function Segmented({ value, onChange, items }) {
  const trackRef = useRef(null);
  const btnRefs = useRef({});
  const labelRefs = useRef({});
  const [thumb, setThumb] = useState({ left: 0, width: 0 });
  const [ready, setReady] = useState(false);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const measure = () => {
      // ---- 1. do the labels still fit? ----
      // Labels collapse with max-w-0, NOT display:none, precisely so this
      // measurement is independent of the mode we're currently in: a collapsed
      // span still reports its full text width via scrollWidth. `needed` is
      // therefore constant, and the control cannot oscillate between the two
      // layouts (which display:none would guarantee: hide → needed shrinks →
      // show → needed grows → hide…).
      let needed = TRACK_PAD;
      items.forEach(({ id }, i) => {
        const el = labelRefs.current[id];
        needed += PAD_X + ICON + ICON_GAP + (el ? el.scrollWidth : 0) + (i ? BTN_GAP : 0);
      });
      setCompact(needed > track.clientWidth);

      // ---- 2. place the thumb ----
      const btn = btnRefs.current[value];
      if (btn) {
        const t = track.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        setThumb({ left: b.left - t.left, width: b.width });
      }
    };

    measure();
    // enable the slide transition only after the first placement (no mount flash)
    const raf = requestAnimationFrame(() => setReady(true));

    // A ResizeObserver on the TRACK, not a window resize listener: the panel's
    // layout can change without the window changing size at all (a container
    // query flipping labels on/off elsewhere, a tool swapping in, a scrollbar
    // appearing), and `resize` never fires for any of those — the thumb would
    // silently desync. `compact` is in the dependency list for the mirror-image
    // reason: toggling it changes every button's width while the TRACK's width
    // stays identical, so the observer alone would not fire either.
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(track);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [value, items, compact]);

  return (
    // `sw-tips` marks the track as a tooltip host and `relative` (already here
    // for the thumb) makes it the carriers' containing block, so a bubble is
    // clamped to `max-width: 100%` OF THE TRACK — it cannot cross the panel edge
    // however many tools a platform grows. The carriers are absolutely
    // positioned, so they add no flex item and no `gap`: every button keeps the
    // exact geometry the thumb measures.
    <div ref={trackRef} className="sw-tips relative flex min-w-0 items-center gap-1 rounded-lg bg-muted p-1">
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
          <Fragment key={id}>
            <button
              ref={(el) => (btnRefs.current[id] = el)}
              type="button"
              onClick={() => onChange(id)}
              aria-label={label}
              aria-pressed={active}
              className={cn(
                // min-w-0 is load-bearing: flex items default to min-width:auto, so
                // without it the buttons refuse to shrink below their label, `truncate`
                // never engages and 5 tools overflow the track (clipped last tab).
                "relative z-10 flex min-w-0 flex-1 items-center justify-center rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors duration-200",
                // the icon↔label gap has to go with the label, or a collapsed
                // (0-width) span would still cost 6px per button.
                compact ? "gap-0" : "gap-1.5",
                active
                  ? "text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon size={13} strokeWidth={active ? 2.25 : 1.75} className="shrink-0" />
              <span
                ref={(el) => (labelRefs.current[id] = el)}
                className={cn(
                  "truncate transition-[max-width,opacity] duration-200 ease-out",
                  compact ? "max-w-0 opacity-0" : "max-w-full opacity-100"
                )}
              >
                {label}
              </span>
            </button>
            {/* Only while the label is collapsed — `compact` IS that state, so
                the bubble and the label can never both be on. The carrier must
                be a SIBLING of the button, not a child: the button is
                `relative`, so a child would anchor to the button instead of the
                track and lose the track-width clamp that keeps the bubble inside
                the panel. */}
            {compact ? <TipCarrier text={label} /> : null}
          </Fragment>
        );
      })}
    </div>
  );
}
