import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

const Switch = React.forwardRef(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      // No border (the transparent border-box seamed against the fill) — the
      // accent fills the whole pill; px-0.5 insets the thumb. outline-none kills
      // the stray UA focus outline; focus-visible keeps an accessible ring.
      // The fill is the flat `sky` primary now; it used to be the brand gradient.
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full px-0.5 shadow-sm outline-none transition-colors duration-[160ms] ease-[var(--sw-ease)] focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm data-[state=checked]:bg-primary-foreground transition-transform duration-[180ms] ease-[var(--sw-ease)] data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
