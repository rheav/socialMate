// A 2-col grid of launcher cards. Used in two modes: platform cards on Home,
// tool cards on a platform hub. `items` carry a Glyph (platforms) or Icon (tools).
export default function Launcher({ items, onPick }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((it) => {
        const Icon = it.Glyph || it.Icon;
        return (
          <button
            key={it.id}
            onClick={() => onPick(it.id)}
            className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card p-4 hover:bg-accent transition-colors"
          >
            {Icon ? <Icon className="size-6" /> : null}
            <span className="text-xs font-medium">{it.name || it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
