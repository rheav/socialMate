// Magic UI AnimatedBeam (registry: animated-beam). Used inside the HowItWorks island.
// Adapted: theme colors by default (set through style: SVG attributes ignore var());
// the travelling light is a native SVG <animate> with the registry's easing, so no
// animation library ships to the browser; static path with reduced motion.
import { useEffect, useId, useState, type RefObject } from "react";

import { cn } from "@/lib/cn";
import { useReducedMotion } from "@/lib/reduced-motion";

export interface AnimatedBeamProps {
  className?: string;
  containerRef: RefObject<HTMLElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  curvature?: number;
  reverse?: boolean;
  pathColor?: string;
  pathWidth?: number;
  pathOpacity?: number;
  gradientStartColor?: string;
  gradientStopColor?: string;
  delay?: number;
  duration?: number;
  startXOffset?: number;
  startYOffset?: number;
  endXOffset?: number;
  endYOffset?: number;
}

export const AnimatedBeam: React.FC<AnimatedBeamProps> = ({
  className,
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 5,
  delay = 0,
  pathColor = "var(--color-text-muted)",
  pathWidth = 2,
  pathOpacity = 0.25,
  gradientStartColor = "var(--color-accent-from)",
  gradientStopColor = "var(--color-accent-to)",
  startXOffset = 0,
  startYOffset = 0,
  endXOffset = 0,
  endYOffset = 0,
}) => {
  const id = useId().replace(/:/g, "");
  const reduce = useReducedMotion();
  const [pathD, setPathD] = useState("");
  const [svgDimensions, setSvgDimensions] = useState({ width: 0, height: 0 });

  const gradientCoordinates = reverse
    ? { x1: ["90%", "-10%"], x2: ["100%", "0%"] }
    : { x1: ["10%", "110%"], x2: ["0%", "100%"] };

  useEffect(() => {
    const updatePath = () => {
      if (containerRef.current && fromRef.current && toRef.current) {
        const containerRect = containerRef.current.getBoundingClientRect();
        const rectA = fromRef.current.getBoundingClientRect();
        const rectB = toRef.current.getBoundingClientRect();
        setSvgDimensions({ width: containerRect.width, height: containerRect.height });
        const startX = rectA.left - containerRect.left + rectA.width / 2 + startXOffset;
        const startY = rectA.top - containerRect.top + rectA.height / 2 + startYOffset;
        const endX = rectB.left - containerRect.left + rectB.width / 2 + endXOffset;
        const endY = rectB.top - containerRect.top + rectB.height / 2 + endYOffset;
        const controlY = startY - curvature;
        setPathD(`M ${startX},${startY} Q ${(startX + endX) / 2},${controlY} ${endX},${endY}`);
      }
    };
    const resizeObserver = new ResizeObserver(() => updatePath());
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    updatePath();
    return () => resizeObserver.disconnect();
  }, [containerRef, fromRef, toRef, curvature, startXOffset, startYOffset, endXOffset, endYOffset]);

  return (
    <svg
      fill="none"
      width={svgDimensions.width}
      height={svgDimensions.height}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("pointer-events-none absolute top-0 left-0 transform-gpu stroke-2", className)}
      viewBox={`0 0 ${svgDimensions.width} ${svgDimensions.height}`}
    >
      <path d={pathD} style={{ stroke: pathColor }} strokeWidth={pathWidth} strokeOpacity={pathOpacity} strokeLinecap="round" />
      {!reduce && (
        <>
          <path d={pathD} strokeWidth={pathWidth} stroke={`url(#${id})`} strokeOpacity="1" strokeLinecap="round" />
          <defs>
            <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0%" x2="0%" y1="0%" y2="0%">
              {(["x1", "x2"] as const).map((attr) => (
                <animate
                  key={attr}
                  attributeName={attr}
                  values={gradientCoordinates[attr].join(";")}
                  dur={`${duration}s`}
                  begin={`${delay}s`}
                  repeatCount="indefinite"
                  keyTimes="0;1"
                  calcMode="spline"
                  keySplines="0.16 1 0.3 1"
                />
              ))}
              <stop style={{ stopColor: gradientStartColor }} stopOpacity="0"></stop>
              <stop style={{ stopColor: gradientStartColor }}></stop>
              <stop offset="32.5%" style={{ stopColor: gradientStopColor }}></stop>
              <stop offset="100%" style={{ stopColor: gradientStopColor }} stopOpacity="0"></stop>
            </linearGradient>
          </defs>
        </>
      )}
    </svg>
  );
};
