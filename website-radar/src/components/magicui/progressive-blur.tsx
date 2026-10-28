// Magic UI ProgressiveBlur (registry: progressive-blur). Static: no client: directive.
import { cn } from "@/lib/utils";

export interface ProgressiveBlurProps {
  className?: string;
  height?: string;
  position?: "top" | "bottom" | "both";
  blurLevels?: number[];
}

const edgeMask = (position: ProgressiveBlurProps["position"], from: string, to: string) =>
  position === "bottom"
    ? `linear-gradient(to bottom, ${from}, ${to})`
    : position === "top"
      ? `linear-gradient(to top, ${from}, ${to})`
      : `linear-gradient(rgba(0,0,0,0) 0%, rgba(0,0,0,1) 5%, rgba(0,0,0,1) 95%, rgba(0,0,0,0) 100%)`;

export function ProgressiveBlur({
  className,
  height = "30%",
  position = "bottom",
  blurLevels = [0.5, 1, 2, 4, 8, 16, 32, 64],
}: ProgressiveBlurProps) {
  const middle = Array(blurLevels.length - 2).fill(null);

  return (
    <div
      aria-hidden="true"
      className={cn(
        "gradient-blur pointer-events-none absolute inset-x-0 z-10",
        className,
        position === "top" ? "top-0" : position === "bottom" ? "bottom-0" : "inset-y-0"
      )}
      style={{ height: position === "both" ? "100%" : height }}
    >
      <div
        className="absolute inset-0"
        style={{
          zIndex: 1,
          backdropFilter: `blur(${blurLevels[0]}px)`,
          WebkitBackdropFilter: `blur(${blurLevels[0]}px)`,
          maskImage: edgeMask(position, "rgba(0,0,0,0) 0%, rgba(0,0,0,1) 12.5%", "rgba(0,0,0,1) 25%, rgba(0,0,0,0) 37.5%"),
          WebkitMaskImage: edgeMask(position, "rgba(0,0,0,0) 0%, rgba(0,0,0,1) 12.5%", "rgba(0,0,0,1) 25%, rgba(0,0,0,0) 37.5%"),
        }}
      />
      {middle.map((_, index) => {
        const blurIndex = index + 1;
        const start = blurIndex * 12.5;
        const mid = (blurIndex + 1) * 12.5;
        const end = (blurIndex + 2) * 12.5;
        const mask = edgeMask(
          position,
          `rgba(0,0,0,0) ${start}%, rgba(0,0,0,1) ${mid}%`,
          `rgba(0,0,0,1) ${end}%, rgba(0,0,0,0) ${end + 12.5}%`
        );
        return (
          <div
            key={`blur-${index}`}
            className="absolute inset-0"
            style={{
              zIndex: index + 2,
              backdropFilter: `blur(${blurLevels[blurIndex]}px)`,
              WebkitBackdropFilter: `blur(${blurLevels[blurIndex]}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        );
      })}
      <div
        className="absolute inset-0"
        style={{
          zIndex: blurLevels.length,
          backdropFilter: `blur(${blurLevels[blurLevels.length - 1]}px)`,
          WebkitBackdropFilter: `blur(${blurLevels[blurLevels.length - 1]}px)`,
          maskImage: edgeMask(position, "rgba(0,0,0,0) 87.5%", "rgba(0,0,0,1) 100%"),
          WebkitMaskImage: edgeMask(position, "rgba(0,0,0,0) 87.5%", "rgba(0,0,0,1) 100%"),
        }}
      />
    </div>
  );
}
