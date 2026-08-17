import { ChevronLeft } from "lucide-react";

// Wraps a tool Panel with a back affordance (labeled with where you'll return).
// The platform switcher used to live here; it now sits in the Shell header so it is
// visible from every screen and doubles as the "which platform is the panel
// following" indicator.
export default function ToolFrame({ title, onBack, children }) {
  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="sw-hoverable flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" /> {title}
      </button>
      {children}
    </div>
  );
}
