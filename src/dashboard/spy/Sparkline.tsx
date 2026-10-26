import { useId } from "react";
import { fmtCount } from "../format";
import { sparkGeometry } from "./spyFormat";

interface SparklineProps {
  points: { day?: string; followers: number }[];
  className?: string;
  width?: number;
}

const HEIGHT = 40;

/**
 * Card trend: a gradient area under a 2px line, ending on a dot, with the first
 * and last follower counts underneath so the size of the change reads at a
 * glance (the y-scale is fitted to the series, so the shape alone exaggerates
 * small moves). Values wear text tokens; the series color is only on the mark.
 */
export function Sparkline({ points, className, width = 112 }: SparklineProps) {
  const gradientId = `spark-${useId().replace(/:/g, "")}`;
  const g = points && points.length >= 2 ? sparkGeometry(points, width, HEIGHT, 4) : null;
  if (!g) return null;
  const first = points[0].followers;
  const last = points[points.length - 1].followers;

  return (
    <div className={className}>
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true" className="block overflow-visible">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={g.area} fill={`url(#${gradientId})`} stroke="none" />
        <path d={g.line} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={g.end.x} cy={g.end.y} r="2.75" fill="var(--chart-1)" stroke="var(--card)" strokeWidth="1.5" />
      </svg>
      <div data-testid="spark-range" className="mt-0.5 flex justify-between text-[10px] leading-3 tabular-nums">
        <span className="text-muted-foreground">{fmtCount(first)}</span>
        <span className="font-medium text-foreground">{fmtCount(last)}</span>
      </div>
    </div>
  );
}
