import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Bookmark, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
} from "@/lib/igMedia";

const SORT_LABEL = { likes: "Likes", views: "Views", comments: "Comments", date: "Date" };

// Instagram Sort + Download. Reads the passive JSON.parse capture (via the IG
// content bridge, message FBW_IG_LIST), sorts it in-panel, and downloads media
// through the background (FBW_DL_MEDIA). No in-page feed manipulation.
export default function IgSortTool() {
  const [records, setRecords] = useState([]);
  const [surface, setSurface] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState("likes");
  const [sortDir, setSortDir] = useState("desc");
  const [noTab, setNoTab] = useState(false);
  const [busy, setBusy] = useState({}); // id -> 'downloading'|'done'|'error'
  const tabId = useRef(null);

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

  async function downloadRecord(rec) {
    const card = recordToCard(rec);
    setBusy((b) => ({ ...b, [card.id]: "downloading" }));
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
      setBusy((b) => ({ ...b, [card.id]: "done" }));
    } catch {
      setBusy((b) => ({ ...b, [card.id]: "error" }));
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

      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Scroll the Instagram feed to collect posts, then sort here.
        </p>
      ) : (
        <div className="space-y-2">
          {sorted.map((rec) => {
            const c = recordToCard(rec);
            const st = busy[c.id];
            const thumbStyle = c.thumb ? { backgroundImage: `url(${c.thumb})` } : undefined;
            const thumbCls =
              "block w-20 h-28 rounded-lg bg-muted bg-cover bg-center flex-none ring-1 ring-black/5";
            return (
              <Card key={c.id}>
                <CardContent className="p-2 flex items-center gap-3">
                  {c.permalink ? (
                    <a
                      href={c.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className={thumbCls}
                      style={thumbStyle}
                      title="Open on Instagram"
                    />
                  ) : (
                    <div className={thumbCls} style={thumbStyle} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">@{c.username}</div>
                    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>❤ {fmtCount(c.likes)}</span>
                      <span>💬 {fmtCount(c.comments)}</span>
                      {c.views != null && <span>▶ {fmtCount(c.views)}</span>}
                    </div>
                    <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground capitalize">
                      {c.type}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 flex-none">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => saveToLibrary(rec)}
                      title="Save to Library"
                    >
                      <Bookmark />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => downloadRecord(rec)}
                      title="Download"
                      disabled={st === "downloading"}
                    >
                      <Download
                        className={
                          st === "done"
                            ? "text-emerald-600"
                            : st === "error"
                              ? "text-destructive"
                              : undefined
                        }
                      />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
