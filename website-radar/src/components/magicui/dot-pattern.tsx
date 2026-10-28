// Magic UI DotPattern (registry: dot-pattern), static variant.
// The current registry version measures the container in an effect and renders no dots
// on the server; this keeps its props but draws with an SVG <pattern>, so it needs no JS.
import { useId, type SVGProps } from "react";

import { cn } from "@/lib/utils";

interface DotPatternProps extends SVGProps<SVGSVGElement> {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  cr?: number;
  className?: string;
}

export function DotPattern({
  width = 16,
  height = 16,
  x = 0,
  y = 0,
  cx = 1,
  cy = 1,
  cr = 1,
  className,
  ...props
}: DotPatternProps) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 h-full w-full fill-neutral-400/80", className)}
      {...props}
    >
      <defs>
        <pattern id={`${id}-dots`} width={width} height={height} patternUnits="userSpaceOnUse" x={x} y={y}>
          <circle cx={cx} cy={cy} r={cr} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" strokeWidth={0} fill={`url(#${id}-dots)`} />
    </svg>
  );
}
