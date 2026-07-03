import { useCallback, useEffect, useState } from "react";
import { ImageDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const FB_GLOB = ["*://*.facebook.com/*"];

async function resolveFbTab() {
  if (typeof chrome === "undefined" || !chrome?.tabs?.query) return null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url && /(^|\.)facebook\.com$/.test(new URL(active.url).hostname)) return active.id;
  const tabs = await chrome.tabs.query({ url: FB_GLOB });
  return tabs.length ? tabs[0].id : null;
}

const slug = (s) => (s || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";

// "Download" dock tab: shows WHO/WHAT the bound Facebook page is (avatar, name,
// follower counts scraped from the profile header) + bulk thumbnail download.
export default function DownloadPanel() {
  const [info, setInfo] = useState(null);
  const [infoErr, setInfoErr] = useState("");
  const [infoBusy, setInfoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // The content script isn't reachable while the FB tab is still loading
  // (e.g. right after an extension reload), so poll a few times before failing.
  const loadInfo = useCallback(async () => {
    setInfoBusy(true);
    setInfoErr("Reading page…");
    try {
      for (let i = 0; i < 6; i++) {
        const tabId = await resolveFbTab();
        if (tabId == null) { setInfo(null); setInfoErr("Open a Facebook page in a tab first."); return; }
        try {
          const res = await chrome.tabs.sendMessage(tabId, { type: "FBW_PAGE_INFO" });
          if (res?.ok) { setInfo(res.info); setInfoErr(""); return; }
        } catch { /* not ready yet */ }
        setInfoErr(`Page not ready — retrying (${i + 1}/6)…`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      setInfo(null);
      setInfoErr("Could not reach the page — reload the Facebook tab, then retry.");
    } finally {
      setInfoBusy(false);
    }
  }, []);

  useEffect(() => { loadInfo(); }, [loadInfo]);

  const downloadThumbs = async () => {
    setBusy(true);
    setMsg("Collecting thumbnails (auto-scrolling the page)…");
    try {
      const tabId = await resolveFbTab();
      if (tabId == null) { setMsg("Open the profile's Reels tab first, then retry."); return; }
      const res = await chrome.tabs.sendMessage(tabId, { type: "FBW_COLLECT_REEL_THUMBS" });
      if (!res?.ok) { setMsg(res?.error || "Collection failed — reload the tab and retry."); return; }
      if (!res.thumbs?.length) { setMsg("No reel thumbnails found — open the profile's Reels tab."); return; }
      setMsg(`Downloading ${res.thumbs.length} thumbnails…`);
      const folder = `socialMate-thumbs/${slug(info?.name)}`;
      let done = 0;
      for (const t of res.thumbs) {
        try {
          await chrome.downloads.download({ url: t.url, filename: `${folder}/reel_${t.id}.jpg` });
          done++;
        } catch { /* skip failed item */ }
      }
      setMsg(`✓ ${done}/${res.thumbs.length} thumbnails saved to Downloads/${folder}`);
    } catch (e) {
      setMsg("Failed: " + (e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3">
          {info ? (
            <div className="flex items-center gap-3">
              {info.avatar ? (
                <img src={info.avatar} alt="" className="h-12 w-12 rounded-full object-cover border border-border" />
              ) : (
                <div className="h-12 w-12 rounded-full bg-muted" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">{info.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {[info.followers, info.following].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={loadInfo} disabled={infoBusy} title="Refresh page info">
                <RefreshCw className={infoBusy ? "size-4 animate-spin" : "size-4"} />
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{infoErr || "Reading page…"}</p>
              <Button variant="ghost" size="icon" onClick={loadInfo} disabled={infoBusy} title="Retry">
                <RefreshCw className={infoBusy ? "size-4 animate-spin" : "size-4"} />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-1.5">
        <Button variant="outline" className="w-full" onClick={downloadThumbs} disabled={busy || !info}>
          <ImageDown className="size-4" />
          Download reel thumbnails (this page)
        </Button>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Open a profile's Reels tab on Facebook, check the card above shows the right page,
        then download. Files land in Downloads/socialMate-thumbs/&lt;page-name&gt;/reel_&lt;id&gt;.jpg.
      </p>
    </div>
  );
}
