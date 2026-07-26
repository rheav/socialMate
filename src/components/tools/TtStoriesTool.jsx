import { useCallback, useEffect, useState } from "react";
import { Download, FileText, Loader2, Bookmark, RotateCw, Eye, Heart } from "lucide-react";
import { ToolBar, ActionButton } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { useContentLink } from "@/lib/useContentLink";
import { filenameFor, extFromUrl, fmtCount } from "@/lib/ttMedia";
import { startPolling } from "@/lib/poll";
import { requireOk } from "@/lib/bg";
import { buildSavedEntry } from "@/lib/shared/savedEntry";
import { useItemStatus, statusKey, statusTitle } from "@/lib/useItemStatus";

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

// TikTok Stories. Reads the passive fetch capture of /api/story/item_list (via the
// bridge, FBW_TT_STORIES) — stories appear once you OPEN a creator's story ring or
// visit a profile that has active stories. Each story item is a full video record
// (HD + captions), so download uses hd_url and transcribe is caption-first.
export default function TtStoriesTool() {
  const [owners, setOwners] = useState([]);
  const [txMap, setTxMap] = useState({});
  const [savedIds, setSavedIds] = useState({});
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("tiktok");

  useEffect(() => {
    if (!chrome?.storage?.local) return;
    const load = () =>
      chrome.storage.local.get(["fbw_transcripts", "fbw_saved"], (r) => {
        const out = {};
        for (const k in r.fbw_transcripts || {}) out[k] = r.fbw_transcripts[k].status;
        setTxMap(out);
        const s = {};
        for (const k in r.fbw_saved || {}) s[k] = true;
        setSavedIds(s);
      });
    load();
    const onCh = (ch, area) => { if (area === "local" && (ch.fbw_transcripts || ch.fbw_saved)) load(); };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  const pull = useCallback(async () => {
    const res = await send({ type: "FBW_TT_STORIES" });
    if (res && Array.isArray(res.owners)) setOwners(res.owners.filter((o) => o.items && o.items.length));
  }, [send]);

  useEffect(() => {
    pull();
    return startPolling(pull, 2500); // skips ticks while the panel is hidden
  }, [pull]);

  const refresh = useCallback(async () => {
    setOwners([]);
    // userAction: the user pressed Atualizar and is owed an answer either way.
    await send({ type: "FBW_TT_CLEAR" }, { userAction: true, action: "limpar a captura" });
    pull();
  }, [send, pull]);

  // Per-item action status. One download per story item, so the record's primary
  // key is the only one needed — and a failure keeps its reason for the tooltip.
  const { run, statusOf, errorOf } = useItemStatus();

  async function download(item) {
    await run(statusKey(item.id), async () => {
      const url = item.hd_url || item.download_url || item.video;
      if (!url) throw new Error("sem URL de vídeo");
      await requireOk({ type: "FBW_DL_MEDIA", kind: "video", url, filename: filenameFor({ ...item, username: item.reel_owner || item.username }, extFromUrl(url, "video")) });
    });
  }

  function transcribe(item) {
    if (!item.video && !item.subtitle) return;
    chrome.runtime.sendMessage({
      type: "FBW_TRANSCRIBE", videoId: item.id, mediaUrl: item.video, platform: "tiktok",
      captionUrl: item.subtitle?.url || null, captionFormat: item.subtitle?.format || null,
      caption: item.desc || null,
      author: { name: item.reel_owner || item.username || "desconhecido", url: item.username ? `https://www.tiktok.com/@${item.username}` : null },
      thumb: item.cover || item.dynamic_cover || null,
    }).catch(() => {});
    setTxMap((m) => ({ ...m, [item.id]: "running" }));
  }

  async function save(item) {
    try {
      const entry = buildSavedEntry({
        id: item.id,
        platform: "tiktok",
        thumb: item.cover || item.dynamic_cover || null,
        caption: item.desc || null,
        authorName: item.reel_owner,
        // item.username, not reel_owner — same field this file's transcribe() above
        // already uses for author.url, and what the permalink is derived from.
        // Without it VideoCard falls back to a dead facebook.com/reel/<id> link.
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
      // The background owns the write and decides insert-vs-remove; `saved` is the
      // state AFTER the toggle, so trust it instead of guessing.
      const res = await requireOk({ type: "FBW_SAVED_TOGGLE", entry });
      setSavedIds((s) => ({ ...s, [item.id]: !!res.saved }));
    } catch (e) { console.warn("[fbw] falha ao salvar na biblioteca", e); }
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

  if (!owners.length)
    return (
      <div className="space-y-2">
        {banner}
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-muted-foreground">Visite um perfil do TikTok que tenha stories ativos (ou abra o anel de stories) para capturá-los aqui.</p>
          <p className="text-[11px] text-muted-foreground/70">Passivo — nada é buscado em segundo plano.</p>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      {banner}
      <ToolBar className="justify-between">
        <span className="min-w-0 break-words text-[11px] text-muted-foreground">
          {owners.length} criador(es) capturado(s)
        </span>
        <ActionButton
          icon={RotateCw}
          label="Atualizar"
          hint="Atualizar — limpar stories capturados"
          variant="outline"
          onClick={refresh}
        />
      </ToolBar>

      {owners.map(({ owner, items }) => (
        <div key={owner} className="space-y-2">
          <a href={`https://www.tiktok.com/@${owner}`} target="_blank" rel="noreferrer" className="text-sm font-semibold text-foreground hover:underline">
            @{owner} · {items.length}
          </a>
          <div className="grid grid-cols-3 gap-1.5">
            {items.map((item) => {
              const st = statusOf(statusKey(item.id));
              return (
                <div key={item.id} className="group relative aspect-[9/16] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5">
                  {item.cover ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" /> : null}

                  <div className="absolute left-1 top-1 flex flex-col gap-1">
                    <IconBtn title={statusTitle("Baixar HD", st, errorOf(statusKey(item.id)))} onClick={() => download(item)} disabled={st === "downloading"}>
                      {st === "downloading" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className={"size-3.5 " + (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")} />}
                    </IconBtn>
                    {(item.video || item.subtitle) && (
                      <IconBtn
                        title={txMap[item.id] === "done" ? "Transcrito" : item.subtitle ? "Transcrever (legendas)" : "Transcrever"}
                        onClick={() => transcribe(item)}
                        disabled={txMap[item.id] === "running"}
                      >
                        {txMap[item.id] === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className={"size-3.5 " + (txMap[item.id] === "done" ? "text-emerald-400" : "")} />}
                      </IconBtn>
                    )}
                    <IconBtn title={savedIds[item.id] ? "Salvo" : "Salvar na biblioteca"} onClick={() => save(item)}>
                      <Bookmark className={"size-3.5 " + (savedIds[item.id] ? "fill-yellow-400 text-yellow-400" : "")} />
                    </IconBtn>
                  </div>

                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[9.5px] font-semibold text-white">
                    {item.play_count != null && <span className="inline-flex items-center gap-0.5"><Eye className="size-2.5" />{fmtCount(item.play_count)}</span>}
                    {item.digg_count != null && <span className="inline-flex items-center gap-0.5"><Heart className="size-2.5" />{fmtCount(item.digg_count)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
