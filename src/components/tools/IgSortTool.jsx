import { useCallback, useEffect, useState } from "react";
import {
  Download,
  Bookmark,
  ArrowUp,
  ArrowDown,
  Heart,
  MessageCircle,
  Eye,
  Zap,
  Repeat2,
  Calendar,
  Play,
  Images,
  Image as ImageIcon,
  ImageDown,
  FileText,
  Loader2,
  Copy,
  Check,
  X,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ToolBar, ActionButton, ToolIconButton, ToolSelect } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { useContentLink } from "@/lib/useContentLink";
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
} from "@/lib/igMedia";

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label — a whole word, never an ellipsis. Values are unchanged.
const SORT_OPTS = [
  { value: "default", label: "Padrão" },
  { value: "views", label: "Visualizações", short: "Visualiz." },
  { value: "likes", label: "Curtidas" },
  { value: "comments", label: "Comentários", short: "Coment." },
  { value: "er", label: "TE %" },
  { value: "date", label: "Data" },
];
const TYPE_ICON = { carousel: Images, video: Play, photo: ImageIcon };

// Small frosted icon button overlaid on a card thumbnail.
function IconBtn({ children, ...props }) {
  return (
    <button
      {...props}
      className="grid size-6 place-items-center rounded-md bg-black/65 text-white transition-colors hover:bg-black/80 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// Instagram Sort + Download. Reads the passive JSON.parse capture (via the IG
// content bridge, FBW_IG_LIST), sorts it in-panel as a 2-col grid of 9:16 cards
// with a right-side stat rail, and downloads media/thumbnail via FBW_DL_MEDIA.
export default function IgSortTool() {
  const [records, setRecords] = useState([]);
  const [surface, setSurface] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState("default");
  const [sortDir, setSortDir] = useState("desc");
  const [busy, setBusy] = useState({}); // id -> 'downloading'|'done'|'error'
  const [overlay, setOverlay] = useState(true);
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("instagram");

  useEffect(() => {
    chrome?.storage?.local?.get("sw_ig_overlay").then((r) => {
      if (r?.sw_ig_overlay != null) setOverlay(!!r.sw_ig_overlay);
    });
  }, []);
  const toggleOverlay = (v) => {
    setOverlay(v);
    chrome?.storage?.local?.set({ sw_ig_overlay: v });
  };

  // Live mirrors of the shared stores: transcript status per post (spinner /
  // green / red on the card button; green opens the transcript) and saved ids
  // (yellow-filled bookmark). Both update via storage.onChanged.
  const [txMap, setTxMap] = useState({});
  const [savedIds, setSavedIds] = useState({});
  const [txModal, setTxModal] = useState(null); // { id, username, text }
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
    const onCh = (c, area) => {
      if (area === "local" && (c.fbw_transcripts || c.fbw_saved)) load();
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  const listFromTab = useCallback(async () => {
    const res = await send({ type: "FBW_IG_LIST" });
    if (res && Array.isArray(res.records)) {
      setRecords(res.records);
      setSurface(res.surface || null);
    }
  }, [send]);

  useEffect(() => {
    listFromTab();
    return startPolling(listFromTab, 2500); // skips ticks while the panel is hidden
  }, [listFromTab]);

  // Drop everything captured so far (other profiles/hashtags) and re-pull the
  // current surface — so switching context doesn't leave stale posts in the grid.
  const refresh = useCallback(async () => {
    setRecords([]);
    // userAction: the user pressed Atualizar and is owed an answer either way.
    await send({ type: "FBW_IG_CLEAR" }, { userAction: true, action: "limpar a captura" });
    listFromTab();
  }, [send, listFromTab]);

  const scoped = showAll ? records : filterBySurface(records, surface);
  const sorted = sortRecords(scoped, sortKey, sortDir);

  const bg = (msg) =>
    new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));

  const setStatus = (id, s) => setBusy((b) => ({ ...b, [id]: s }));

  async function downloadRecord(rec) {
    const id = rec.code || rec.pk;
    setStatus(id, "downloading");
    try {
      if (rec.media_type === "carousel" && Array.isArray(rec.carousel)) {
        let i = 0;
        for (const child of rec.carousel) {
          i += 1;
          const isVid = child.media_type === "video" && child.video;
          const url = isVid ? child.video : child.image;
          if (!url) continue;
          await bg({
            type: "FBW_DL_MEDIA",
            kind: isVid ? "video" : "image",
            url,
            filename: filenameFor(rec, extFromUrl(url, isVid ? "video" : "image"), i),
          });
        }
      } else if (rec.video) {
        await bg({
          type: "FBW_DL_MEDIA",
          kind: "video",
          url: rec.video,
          filename: filenameFor(rec, extFromUrl(rec.video, "video")),
        });
      } else if (rec.image) {
        await bg({
          type: "FBW_DL_MEDIA",
          kind: "image",
          url: rec.image,
          filename: filenameFor(rec, extFromUrl(rec.image, "image")),
        });
      }
      setStatus(id, "done");
    } catch {
      setStatus(id, "error");
    }
  }

  // Download just the cover image (thumbnail), suffixed -thumb.
  async function downloadThumb(rec) {
    const id = rec.code || rec.pk;
    const url = rec.image || rec.thumb;
    if (!url) return;
    setStatus(id, "downloading");
    try {
      const ext = extFromUrl(url, "image");
      const filename = filenameFor(rec, ext).replace(
        new RegExp("\\." + ext + "$"),
        "-thumb." + ext,
      );
      await bg({ type: "FBW_DL_MEDIA", kind: "image", url, filename });
      setStatus(id, "done");
    } catch {
      setStatus(id, "error");
    }
  }

  async function downloadAll() {
    for (const rec of sorted) {
      await downloadRecord(rec);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // Toggle: first tap saves to the shared Library, second removes.
  async function saveToLibrary(rec) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      const id = rec.code || rec.pk;
      if (map[id]) {
        delete map[id];
        await chrome.storage.local.set({ fbw_saved: map });
        return;
      }
      map[id] = {
        videoId: id,
        platform: "instagram",
        thumb: rec.thumb || rec.image || null,
        caption: rec.caption || null,
        author: { name: rec.username || rec.full_name || "desconhecido", url: rec.username ? `/${rec.username}/` : null },
        counts: {
          like: rec.like_count != null ? fmtCount(rec.like_count) : null,
          comment: rec.comment_count != null ? fmtCount(rec.comment_count) : null,
          views: rec.play_count != null ? fmtCount(rec.play_count) : null,
        },
        code: rec.code || null,
        pk: rec.pk || null,
        media_type: rec.media_type || null,
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch {
      /* ignore */
    }
  }

  // Transcribe a reel: hand the background the direct MP4 URL (captured via the
  // always-on full-stats fetch). It reuses the same Whisper pipeline as Facebook;
  // the result streams into fbw_transcripts → Library → Transcripts.
  function transcribe(rec) {
    const id = rec.code || rec.pk;
    if (!rec.video) return;
    chrome.runtime.sendMessage({
      type: "FBW_TRANSCRIBE",
      videoId: id,
      mediaUrl: rec.video,
      platform: "instagram",
      caption: rec.caption || null,
      author: {
        name: rec.username || rec.full_name || "desconhecido",
        url: rec.username ? `/${rec.username}/` : null,
      },
      thumb: rec.thumb || rec.image || null,
      counts: {
        like: rec.like_count != null ? fmtCount(rec.like_count) : null,
        comment: rec.comment_count != null ? fmtCount(rec.comment_count) : null,
        views: rec.play_count != null ? fmtCount(rec.play_count) : null,
      },
    });
    setTxMap((m) => ({ ...m, [id]: "running" })); // optimistic; store listener corrects
  }

  // Green button → read the finished transcript from the shared store and show
  // it in a small modal with one-tap copy.
  async function openTranscript(rec) {
    const id = rec.code || rec.pk;
    const r = await chrome.storage.local.get("fbw_transcripts");
    const t = (r.fbw_transcripts || {})[id];
    if (!t?.text) return;
    setCopied(false);
    setTxModal({ id, username: rec.username || rec.full_name || "desconhecido", text: t.text });
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

  return (
    <div className="space-y-3">
      {banner}
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
          hint="Baixar todos os posts listados"
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

      <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <Label htmlFor="ig-overlay" className="min-w-0 text-xs text-foreground cursor-pointer">
          Sobreposição de estatísticas no Instagram
        </Label>
        <Switch id="ig-overlay" className="shrink-0" checked={overlay} onCheckedChange={toggleOverlay} />
      </div>


      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Role o feed do Instagram para coletar posts e ordená-los aqui.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {sorted.map((rec) => {
            const c = recordToCard(rec);
            const st = busy[c.id];
            const er = engagementRate(rec);
            const TypeIcon = TYPE_ICON[c.type] || ImageIcon;
            return (
              <div
                key={c.id}
                className="group relative aspect-[9/16] overflow-hidden rounded-xl bg-muted ring-1 ring-black/5"
              >
                {c.thumb ? (
                  c.permalink ? (
                    <a href={c.permalink} target="_blank" rel="noreferrer" className="absolute inset-0">
                      <img src={c.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                    </a>
                  ) : (
                    <img src={c.thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                  )
                ) : null}

                {/* actions — top-left */}
                <div className="absolute left-1.5 top-1.5 flex flex-col gap-1">
                  <IconBtn
                    title={savedIds[c.id] ? "Salvo — toque para remover" : "Salvar na biblioteca"}
                    onClick={() => saveToLibrary(rec)}
                  >
                    <Bookmark
                      className={
                        "size-3.5 " + (savedIds[c.id] ? "fill-yellow-400 text-yellow-400" : "")
                      }
                    />
                  </IconBtn>
                  <IconBtn
                    title="Baixar mídia"
                    onClick={() => downloadRecord(rec)}
                    disabled={st === "downloading"}
                  >
                    <Download
                      className={
                        "size-3.5 " +
                        (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")
                      }
                    />
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
                      onClick={() =>
                        txMap[c.id] === "done" ? openTranscript(rec) : transcribe(rec)
                      }
                      disabled={txMap[c.id] === "running"}
                    >
                      {txMap[c.id] === "running" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <FileText
                          className={
                            "size-3.5 " +
                            (txMap[c.id] === "done"
                              ? "text-emerald-400"
                              : txMap[c.id] === "error"
                                ? "text-red-400"
                                : "")
                          }
                        />
                      )}
                    </IconBtn>
                  )}
                </div>

                {/* media type — top-right, opens the post */}
                <a
                  href={c.permalink || undefined}
                  target="_blank"
                  rel="noreferrer"
                  title="Abrir no Instagram"
                  className="absolute right-1.5 top-1.5 grid place-items-center rounded-md bg-black/65 p-1 text-white transition-colors hover:bg-black/80"
                >
                  <TypeIcon className="size-3.5" />
                </a>

                {/* stat rail — right side, subtle blue glow */}
                <div className="absolute bottom-9 right-1.5 flex flex-col items-end gap-0.5 rounded-lg border border-sky-400/30 bg-black/60 px-2 py-1.5 text-white shadow-[0_0_10px_rgba(56,130,246,0.28)]">
                  {c.views != null && (
                    <div className="flex items-center gap-1 text-[14px] font-extrabold leading-none">
                      <Eye className="size-3.5" />
                      {fmtCount(c.views)}
                    </div>
                  )}
                  <div
                    className={
                      "flex items-center gap-1 leading-none " +
                      (c.views == null ? "text-[14px] font-extrabold" : "text-[11.5px] font-bold")
                    }
                  >
                    <Heart className={c.views == null ? "size-3.5" : "size-3"} />
                    {fmtCount(c.likes)}
                  </div>
                  <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                    <MessageCircle className="size-3" />
                    {fmtCount(c.comments)}
                  </div>
                  {c.reposts != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Repeat2 className="size-3" />
                      {fmtCount(c.reposts)}
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

      {/* transcript viewer — small modal with one-tap copy */}
      {txModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
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
