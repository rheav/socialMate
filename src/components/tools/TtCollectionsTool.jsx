import { useCallback, useEffect, useState, useRef } from "react";
import { Download, Bookmark, RotateCw, Trash2, ListVideo, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { ToolBar, ActionButton } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { useContentLink } from "@/lib/useContentLink";
import { filenameFor, extFromUrl, fmtCount } from "@/lib/ttMedia";
import { startPolling } from "@/lib/poll";
import { requireOk } from "@/lib/bg";
import { buildSavedEntry } from "@/lib/shared/savedEntry";
import { useItemStatus, statusKey, statusTitle } from "@/lib/useItemStatus";
import IconBtn from "@/components/ui/IconBtn";

// TikTok Collections + Playlists. Reads the passive capture of /api/user/playlist
// + /api/user/collection_list (bucket metadata) and /api/mix|collection/item_list
// (the videos inside), via FBW_TT_LISTS. A creator's curated buckets surface their
// best-organized reference content. Videos load into a bucket once you open that
// playlist/collection on TikTok (passive).
export default function TtCollectionsTool() {
  const [lists, setLists] = useState([]);
  const [open, setOpen] = useState({});
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("tiktok");
  // The bridge answers {unchanged:true} when its store hasn't moved since the
  // version we last saw, which makes an idle poll near-free — it otherwise
  // re-serialises the whole store every 2.5s. `null` forces a full answer, which is
  // what Atualizar wants after a clear.
  const sinceRef = useRef(null);

  const pull = useCallback(async () => {
    const res = await send({ type: "FBW_TT_LISTS", since: sinceRef.current });
    if (!res || res.unchanged) return;
    sinceRef.current = res.version ?? sinceRef.current;
    if (res && Array.isArray(res.lists)) setLists(res.lists);
  }, [send]);

  useEffect(() => {
    return startPolling(pull, 2500); // skips ticks while the panel is hidden
  }, [pull]);

  const refresh = useCallback(async () => {
    sinceRef.current = null;
    setLists([]);
    // userAction: the user pressed Atualizar and is owed an answer either way.
    await send({ type: "FBW_TT_CLEAR" }, { userAction: true, action: "limpar a captura" });
    pull();
  }, [send, pull]);

  // FBW_TT_CLEAR is platform-global: it empties the capture behind every TikTok
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

  // Per-action status. The key is namespaced per action: a failed SAVE used to
  // share the record's key and so painted the video-download icon red.
  const { run, statusOf, errorOf } = useItemStatus();

  // Mirror fbw_saved so the bookmark reflects reality — without this the icon never
  // fills, so a toggle looks like a no-op and a second tap silently un-saves.
  const [savedIds, setSavedIds] = useState({});
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    const load = () =>
      chrome.storage.local.get("fbw_saved", (r) => {
        const s = {};
        for (const k in r.fbw_saved || {}) s[k] = true;
        setSavedIds(s);
      });
    load();
    const onCh = (c, area) => {
      if (area === "local" && c.fbw_saved) load();
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  async function download(item) {
    await run(statusKey(item.id), async () => {
      const url = item.hd_url || item.download_url || item.video;
      if (!url) throw new Error("sem URL de vídeo");
      await requireOk({ type: "FBW_DL_MEDIA", kind: "video", url, filename: filenameFor(item, extFromUrl(url, "video")) });
    });
  }
  async function save(item) {
    // The background owns the write (serialized) and decides insert-vs-remove by
    // whether the id is already in fbw_saved — no read-modify-write here.
    await run(statusKey(item.id, "save"), async () => {
      const entry = buildSavedEntry({
        id: item.id,
        platform: "tiktok",
        thumb: item.cover,
        caption: item.desc,
        // @handle first, nickname only as fallback — the precedence this pane and
        // both sibling TikTok writers (TtSortTool, tt-relay) have always used.
        authorName: item.username || item.nickname,
        username: item.username,
        counts: {
          like: item.digg_count,
          comment: item.comment_count,
          view: item.play_count,
          share: item.share_count,
          save: item.collect_count,
        },
        code: item.id,
      });
      await requireOk({ type: "FBW_SAVED_TOGGLE", entry });
    });
  }

  async function downloadAll(items) {
    for (const it of items) { await download(it); await new Promise((r) => setTimeout(r, 400)); }
  }

  // One banner for every link failure, rendered in every branch below so the
  // explanation (and its fix) can never be hidden by an empty state.
  const banner = (
    <ContentLinkBanner
      link={link}
      platformName="TikTok"
      fixing={fixing}
      onRevive={revive}
      onOpenTab={openTab}
    />
  );

  if (noTab) return banner;

  if (!lists.length)
    return (
      <div className="space-y-2">
        {banner}
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-muted-foreground">Visite um perfil do TikTok que tenha playlists/coleções para capturar as coleções aqui.</p>
          <p className="text-[11px] text-muted-foreground/70">Abra uma playlist para carregar os vídeos dela (passivo).</p>
        </div>
      </div>
    );

  return (
    <div className="space-y-2">
      {banner}
      <ToolBar className="justify-between">
        <span className="min-w-0 break-words text-[11px] text-muted-foreground">
          {lists.length} coleção(ões) capturada(s)
        </span>
        <ActionButton
          ref={clearBtnRef}
          icon={clearArmed ? Trash2 : RotateCw}
          label={clearArmed ? "Confirmar?" : "Atualizar"}
          hint={
            clearArmed
              ? "Toque de novo para confirmar — apaga a captura de Ordenar, Comentários, Stories e Playlists"
              : "Atualizar — limpa TODA a captura do TikTok (Ordenar, Comentários, Stories e Playlists), não só as coleções"
          }
          variant={clearArmed ? "destructive" : "outline"}
          onClick={onClearTap}
        />
      </ToolBar>

      {lists.map((L) => {
        const isOpen = !!open[L.list_id];
        const items = L.items || [];
        return (
          <div key={L.list_id} className="rounded-lg border border-border bg-card">
            <button
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
              onClick={() => setOpen((o) => ({ ...o, [L.list_id]: !o[L.list_id] }))}
            >
              {L.cover ? (
                <img src={L.cover} alt="" referrerPolicy="no-referrer" className="size-9 shrink-0 rounded object-cover" />
              ) : (
                <span className="grid size-9 shrink-0 place-items-center rounded bg-muted"><ListVideo className="size-4 text-muted-foreground" /></span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{L.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {L.kind === "collection" ? "Coleção" : "Playlist"} · {L.video_count ?? "?"} vídeos
                  {items.length ? ` · ${items.length} capturados` : ""}
                </div>
              </div>
              {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            </button>

            {isOpen && (
              <div className="border-t border-border p-2">
                {!items.length ? (
                  <p className="py-3 text-center text-[11px] text-muted-foreground">Abra esta {L.kind === "collection" ? "coleção" : "playlist"} no TikTok para carregar os vídeos dela.</p>
                ) : (
                  <>
                    {/* ToolBar here too, so the container measures the width
                        INSIDE the card, not the panel's. */}
                    <ToolBar className="mb-2 justify-end">
                      <ActionButton
                        icon={Download}
                        label="Tudo em HD"
                        hint="Baixar todos os vídeos desta coleção em HD"
                        variant="secondary"
                        onClick={() => downloadAll(items)}
                      />
                    </ToolBar>
                    <div className="grid grid-cols-3 gap-1.5">
                      {items.map((item) => {
                        const st = statusOf(statusKey(item.id));
                        const stSave = statusOf(statusKey(item.id, "save"));
                        return (
                          <div key={item.id} className="group relative aspect-[9/16] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5">
                            {item.cover ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" /> : null}
                            <div className="absolute left-1 top-1 flex flex-col gap-1">
                              <IconBtn title={statusTitle("Baixar vídeo em HD", st, errorOf(statusKey(item.id)))} onClick={() => download(item)} disabled={st === "downloading"}>
                                <Download className={"size-3.5 " + (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")} />
                              </IconBtn>
                              <IconBtn
                                title={statusTitle(
                                  savedIds[item.id] ? "Salvo — toque para remover" : "Salvar na biblioteca",
                                  stSave,
                                  errorOf(statusKey(item.id, "save")),
                                )}
                                onClick={() => save(item)}
                                disabled={stSave === "downloading"}
                              >
                                <Bookmark
                                  className={
                                    "size-3.5 " +
                                    (stSave === "error"
                                      ? "text-red-400"
                                      : savedIds[item.id]
                                        ? "fill-current text-amber-300"
                                        : "")
                                  }
                                />
                              </IconBtn>
                            </div>
                            {item.play_count != null && (
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[9.5px] font-semibold text-white">
                                <span className="inline-flex items-center gap-0.5"><Eye className="size-2.5" />{fmtCount(item.play_count)}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
