import { CircleDashed } from "lucide-react";

import { cn } from "@/dashboard/lib/utils";

export function EmptyState({
  title,
  description,
  className,
}: {
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div className={cn("fx-dots grid min-h-36 place-items-center rounded-xl px-6 py-10 text-center", className)}>
      <div className="grid max-w-sm gap-2">
        <div className="mx-auto grid size-9 place-items-center rounded-md border bg-muted/40 text-muted-foreground">
          <CircleDashed className="size-4" />
        </div>
        <strong className="text-sm font-medium">{title}</strong>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

