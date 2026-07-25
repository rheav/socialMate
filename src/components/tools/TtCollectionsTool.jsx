import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Bookmark, RotateCw, ListVideo, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { ToolBar, ActionButton } from "@/components/ui/ToolBar";
import { resolvePlatformTab } from "@/lib/tabs";
import { filenameFor, extFromUrl, fmtCount } from "@/lib/ttMedia";
import { startPolling } from "@/lib/poll";

// TikTok Collections + Playlists. Reads the passive capture of /api/user/playlist
// + /api/user/collection_list (bucket metadata) and /api/mix|collection/item_list
// (the videos inside), via FBW_TT_LISTS. A creator's curated buckets surface their
// best-organized reference content. Videos load into a bucket once you open that
// playlist/collection on TikTok (passive).
export default function TtCollectionsTool() {
  const [lists, setLists] = useState([]);
  const [noTab, setNoTab] = useState(false);
  const [open, setOpen] = useState({});
  const [busy, setBusy] = useState({});
  const tabId = useRef(null);

  const pull = useCallback(async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("tiktok");
    if (tabId.current == null) { setNoTab(true); return; }
    setNoTab(false);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_TT_LISTS" });
      if (res && Array.isArray(res.lists)) setLists(res.lists);
    } catch { tabId.current = null; }
  }, []);

  useEffect(() => {
    pull();
    return startPolling(pull, 2500); // skips ticks while the panel is hidden
  }, [pull]);

  const refresh = useCallback(async () => {
    setLists([]);
    try {
      if (tabId.current == null) tabId.current = await resolvePlatformTab("tiktok");
      if (tabId.current != null) await chrome.tabs.sendMessage(tabId.current, { type: "FBW_TT_CLEAR" });
    } catch { tabId.current = null; }
    pull();
  }, [pull]);

  const bg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));
  const setStatus = (id, s) => setBusy((b) => ({ ...b, [id]: s }));

  async function download(item) {
    setStatus(item.id, "downloading");
    try {
      const url = item.hd_url || item.download_url || item.video;
      if (!url) throw new Error("no url");
      await bg({ type: "FBW_DL_MEDIA", kind: "video", url, filename: filenameFor(item, extFromUrl(url, "video")) });
      setStatus(item.id, "done");
    } catch { setStatus(item.id, "error"); }
  }
  async function save(item) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      if (map[item.id]) delete map[item.id];
      else map[item.id] = {
        videoId: item.id, platform: "tiktok", thumb: item.cover || null, caption: item.desc || null,
        author: { name: item.username || item.nickname || "desconhecido", url: item.username ? `https://www.tiktok.com/@${item.username}` : null },
        counts: { like: fmtCount(item.digg_count), comment: fmtCount(item.comment_count), views: fmtCount(item.play_count) },
        code: item.id,
        // This file has no transcribe path to mirror; same shape as TtSortTool's —
        // without it VideoCard falls back to a dead facebook.com/reel/<id> link.
        sourceUrl: item.username ? `https://www.tiktok.com/@${item.username}/video/${item.id}` : null,
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch { /* ignore */ }
  }

  async function downloadAll(items) {
    for (const it of items) { await download(it); await new Promise((r) => setTimeout(r, 400)); }
  }

  if (noTab)
    return <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2">Abra o TikTok em uma aba (com login feito) e reabra este painel.</div>;

  if (!lists.length)
    return (
      <div className="space-y-2 py-8 text-center">
        <p className="text-sm text-muted-foreground">Visite um perfil do TikTok que tenha playlists/coleções para capturar as coleções aqui.</p>
        <p className="text-[11px] text-muted-foreground/70">Abra uma playlist para carregar os vídeos dela (passivo).</p>
      </div>
    );

  return (
    <div className="space-y-2">
      <ToolBar className="justify-between">
        <span className="min-w-0 break-words text-[11px] text-muted-foreground">
          {lists.length} coleção(ões) capturada(s)
        </span>
        <ActionButton
          icon={RotateCw}
          label="Atualizar"
          hint="Atualizar — limpar coleções capturadas"
          variant="outline"
          onClick={refresh}
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
                        const st = busy[item.id];
                        return (
                          <div key={item.id} className="group relative aspect-[9/16] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5">
                            {item.cover ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" /> : null}
                            <div className="absolute left-1 top-1 flex flex-col gap-1">
                              <button onClick={() => download(item)} disabled={st === "downloading"} className="grid size-6 place-items-center rounded-md bg-black/65 text-white hover:bg-black/80 disabled:opacity-50">
                                <Download className={"size-3.5 " + (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")} />
                              </button>
                              <button onClick={() => save(item)} className="grid size-6 place-items-center rounded-md bg-black/65 text-white hover:bg-black/80">
                                <Bookmark className="size-3.5" />
                              </button>
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
