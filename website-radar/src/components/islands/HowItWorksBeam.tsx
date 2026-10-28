// "How it works": three steps joined by AnimatedBeam. Island: client:visible.
// The steps are in the SSR HTML; only the beams need the browser.
import { useRef } from "react";

import { AnimatedBeam } from "@/components/magicui/animated-beam";

interface Step {
  title: string;
  text: string;
}

const icons = [
  // download / install
  "M12 3v12m0 0-4-4m4 4 4-4M5 21h14",
  // window / the social network page
  "M3 5h18v14H3zM3 9h18",
  // cursor click
  "m9 9 10 4-4 2-2 4zM5 3v3M3 5h3M10 4l1 2M4 10l2 1",
];

export function HowItWorksBeam({ steps }: { steps: Step[] }) {
  const container = useRef<HTMLDivElement>(null);
  const a = useRef<HTMLDivElement>(null);
  const b = useRef<HTMLDivElement>(null);
  const c = useRef<HTMLDivElement>(null);
  const refs = [a, b, c];

  return (
    <div ref={container} className="relative grid gap-10 md:grid-cols-3 md:gap-6">
      {steps.map((step, i) => (
        <div key={step.title} className="relative z-10 flex flex-col items-center text-center">
          <div
            ref={refs[i]}
            className="flex size-16 items-center justify-center rounded-2xl border border-theme bg-theme-card shadow-lg"
          >
            <svg viewBox="0 0 24 24" className="size-7 fill-none stroke-2" style={{ stroke: "var(--color-accent-from)" }} aria-hidden="true">
              <path d={icons[i]} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="mt-2 text-xs font-semibold tracking-widest text-theme-muted" aria-hidden="true">
            0{i + 1}
          </p>
          <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
          <p className="mt-1 max-w-xs text-sm text-theme-muted leading-relaxed">{step.text}</p>
        </div>
      ))}
      <div className="pointer-events-none absolute inset-0 hidden md:block">
        <AnimatedBeam containerRef={container} fromRef={a} toRef={b} duration={3} />
        <AnimatedBeam containerRef={container} fromRef={b} toRef={c} duration={3} delay={1.5} />
      </div>
    </div>
  );
}
