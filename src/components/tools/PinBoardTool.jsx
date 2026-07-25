import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RotateCw, Play, Image as ImageIcon, Film, Layers, Bookmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resolvePlatformTab } from "@/lib/tabs";
import { startPolling } from "@/lib/poll";
import { sortRecords, recordToCard, fmtCount, filenameFor, extFromUrl } from "@/lib/pinMedia";

const MAX_PAGES = 40; // ~1000 pins per run — surfaced in the UI, never a silent cap.

// Pinterest Board tool. Unlike the IG/TT tools this is not polling a passive
// capture — pin-api.js actively pages Pinterest's resource API, so the panel asks
// for context once per surface and then drives an explicit Harvest.
export default function PinBoardTool() {
  const [ctx, setCtx] = useState(null);
  const [noTab, setNoTab] = useState(false);
  const tabId = useRef(null);

  const [records, setRecords] = useState([]);
  const [state, setState] = useState({ harvesting: false, pages: 0, done: false, hitCap: false, error: null });
  const [sortKey, setSortKey] = useState("default");

  const send = useCallback(async (msg) => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("pinterest");
    if (tabId.current == null) { setNoTab(true); return null; }
    setNoTab(false);
    try {
      return await chrome.tabs.sendMessage(tabId.current, msg);
    } catch {
      tabId.current = null;
      return null;
    }
  }, []);

  const loadContext = useCallback(async () => {
    const res = await send({ type: "FBW_PIN_CONTEXT" });
    if (res) setCtx(res);
  }, [send]);

  useEffect(() => {
    loadContext();
    // Context is cheap but not free (2 API calls), so re-check on a slow interval
    // to catch SPA navigation between boards rather than the 2.5s data-tool cadence.
    // startPolling (house pattern, see TtCollectionsTool) skips ticks while the panel
    // is hidden and fires once immediately on becoming visible.
    return startPolling(loadContext, 5000);
  }, [loadContext]);

  const pullState = useCallback(async () => {
    const res = await send({ type: "FBW_PIN_STATE" });
    if (!res) return;
    setRecords(res.records || []);
    setState({ harvesting: !!res.harvesting, pages: res.pages || 0, done: !!res.done, hitCap: !!res.hitCap, error: res.error || null });
  }, [send]);

  useEffect(() => {
    // Harvest is a live, possibly long-running job — poll every second, but
    // via startPolling so a hidden panel doesn't keep waking the content script.
    pullState();
    return startPolling(pullState, 1000);
  }, [pullState]);

  const harvest = useCallback(async () => {
    setRecords([]);
    await send({ type: "FBW_PIN_HARVEST", maxPages: MAX_PAGES });
    pullState();
  }, [send, pullState]);

  const clear = useCallback(async () => {
    await send({ type: "FBW_PIN_CLEAR" });
    setRecords([]);
    pullState();
  }, [send, pullState]);

  const sorted = sortRecords(records, sortKey, "desc");

  const [busy, setBusy] = useState({});
  const setStatus = (id, s) => setBusy((b) => ({ ...b, [id]: s }));
  const bg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));

  async function downloadRecord(rec) {
    setStatus(rec.id, "downloading");
    try {
      const multi = rec.items.length > 1;
      for (let i = 0; i < rec.items.length; i++) {
        const item = rec.items[i];
        let url = item.url;
        // ~80% of Pinterest videos are HLS-only. The content script derives a real
        // MP4 from the master manifest; a plain .m3u8 would download as a useless
        // text playlist.
        if (item.kind === "video" && item.hls) {
          const r = await send({ type: "FBW_PIN_RESOLVE", id: rec.id, itemIndex: i });
          if (!r?.ok) throw new Error(r?.error || "could not resolve video");
          url = r.url;
        }
        const ext = extFromUrl(url, item.kind);
        await bg({
          type: "FBW_DL_MEDIA",
          kind: item.kind,
          url,
          filename: filenameFor(rec, ext, multi ? i + 1 : null),
        });
      }
      setStatus(rec.id, "done");
    } catch {
      setStatus(rec.id, "error");
    }
  }

  async function save(rec) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      if (map[rec.id]) delete map[rec.id];
      else
        map[rec.id] = {
          videoId: rec.id,
          platform: "pinterest",
          thumb: rec.thumb || null,
          caption: rec.title || rec.description || null,
          author: { name: rec.username || "unknown", url: rec.username ? `https://www.pinterest.com/${rec.username}/` : null },
          counts: { like: fmtCount(rec.saves), comment: fmtCount(rec.comments), views: "—" },
          code: rec.id,
          // TranscriptsPanel only knows how to rebuild FB/IG permalinks, so Pinterest
          // must always carry its own.
          sourceUrl: rec.permalink,
          updatedAt: Date.now(),
        };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch { /* ignore */ }
  }

  // Serial with a 400 ms gap, matching IgSortTool/TtSortTool. Chrome will happily
  // accept parallel downloads, but Pinterest's CDN starts refusing under a burst.
  async function downloadAll() {
    for (const rec of sorted) {
      await downloadRecord(rec);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  if (noTab)
    return <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">Open Pinterest in a tab (logged in), then reopen this panel.</div>;

  if (!ctx) return <p className="py-8 text-center text-sm text-muted-foreground">Reading the page…</p>;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="text-[13px] font-medium">{ctx.board?.name || ctx.surface?.kind}</div>
        <div className="text-[11px] text-muted-foreground">
          surface: {ctx.surface?.kind} · board: {ctx.board?.id || "—"} · pins: {ctx.board?.pin_count ?? "—"} · sections: {ctx.sections?.length ?? 0}
        </div>
        {ctx.error ? <div className="mt-1 text-[11px] text-red-600">{ctx.error}</div> : null}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={harvest} disabled={state.harvesting}>
          <Play className="size-3.5" /> {state.harvesting ? `Harvesting… ${state.pages}p` : "Harvest"}
        </Button>
        <Button variant="outline" size="sm" onClick={clear} disabled={state.harvesting}>
          <RotateCw className="size-3.5" /> Clear
        </Button>
        <Button variant="secondary" size="sm" onClick={downloadAll} disabled={!records.length || state.harvesting}>
          <Download className="size-3.5" /> All ({records.length})
        </Button>
        <select
          className="ml-auto rounded-md border border-border bg-background px-1.5 py-1 text-[11px]"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
        >
          <option value="default">Board order</option>
          <option value="saves">Most saved</option>
          <option value="comments">Most commented</option>
          <option value="date">Newest</option>
        </select>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {records.length} pin(s) · {state.pages} page(s)
        {/* done and hitCap are mutually exclusive (set from pin-api.js's reachedEnd branch),
            so "complete" and the cap message never render together. */}
        {state.harvesting ? " · running" : state.done ? " · complete" : ""}
        {state.hitCap ? ` · stopped at the ${MAX_PAGES}-page cap — Harvest again for more` : ""}
      </div>
      {state.error ? <div className="rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-700">{state.error}</div> : null}

      <div className="grid grid-cols-3 gap-1.5">
        {sorted.map((rec) => {
          const card = recordToCard(rec);
          const Badge = card.mediaType === "video" ? Film : card.mediaType === "idea" ? Layers : ImageIcon;
          return (
            <div key={card.id} className="group relative aspect-[3/4] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5">
              <button
                onClick={() => downloadRecord(rec)}
                disabled={busy[rec.id] === "downloading"}
                className="absolute left-1 top-1 z-10 grid size-6 place-items-center rounded-md bg-black/65 text-white hover:bg-black/80 disabled:opacity-50"
                title={rec.items.length > 1 ? `Download ${rec.items.length} assets` : "Download"}
              >
                <Download className={"size-3.5 " + (busy[rec.id] === "done" ? "text-emerald-400" : busy[rec.id] === "error" ? "text-red-400" : "")} />
              </button>
              <button
                onClick={() => save(rec)}
                className="absolute left-1 top-8 z-10 grid size-6 place-items-center rounded-md bg-black/65 text-white hover:bg-black/80"
                title="Save to Library"
              >
                <Bookmark className="size-3.5" />
              </button>
              {card.thumb ? (
                <img src={card.thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
              ) : null}
              <span className="absolute right-1 top-1 grid size-5 place-items-center rounded bg-black/65 text-white">
                <Badge className="size-3" />
              </span>
              {card.saves != null && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[9.5px] font-semibold text-white">
                  {fmtCount(card.saves)} saves
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
