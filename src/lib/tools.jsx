import { Flame, ArrowDownUp, Clapperboard, Film, MessageSquare, ListVideo, Library as LibraryIcon } from "lucide-react";
import WarmTool from "@/components/tools/WarmTool";
import IgSortTool from "@/components/tools/IgSortTool";
import IgStoriesTool from "@/components/tools/IgStoriesTool";
import FbReelsTool from "@/components/tools/FbReelsTool";
import FbCommentsTool from "@/components/tools/FbCommentsTool";
import TtSortTool from "@/components/tools/TtSortTool";
import TtCommentsTool from "@/components/tools/TtCommentsTool";
import TtStoriesTool from "@/components/tools/TtStoriesTool";
import TtCollectionsTool from "@/components/tools/TtCollectionsTool";
import LibraryTool from "@/components/tools/LibraryTool";
import { filterToolsForPlatform } from "@/lib/toolsFilter";

// Declarative registry — the single source of truth for what tool shows where.
// Adding a platform/tool later is an entry here + its Panel; the Shell never changes.
//
// Facebook is intentionally single-tool (Warm): per-video Download/Transcribe now
// live as on-page buttons injected into the feed/reel/video-post, and results land
// in the global Library (Transcripts / Saved). The old profile-thumbnail Download
// panel was dropped to keep the FB surface uncluttered.
export const TOOLS = [
  { id: "warm", label: "Warm", Icon: Flame, platforms: ["facebook", "instagram", "tiktok"], Panel: WarmTool, requiresTab: true },
  { id: "fb-reels", label: "Reels Sort", Icon: Film, platforms: ["facebook"], Panel: FbReelsTool, requiresTab: true },
  { id: "fb-comments", label: "Comments", Icon: MessageSquare, platforms: ["facebook"], Panel: FbCommentsTool, requiresTab: false },
  // "Sort" — download is implicit (every card has a download action). Kept short so
  // 5 tools fit the segmented sub-nav without clipping.
  { id: "ig-sort", label: "Sort", Icon: ArrowDownUp, platforms: ["instagram"], Panel: IgSortTool, requiresTab: true },
  { id: "ig-stories", label: "Stories", Icon: Clapperboard, platforms: ["instagram"], Panel: IgStoriesTool, requiresTab: true },
  { id: "tt-sort", label: "Sort", Icon: ArrowDownUp, platforms: ["tiktok"], Panel: TtSortTool, requiresTab: true },
  { id: "tt-comments", label: "Comments", Icon: MessageSquare, platforms: ["tiktok"], Panel: TtCommentsTool, requiresTab: false },
  { id: "tt-stories", label: "Stories", Icon: Clapperboard, platforms: ["tiktok"], Panel: TtStoriesTool, requiresTab: true },
  { id: "tt-collections", label: "Playlists", Icon: ListVideo, platforms: ["tiktok"], Panel: TtCollectionsTool, requiresTab: true },
  { id: "library", label: "Library", Icon: LibraryIcon, platforms: "global", Panel: LibraryTool, requiresTab: false },
];

export { filterToolsForPlatform };
export const toolsForPlatform = (platform) => filterToolsForPlatform(TOOLS, platform);
export const globalTools = () => TOOLS.filter((t) => t.platforms === "global");
export const getTool = (id) => TOOLS.find((t) => t.id === id) || null;
