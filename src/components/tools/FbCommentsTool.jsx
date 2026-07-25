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
  ArrowDownUp,
  Loader2,
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
import { fmtCount } from "@/lib/fbReels";

const CKEY = "fbw_comments"; // archive: { post_id -> envelope }, ≤8 posts
const LKEY = "fbw_comments_live"; // single post currently streaming
const hasStorage = () => typeof chrome !== "undefined" && !!chrome?.storage?.local;

function jsonDownload(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

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
            {c.author?.name || "unknown"}
          </a>
        ) : (
          <span className="truncate text-[12px] font-semibold text-foreground">{c.author?.name || "unknown"}</span>
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
        <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/85">{c.text}</p>
      ) : (
        <p className="text-[11px] italic text-muted-foreground">(no text — sticker / media)</p>
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
    getItemKey: (i) => rows[i].comment_id || i,
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
        No comments scraped yet.<br />
        Open a Facebook reel/post and hit the <span className="font-medium text-foreground">💬 comment</span> button in the
        video rail — the thread streams in here.
      </p>
    );

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex h-[calc(100dvh-190px)] min-h-[320px] flex-col gap-2.5">
      {/* post selector + refresh (jump to the newest / streaming scrape) */}
      <div className="flex items-center gap-2">
        {posts.length > 1 && (
          <Select value={active?.post_id || ""} onValueChange={setPostId}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {posts.map((p) => (
                <SelectItem key={p.post_id} value={p.post_id}>
                  {p.scraping ? "⏳ " : ""}{p.post_id} · {p.count} comments
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          size="icon"
          className="ml-auto shrink-0"
          onClick={() => setPostId(null)}
          title="Refresh — jump to the newest / streaming scrape"
        >
          <RotateCw />
        </Button>
      </div>

      {/* controls */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text / author" className="h-8 pl-7 text-xs" />
        </div>
        <Select value={sortKey} onValueChange={setSortKey}>
          <SelectTrigger className="h-8 w-[112px] text-xs">
            <ArrowDownUp className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="order">Thread order</SelectItem>
            <SelectItem value="reactions">Reactions</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* filter pills + counts */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {[["all", "All"], ["top", "Top-level"], ["replies", "Replies"]].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={
                "rounded-md px-2 py-1 text-[11px] font-medium transition-colors " +
                (filter === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")
              }
            >
              {l}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {active.scraping && <Loader2 className="size-3 animate-spin text-sky-500" />}
          {rows.length} shown · {active.count}{active.scraping ? "…" : " total"}
        </span>
      </div>

      {/* actions */}
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" className="h-8 flex-1 text-xs" onClick={copyAll}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy text"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-1 text-xs"
          onClick={() => jsonDownload(`fb-comments-${active.post_id}.json`, active)}
        >
          <Download className="size-3.5" /> JSON
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Clear this post" onClick={clearPost}>
          <Trash2 className="size-3.5 text-muted-foreground" />
        </Button>
      </div>

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
