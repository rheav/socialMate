import { useCallback, useEffect, useState } from "react";
import {
  Bookmark,
  ArrowUp,
  ArrowDown,
  Eye,
  MessageCircle,
  Share2,
  ImageDown,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { ToolBar, ActionButton, ToolIconButton, ToolSelect } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { useContentLink } from "@/lib/useContentLink";
import { requireOk } from "@/lib/bg";
import { buildSavedEntry } from "@/lib/shared/savedEntry";
import { sortRecords, recordToCard, filenameFor, fmtCount } from "@/lib/fbReels";
import { startPolling } from "@/lib/poll";
import { useItemStatus, statusKey, statusTitle } from "@/lib/useItemStatus";

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label — a whole word, never an ellipsis. Values are unchanged.
const SORT_OPTS = [
  { value: "default", label: "Padrão" },
  { value: "views", label: "Visualizações", short: "Visualiz." },
  { value: "comments", label: "Comentários", short: "Coment." },
  { value: "shares", label: "Compartilhamentos", short: "Compart." },
];

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

// Facebook Reels Sort — reads the reels-tab grid (DOM tiles + initial embedded
// JSON, via the FB reels-capture content script), sorts it in-panel as a 2-col
// grid of 9:16 cards with a right-side stat rail (views / comments / shares),
// and downloads thumbnails or saves reels to the shared Library.
export default function FbReelsTool() {
  const [records, setRecords] = useState([]);
  const [owner, setOwner] = useState(null);
  const [onReelsTab, setOnReelsTab] = useState(true);
  const [sortKey, setSortKey] = useState("views");
  const [sortDir, setSortDir] = useState("desc");
  const [harvesting, setHarvesting] = useState(false);
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("facebook");

  // Saved-ids mirror (yellow-filled bookmark), live via storage.onChanged.
  const [savedIds, setSavedIds] = useState({});
  useEffect(() => {
    if (!chrome?.storage?.local) return;
    const load = () =>
      chrome.storage.local.get("fbw_saved", (r) => {
        const s = {};
        for (const k in r.fbw_saved || {}) s[k] = true;
        setSavedIds(s);
      });
    load();
    const onCh = (c, area) => { if (area === "local" && c.fbw_saved) load(); };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  const apply = useCallback((res) => {
    if (!res || !Array.isArray(res.records)) return;
    setRecords(res.records);
    setOwner(res.owner || null);
    setOnReelsTab(!!res.onReelsTab);
  }, []);

  const listFromTab = useCallback(async () => {
    apply(await send({ type: "FBW_FB_REELS_LIST" }));
  }, [send, apply]);

  useEffect(() => {
    listFromTab();
    return startPolling(listFromTab, 3000); // skips ticks while the panel is hidden
  }, [listFromTab]);

  // Auto-scroll the FB grid to load every reel, then take the full list.
  async function collectAll() {
    setHarvesting(true);
    try {
      // userAction: a click that can't reach the page says so at once.
      apply(
        await send(
          { type: "FBW_FB_REELS_HARVEST" },
          { userAction: true, action: "coletar os reels" },
        ),
      );
    } finally {
      setHarvesting(false);
    }
  }

  const sorted = sortRecords(records, sortKey, sortDir);

  // Per-action status. The thumbnail is the only action routed through this hook
  // (the card's save button reports through the savedIds mirror instead), so the
  // record's primary key is enough — and a failure now keeps its reason for the
  // button's tooltip instead of only painting the icon red.
  const { run, statusOf, errorOf } = useItemStatus();

  async function downloadThumb(rec) {
    if (!rec.thumb) return;
    await run(statusKey(rec.id), () =>
      requireOk({ type: "FBW_DL_MEDIA", kind: "image", url: rec.thumb, filename: filenameFor(owner, rec.id) }),
    );
  }

  async function downloadAllThumbs() {
    for (const rec of sorted) {
      await downloadThumb(rec);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Toggle: first tap saves the reel to the shared Library, second removes.
  // The background owns the write (serialized, so the panel and a page overlay
  // can't clobber each other) and replies with the state AFTER the toggle.
  async function saveToLibrary(rec) {
    // Counts go in RAW — fmtCount is render-time only (see the stat rail below).
    const entry = buildSavedEntry({
      id: rec.id,
      platform: "facebook",
      thumb: rec.thumb,
      authorName: owner,
      counts: { comment: rec.comments, share: rec.shares, view: rec.views },
    });
    if (!entry) return;
    try {
      const { saved } = await requireOk({ type: "FBW_SAVED_TOGGLE", entry });
      // Trust the reply over guessing; the storage.onChanged mirror above also
      // re-syncs, so this only removes the one-tick lag.
      setSavedIds((s) => {
        const next = { ...s };
        if (saved) next[rec.id] = true;
        else delete next[rec.id];
        return next;
      });
    } catch (e) {
      console.warn("[fbw] falha ao salvar reel na biblioteca", e);
    }
  }

  // One banner for every link failure, rendered in every branch below so the
  // explanation (and its fix) can never be hidden by an empty state.
  const banner = (
    <ContentLinkBanner
      link={link}
      platformName="Facebook"
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
        <ActionButton
          icon={harvesting ? Loader2 : RefreshCw}
          iconClassName={harvesting ? "animate-spin" : undefined}
          label={harvesting ? "Coletando" : "Coletar tudo"}
          hint="Rolar a grade para carregar todos os reels"
          variant="secondary"
          onClick={collectAll}
          disabled={harvesting}
        />
      </ToolBar>

      {/* flex-wrap, not truncate: the action drops to its own line instead of
          the owner name losing characters. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 break-words">
          {sorted.length} reels{owner ? ` · ${owner}` : ""}
        </span>
        <button
          className="shrink-0 underline disabled:opacity-50"
          onClick={downloadAllThumbs}
          disabled={!sorted.length}
        >
          baixar todas as miniaturas
        </button>
      </div>

      {!onReelsTab && (
        <div className="rounded-md bg-amber-500/10 text-amber-700 text-[11px] px-3 py-2">
          Abra a aba <span className="font-semibold">Reels</span> do perfil no Facebook e toque em Coletar tudo.
        </div>
      )}

      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Abra a aba Reels de um perfil e toque em <span className="font-medium text-foreground">Coletar tudo</span> para carregar e ordenar os reels aqui.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {sorted.map((rec) => {
            const c = recordToCard(rec);
            const st = statusOf(statusKey(c.id));
            return (
              <div
                key={c.id}
                className="group relative aspect-[9/16] overflow-hidden rounded-xl bg-muted ring-1 ring-black/5"
              >
                {c.thumb ? (
                  <a href={c.permalink} target="_blank" rel="noreferrer" className="absolute inset-0">
                    <img src={c.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  </a>
                ) : null}

                {/* actions — top-left */}
                <div className="absolute left-1.5 top-1.5 flex flex-col gap-1">
                  <IconBtn
                    title={savedIds[c.id] ? "Salvo — toque para remover" : "Salvar na biblioteca"}
                    onClick={() => saveToLibrary(rec)}
                  >
                    <Bookmark className={"size-3.5 " + (savedIds[c.id] ? "fill-yellow-400 text-yellow-400" : "")} />
                  </IconBtn>
                  <IconBtn
                    title={statusTitle("Baixar miniatura", st, errorOf(statusKey(c.id)))}
                    onClick={() => downloadThumb(rec)}
                    disabled={st === "downloading"}
                  >
                    {st === "downloading" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ImageDown className={"size-3.5 " + (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")} />
                    )}
                  </IconBtn>
                </div>

                {/* stat rail — right side, subtle blue glow */}
                <div className="absolute bottom-9 right-1.5 flex flex-col items-end gap-0.5 rounded-lg border border-sky-400/30 bg-black/60 px-2 py-1.5 text-white shadow-[0_0_10px_rgba(56,130,246,0.28)]">
                  <div className="flex items-center gap-1 text-[14px] font-extrabold leading-none">
                    <Eye className="size-3.5" />
                    {c.views != null ? fmtCount(c.views) : "—"}
                  </div>
                  {c.comments != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <MessageCircle className="size-3" />
                      {fmtCount(c.comments)}
                    </div>
                  )}
                  {c.shares != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Share2 className="size-3" />
                      {fmtCount(c.shares)}
                    </div>
                  )}
                </div>

                {/* open-on-facebook — bottom gradient */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6">
                  <a
                    href={c.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="pointer-events-auto block max-w-[70%] truncate text-[12px] font-semibold text-white"
                  >
                    Abrir reel
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
