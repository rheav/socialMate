import { ChevronLeft } from "lucide-react";
import PlatformSwitcher from "@/components/ui/PlatformSwitcher";

// Wraps a tool Panel: a back affordance (labeled with where you'll return) and,
// for platform-bound tools, a compact platform-swap control.
export default function ToolFrame({ title, onBack, platform, onSwapPlatform, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> {title}
        </button>
        {platform ? (
          <PlatformSwitcher value={platform} onValueChange={onSwapPlatform} />
        ) : null}
      </div>
      {children}
    </div>
  );
}
