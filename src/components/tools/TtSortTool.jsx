import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Bookmark,
  ArrowUp,
  ArrowDown,
  Heart,
  MessageCircle,
  Eye,
  Zap,
  Share2,
  Calendar,
  Play,
  ImageDown,
  FileText,
  Loader2,
  Copy,
  Check,
  X,
  Pin,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolBar, ActionButton, ToolIconButton, ToolSelect } from "@/components/ui/ToolBar";
import { resolvePlatformTab } from "@/lib/tabs";
import { startPolling } from "@/lib/poll";
import {
  sortRecords,
  recordToCard,
  filenameFor,
  extFromUrl,
  fmtCount,
  filterBySurface,
  engagementRate,
  fmtER,
} from "@/lib/ttMedia";

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label — a whole word, never an ellipsis. Values are unchanged.
const SORT_OPTS = [
  { value: "default", label: "Padrão" },
  { value: "views", label: "Visualizações", short: "Visualiz." },
  { value: "likes", label: "Curtidas" },
  { value: "comments", label: "Comentários", short: "Coment." },
  { value: "shares", label: "Compartilhamentos", short: "Compart." },
  { value: "saves", label: "Salvamentos", short: "Salvos" },
  { value: "er", label: "TE %" },
  { value: "date", label: "Data" },
];

// Small icon button overlaid on a card thumbnail.
function IconBtn({ children, ...props }) {
  return (
    <button
      {...props}
      className="grid size-6 place-items-center rounded-md bg-black/55 text-white transition-colors hover:bg-black/80 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// TikTok Sort + Download. Reads the passive fetch capture (via the TikTok content
// bridge, FBW_TT_LIST), sorts it in-panel as a 2-col grid of 9:16 cards with a
// right-side stat rail, and downloads media/thumbnail via FBW_DL_MEDIA. TikTok
// exposes shares AND saves on the list (Instagram doesn't), so the rail is richer.
export default function TtSortTool() {
  const [records, setRecords] = useState([]);
  const [surface, setSurface] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState("default");
  const [sortDir, setSortDir] = useState("desc");
  const [noTab, setNoTab] = useState(false);
  const [busy, setBusy] = useState({}); // id -> 'downloading'|'done'|'error'
  const tabId = useRef(null);

  const [txMap, setTxMap] = useState({});
  const [savedIds, setSavedIds] = useState({});
  const [txModal, setTxModal] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!chrome?.storage?.local) return;
    const load = () =>
      chrome.storage.local.get(["fbw_transcripts", "fbw_saved"], (r) => {
        const m = r.fbw_transcripts || {};
        const out = {};
        for (const k in m) out[k] = m[k].status;
        setTxMap(out);
        const s = {};
        for (const k in r.fbw_saved || {}) s[k] = true;
        setSavedIds(s);
      });
    load();
    const onCh = (ch, area) => {
      if (area === "local" && (ch.fbw_transcripts || ch.fbw_saved)) load();
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  const listFromTab = useCallback(async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("tiktok");
    if (tabId.current == null) {
      setNoTab(true);
      return;
    }
    setNoTab(false);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_TT_LIST" });
      if (res && Array.isArray(res.records)) {
        setRecords(res.records);
        setSurface(res.surface || null);
      }
    } catch {
      tabId.current = null;
    }
  }, []);

  useEffect(() => {
    listFromTab();
    return startPolling(listFromTab, 2500); // skips ticks while the panel is hidden
  }, [listFromTab]);

  // Drop everything captured so far (other profiles/surfaces) and re-pull the
  // current one — so switching context doesn't leave stale videos in the grid.
  const refresh = useCallback(async () => {
    setRecords([]);
    try {
      if (tabId.current == null) tabId.current = await resolvePlatformTab("tiktok");
      if (tabId.current != null) await chrome.tabs.sendMessage(tabId.current, { type: "FBW_TT_CLEAR" });
    } catch {
      tabId.current = null;
    }
    listFromTab();
  }, [listFromTab]);

  const scoped = showAll ? records : filterBySurface(records, surface);
  const sorted = sortRecords(scoped, sortKey, sortDir);

  const bg = (msg) =>
    new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));
  const setStatus = (id, s) => setBusy((b) => ({ ...b, [id]: s }));

  async function downloadRecord(rec) {
    setStatus(rec.id, "downloading");
    try {
      const url = rec.hd_url || rec.download_url || rec.video; // always highest quality
      if (!url) throw new Error("no video url");
      await bg({
        type: "FBW_DL_MEDIA",
        kind: "video",
        url,
        filename: filenameFor(rec, extFromUrl(url, "video")),
      });
      setStatus(rec.id, "done");
    } catch {
      setStatus(rec.id, "error");
    }
  }

  async function downloadThumb(rec) {
    const url = rec.cover || rec.dynamic_cover;
    if (!url) return;
    setStatus(rec.id, "downloading");
    try {
      const ext = extFromUrl(url, "image");
      const filename = filenameFor(rec, ext).replace(new RegExp("\\." + ext + "$"), "-thumb." + ext);
      await bg({ type: "FBW_DL_MEDIA", kind: "image", url, filename });
      setStatus(rec.id, "done");
    } catch {
      setStatus(rec.id, "error");
    }
  }

  async function downloadAll() {
    for (const rec of sorted) {
      await downloadRecord(rec);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function saveToLibrary(rec) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      if (map[rec.id]) {
        delete map[rec.id];
        await chrome.storage.local.set({ fbw_saved: map });
        return;
      }
      map[rec.id] = {
        videoId: rec.id,
        platform: "tiktok",
        thumb: rec.cover || rec.dynamic_cover || null,
        caption: rec.desc || null,
        author: {
          name: rec.username || rec.nickname || "desconhecido",
          url: rec.username ? `https://www.tiktok.com/@${rec.username}` : null,
        },
        counts: {
          like: rec.digg_count != null ? fmtCount(rec.digg_count) : null,
          comment: rec.comment_count != null ? fmtCount(rec.comment_count) : null,
          views: rec.play_count != null ? fmtCount(rec.play_count) : null,
        },
        code: rec.id,
        // Same shape as the transcribe path below — without it VideoCard falls back
        // to a dead facebook.com/reel/<id> link.
        sourceUrl: rec.username ? `https://www.tiktok.com/@${rec.username}/video/${rec.id}` : null,
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch {
      /* ignore */
    }
  }

  function transcribe(rec) {
    if (!rec.video && !rec.subtitle) return;
    chrome.runtime.sendMessage({
      type: "FBW_TRANSCRIBE",
      videoId: rec.id,
      mediaUrl: rec.video,
      platform: "tiktok",
      captionUrl: rec.subtitle?.url || null, // caption-first, skips Whisper
      captionFormat: rec.subtitle?.format || null,
      caption: rec.desc || null,
      author: {
        name: rec.username || rec.nickname || "desconhecido",
        url: rec.username ? `https://www.tiktok.com/@${rec.username}` : null,
      },
      thumb: rec.cover || rec.dynamic_cover || null,
      sourceUrl: rec.username ? `https://www.tiktok.com/@${rec.username}/video/${rec.id}` : null,
      counts: {
        like: rec.digg_count != null ? fmtCount(rec.digg_count) : null,
        comment: rec.comment_count != null ? fmtCount(rec.comment_count) : null,
        views: rec.play_count != null ? fmtCount(rec.play_count) : null,
      },
    });
    setTxMap((m) => ({ ...m, [rec.id]: "running" }));
  }

  async function openTranscript(rec) {
    const r = await chrome.storage.local.get("fbw_transcripts");
    const t = (r.fbw_transcripts || {})[rec.id];
    if (!t?.text) return;
    setCopied(false);
    setTxModal({ id: rec.id, username: rec.username || rec.nickname || "desconhecido", text: t.text });
  }

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(txModal.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  if (noTab)
    return (
      <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2">
        Abra o TikTok em uma aba (com login feito) e reabra este painel.
      </div>
    );

  return (
    <div className="space-y-3">
      <ToolBar>
        <ToolSelect label="Ordenar por" value={sortKey} onValueChange={setSortKey} options={SORT_OPTS} />
        <ToolIconButton
          icon={sortDir === "desc" ? ArrowDown : ArrowUp}
          label={sortDir === "desc" ? "Maior → menor" : "Menor → maior"}
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
        />
        <ToolIconButton
          icon={RotateCw}
          label="Atualizar"
          hint="Atualizar — descarta outras superfícies, recolhe esta"
          onClick={refresh}
        />
        <ActionButton
          icon={Download}
          label="Tudo"
          hint="Baixar todos os vídeos listados"
          variant="secondary"
          onClick={downloadAll}
          disabled={!sorted.length}
        />
      </ToolBar>

      {/* flex-wrap, not truncate: when the tally and the toggle can't share a
          line the toggle drops to its own line instead of losing words. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 break-words">
          {sorted.length} coletados{surface ? ` · ${surface}` : ""}
        </span>
        <button className="shrink-0 underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "restringir à superfície" : "mostrar tudo"}
        </button>
      </div>

      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Role um perfil / hashtag / feed do TikTok para coletar vídeos e ordená-los aqui.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {sorted.map((rec) => {
            const c = recordToCard(rec);
            const st = busy[c.id];
            const er = engagementRate(rec);
            return (
              <div
                key={c.id}
                className="group relative aspect-[9/16] overflow-hidden rounded-xl bg-muted ring-1 ring-black/5"
              >
                {c.thumb ? (
                  c.permalink ? (
                    <a href={c.permalink} target="_blank" rel="noreferrer" className="absolute inset-0">
                      <img src={c.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                    </a>
                  ) : (
                    <img src={c.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" />
                  )
                ) : null}

                {/* actions — top-left */}
                <div className="absolute left-1.5 top-1.5 flex flex-col gap-1">
                  <IconBtn
                    title={savedIds[c.id] ? "Salvo — toque para remover" : "Salvar na biblioteca"}
                    onClick={() => saveToLibrary(rec)}
                  >
                    <Bookmark className={"size-3.5 " + (savedIds[c.id] ? "fill-yellow-400 text-yellow-400" : "")} />
                  </IconBtn>
                  <IconBtn title="Baixar vídeo" onClick={() => downloadRecord(rec)} disabled={st === "downloading"}>
                    <Download className={"size-3.5 " + (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")} />
                  </IconBtn>
                  <IconBtn title="Baixar miniatura" onClick={() => downloadThumb(rec)}>
                    <ImageDown className="size-3.5" />
                  </IconBtn>
                  {(rec.video || txMap[c.id] === "done") && (
                    <IconBtn
                      title={
                        txMap[c.id] === "done"
                          ? "Ver transcrição"
                          : txMap[c.id] === "error"
                            ? "Falha na transcrição — toque para tentar novamente"
                            : "Transcrever"
                      }
                      onClick={() => (txMap[c.id] === "done" ? openTranscript(rec) : transcribe(rec))}
                      disabled={txMap[c.id] === "running"}
                    >
                      {txMap[c.id] === "running" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <FileText className={"size-3.5 " + (txMap[c.id] === "done" ? "text-emerald-400" : txMap[c.id] === "error" ? "text-red-400" : "")} />
                      )}
                    </IconBtn>
                  )}
                </div>

                {/* type / pin — top-right, opens the video */}
                <a
                  href={c.permalink || undefined}
                  target="_blank"
                  rel="noreferrer"
                  title="Abrir no TikTok"
                  className="absolute right-1.5 top-1.5 grid place-items-center rounded-md bg-black/55 p-1 text-white transition-colors hover:bg-black/80"
                >
                  {c.pinned ? <Pin className="size-3.5" /> : <Play className="size-3.5" />}
                </a>

                {/* stat rail — right side, blue glow */}
                <div className="absolute bottom-9 right-1.5 flex flex-col items-end gap-0.5 rounded-lg border border-sky-400/30 bg-black/60 px-2 py-1.5 text-white shadow-[0_0_10px_rgba(56,130,246,0.28)]">
                  {c.views != null && (
                    <div className="flex items-center gap-1 text-[14px] font-extrabold leading-none">
                      <Eye className="size-3.5" />
                      {fmtCount(c.views)}
                    </div>
                  )}
                  <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                    <Heart className="size-3" />
                    {fmtCount(c.likes)}
                  </div>
                  <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                    <MessageCircle className="size-3" />
                    {fmtCount(c.comments)}
                  </div>
                  {c.shares != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Share2 className="size-3" />
                      {fmtCount(c.shares)}
                    </div>
                  )}
                  {c.saves != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Bookmark className="size-3" />
                      {fmtCount(c.saves)}
                    </div>
                  )}
                  {er != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Zap className="size-3" />
                      {fmtER(er)}
                    </div>
                  )}
                  {c.date && (
                    <div className="flex items-center gap-1 text-[10.5px] font-semibold leading-none opacity-90">
                      <Calendar className="size-3" />
                      {c.date}
                    </div>
                  )}
                </div>

                {/* @username — bottom-left */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6">
                  <a
                    href={c.permalink || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="pointer-events-auto block max-w-[60%] truncate text-[12px] font-semibold text-white"
                  >
                    @{c.username}
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {txModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
          onClick={() => setTxModal(null)}
        >
          <div
            className="flex max-h-[75vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <FileText className="size-4 text-emerald-500" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                @{txModal.username} · {txModal.id}
              </span>
              <button
                onClick={() => setTxModal(null)}
                className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-[12px] leading-relaxed text-foreground">
              {txModal.text}
            </div>
            <div className="border-t border-border p-2.5">
              <Button className="w-full" variant={copied ? "secondary" : "default"} onClick={copyTranscript}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copiado" : "Copiar transcrição"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
