import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, Loader2, Bookmark, RotateCw, Eye, Heart } from "lucide-react";
import { ToolBar, ActionButton } from "@/components/ui/ToolBar";
import { resolvePlatformTab } from "@/lib/tabs";
import { filenameFor, extFromUrl, fmtCount } from "@/lib/ttMedia";
import { startPolling } from "@/lib/poll";

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
  const [noTab, setNoTab] = useState(false);
  const [busy, setBusy] = useState({});
  const [txMap, setTxMap] = useState({});
  const [savedIds, setSavedIds] = useState({});
  const tabId = useRef(null);

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
    if (tabId.current == null) tabId.current = await resolvePlatformTab("tiktok");
    if (tabId.current == null) { setNoTab(true); return; }
    setNoTab(false);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_TT_STORIES" });
      if (res && Array.isArray(res.owners)) setOwners(res.owners.filter((o) => o.items && o.items.length));
    } catch {
      tabId.current = null;
    }
  }, []);

  useEffect(() => {
    pull();
    return startPolling(pull, 2500); // skips ticks while the panel is hidden
  }, [pull]);

  const refresh = useCallback(async () => {
    setOwners([]);
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
      await bg({ type: "FBW_DL_MEDIA", kind: "video", url, filename: filenameFor({ ...item, username: item.reel_owner || item.username }, extFromUrl(url, "video")) });
      setStatus(item.id, "done");
    } catch { setStatus(item.id, "error"); }
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
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      if (map[item.id]) { delete map[item.id]; }
      else map[item.id] = {
        videoId: item.id, platform: "tiktok", thumb: item.cover || item.dynamic_cover || null, caption: item.desc || null,
        author: { name: item.reel_owner || item.username || "desconhecido", url: item.username ? `https://www.tiktok.com/@${item.username}` : null },
        counts: { like: fmtCount(item.digg_count), comment: fmtCount(item.comment_count), views: fmtCount(item.play_count) },
        code: item.id,
        // item.username, not reel_owner — same field this file's transcribe() above
        // already uses for author.url. Without this VideoCard falls back to a dead
        // facebook.com/reel/<id> link.
        sourceUrl: item.username ? `https://www.tiktok.com/@${item.username}/video/${item.id}` : null,
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch { /* ignore */ }
  }

  if (noTab)
    return <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2">Abra o TikTok em uma aba (com login feito) e reabra este painel.</div>;

  if (!owners.length)
    return (
      <div className="space-y-2 py-8 text-center">
        <p className="text-sm text-muted-foreground">Visite um perfil do TikTok que tenha stories ativos (ou abra o anel de stories) para capturá-los aqui.</p>
        <p className="text-[11px] text-muted-foreground/70">Passivo — nada é buscado em segundo plano.</p>
      </div>
    );

  return (
    <div className="space-y-4">
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
              const st = busy[item.id];
              return (
                <div key={item.id} className="group relative aspect-[9/16] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5">
                  {item.cover ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" /> : null}

                  <div className="absolute left-1 top-1 flex flex-col gap-1">
                    <IconBtn title="Baixar HD" onClick={() => download(item)} disabled={st === "downloading"}>
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
