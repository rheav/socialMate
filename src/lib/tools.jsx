import { Flame, ArrowDownUp, Clapperboard, Film, Filter, MessageSquare, ListVideo, Library as LibraryIcon, Image as ImageIcon, Images } from "lucide-react";
import WarmTool from "@/components/tools/WarmTool";
import FbFilterTool from "@/components/tools/FbFilterTool";
import IgSortTool from "@/components/tools/IgSortTool";
import IgStoriesTool from "@/components/tools/IgStoriesTool";
import FbReelsTool from "@/components/tools/FbReelsTool";
import FbCommentsTool from "@/components/tools/FbCommentsTool";
import FbPhotosTool from "@/components/tools/FbPhotosTool";
import TtSortTool from "@/components/tools/TtSortTool";
import TtCommentsTool from "@/components/tools/TtCommentsTool";
import TtStoriesTool from "@/components/tools/TtStoriesTool";
import TtCollectionsTool from "@/components/tools/TtCollectionsTool";
import PinBoardTool from "@/components/tools/PinBoardTool";
import LibraryTool from "@/components/tools/LibraryTool";
import { filterToolsForPlatform, workspaceToolsForPlatform as workspaceFilter } from "@/lib/toolsFilter";

// Declarative registry — the single source of truth for what tool shows where.
// Adding a platform/tool later is an entry here + its Panel; the Shell never changes.
//
// Facebook is intentionally single-tool (Warm): per-video Download/Transcribe now
// live as on-page buttons injected into the feed/reel/video-post, and results land
// in the global Library (Transcripts / Saved). The old profile-thumbnail Download
// panel was dropped to keep the FB surface uncluttered.
export const TOOLS = [
  { id: "warm", label: "Aquecer", Icon: Flame, platforms: ["facebook", "instagram", "tiktok"], Panel: WarmTool },
  // "Filtrar" — the search/hashtag engagement filter. First of Facebook's research
  // tools because it is the one that runs WHILE you browse, not after.
  { id: "fb-filter", label: "Filtrar", Icon: Filter, platforms: ["facebook"], Panel: FbFilterTool },
  { id: "fb-reels", label: "Ordenar Reels", Icon: Film, platforms: ["facebook"], Panel: FbReelsTool },
  { id: "fb-comments", label: "Comentários", Icon: MessageSquare, platforms: ["facebook"], Panel: FbCommentsTool },
  // "Fotos" stays one short word on purpose: Facebook now has 4 tools in the
  // segmented sub-nav, which clips rather than wraps.
  { id: "fb-photos", label: "Fotos", Icon: Images, platforms: ["facebook"], Panel: FbPhotosTool },
  // "Ordenar" — download is implicit (every card has a download action). Kept short so
  // 5 tools fit the segmented sub-nav without clipping.
  { id: "ig-sort", label: "Ordenar", Icon: ArrowDownUp, platforms: ["instagram"], Panel: IgSortTool },
  { id: "ig-stories", label: "Stories", Icon: Clapperboard, platforms: ["instagram"], Panel: IgStoriesTool },
  { id: "tt-sort", label: "Ordenar", Icon: ArrowDownUp, platforms: ["tiktok"], Panel: TtSortTool },
  { id: "tt-comments", label: "Comentários", Icon: MessageSquare, platforms: ["tiktok"], Panel: TtCommentsTool },
  { id: "tt-stories", label: "Stories", Icon: Clapperboard, platforms: ["tiktok"], Panel: TtStoriesTool },
  { id: "tt-collections", label: "Playlists", Icon: ListVideo, platforms: ["tiktok"], Panel: TtCollectionsTool },
  { id: "pin-board", label: "Pasta", Icon: ImageIcon, platforms: ["pinterest"], Panel: PinBoardTool },
  { id: "library", label: "Arquivo", Icon: LibraryIcon, platforms: "global", Panel: LibraryTool },
];

export { filterToolsForPlatform };
export const toolsForPlatform = (platform) => filterToolsForPlatform(TOOLS, platform);
// The Pesquisa workspace's sub-tools: the platform's tools minus the warmer, which
// is a top-level tab of its own now.
export const workspaceToolsForPlatform = (platform) => workspaceFilter(TOOLS, platform);
export const getTool = (id) => TOOLS.find((t) => t.id === id) || null;
