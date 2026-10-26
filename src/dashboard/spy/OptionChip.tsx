import { X } from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import { cn } from "@/dashboard/lib/utils";

interface OptionChipProps {
  value: string;
  color?: string | null;
  className?: string;
  onRemove?: () => void;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}

export function OptionChip({
  value,
  color,
  className,
  onRemove,
  disabled,
  onClick,
  title,
}: OptionChipProps) {
  const accent = color?.trim().toLowerCase();

  const customStyle: CSSProperties = accent
    ? ({
        "--tag-color": accent,
        backgroundColor: "color-mix(in oklab, var(--tag-color) 14%, transparent)",
        borderColor: "color-mix(in oklab, var(--tag-color) 35%, transparent)",
        color: "var(--tag-color)",
      } as CSSProperties)
    : {};

  return (
    <span
      onClick={onClick}
      title={title}
      style={customStyle}
      className={cn(
        "group/chip inline-flex h-5 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors select-none",
        accent
          ? "border-transparent"
          : "border-border/60 bg-muted/70 text-muted-foreground",
        onClick && "cursor-pointer hover:opacity-85",
        className
      )}
    >
      <span className="truncate">{value}</span>
      {onRemove && (
        <button
          type="button"
          disabled={disabled}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 -mr-0.5 rounded-full p-0.5 text-inherit opacity-60 hover:opacity-100 hover:bg-black/15 cursor-pointer transition-opacity"
          aria-label={`Remover tag ${value}`}
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}
