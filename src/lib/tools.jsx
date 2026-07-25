import { Flame, ArrowDownUp, Clapperboard, Film, MessageSquare, ListVideo, Library as LibraryIcon, Image as ImageIcon } from "lucide-react";
import WarmTool from "@/components/tools/WarmTool";
import IgSortTool from "@/components/tools/IgSortTool";
import IgStoriesTool from "@/components/tools/IgStoriesTool";
import FbReelsTool from "@/components/tools/FbReelsTool";
import FbCommentsTool from "@/components/tools/FbCommentsTool";
import TtSortTool from "@/components/tools/TtSortTool";
import TtCommentsTool from "@/components/tools/TtCommentsTool";
import TtStoriesTool from "@/components/tools/TtStoriesTool";
import TtCollectionsTool from "@/components/tools/TtCollectionsTool";
import PinBoardTool from "@/components/tools/PinBoardTool";
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
  { id: "warm", label: "Warm", Icon: Flame, platforms: ["facebook", "instagram", "tiktok"], Panel: WarmTool },
  { id: "fb-reels", label: "Reels Sort", Icon: Film, platforms: ["facebook"], Panel: FbReelsTool },
  { id: "fb-comments", label: "Comments", Icon: MessageSquare, platforms: ["facebook"], Panel: FbCommentsTool },
  // "Sort" — download is implicit (every card has a download action). Kept short so
  // 5 tools fit the segmented sub-nav without clipping.
  { id: "ig-sort", label: "Sort", Icon: ArrowDownUp, platforms: ["instagram"], Panel: IgSortTool },
  { id: "ig-stories", label: "Stories", Icon: Clapperboard, platforms: ["instagram"], Panel: IgStoriesTool },
  { id: "tt-sort", label: "Sort", Icon: ArrowDownUp, platforms: ["tiktok"], Panel: TtSortTool },
  { id: "tt-comments", label: "Comments", Icon: MessageSquare, platforms: ["tiktok"], Panel: TtCommentsTool },
  { id: "tt-stories", label: "Stories", Icon: Clapperboard, platforms: ["tiktok"], Panel: TtStoriesTool },
  { id: "tt-collections", label: "Playlists", Icon: ListVideo, platforms: ["tiktok"], Panel: TtCollectionsTool },
  { id: "pin-board", label: "Board", Icon: ImageIcon, platforms: ["pinterest"], Panel: PinBoardTool, requiresTab: true },
  { id: "library", label: "Library", Icon: LibraryIcon, platforms: "global", Panel: LibraryTool },
];

export { filterToolsForPlatform };
export const toolsForPlatform = (platform) => filterToolsForPlatform(TOOLS, platform);
export const getTool = (id) => TOOLS.find((t) => t.id === id) || null;
