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
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { ToolBar, ToolIconButton, ToolSelect } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { sendBg } from "@/lib/bg";
import { useContentLink } from "@/lib/useContentLink";
import { fmtCount } from "@/lib/igMedia";
import { startPolling } from "@/lib/poll";
import {
  sortComments,
  filterComments,
  commentToRow,
  commentCounts,
  buildIgExport,
  igExportFilename,
} from "@/lib/igComments";

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label. Values are unchanged.
const SORT_OPTS = [
  { value: "thread", label: "Ordem da conversa", short: "Conversa" },
  { value: "likes", label: "Curtidas" },
  { value: "date", label: "Data" },
];

// Instagram Comments. Captured passively from the comment pages Instagram itself
// loads when you OPEN a post (/p/, /reel/, /reels/) — the first page is
// server-rendered, more arrive as you scroll the thread or tap "ver respostas".
// Nothing is fetched in the background. Same layout as the TikTok tool; the
// records share its field names, so the thread/sort/filter helpers are shared.
export default function IgCommentsTool() {
  const [posts, setPosts] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState("thread");
  const [sortDir, setSortDir] = useState("desc");
  const [copied, setCopied] = useState(false);
  const [exportErr, setExportErr] = useState(false);
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("instagram");
  // The bridge answers {unchanged:true} when its store hasn't moved since the
  // version we last saw, which makes an idle poll near-free — it otherwise
  // re-serialises the whole store every 2.5s. `null` forces a full answer, which is
  // what Atualizar wants after a clear.
  const sinceRef = useRef(null);
  // Follow the currently-open Instagram post until the user manually picks one.
  const follow = useRef(true);
  // Mirror of the last list so the {unchanged} poll path can still answer "does
  // this post have comments?" without the payload.
  const postsRef = useRef([]);
  const hasComments = (id) => !!id && postsRef.current.some((v) => v.code === id);

  const pull = useCallback(async () => {
    const res = await send({ type: "FBW_IG_COMMENTS", since: sinceRef.current });
    if (!res) return;
    // `current` (the post being viewed) changes without new comments and drives
    // the auto-follow, so it is honoured even when the store hasn't moved. The
    // guard still has to be "does this post actually have comments", which the
    // short-circuit reply doesn't carry — hence the ref mirror of the last list.
    if (res.unchanged) {
      if (follow.current && res.current && hasComments(res.current))
        setActiveId(res.current);
      return;
    }
    sinceRef.current = res.version ?? sinceRef.current;
    if (res && Array.isArray(res.posts)) {
      // Keep only posts that actually have comments; newest capture first.
      const withComments = res.posts.filter((v) => v.comments && v.comments.length);
      postsRef.current = withComments;
      setPosts(withComments);
      const has = (id) => id && withComments.some((v) => v.code === id);
      setActiveId((cur) => {
        // Auto-follow the post the user is currently viewing (res.current).
        if (follow.current && has(res.current)) return res.current;
        if (has(cur)) return cur;
        return (withComments[0] && withComments[0].code) || null;
      });
    }
  }, [send]);

  const pickPost = (id) => { follow.current = false; setActiveId(id); };

  const refresh = useCallback(async () => {
    follow.current = true;
    sinceRef.current = null;
    postsRef.current = [];
    setPosts([]);
    setActiveId(null);
    // userAction: the user pressed Atualizar and is owed an answer either way.
    await send({ type: "FBW_IG_CLEAR" }, { userAction: true, action: "limpar a captura" });
    pull();
  }, [send, pull]);

  // FBW_IG_CLEAR is platform-global: it empties the capture behind every Instagram
  // pane, not just this one. So Atualizar arms on the first tap and only clears on
  // the second — the same two-step the Library's "limpar tudo" uses.
  const [clearArmed, setClearArmed] = useState(false);
  const clearBtnRef = useRef(null);
  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 4000);
    // Capture phase, so a handler that stops propagation can't leave it armed.
    const disarm = (e) => { if (!clearBtnRef.current?.contains(e.target)) setClearArmed(false); };
    document.addEventListener("pointerdown", disarm, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", disarm, true);
    };
  }, [clearArmed]);
  const onClearTap = () => {
    if (!clearArmed) { setClearArmed(true); return; }
    setClearArmed(false);
    refresh();
  };

  useEffect(() => {
    return startPolling(pull, 2500); // skips ticks while the panel is hidden
  }, [pull]);

  const active = posts.find((v) => v.code === activeId) || null;
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

  async function exportJson() {
    if (!active) return;
    const res = await sendBg({
      type: "FBW_DL_JSON",
      data: buildIgExport(active),
      filename: igExportFilename(active.code, active.meta?.username),
    });
    // The link itself is the only feedback this export has, so it flashes the
    // failure the same way Copiar flashes success — otherwise a download that
    // never landed looks exactly like one that did.
    setExportErr(!res.ok);
    if (!res.ok) setTimeout(() => setExportErr(false), 2500);
  }

  // One banner for every link failure, rendered in every branch below so the
  // explanation (and its fix) can never be hidden by an empty state.
  const banner = (
    <ContentLinkBanner
      link={link}
      platformName="Instagram"
      fixing={fixing}
      onRevive={revive}
      onOpenTab={openTab}
    />
  );

  if (noTab) return banner;

  if (!posts.length)
    return (
      <div className="space-y-2">
        {banner}
        <p className="text-sm text-muted-foreground py-8 text-center">
          Abra um post do Instagram e role os comentários para capturar a conversa aqui.
        </p>
      </div>
    );

  return (
    <div className="space-y-3">
      {banner}
      {/* post picker + refresh */}
      <ToolBar>
        <ToolSelect
          label="Post"
          value={activeId || ""}
          onValueChange={pickPost}
          options={posts.map((v) => {
            const label =
              (v.meta && (v.meta.caption || (v.meta.username && "@" + v.meta.username))) ||
              "post " + v.code;
            return {
              value: v.code,
              label: `${String(label).slice(0, 48)} · ${v.comments.length}`,
              short: String(label).slice(0, 24),
            };
          })}
        />
        <ToolIconButton
          ref={clearBtnRef}
          icon={clearArmed ? Trash2 : RotateCw}
          label={clearArmed ? "Confirmar limpeza" : "Atualizar"}
          hint={
            clearArmed
              ? "Toque de novo para confirmar — apaga a captura de Ordenar, Comentários e Stories"
              : "Atualizar — limpa TODA a captura do Instagram (Ordenar, Comentários e Stories) e volta a seguir o post que você está vendo"
          }
          variant={clearArmed ? "destructive" : "outline"}
          onClick={onClearTap}
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
          <button
            className={"inline-flex items-center gap-1 underline " + (exportErr ? "text-danger" : "")}
            onClick={exportJson}
          >
            <Download className="size-3" /> {exportErr ? "Erro" : "JSON"}
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
                  href={`https://www.instagram.com/${r.handle}/`}
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
