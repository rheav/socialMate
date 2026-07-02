import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  DownloadCloud,
  Loader2,
  Play,
  Images,
  Image as ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { resolvePlatformTab } from "@/lib/tabs";
import { extFromUrl } from "@/lib/igMedia";
import { groupReels, reelLabel, storyToCard, storyFilename } from "@/lib/igReels";

const TYPE_ICON = { carousel: Images, video: Play, photo: ImageIcon };

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

// Instagram Stories & Highlights. Reads the passive reel capture (bridge
// FBW_IG_REELS) — reels only exist here once you OPEN a story/highlight on
// Instagram (nothing is fetched in the background). Downloads via FBW_DL_MEDIA.
export default function IgStoriesTool() {
  const [reels, setReels] = useState([]);
  const [noTab, setNoTab] = useState(false);
  const [busy, setBusy] = useState({}); // pk -> 'downloading'|'done'|'error'
  const tabId = useRef(null);

  const listFromTab = useCallback(async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("instagram");
    if (tabId.current == null) { setNoTab(true); return; }
    setNoTab(false);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_IG_REELS" });
      if (res && Array.isArray(res.reels)) setReels(res.reels);
    } catch {
      tabId.current = null;
    }
  }, []);

  useEffect(() => {
    listFromTab();
    const id = setInterval(listFromTab, 2500);
    return () => clearInterval(id);
  }, [listFromTab]);

  const bg = (msg) =>
    new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));
  const setStatus = (id, s) => setBusy((b) => ({ ...b, [id]: s }));

  async function downloadItem(item) {
    const id = item.pk;
    setStatus(id, "downloading");
    try {
      if (item.media_type === "carousel" && Array.isArray(item.carousel)) {
        let i = 0;
        for (const ch of item.carousel) {
          i += 1;
          const isVid = ch.media_type === "video" && ch.video;
          const url = isVid ? ch.video : ch.image;
          if (!url) continue;
          await bg({
            type: "FBW_DL_MEDIA",
            kind: isVid ? "video" : "image",
            url,
            filename: storyFilename(item, extFromUrl(url, isVid ? "video" : "image"), i),
          });
        }
      } else if (item.video) {
        await bg({
          type: "FBW_DL_MEDIA",
          kind: "video",
          url: item.video,
          filename: storyFilename(item, extFromUrl(item.video, "video")),
        });
      } else if (item.image) {
        await bg({
          type: "FBW_DL_MEDIA",
          kind: "image",
          url: item.image,
          filename: storyFilename(item, extFromUrl(item.image, "image")),
        });
      }
      setStatus(id, "done");
    } catch {
      setStatus(id, "error");
    }
  }

  async function downloadReel(reel) {
    for (const item of reel.items || []) {
      await downloadItem(item);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  if (noTab)
    return (
      <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2">
        Open Instagram in a tab, then reopen this panel.
      </div>
    );

  const groups = groupReels(reels);

  if (!groups.length)
    return (
      <div className="space-y-2 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          Open a story or highlight on Instagram to capture it here.
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          Nothing is fetched in the background — you tap it, we grab it.
        </p>
      </div>
    );

  return (
    <div className="space-y-4">
      {groups.map(({ owner, reels: ownerReels }) => (
        <div key={owner} className="space-y-2">
          <div className="text-sm font-semibold text-foreground">@{owner}</div>
          {ownerReels.map((reel) => (
            <div key={reel.reel_id} className="rounded-lg border border-border bg-card p-2">
              <div className="mb-2 flex items-center gap-2">
                {reel.cover ? (
                  <img src={reel.cover} alt="" className="size-8 shrink-0 rounded-full object-cover ring-1 ring-black/10" />
                ) : (
                  <div className="size-8 shrink-0 rounded-full bg-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{reelLabel(reel)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {(reel.items?.length || 0)} item{(reel.items?.length || 0) === 1 ? "" : "s"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => downloadReel(reel)}
                  disabled={!reel.items?.length}
                >
                  <DownloadCloud className="size-3.5" /> All
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                {(reel.items || []).map((item) => {
                  const c = storyToCard(item);
                  const st = busy[c.id];
                  const TypeIcon = TYPE_ICON[c.type] || ImageIcon;
                  return (
                    <div
                      key={c.id}
                      className="group relative aspect-[9/16] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5"
                    >
                      {c.thumb ? (
                        <img src={c.thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                      ) : null}

                      <span className="absolute right-1 top-1 grid place-items-center rounded bg-black/45 p-0.5 text-white backdrop-blur-sm">
                        <TypeIcon className="size-3" />
                      </span>

                      <div className="absolute left-1 top-1">
                        <IconBtn
                          title="Download"
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
