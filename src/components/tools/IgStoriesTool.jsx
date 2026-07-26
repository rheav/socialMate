import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  DownloadCloud,
  Loader2,
  Play,
  Images,
  Image as ImageIcon,
  RotateCw,
  Link2,
  Square,
} from "lucide-react";
import { ToolBar, ActionButton } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { useContentLink } from "@/lib/useContentLink";
import { extFromUrl } from "@/lib/igMedia";
import { groupReels, reelLabel, storyToCard, storyFilename } from "@/lib/igReels";
import { startPolling } from "@/lib/poll";
import { useItemStatus, statusKey, statusTitle } from "@/lib/useItemStatus";
import { requireOk } from "@/lib/bg";
import IconBtn from "@/components/ui/IconBtn";

const TYPE_ICON = { carousel: Images, video: Play, photo: ImageIcon };

// Instagram Stories & Highlights. Reads the passive reel capture (bridge
// FBW_IG_REELS) — reels only exist here once you OPEN a story/highlight on
// Instagram (nothing is fetched in the background). Downloads via FBW_DL_MEDIA.
export default function IgStoriesTool() {
  const [reels, setReels] = useState([]);
  // Per-item download status, keyed by story pk — keeps the failure REASON so a
  // red icon can say why on hover.
  const { run, statusOf, errorOf } = useItemStatus();
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("instagram");

  const listFromTab = useCallback(async () => {
    const res = await send({ type: "FBW_IG_REELS" });
    if (res && Array.isArray(res.reels)) setReels(res.reels);
  }, [send]);

  useEffect(() => {
    return startPolling(listFromTab, 2500); // skips ticks while the panel is hidden
  }, [listFromTab]);

  const refresh = useCallback(async () => {
    setReels([]);
    // userAction: the user pressed Atualizar and is owed an answer either way.
    await send({ type: "FBW_IG_CLEAR" }, { userAction: true, action: "limpar a captura" });
    listFromTab();
  }, [send, listFromTab]);

  async function downloadItem(item) {
    const id = item.pk;
    await run(statusKey(id), async () => {
      if (item.media_type === "carousel" && Array.isArray(item.carousel)) {
        let i = 0;
        for (const ch of item.carousel) {
          i += 1;
          const isVid = ch.media_type === "video" && ch.video;
          const url = isVid ? ch.video : ch.image;
          if (!url) continue;
          await requireOk({
            type: "FBW_DL_MEDIA",
            kind: isVid ? "video" : "image",
            url,
            filename: storyFilename(item, extFromUrl(url, isVid ? "video" : "image"), i),
          });
        }
      } else if (item.video) {
        await requireOk({
          type: "FBW_DL_MEDIA",
          kind: "video",
          url: item.video,
          filename: storyFilename(item, extFromUrl(item.video, "video")),
        });
      } else if (item.image) {
        await requireOk({
          type: "FBW_DL_MEDIA",
          kind: "image",
          url: item.image,
          filename: storyFilename(item, extFromUrl(item.image, "image")),
        });
      } else {
        throw new Error("nenhuma mídia neste story");
      }
    });
  }

  // Every reel has its own "Tudo", but only ONE may run: the 400 ms gap below is
  // there because the CDN refuses a burst, and a second loop — the same reel tapped
  // twice, or a neighbouring one — would interleave and defeat it. So the running
  // reel's button becomes its own stop control (it cannot just be `disabled`, or a
  // long run would have no way out) and every other one goes disabled meanwhile.
  const [bulk, setBulk] = useState(null); // { reelId, done, total, stopping }
  const stopBulkRef = useRef(false);
  const isBulking = (reel) => bulk?.reelId === reel.reel_id;

  async function downloadReel(reel) {
    if (bulk) return;
    const items = reel.items || [];
    stopBulkRef.current = false;
    setBulk({ reelId: reel.reel_id, done: 0, total: items.length, stopping: false });
    try {
      for (const item of items) {
        if (stopBulkRef.current) break;
        await downloadItem(item);
        setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      setBulk(null);
    }
  }

  // Cooperative: the loop is mid-await on a download, so it can only honour this
  // between items. A ref, not state — the running loop's closure would never see
  // a state update.
  function stopBulk() {
    stopBulkRef.current = true;
    setBulk((b) => (b ? { ...b, stopping: true } : b));
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

  const groups = groupReels(reels);

  if (!groups.length)
    return (
      <div className="space-y-2">
        {banner}
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            Abra um story ou destaque no Instagram para capturá-lo aqui.
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Nada é buscado em segundo plano — você toca, nós capturamos.
          </p>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      {banner}
      <ToolBar className="justify-between">
        <span className="min-w-0 break-words text-[11px] text-muted-foreground">
          {groups.length} perfil(is) capturado(s)
        </span>
        <ActionButton
          icon={RotateCw}
          label="Atualizar"
          hint="Atualizar — limpar stories capturados"
          variant="outline"
          onClick={refresh}
        />
      </ToolBar>
      {groups.map(({ owner, reels: ownerReels }) => (
        <div key={owner} className="space-y-2">
          <div className="text-sm font-semibold text-foreground">@{owner}</div>
          {ownerReels.map((reel) => (
            <div key={reel.reel_id} className="rounded-lg border border-border bg-card p-2">
              {/* ToolBar here too, so the container measures the width INSIDE the
                  card (panel − page gutters − card padding), not the panel's. */}
              <ToolBar className="mb-2 gap-2">
                {reel.cover ? (
                  <img src={reel.cover} alt="" className="size-8 shrink-0 rounded-full object-cover ring-1 ring-black/10" />
                ) : (
                  <div className="size-8 shrink-0 rounded-full bg-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{reelLabel(reel)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {(reel.items?.length || 0)} {(reel.items?.length || 0) === 1 ? "item" : "itens"}
                  </div>
                </div>
                <ActionButton
                  icon={isBulking(reel) ? Square : DownloadCloud}
                  label={
                    isBulking(reel)
                      ? bulk.stopping
                        ? "Parando…"
                        : `Parar ${bulk.done}/${bulk.total}`
                      : "Tudo"
                  }
                  hint={
                    isBulking(reel)
                      ? "Parar o download deste story"
                      : "Baixar todos os itens deste story"
                  }
                  variant="secondary"
                  onClick={() => (isBulking(reel) ? stopBulk() : downloadReel(reel))}
                  disabled={bulk ? !isBulking(reel) || bulk.stopping : !reel.items?.length}
                />
              </ToolBar>

              <div className="grid grid-cols-3 gap-1.5">
                {(reel.items || []).map((item) => {
                  const c = storyToCard(item);
                  const st = statusOf(statusKey(c.id));
                  const TypeIcon = TYPE_ICON[c.type] || ImageIcon;
                  return (
                    <div
                      key={c.id}
                      className="group relative aspect-[9/16] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5"
                    >
                      {c.thumb ? (
                        <img src={c.thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                      ) : null}

                      <span className="absolute right-1 top-1 grid place-items-center rounded bg-black/65 p-0.5 text-white">
                        <TypeIcon className="size-3" />
                      </span>

                      <div className="absolute left-1 top-1">
                        <IconBtn
                          title={statusTitle("Baixar", st, errorOf(statusKey(c.id)))}
                          onClick={() => downloadItem(item)}
                          disabled={st === "downloading"}
                        >
                          {st === "downloading" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download
                              className={
                                "size-3.5 " +
                                (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")
                              }
                            />
                          )}
                        </IconBtn>
                      </div>

                      {/* swipe-up link sticker → competitor funnel URL */}
                      {c.links && c.links.length > 0 && (
                        <a
                          href={c.links[0]}
                          target="_blank"
                          rel="noreferrer"
                          title={`Link (arraste para cima): ${c.links[0]}`}
                          className="absolute bottom-1 left-1 z-10 inline-flex items-center gap-0.5 rounded bg-sky-500/90 px-1 py-0.5 text-[9px] font-semibold text-white hover:bg-sky-500"
                        >
                          <Link2 className="size-2.5" /> link
                        </a>
                      )}

                      {c.date && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-4 text-[9.5px] font-medium text-white">
                          {c.date}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
