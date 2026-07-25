import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
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
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { resolvePlatformTab } from "@/lib/tabs";
import { sortRecords, recordToCard, filenameFor, fmtCount } from "@/lib/fbReels";

const SORT_LABEL = { default: "Default", views: "Views", comments: "Comments", shares: "Shares" };

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
  const [noTab, setNoTab] = useState(false);
  const [busy, setBusy] = useState({}); // id -> 'downloading'|'done'|'error'
  const [harvesting, setHarvesting] = useState(false);
  const tabId = useRef(null);

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

  const listFromTab = useCallback(async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("facebook");
    if (tabId.current == null) { setNoTab(true); return; }
    setNoTab(false);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_FB_REELS_LIST" });
      if (res && Array.isArray(res.records)) {
        setRecords(res.records);
        setOwner(res.owner || null);
        setOnReelsTab(!!res.onReelsTab);
      }
    } catch {
      tabId.current = null;
    }
  }, []);

  useEffect(() => {
    listFromTab();
    const id = setInterval(listFromTab, 3000);
    return () => clearInterval(id);
  }, [listFromTab]);

  // Auto-scroll the FB grid to load every reel, then take the full list.
  async function collectAll() {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("facebook");
    if (tabId.current == null) { setNoTab(true); return; }
    setHarvesting(true);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_FB_REELS_HARVEST" });
      if (res && Array.isArray(res.records)) {
        setRecords(res.records);
        setOwner(res.owner || null);
        setOnReelsTab(!!res.onReelsTab);
      }
    } catch {
      tabId.current = null;
    } finally {
      setHarvesting(false);
    }
  }

  const sorted = sortRecords(records, sortKey, sortDir);

  const bg = (msg) =>
    new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));
  const setStatus = (id, s) => setBusy((b) => ({ ...b, [id]: s }));

  async function downloadThumb(rec) {
    if (!rec.thumb) return;
    setStatus(rec.id, "downloading");
    try {
      await bg({ type: "FBW_DL_MEDIA", kind: "image", url: rec.thumb, filename: filenameFor(owner, rec.id) });
      setStatus(rec.id, "done");
    } catch {
      setStatus(rec.id, "error");
    }
  }

  async function downloadAllThumbs() {
    for (const rec of sorted) {
      await downloadThumb(rec);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Toggle: first tap saves the reel to the shared Library, second removes.
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
        platform: "facebook",
        thumb: rec.thumb || null,
        caption: null,
        author: { name: owner || "unknown", url: null },
        counts: {
          like: null,
          comment: rec.comments != null ? fmtCount(rec.comments) : null,
          share: rec.shares != null ? fmtCount(rec.shares) : null,
          views: rec.views != null ? fmtCount(rec.views) : null,
        },
        sourceUrl: `https://www.facebook.com/reel/${rec.id}`,
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch {
      /* ignore */
    }
  }

  if (noTab)
    return (
      <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2">
        Open Facebook in a tab, then reopen this panel.
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={sortKey} onValueChange={setSortKey}>
          <SelectTrigger className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SORT_LABEL).map(([k, l]) => (
              <SelectItem key={k} value={k}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          title={sortDir === "desc" ? "High → low" : "Low → high"}
        >
          {sortDir === "desc" ? <ArrowDown /> : <ArrowUp />}
        </Button>
        <Button variant="secondary" onClick={collectAll} disabled={harvesting} title="Scroll the grid to load every reel">
          {harvesting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {harvesting ? "Collecting" : "Collect all"}
        </Button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {sorted.length} reels{owner ? ` · ${owner}` : ""}
        </span>
        <button
          className="underline disabled:opacity-50"
          onClick={downloadAllThumbs}
          disabled={!sorted.length}
        >
          download all thumbnails
        </button>
      </div>

      {!onReelsTab && (
        <div className="rounded-md bg-amber-500/10 text-amber-700 text-[11px] px-3 py-2">
          Open the profile's <span className="font-semibold">Reels</span> tab on Facebook, then Collect all.
        </div>
      )}

      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Open a profile's Reels tab, then <span className="font-medium text-foreground">Collect all</span> to load and sort them here.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {sorted.map((rec) => {
            const c = recordToCard(rec);
            const st = busy[c.id];
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
                    title={savedIds[c.id] ? "Saved — tap to remove" : "Save to Library"}
                    onClick={() => saveToLibrary(rec)}
                  >
                    <Bookmark className={"size-3.5 " + (savedIds[c.id] ? "fill-yellow-400 text-yellow-400" : "")} />
                  </IconBtn>
                  <IconBtn title="Download thumbnail" onClick={() => downloadThumb(rec)} disabled={st === "downloading"}>
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
                    Open reel
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
