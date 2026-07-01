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
  Repeat2,
  Calendar,
  Play,
  Images,
  Image as ImageIcon,
  ImageDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { resolvePlatformTab } from "@/lib/tabs";
import {
  sortRecords,
  recordToCard,
  filenameFor,
  extFromUrl,
  fmtCount,
  filterBySurface,
  engagementRate,
} from "@/lib/igMedia";

const SORT_LABEL = { views: "Views", likes: "Likes", comments: "Comments", er: "ER %", date: "Date" };
const TYPE_ICON = { carousel: Images, video: Play, photo: ImageIcon };

// Small frosted icon button overlaid on a card thumbnail.
function IconBtn({ children, ...props }) {
  return (
    <button
      {...props}
      className="grid size-6 place-items-center rounded-md bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/70 disabled:opacity-50"
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
  const [sortKey, setSortKey] = useState("views");
  const [sortDir, setSortDir] = useState("desc");
  const [noTab, setNoTab] = useState(false);
  const [busy, setBusy] = useState({}); // id -> 'downloading'|'done'|'error'
  const [overlay, setOverlay] = useState(true);
  const tabId = useRef(null);

  useEffect(() => {
    chrome?.storage?.local?.get("sw_ig_overlay").then((r) => {
      if (r?.sw_ig_overlay != null) setOverlay(!!r.sw_ig_overlay);
    });
  }, []);
  const toggleOverlay = (v) => {
    setOverlay(v);
    chrome?.storage?.local?.set({ sw_ig_overlay: v });
  };

  const listFromTab = useCallback(async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("instagram");
    if (tabId.current == null) {
      setNoTab(true);
      return;
    }
    setNoTab(false);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_IG_LIST" });
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
    const id = setInterval(listFromTab, 2000);
    return () => clearInterval(id);
  }, [listFromTab]);

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

  async function saveToLibrary(rec) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      const id = rec.code || rec.pk;
      map[id] = {
        ...(map[id] || {}),
        ...rec,
        videoId: id,
        platform: "instagram",
        autoSaved: false,
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
        Open Instagram in a tab, then reopen this panel.
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
        <Button variant="secondary" onClick={downloadAll} disabled={!sorted.length}>
          <Download /> All
        </Button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {sorted.length} collected{surface ? ` · ${surface}` : ""}
        </span>
        <button className="underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "scope to surface" : "show all"}
        </button>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2">
        <Label htmlFor="ig-overlay" className="text-xs text-foreground cursor-pointer">
          Stats overlay on Instagram
        </Label>
        <Switch id="ig-overlay" checked={overlay} onCheckedChange={toggleOverlay} />
      </div>

      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Scroll the Instagram feed to collect posts, then sort here.
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
                  <IconBtn title="Save to Library" onClick={() => saveToLibrary(rec)}>
                    <Bookmark className="size-3.5" />
                  </IconBtn>
                  <IconBtn
                    title="Download media"
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
                  <IconBtn title="Download thumbnail" onClick={() => downloadThumb(rec)}>
                    <ImageDown className="size-3.5" />
                  </IconBtn>
                </div>

                {/* media type — top-right, opens the post */}
                <a
                  href={c.permalink || undefined}
                  target="_blank"
                  rel="noreferrer"
                  title="Open on Instagram"
                  className="absolute right-1.5 top-1.5 grid place-items-center rounded-md bg-black/45 p-1 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
                >
                  <TypeIcon className="size-3.5" />
                </a>

                {/* stat rail — right side, subtle blue glow */}
                <div className="absolute bottom-9 right-1.5 flex flex-col items-end gap-0.5 rounded-lg border border-sky-400/30 bg-black/40 px-2 py-1.5 text-white shadow-[0_0_10px_rgba(56,130,246,0.28)] backdrop-blur-sm">
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
                      {er.toFixed(1)}%
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
    </div>
  );
}
