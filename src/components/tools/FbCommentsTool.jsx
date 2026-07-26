import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Heart,
  CornerDownRight,
  Search,
  Copy,
  Check,
  Download,
  Trash2,
  BadgeCheck,
  Loader2,
  RotateCw,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { ToolBar, ActionButton, ToolIconButton, ToolSelect } from "@/components/ui/ToolBar";
import { fmtCount } from "@/lib/fbReels";
import { downloadPath } from "@/lib/downloadPath";

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label. Values are unchanged.
const SORT_OPTS = [
  { value: "order", label: "Ordem da conversa", short: "Conversa" },
  { value: "reactions", label: "Reações" },
];

const CKEY = "fbw_comments"; // archive: { post_id -> envelope }, ≤8 posts
const LKEY = "fbw_comments_live"; // single post currently streaming
const hasStorage = () => typeof chrome !== "undefined" && !!chrome?.storage?.local;

// This used to click a synthetic <a download="…">, which cannot put a file in a
// sub-folder: Chrome flattens the whole path into the name and drops it in the
// Downloads ROOT (verified — "a/b/c.json" saved as "a_b_c.json"). So it goes through
// chrome.downloads like every other export, which does honour the folder. The panel
// is a normal extension page, so it can mint the blob URL itself — no data: round
// trip through the service worker.
function jsonDownload(path, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  chrome.downloads.download({ url, filename: path, saveAs: false, conflictAction: "uniquify" });
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

// Row key for the virtualizer. The fallback mirrors the shape the scraper uses to
// dedupe (dedupeKey in content/fb/comments-scrape.js), so a comment with no
// comment_id — figurinhas and pre-permalink records have none — still gets a key
// that is unique inside the stored list. It must NOT be the array index: with a
// search or a filter active the list shifts, so index keys land on a different
// comment and react-virtual replays the wrong measured height.
const rowKey = (c) => c.comment_id || `${c.author?.id || "?"}|${String(c.text || "").slice(0, 40)}`;

// One comment row (top-level or reply).
function CommentRow({ c }) {
  const prof = c.author?.url || null;
  return (
    <div
      className={
        "rounded-lg border border-border bg-card p-2 " +
        (c.is_reply ? "ml-4 border-l-2 border-l-sky-400/40" : "")
      }
    >
      <div className="mb-0.5 flex items-center gap-1.5">
        {c.is_reply && <CornerDownRight className="size-3 flex-none text-sky-400/70" />}
        {prof ? (
          <a href={prof} target="_blank" rel="noreferrer" className="truncate text-[12px] font-semibold text-foreground hover:underline">
            {c.author?.name || "desconhecido"}
          </a>
        ) : (
          <span className="truncate text-[12px] font-semibold text-foreground">{c.author?.name || "desconhecido"}</span>
        )}
        {c.badges?.length ? <BadgeCheck className="size-3 flex-none text-amber-500" /> : null}
        {c.time_relative && <span className="flex-none text-[10px] text-muted-foreground">· {c.time_relative}</span>}
        {c.reactions > 0 && (
          <span className="ml-auto flex flex-none items-center gap-0.5 text-[11px] font-semibold text-rose-500">
            <Heart className="size-3 fill-rose-500" /> {fmtCount(c.reactions)}
          </span>
        )}
      </div>
      {c.text ? (
        // break-words: a pasted URL is one unbreakable token and would otherwise
        // push the whole panel wider than the window.
        <p className="break-words whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/85">{c.text}</p>
      ) : (
        <p className="text-[11px] italic text-muted-foreground">(sem texto — figurinha / mídia)</p>
      )}
    </div>
  );
}

// Facebook Comments — renders the scraped comment thread of a post/reel, filling
// in LIVE as the on-page scraper streams comments to storage. Virtualized
// (@tanstack/react-virtual) so a 1000-comment thread renders only the visible
// rows. Search, sort by reactions, filter replies, copy the corpus, export JSON.
export default function FbCommentsTool() {
  // Storage is split: CKEY is the finished-scrape archive (up to 8 posts); LKEY
  // is the single post being streamed right now. During a live scrape only LKEY
  // changes, so the archive is never re-read/re-written per tick — the panel
  // updates from the change event's newValue directly (no re-get).
  const [archive, setArchive] = useState({});
  const [live, setLive] = useState(null);
  const [postId, setPostId] = useState(null);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState("order");
  const [filter, setFilter] = useState("all");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!hasStorage()) return;
    chrome.storage.local.get([CKEY, LKEY], (r) => {
      setArchive(r[CKEY] || {});
      setLive(r[LKEY] || null);
    });
    const onCh = (c, area) => {
      if (area !== "local") return;
      if (c[CKEY]) setArchive(c[CKEY].newValue || {});
      if (c[LKEY]) setLive(c[LKEY].newValue || null);
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  // The live post (while streaming) overrides its archived copy. Its scraped_at
  // is rewritten every flush, so if it's gone stale (>10 min) the scrape's tab
  // was navigated away mid-run — ignore the orphan rather than show it "scraping".
  const store = useMemo(() => {
    const m = { ...archive };
    const fresh = live?.post_id && Date.now() - (Date.parse(live.scraped_at) || 0) < 10 * 60 * 1000;
    if (fresh) m[live.post_id] = live;
    return m;
  }, [archive, live]);

  const posts = useMemo(
    () => Object.values(store).sort((a, b) => (Date.parse(b.scraped_at) || 0) - (Date.parse(a.scraped_at) || 0)),
    [store],
  );
  // While a scrape is streaming, follow that post; otherwise the user's pick / newest.
  const scraping = posts.find((p) => p.scraping);
  const active = (postId && store[postId]) || scraping || posts[0] || null;

  const rows = useMemo(() => {
    if (!active) return [];
    let list = active.comments || [];
    if (filter === "top") list = list.filter((c) => !c.is_reply);
    else if (filter === "replies") list = list.filter((c) => c.is_reply);
    if (q.trim()) {
      const s = q.toLowerCase();
      list = list.filter(
        (c) => (c.text || "").toLowerCase().includes(s) || (c.author?.name || "").toLowerCase().includes(s),
      );
    }
    if (sortKey === "reactions") list = [...list].sort((a, b) => (b.reactions || 0) - (a.reactions || 0));
    return list;
  }, [active, filter, q, sortKey]);

  // ---- virtualization ----
  const parentRef = useRef(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 66,
    overscan: 10,
    getItemKey: (i) => rowKey(rows[i]),
  });

  const copyAll = async () => {
    const text = rows.map((c) => `${c.author?.name || "?"}${c.is_reply ? " (reply)" : ""}: ${c.text || ""}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const clearPost = async () => {
    if (!active || !hasStorage()) return;
    const r = await chrome.storage.local.get([CKEY, LKEY]);
    const nextArchive = { ...(r[CKEY] || {}) };
    delete nextArchive[active.post_id];
    const upd = { [CKEY]: nextArchive };
    if (r[LKEY]?.post_id === active.post_id) upd[LKEY] = null; // also drop the live copy
    await chrome.storage.local.set(upd);
    setPostId(null);
  };

  if (!posts.length)
    return (
      <p className="text-sm text-muted-foreground py-8 text-center leading-relaxed">
        Nenhum comentário coletado ainda.<br />
        Abra um reel/post do Facebook e toque no botão <span className="font-medium text-foreground">💬 comentário</span> na
        barra de vídeos — a conversa aparece aqui em tempo real.
      </p>
    );

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex h-[calc(100dvh-190px)] min-h-[320px] flex-col gap-2.5">
      {/* post selector + refresh (jump to the newest / streaming scrape) */}
      <ToolBar>
        {posts.length > 1 && (
          <ToolSelect
            label="Post"
            value={active?.post_id || ""}
            onValueChange={setPostId}
            options={posts.map((p) => ({
              value: p.post_id,
              label: `${p.scraping ? "⏳ " : ""}${p.post_id} · ${p.count} comentários`,
              short: `${p.scraping ? "⏳ " : ""}${p.post_id}`,
            }))}
          />
        )}
        <ToolIconButton
          icon={RotateCw}
          label="Atualizar"
          hint="Atualizar — ir para a coleta mais recente / em andamento"
          className="ml-auto"
          onClick={() => setPostId(null)}
        />
      </ToolBar>

      {/* controls */}
      <ToolBar>
        {/* min-w-0 on the wrapper is required: an <input> has an intrinsic
            min-content width (~20 chars), so a flex-1 wrapper without it will
            not shrink and pushes the sorter off the panel. */}
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pesquisar texto / autor" className="h-8 min-w-0 pl-7 text-xs" />
        </div>
        <ToolSelect
          label="Ordenar por"
          value={sortKey}
          onValueChange={setSortKey}
          options={SORT_OPTS}
          className="max-w-[130px]"
        />
      </ToolBar>

      {/* filter pills + counts — flex-wrap, not truncate: when the pills and the
          tally can't share a line the tally moves to its own line instead of
          losing words. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex shrink-0 gap-1">
          {[["all", "Todos"], ["top", "Principais"], ["replies", "Respostas"]].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              title={l}
              aria-label={l}
              aria-pressed={filter === k}
              className={
                "rounded-md px-2 py-1 text-[11px] font-medium transition-colors " +
                (filter === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")
              }
            >
              {l}
            </button>
          ))}
        </div>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          {active.scraping && <Loader2 className="size-3 shrink-0 animate-spin text-sky-500" />}
          {rows.length} exibidos · {active.count}{active.scraping ? "…" : " no total"}
        </span>
      </div>

      {/* actions */}
      <ToolBar>
        <ActionButton
          icon={copied ? Check : Copy}
          label={copied ? "Copiado" : "Copiar texto"}
          variant="secondary"
          className="h-8 basis-0 grow"
          onClick={copyAll}
        />
        <ActionButton
          icon={Download}
          label="JSON"
          hint="Exportar a conversa como JSON"
          variant="outline"
          className="h-8 basis-0 grow"
          onClick={() =>
            jsonDownload(
              downloadPath("facebook", "comments", `fb-comments-${active.post_id}.json`),
              active,
            )
          }
        />
        <ToolIconButton
          icon={Trash2}
          label="Limpar este post"
          variant="ghost"
          iconClassName="text-muted-foreground"
          onClick={clearPost}
        />
      </ToolBar>

      {/* virtualized comment list */}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {items.map((vi) => (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
            >
              <div className="pb-1.5">
                <CommentRow c={rows[vi.index]} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
