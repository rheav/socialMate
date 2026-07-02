import { Flame, ArrowDownUp, Download, Clapperboard, Library as LibraryIcon } from "lucide-react";
import WarmTool from "@/components/tools/WarmTool";
import IgSortTool from "@/components/tools/IgSortTool";
import IgStoriesTool from "@/components/tools/IgStoriesTool";
import LibraryTool from "@/components/tools/LibraryTool";
import DownloadPanel from "@/components/DownloadPanel";
import { filterToolsForPlatform } from "@/lib/toolsFilter";

// Declarative registry — the single source of truth for what tool shows where.
// Adding a platform/tool later is an entry here + its Panel; the Shell never changes.
export const TOOLS = [
  { id: "warm", label: "Warm", Icon: Flame, platforms: ["facebook", "instagram", "tiktok"], Panel: WarmTool, requiresTab: true },
  { id: "ig-sort", label: "Sort + Download", Icon: ArrowDownUp, platforms: ["instagram"], Panel: IgSortTool, requiresTab: true },
  { id: "ig-stories", label: "Stories", Icon: Clapperboard, platforms: ["instagram"], Panel: IgStoriesTool, requiresTab: true },
  { id: "download", label: "Download", Icon: Download, platforms: ["facebook"], Panel: DownloadPanel, requiresTab: true },
  { id: "library", label: "Library", Icon: LibraryIcon, platforms: "global", Panel: LibraryTool, requiresTab: false },
];

export { filterToolsForPlatform };
export const toolsForPlatform = (platform) => filterToolsForPlatform(TOOLS, platform);
export const globalTools = () => TOOLS.filter((t) => t.platforms === "global");
export const getTool = (id) => TOOLS.find((t) => t.id === id) || null;
