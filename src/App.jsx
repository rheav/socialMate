import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, Square, ExternalLink, Flame, FileText, Bookmark, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import Segmented from "@/components/ui/Segmented";
import OptionsDropdown from "@/components/ui/OptionsDropdown";
import BottomNav from "@/components/ui/BottomNav";
import TranscriptsPanel, { SavedPanel } from "@/components/TranscriptsPanel";
import DownloadPanel from "@/components/DownloadPanel";
import PlatformSwitcher from "@/components/ui/PlatformSwitcher";
import { PLATFORMS } from "@/lib/platforms";

const MODE_NAME = { A: "Keyword", B: "Feed", C: "Reels" };

// host regex + tab-query glob per platform
const PLATFORM_HOST = {
  facebook: { re: /(^|\.)facebook\.com$/, glob: ["*://*.facebook.com/*"] },
  instagram: { re: /(^|\.)instagram\.com$/, glob: ["*://*.instagram.com/*"] },
  tiktok: { re: /(^|\.)tiktok\.com$/, glob: ["*://*.tiktok.com/*"] },
};
const matchesPlatform = (platform, url) => {
  try { return PLATFORM_HOST[platform].re.test(new URL(url).hostname); } catch { return false; }
};
const hasChromeTabs = () => typeof chrome !== "undefined" && !!chrome?.tabs?.query;
async function resolvePlatformTab(platform) {
  if (!hasChromeTabs()) return null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && matchesPlatform(platform, active.url || "")) return active.id;
  const tabs = await chrome.tabs.query({ url: PLATFORM_HOST[platform].glob });
  return tabs.length ? tabs[0].id : null;
}
const fmtMs = (ms) => {
  if (!ms || ms <= 0) return "0:00";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtClock = (t) => new Date(t).toTimeString().slice(0, 8);

export default function App() {
  const [platform, setPlatform] = useState("facebook");
  const [view, setView] = useState("warm"); // "warm" | "transcripts"
  const [mode, setMode] = useState("C");
  const [keyword, setKeyword] = useState("");
  const [targetN, setTargetN] = useState(10);
  const [personality, setPersonality] = useState("random");
  const [actions, setActions] = useState({ save: true, like: true, follow: false });
  const [englishOnly, setEnglishOnly] = useState(true);
  const [pacing, setPacing] = useState({ minDelay: 4, maxDelay: 9, reelMin: 6, reelMax: 15 });
  const [sessionCap, setSessionCap] = useState(0);
  const [thresholds, setThresholds] = useState({ minLikes: 0, minComments: 0 });
  const optsLoaded = useRef(false);

  // Options persist across panel opens (same approach as unfunnelizer: chrome.storage.local).
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) { optsLoaded.current = true; return; }
    chrome.storage.local.get("swOptions").then((r) => {
      const o = r?.swOptions;
      if (o?.pacing) setPacing(o.pacing);
      if (o?.thresholds) setThresholds(o.thresholds);
      if (o?.sessionCap != null) setSessionCap(o.sessionCap);
      optsLoaded.current = true;
    });
  }, []);
  useEffect(() => {
    if (!optsLoaded.current || typeof chrome === "undefined" || !chrome?.storage?.local) return;
    chrome.storage.local.set({ swOptions: { pacing, thresholds, sessionCap } });
  }, [pacing, thresholds, sessionCap]);

  const [status, setStatus] = useState(null);
  const [noTab, setNoTab] = useState(false);
  const tabId = useRef(null);
  const logRef = useRef(null);

  const send = useCallback(async (type, payload = {}) => {
    if (tabId.current == null) return null;
    try { return await chrome.tabs.sendMessage(tabId.current, { type, ...payload }); }
    catch { return null; }
  }, []);

  const poll = useCallback(async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab(platform);
    if (tabId.current == null) { setNoTab(true); return; }
    setNoTab(false);
    const st = await send("FBW_STATUS");
    if (st === null) { tabId.current = null; return; }
    setStatus(st);
  }, [send, platform]);

  // re-resolve the target tab whenever the selected platform changes
  useEffect(() => { tabId.current = null; }, [platform]);

  // retint the whole panel to the active platform's palette
  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(PLATFORMS[platform].theme)) root.style.setProperty(k, v);
  }, [platform]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 1000);
    // Stay LOCKED on the bound tab: don't drop it when the user switches tabs —
    // the panel drives that FB tab by id, so you can work elsewhere. We only
    // re-resolve if the bound tab goes away (poll's send() returns null) or the
    // platform changes. Re-bind here only when nothing is bound yet.
    const onClosed = (closedId) => { if (closedId === tabId.current) tabId.current = null; };
    const hasTabs = typeof chrome !== "undefined" && chrome?.tabs?.onRemoved;
    if (hasTabs) chrome.tabs.onRemoved.addListener(onClosed);
    return () => { clearInterval(id); if (hasTabs) chrome.tabs.onRemoved.removeListener(onClosed); };
  }, [poll]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log]);

  const running = !!status?.isRunning;
  const paused = !!(status && (status.isPaused || status.isAutoBreak));
  const halted = !!status?.haltReason;

  const start = async () => {
    if (mode === "A" && !keyword.trim()) return;
    const settings = {
      platform, mode, keyword: keyword.trim(), targetN: Number(targetN) || 10,
      ...actions, englishOnly, personality,
      thresholds: { minLikes: Number(thresholds.minLikes) || 0, minComments: Number(thresholds.minComments) || 0 },
      sessionCapMinutes: Number(sessionCap) || 0,
      pacing: {
        minDelay: (Number(pacing.minDelay) || 4) * 1000,
        maxDelay: (Number(pacing.maxDelay) || 9) * 1000,
        reelDwellMin: (Number(pacing.reelMin) || 6) * 1000,
        reelDwellMax: (Number(pacing.reelMax) || 15) * 1000,
      },
    };
    const res = await send("FBW_START", { settings });
    if (res?.ok) setStatus(res);
  };
  const togglePause = async () => { const r = await send("FBW_TOGGLE_PAUSE"); if (r) setStatus(r); };
  const stop = async () => { const r = await send("FBW_STOP"); if (r) setStatus(r); };


  // Pop the bound tab into its OWN window (kept unfocused). A tab that's the
  // foreground tab of its window stays document.visibilityState==='visible' even
  // when another window has focus → Chrome won't throttle its timers or pause
  // reels. So you can let it run there and work freely in your main window.
  const detach = async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab(platform);
    if (tabId.current == null || typeof chrome === "undefined" || !chrome?.windows?.create) return;
    try { await chrome.windows.create({ tabId: tabId.current, focused: false }); }
    catch { /* tab may already be alone in its window */ }
  };

  const toggle = (k) => setActions((a) => ({ ...a, [k]: !a[k] }));

  const platformCfg = PLATFORMS[platform];
  const modeTabs = platformCfg.modes;
  const switchPlatform = (id) => {
    if (id === platform) return;
    setPlatform(id);
    setMode(PLATFORMS[id].defaultMode); // reset to a mode this platform supports
  };

  const hint = (() => {
    if (platform === "facebook")
      return mode === "C"
        ? "Facebook reels: Save + Like verified."
        : "Facebook posts: Save, Like + Follow verified. English-only filters posts.";
    if (platform === "instagram")
      return mode === "C"
        ? "Instagram reels: Like, Save + Follow verified (localized labels handled)."
        : "Instagram explore/hashtag: best-effort — likes centered reels while scrolling.";
    return mode === "A"
      ? "TikTok search: Like, Favorite + Follow verified; opens results and swipes through."
      : "TikTok For You: Like, Favorite + Follow verified.";
  })();

  return (
    <div className="flex min-h-screen flex-col pb-[84px]">
      <header className="px-4 pt-4 pb-2.5 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Logo />
            <h1 className="text-[15px] font-semibold grad-identity-text tracking-tight">socialWarmer</h1>
          </div>
          <div className="flex items-center gap-1.5">
            <OptionsDropdown
              pacing={pacing} setPacing={setPacing}
              thresholds={thresholds} setThresholds={setThresholds}
              sessionCap={sessionCap} setSessionCap={setSessionCap}
              disabled={running}
            />
            <StatusChip running={running} paused={paused} halted={halted} />
          </div>
        </div>
        {view === "warm" ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{platformCfg.name}</span>
            <PlatformSwitcher value={platform} onValueChange={switchPlatform} disabled={running} />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {view === "transcripts" ? "Captured transcripts" : view === "download" ? "Bulk downloads" : "Saved videos"}
          </span>
        )}
      </header>
      {running && !paused && !halted ? <div className="heat-bar" /> : null}

      <main className="flex-1 px-4 py-3 space-y-3">
      {view === "transcripts" ? (
        <TranscriptsPanel />
      ) : view === "saved" ? (
        <SavedPanel />
      ) : view === "download" ? (
        <DownloadPanel />
      ) : (
        <>

      {halted && (
        <div className="rounded-md bg-destructive/10 text-destructive text-sm font-medium px-3 py-2">
          Auto-halted: {status.haltReason}
        </div>
      )}
      {noTab && (
        <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2">
          Open {platformCfg.name} in a tab, then reopen this panel.
        </div>
      )}

      {!running && !halted && (
        <div className="space-y-3">
          <Segmented value={mode} onChange={setMode} items={modeTabs} />

          {mode === "A" && (
            <div className="space-y-1.5">
              <Label htmlFor="kw">Keyword or #hashtag</Label>
              <Input id="kw" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={platformCfg.keywordPlaceholder} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label htmlFor="targetN">Target (N)</Label>
              <Input id="targetN" type="number" min={1} max={500} value={targetN} onChange={(e) => setTargetN(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="persona">Personality</Label>
              <Select value={personality} onValueChange={setPersonality}>
                <SelectTrigger id="persona"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="random">Random</SelectItem>
                  <SelectItem value="binge">Binge</SelectItem>
                  <SelectItem value="casual">Casual</SelectItem>
                  <SelectItem value="engage">Engaged</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Card>
            <CardContent className="p-3.5 space-y-3">
              {[
                ["save", "Save"],
                ["like", "Like"],
                ["follow", "Follow"],
              ].map(([k, label]) => (
                <div key={k} className="flex items-center justify-between">
                  <Label htmlFor={`act-${k}`} className="text-sm text-foreground cursor-pointer">{label}</Label>
                  <Switch id={`act-${k}`} checked={actions[k]} onCheckedChange={() => toggle(k)} />
                </div>
              ))}
              {platform === "facebook" && mode !== "C" && (
                <>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <Label htmlFor="englishOnly" className="text-sm text-foreground cursor-pointer">English-only posts</Label>
                    <Switch id="englishOnly" checked={englishOnly} onCheckedChange={() => setEnglishOnly((v) => !v)} />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground leading-relaxed">{hint}</p>
        </div>
      )}

      {(running || halted) && status && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Mode" value={MODE_NAME[status.mode] || status.mode} />
            <Stat label="Persona" value={status.personality || "—"} />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Counter label="done" value={`${status.processed}/${status.targetN}`} />
            <Counter label="saved" value={status.saved} />
            <Counter label="liked" value={status.liked} />
            <Counter label="followed" value={status.followed} />
          </div>
          {status.etaMs > 0 && (
            <p className="text-xs text-muted-foreground text-right">time left {fmtMs(status.etaMs)}</p>
          )}
          <div ref={logRef} className="log-scroll rounded-lg bg-zinc-900 text-zinc-200 p-2.5 text-[11px] font-mono leading-relaxed h-52 overflow-y-auto whitespace-pre-wrap">
            {(status.log || []).map((e, i) => (
              <div key={i}><span className="text-zinc-500">{fmtClock(e.t)}</span> {e.msg}</div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        {!running ? (
          <Button className="flex-1 grad-blue border-0 text-white shadow-md" onClick={start} disabled={noTab}><Play /> Start</Button>
        ) : (
          <>
            <Button className="flex-1" variant="secondary" onClick={togglePause}>
              {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
            </Button>
            <Button className="flex-1" variant="destructive" onClick={stop}><Square /> Stop</Button>
          </>
        )}
        <Button
          variant="outline"
          size="icon"
          onClick={detach}
          disabled={noTab}
          title={`Move ${platformCfg.name} to its own window so it keeps scrolling while you work in other tabs`}
        >
          <ExternalLink />
        </Button>
      </div>
      {!noTab && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Click <ExternalLink className="inline size-3 -mt-0.5" /> to pop {platformCfg.name} into its own window — it keeps running there while you use other tabs. (A tab only scrolls while it's the visible tab of its window.)
        </p>
      )}

        </>
      )}
      </main>

      <BottomNav
        value={view}
        onChange={setView}
        pulse={running ? "warm" : null}
        items={[
          { id: "warm", label: "Warm", Icon: Flame },
          { id: "transcripts", label: "Transcripts", Icon: FileText },
          { id: "saved", label: "Saved", Icon: Bookmark },
          { id: "download", label: "Download", Icon: Download },
        ]}
      />
    </div>
  );
}

function StatusChip({ running, paused, halted }) {
  if (halted)
    return <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive">halted</span>;
  if (!running)
    return <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">idle</span>;
  if (paused)
    return <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-medium text-amber-600">paused</span>;
  return (
    <span
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ background: "hsl(var(--sw-ember) / 0.12)", color: "hsl(var(--sw-ember) / 0.95)" }}
    >
      <span className="ember-pulse h-1.5 w-1.5 rounded-full" style={{ background: "hsl(var(--sw-ember))" }} />
      running
    </span>
  );
}

function Stat({ label, value }) {
  return (
    <Card><CardContent className="p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-normal truncate">{value}</div>
    </CardContent></Card>
  );
}
function Counter({ label, value }) {
  return (
    <Card><CardContent className="p-2 text-center">
      <div className="text-xl font-normal grad-blue-text leading-tight">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </CardContent></Card>
  );
}

function Logo() {
  return (
    <div className="grad-identity size-7 rounded-[9px] flex items-center justify-center shadow-sm">
      <svg width="16" height="16" viewBox="0 0 128 128" aria-hidden="true">
        <path
          d="M64 27 C 73 48, 87 55, 87 75 C 87 87.7 76.7 98 64 98 C 51.3 98 41 87.7 41 75 C 41 64.5 48 58 52.5 51.5 C 54.5 60 60 62 60 56 C 60 44 60 37 64 27 Z"
          fill="#ffffff"
        />
        <path
          d="M64 60 C 69 70, 75 73, 75 81.5 C 75 87 70 91 64 91 C 58 91 53 87 53 81.5 C 53 75.5 57.5 73 60 68.5 C 61 73 64 73 64 68 C 64 65 63.5 63 64 60 Z"
          fill="#bfe3f6"
        />
      </svg>
    </div>
  );
}
