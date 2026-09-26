import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { surfaceLabel, surfaceHint } from "@/lib/surfaceLabel";

// The page picker that replaced "N coletados · <raw surface key>" + "mostrar tudo".
//
// WHY. Instagram and TikTok are SPAs, so one tab's capture store spans every page
// you visited: a hashtag, then the Explore feed, then a profile. The panel scoped
// the grid to the LIVE page, which is right — but it printed the raw key and gave
// no way to see any other page, so when the key itself was wrong (every IG hashtag
// bucketed as "explore", measured 2026-09-22) the list filled with unrelated posts
// and the only escape was "mostrar tudo", which made it worse.
//
// Now the buckets are correct AND visible: the store keeps everything, the grid
// shows one page, and this names which. "Seguir a página" is the default and
// re-points itself as you browse; picking a page by hand pins it until you pick
// "Seguir" again.
export const FOLLOW = "__live__";
export const ALL = "__all__";

/** The surface to filter by, given the picker's value and the live page. */
export function resolveSurface(value, live) {
  if (value === ALL) return null; // filterBySurface(records, null) = everything
  if (value === FOLLOW) return live || null;
  return value;
}

export default function SurfacePicker({ value, onChange, live, surfaces, total, shown }) {
  const list = Array.isArray(surfaces) ? surfaces : [];
  // A page you are standing on but have captured nothing from yet still belongs in
  // the menu — otherwise "Seguir a página" points at an option that isn't there.
  const known = new Set(list.map((s) => s.key));
  const rows = live && !known.has(live) ? [{ key: live, count: 0 }, ...list] : list;
  const active = resolveSurface(value, live);
  const hint = surfaceHint(active);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <Select value={value} onValueChange={onChange}>
          {/* min-w-0 is load-bearing: the trigger holds a truncating span and would
              otherwise take its intrinsic content width and push the tally out. */}
          <SelectTrigger className="h-7 min-w-0 flex-1 text-xs" aria-label="Página mostrada">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW}>
              Seguir a página{live ? ` (${surfaceLabel(live)})` : ""}
            </SelectItem>
            {rows.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {surfaceLabel(s.key)}
                {s.count ? ` (${s.count})` : ""}
              </SelectItem>
            ))}
            <SelectItem value={ALL}>Tudo{total ? ` (${total})` : ""}</SelectItem>
          </SelectContent>
        </Select>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {shown}
          {total > shown ? `/${total}` : ""}
        </span>
      </div>
      {hint ? <p className="text-[11px] leading-tight text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
