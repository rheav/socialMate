import { useEffect, useRef, useState } from "react";

// The panel's touches that need a line of script (the rest is effects.css).
// Budget: memory `ui-lightness-ram` — no per-card handlers, no state per frame,
// nothing that keeps running on an idle screen.

/** Whether the viewer asked for less motion; read once, cheap. */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A number that counts up to its value the first time it appears (about a
 * second of requestAnimationFrame, then nothing). A later change of `value`
 * shows at once: the count is for the arrival, not for every refresh. Under
 * reduced motion, or without a value, it is just the value.
 */
export function useCountUp(value: number | null | undefined, durationMs = 1100): number | null | undefined {
  const [shown, setShown] = useState<number | null | undefined>(() => (reducedMotion() ? value : value == null ? value : 0));
  const first = useRef(true);
  useEffect(() => {
    if (value == null || reducedMotion() || !first.current) {
      setShown(value);
      return;
    }
    first.current = false;
    const t0 = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(value * eased));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);
  return shown;
}
