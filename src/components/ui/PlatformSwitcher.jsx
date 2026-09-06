import { cn } from "@/lib/utils";
import { PLATFORMS, PLATFORM_ORDER, platformAccent } from "@/lib/platforms";

// Top-right platform picker. The active logo is filled with its OWN brand hue,
// graded to the theme (see platformAccent), on a wash of the same colour;
// inactive logos are muted and lift on hover. Brand marks only — no labels.
//
// It used to paint the active glyph with the panel's gradient through a shared
// <linearGradient> def, which meant every network looked the same when selected
// and nothing looked like itself. The def is gone: a flat fill needs no SVG
// plumbing, and the colour now says WHICH network is active.
export default function PlatformSwitcher({ value, onValueChange, disabled }) {
  return (
    // shrink-0: the switcher is the header's payload — the wordmark next to it
    // is what gives way when the panel narrows, never these four targets.
    <div className="flex shrink-0 items-center gap-1.5">
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
              "grid place-items-center size-7 rounded-lg sw-hoverable",
              "disabled:cursor-not-allowed disabled:opacity-40",
              active
                ? "bg-[color-mix(in_oklab,var(--sw-accent)_14%,transparent)] text-[var(--sw-accent)]"
                : "text-muted-foreground/70 opacity-70 hover:bg-panel/[0.07] hover:text-foreground hover:opacity-100"
            )}
            {...(active ? platformAccent(id) : {})}
            aria-pressed={active}
            aria-label={name}
          >
            <Glyph width={17} height={17} fill="currentColor" />
          </button>
        );
      })}
    </div>
  );
}
