import { cn } from "@/lib/utils";

// Unfunnelizer-style tab bar: collapsed icons; the active tab (and any hovered tab)
// expands to reveal its label. Bottom border, azure active state.
export default function TabNav({ value, onValueChange, tabs }) {
  return (
    <div className="flex w-full items-stretch gap-0.5 border-b border-blue-100">
      {tabs.map(({ id, label, Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onValueChange(id)}
            title={label}
            className={cn(
              "group relative flex cursor-pointer items-center justify-center rounded-t-lg px-2.5 py-2.5 text-[11px] transition-all duration-200 border-b-2",
              active
                ? "bg-primary/10 text-primary border-primary"
                : "text-muted-foreground border-transparent hover:bg-primary/5 hover:text-primary"
            )}
          >
            <Icon size={15} className="shrink-0" />
            <span
              className={cn(
                "overflow-hidden whitespace-nowrap transition-all duration-200 ease-out",
                active
                  ? "max-w-[72px] opacity-100 ml-1.5"
                  : "max-w-0 opacity-0 group-hover:max-w-[72px] group-hover:opacity-100 group-hover:ml-1.5"
              )}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
