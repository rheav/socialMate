import { useCallback, useEffect, useRef, useState } from "react";
import {
  Heart,
  MessageCircle,
  Search,
  ArrowUp,
  ArrowDown,
  Copy,
  Check,
  Download,
  CornerDownRight,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { resolvePlatformTab } from "@/lib/tabs";
import { fmtCount } from "@/lib/ttMedia";
import { startPolling } from "@/lib/poll";
import {
  sortComments,
  filterComments,
  commentToRow,
  commentCounts,
  buildExport,
  exportFilename,
} from "@/lib/ttComments";

const SORT_LABEL = { thread: "Ordem da conversa", likes: "Curtidas", date: "Data" };

// TikTok Comments. Comments are captured passively (fetch tee of
// /api/comment/list/) when you OPEN a video on TikTok — nothing is fetched in the
// background. The panel lists captured videos, shows each thread with search /
// sort-by-likes / copy / JSON export.
export default function TtCommentsTool() {
  const [videos, setVideos] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState("thread");
  const [sortDir, setSortDir] = useState("desc");
  const [noTab, setNoTab] = useState(false);
  const [copied, setCopied] = useState(false);
  const tabId = useRef(null);
  // Follow the currently-open TikTok video until the user manually picks one.
  const follow = useRef(true);

  const pull = useCallback(async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("tiktok");
    if (tabId.current == null) {
      setNoTab(true);
      return;
    }
    setNoTab(false);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_TT_COMMENTS" });
      if (res && Array.isArray(res.videos)) {
        // Keep only videos that actually have comments; newest capture first.
        const withComments = res.videos.filter((v) => v.comments && v.comments.length);
        setVideos(withComments);
        const has = (id) => id && withComments.some((v) => v.aweme_id === id);
        setActiveId((cur) => {
          // Auto-follow the video the user is currently viewing (res.current).
          if (follow.current && has(res.current)) return res.current;
          if (has(cur)) return cur;
          return (withComments[0] && withComments[0].aweme_id) || null;
        });
      }
    } catch {
      tabId.current = null;
    }
  }, []);

  const pickVideo = (id) => { follow.current = false; setActiveId(id); };

  const refresh = useCallback(async () => {
    follow.current = true;
    setVideos([]);
    setActiveId(null);
    try {
      if (tabId.current == null) tabId.current = await resolvePlatformTab("tiktok");
      if (tabId.current != null) await chrome.tabs.sendMessage(tabId.current, { type: "FBW_TT_CLEAR" });
    } catch {
      tabId.current = null;
    }
    pull();
  }, [pull]);

  useEffect(() => {
    pull();
    return startPolling(pull, 2500); // skips ticks while the panel is hidden
  }, [pull]);

  const active = videos.find((v) => v.aweme_id === activeId) || null;
  const counts = active ? commentCounts(active.comments) : { total: 0, replies: 0, topLevel: 0 };
  const rows = active
    ? sortComments(filterComments(active.comments, query), sortKey, sortDir).map(commentToRow)
    : [];

  async function copyAll() {
    if (!active) return;
    const text = sortComments(active.comments, "thread")
      .map((c) => `${c.is_reply ? "  ↳ " : ""}${c.nickname || c.username || "?"}: ${c.text}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  function exportJson() {
    if (!active) return;
    chrome.runtime.sendMessage({
      type: "FBW_DL_JSON",
      data: buildExport(active),
      filename: exportFilename(active.aweme_id),
    });
  }

  if (noTab)
    return (
      <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2">
        Abra o TikTok em uma aba (com login feito) e reabra este painel.
      </div>
    );

  if (!videos.length)
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Abra um vídeo do TikTok (para carregar os comentários) para capturar a conversa aqui.
      </p>
    );

  return (
    <div className="space-y-3">
      {/* video picker + refresh */}
      <div className="flex items-center gap-2">
        <Select value={activeId || ""} onValueChange={pickVideo}>
        <SelectTrigger>
          <SelectValue placeholder="Escolha um vídeo capturado" />
        </SelectTrigger>
        <SelectContent>
          {videos.map((v) => {
            const label =
              (v.meta && (v.meta.desc || (v.meta.username && "@" + v.meta.username))) ||
              "vídeo " + v.aweme_id;
            return (
              <SelectItem key={v.aweme_id} value={v.aweme_id}>
                {String(label).slice(0, 48)} · {v.comments.length}
              </SelectItem>
            );
          })}
        </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          onClick={refresh}
          title="Atualizar — descarta outros vídeos, segue o que você está vendo"
        >
          <RotateCw />
        </Button>
      </div>

      {/* controls */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Pesquisar texto / autor"
            className="pl-7"
          />
        </div>
        <Select value={sortKey} onValueChange={setSortKey}>
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SORT_LABEL).map(([k, l]) => (
              <SelectItem key={k} value={k}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          disabled={sortKey === "thread"}
          title={sortDir === "desc" ? "Maior → menor" : "Menor → maior"}
        >
          {sortDir === "desc" ? <ArrowDown /> : <ArrowUp />}
        </Button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {counts.total} comentários · {counts.topLevel} principais · {counts.replies} respostas
        </span>
        <div className="flex items-center gap-3">
          <button className="inline-flex items-center gap-1 underline" onClick={copyAll}>
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copiado" : "Copiar"}
          </button>
          <button className="inline-flex items-center gap-1 underline" onClick={exportJson}>
            <Download className="size-3" /> JSON
          </button>
        </div>
      </div>

      {/* thread */}
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div
            key={r.cid}
            className={
              "rounded-lg border border-border bg-card px-2.5 py-2 " +
              (r.isReply ? "ml-5 border-l-2 border-l-sky-400/40" : "")
            }
          >
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
              {r.isReply && <CornerDownRight className="size-3 text-muted-foreground" />}
              {r.handle ? (
                <a
                  href={`https://www.tiktok.com/@${r.handle}`}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate hover:underline"
                >
                  {r.author}
                </a>
              ) : (
                <span className="truncate">{r.author}</span>
              )}
              <div className="ml-auto flex items-center gap-2 text-[10.5px] font-medium text-muted-foreground">
                {r.likes != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Heart className="size-3" />
                    {fmtCount(r.likes)}
                  </span>
                )}
                {r.replies != null && r.replies > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <MessageCircle className="size-3" />
                    {fmtCount(r.replies)}
                  </span>
                )}
              </div>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-snug text-foreground">
              {r.text}
            </p>
          </div>
        ))}
        {!rows.length && (
          <p className="py-6 text-center text-sm text-muted-foreground">Nenhum comentário encontrado.</p>
        )}
      </div>
    </div>
  );
}
