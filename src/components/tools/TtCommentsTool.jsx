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
import { Input } from "@/components/ui/input";
import { ToolBar, ToolIconButton, ToolSelect } from "@/components/ui/ToolBar";
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

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label. Values are unchanged.
const SORT_OPTS = [
  { value: "thread", label: "Ordem da conversa", short: "Conversa" },
  { value: "likes", label: "Curtidas" },
  { value: "date", label: "Data" },
];

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
      <ToolBar>
        <ToolSelect
          label="Vídeo"
          value={activeId || ""}
          onValueChange={pickVideo}
          options={videos.map((v) => {
            const label =
              (v.meta && (v.meta.desc || (v.meta.username && "@" + v.meta.username))) ||
              "vídeo " + v.aweme_id;
            return {
              value: v.aweme_id,
              label: `${String(label).slice(0, 48)} · ${v.comments.length}`,
              short: String(label).slice(0, 24),
            };
          })}
        />
        <ToolIconButton
          icon={RotateCw}
          label="Atualizar"
          hint="Atualizar — descarta outros vídeos, segue o que você está vendo"
          onClick={refresh}
        />
      </ToolBar>

      {/* controls */}
      <ToolBar>
        {/* min-w-0 on the wrapper is required: an <input> has an intrinsic
            min-content width (~20 chars), so a flex-1 wrapper without it will
            not shrink and pushes the sorter off the panel. */}
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Pesquisar texto / autor"
            className="h-8 min-w-0 pl-7 text-xs"
          />
        </div>
        <ToolSelect
          label="Ordenar por"
          value={sortKey}
          onValueChange={setSortKey}
          options={SORT_OPTS}
          className="max-w-[130px]"
        />
        <ToolIconButton
          icon={sortDir === "desc" ? ArrowDown : ArrowUp}
          label={sortDir === "desc" ? "Maior → menor" : "Menor → maior"}
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          disabled={sortKey === "thread"}
        />
      </ToolBar>

      {/* flex-wrap, not truncate: the copy/export links drop to their own line
          instead of the tally losing words. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 break-words">
          {counts.total} comentários · {counts.topLevel} principais · {counts.replies} respostas
        </span>
        <div className="flex shrink-0 items-center gap-3">
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
            {/* break-words: a pasted URL is one unbreakable token and would
                otherwise push the whole panel wider than the window. */}
            <p className="mt-0.5 break-words whitespace-pre-wrap text-[12px] leading-snug text-foreground">
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
