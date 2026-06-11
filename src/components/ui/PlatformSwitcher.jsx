import { cn } from "@/lib/utils";
import { PLATFORMS, PLATFORM_ORDER } from "@/lib/platforms";

// Top-right platform picker. Active logo fills with the azure→seafoam gradient
// (via the shared <linearGradient> def below) and glows; inactive logos are muted
// gray and lift on hover. Brand marks only — no labels.
export default function PlatformSwitcher({ value, onValueChange, disabled }) {
  return (
    <div className="flex items-center gap-1.5">
      {/* one shared gradient def for all active glyphs */}
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <defs>
          <linearGradient id="sw-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--sw-from)" />
            <stop offset="100%" stopColor="var(--sw-to)" />
          </linearGradient>
        </defs>
      </svg>

      {PLATFORM_ORDER.map((id) => {
        const { name, Glyph } = PLATFORMS[id];
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            title={name}
            disabled={disabled}
            onClick={() => onValueChange(id)}
            className={cn(
              "grid place-items-center size-7 rounded-lg transition-all duration-200",
              "disabled:cursor-not-allowed disabled:opacity-40",
              active
                ? "platform-glow"
                : "text-muted-foreground/70 opacity-70 hover:opacity-100 hover:text-foreground hover:bg-primary/5"
            )}
            aria-pressed={active}
            aria-label={name}
          >
            <Glyph
              width={17}
              height={17}
              style={active ? { fill: "url(#sw-grad)" } : undefined}
            />
          </button>
        );
      })}
    </div>
  );
}
