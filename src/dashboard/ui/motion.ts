import type { Transition } from "motion/react";

/** JS mirror of the CSS easing, so both sides agree on the same curve. */
export const EASE_OUT_SOFT = [0.22, 1, 0.36, 1] as const;

/**
 * One motion vocabulary for the whole dashboard. Every animated component pulls
 * its timing from here, so the app reads as one system instead of per-file
 * guesses — and so a change of pace is one edit, not twenty.
 *
 * `MotionConfig reducedMotion="user"` in main.tsx neutralises transform and
 * layout animation for anyone who asked their OS for less motion.
 */
export const MOTION = {
  /** Snappy — state flips, the pill sliding between tabs. */
  spring: { type: "spring", stiffness: 500, damping: 40 } as Transition,
  /** Enter/exit of small elements. */
  fade: { duration: 0.18, ease: EASE_OUT_SOFT } as Transition,
  /** A whole view arriving. Longer than `fade`: at 180ms a full grid reads as a cut. */
  view: { duration: 0.24, ease: EASE_OUT_SOFT } as Transition,
  /** Leaving is shorter than arriving — with `mode="wait"` the two run back to back. */
  viewOut: { duration: 0.12, ease: "easeIn" } as Transition,
  /** The side sheet, which travels the width of itself. */
  sheet: { type: "spring", stiffness: 380, damping: 40 } as Transition,
} as const;
