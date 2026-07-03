import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, Square, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import Segmented from "@/components/ui/Segmented";
import OptionsDropdown from "@/components/ui/OptionsDropdown";
import { PLATFORMS } from "@/lib/platforms";
import { resolvePlatformTab } from "@/lib/tabs";
import { isStaleSession } from "@/lib/sessionMath";

const MODE_NAME = { A: "Keyword", B: "Feed", C: "Reels" };
const fmtMs = (ms) => {
  if (!ms || ms <= 0) return "0:00";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtClock = (t) => new Date(t).toTimeString().slice(0, 8);

// The Warm tool — semi-automated warming for the given platform. Self-contained:
// owns its bound tab, polling, options persistence, and run controls. The Shell
// provides the platform (prop), the header chrome, theme retint, and navigation.
export default function WarmTool({ platform }) {
  const platformCfg = PLATFORMS[platform];
  const [mode, setMode] = useState(platformCfg.defaultMode);
  const [keyword, setKeyword] = useState("");
  const [duration, setDuration] = useState(15); // session length, minutes
  const [personality, setPersonality] = useState("random");
  const [actions, setActions] = useState({
    save: true,
    like: true,
    follow: false,
  });
  const [englishOnly, setEnglishOnly] = useState(true);
  const [relevanceMin, setRelevanceMin] = useState(0.25); // niche cosine gate (0 = off)
  const [spamGuard, setSpamGuard] = useState(true); // skip scam/spam posts
  const [deepRelevance, setDeepRelevance] = useState(false); // transcribe video for relevance
  const [pacing, setPacing] = useState({
    minDelay: 4,
    maxDelay: 9,
    reelMin: 6,
    reelMax: 15,
  });
  const [maxItems, setMaxItems] = useState(0); // 0 = no item cap
  const [thresholds, setThresholds] = useState({ minLikes: 0, minComments: 0 });
  const [autoCapture, setAutoCapture] = useState({
    enabled: false,
    minLikes: 0,
    minComments: 0,
    download: true,
    transcribe: true,
    favorite: true,
  });
  const optsLoaded = useRef(false);

  // Options persist across panel opens (chrome.storage.local).
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) {
      optsLoaded.current = true;
      return;
    }
    chrome.storage.local.get("swOptions").then((r) => {
      const o = r?.swOptions;
      if (o?.pacing) setPacing(o.pacing);
      if (o?.thresholds) setThresholds(o.thresholds);
      if (o?.autoCapture) setAutoCapture((a) => ({ ...a, ...o.autoCapture }));
      if (o?.duration != null) setDuration(o.duration);
      if (o?.maxItems != null) setMaxItems(o.maxItems);
      if (o?.relevanceMin != null) setRelevanceMin(o.relevanceMin);
      if (o?.spamGuard != null) setSpamGuard(o.spamGuard);
      if (o?.deepRelevance != null) setDeepRelevance(o.deepRelevance);
      optsLoaded.current = true;
    });
  }, []);
  useEffect(() => {
    if (
      !optsLoaded.current ||
      typeof chrome === "undefined" ||
      !chrome?.storage?.local
    )
      return;
    chrome.storage.local.set({
      swOptions: {
        pacing,
        thresholds,
        autoCapture,
        duration,
        maxItems,
        relevanceMin,
        spamGuard,
        deepRelevance,
      },
    });
  }, [
    pacing,
    thresholds,
    autoCapture,
    duration,
    maxItems,
    relevanceMin,
    spamGuard,
    deepRelevance,
  ]);

  const [status, setStatus] = useState(null);
  const [noTab, setNoTab] = useState(false);
  const tabId = useRef(null);
  const logRef = useRef(null);

  const [summary, setSummary] = useState(null);

  // Load last-run summary when idle; reconcile abandoned runs on mount.
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    (async () => {
      const r = await chrome.storage.local.get(["fbw_session", "fbw_history", "fbw_last_summary"]);
      const s = r?.fbw_session;
      if (isStaleSession(s)) {
        // Run died without an end path (browser/tab killed) → abandoned.
        const entry = {
          at: Date.now(),
          startedAt: s.startedAt || 0,
          durationMs: (s.savedAt || Date.now()) - (s.startedAt || s.savedAt || Date.now()),
          platform: s.platform,
          mode: s.mode,
          keyword: s.keyword || "",
          processed: s.processed || 0,
          liked: s.liked || 0,
          loved: s.loved || 0,
          skipped: s.skipped || 0,
          outcome: "abandoned",
        };
        const hist = Array.isArray(r.fbw_history) ? r.fbw_history : [];
        const sum = {
          outcome: "abandoned",
          platform: s.platform,
          mode: s.mode,
          keyword: s.keyword || "",
          startedAt: s.startedAt || 0,
          endedAt: s.savedAt || Date.now(),
          durationMs: entry.durationMs,
          processed: entry.processed,
          saved: s.saved || 0,
          liked: entry.liked,
          loved: entry.loved,
          followed: s.followed || 0,
          skipped: entry.skipped,
          personality: null,
        };
        await chrome.storage.local.set({
          fbw_history: [...hist, entry].slice(-50),
          fbw_last_summary: sum,
          fbw_session: { isRunning: false },
        });
        setSummary(sum);
      } else if (r?.fbw_last_summary) {
        setSummary(r.fbw_last_summary);
      }
    })().catch(() => {});
  }, []);

  const send = useCallback(async (type, payload = {}) => {
    if (tabId.current == null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId.current, { type, ...payload });
    } catch {
      return null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (tabId.current == null)
      tabId.current = await resolvePlatformTab(platform);
    if (tabId.current == null) {
      setNoTab(true);
      return;
    }
    setNoTab(false);
    const st = await send("FBW_STATUS");
    if (st === null) {
      tabId.current = null;
      return;
    }
    setStatus(st);
  }, [send, platform]);

  // reset mode + re-resolve the target tab whenever the platform changes
  useEffect(() => {
    setMode(PLATFORMS[platform].defaultMode);
    tabId.current = null;
  }, [platform]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 1000);
    const onClosed = (closedId) => {
      if (closedId === tabId.current) tabId.current = null;
    };
    const hasTabs = typeof chrome !== "undefined" && chrome?.tabs?.onRemoved;
    if (hasTabs) chrome.tabs.onRemoved.addListener(onClosed);
    return () => {
      clearInterval(id);
      if (hasTabs) chrome.tabs.onRemoved.removeListener(onClosed);
    };
  }, [poll]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log]);

  const running = !!status?.isRunning;
  const paused = !!status?.isPaused;
  const halted = !!status?.haltReason;

  // Refresh the card when a run ends while the panel is open.
  useEffect(() => {
    if (running || typeof chrome === "undefined" || !chrome?.storage?.local) return;
    chrome.storage.local
      .get("fbw_last_summary")
      .then((r) => r?.fbw_last_summary && setSummary(r.fbw_last_summary))
      .catch(() => {});
  }, [running]);

  const dismissSummary = () => {
    chrome?.storage?.local?.remove("fbw_last_summary");
    setSummary(null);
  };

  const start = async () => {
    if (mode === "A" && !keyword.trim()) return;
    const settings = {
      platform,
      mode,
      keyword: keyword.trim(),
      durationMinutes: Math.max(3, Number(duration) || 15),
      maxItems: Math.max(0, Number(maxItems) || 0),
      ...actions,
      englishOnly,
      relevanceMin: Number(relevanceMin) || 0,
      spamGuard,
      deepRelevance,
      personality,
      thresholds: {
        minLikes: Number(thresholds.minLikes) || 0,
        minComments: Number(thresholds.minComments) || 0,
      },
      autoCapture: {
        enabled: !!autoCapture.enabled,
        minLikes: Number(autoCapture.minLikes) || 0,
        minComments: Number(autoCapture.minComments) || 0,
        download: autoCapture.download !== false,
        transcribe: autoCapture.transcribe !== false,
        favorite: autoCapture.favorite !== false,
      },
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
  const togglePause = async () => {
    const r = await send("FBW_TOGGLE_PAUSE");
    if (r) setStatus(r);
  };
  const stop = async () => {
    const r = await send("FBW_STOP");
    if (r) setStatus(r);
  };

  // Pop the bound tab into its OWN window (kept unfocused) so it keeps scrolling
  // while you work elsewhere.
  const detach = async () => {
    if (tabId.current == null)
      tabId.current = await resolvePlatformTab(platform);
    if (
      tabId.current == null ||
      typeof chrome === "undefined" ||
      !chrome?.windows?.create
    )
      return;
    try {
      await chrome.windows.create({ tabId: tabId.current, focused: false });
    } catch {
      /* tab may already be alone in its window */
    }
  };

  const toggle = (k) => setActions((a) => ({ ...a, [k]: !a[k] }));

  const modeTabs = platformCfg.modes;

  const hint = (() => {
    if (platform === "facebook")
      return "Facebook hashtag: lurks first, then Likes/Loves posts weighted by niche relevance — human pointer trail, per-author throttle, hourly cap, circadian pacing.";
    if (platform === "instagram")
      return mode === "C"
        ? "Instagram reels: Like, Save + Follow verified (localized labels handled)."
        : "Instagram explore/hashtag: best-effort — likes centered reels while scrolling.";
    return mode === "A"
      ? "TikTok search: Like, Favorite + Follow verified; opens results and swipes through."
      : "TikTok For You: Like, Favorite + Follow verified.";
  })();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-1.5">
        <OptionsDropdown
          pacing={pacing}
          setPacing={setPacing}
          thresholds={thresholds}
          setThresholds={setThresholds}
          autoCapture={autoCapture}
          setAutoCapture={setAutoCapture}
          maxItems={maxItems}
          setMaxItems={setMaxItems}
          disabled={running}
        />
        <StatusChip
          running={running}
          paused={paused}
          halted={halted}
          onBreak={!!status?.isAutoBreak}
        />
      </div>
      {running && !paused && !halted && !status?.isAutoBreak ? (
        <div className="heat-bar" />
      ) : null}

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

      {!running && summary && (
        <SummaryCard summary={summary} onDismiss={dismissSummary} />
      )}

      {!running && !halted && (
        <div className="space-y-3">
          {modeTabs.length > 1 && (
            <Segmented value={mode} onChange={setMode} items={modeTabs} />
          )}

          {mode === "A" && (
            <div className="space-y-1.5">
              <Label htmlFor="kw">
                {platform === "facebook"
                  ? "Hashtag (no # needed)"
                  : "Keyword or #hashtag"}
              </Label>
              <Input
                id="kw"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={platformCfg.keywordPlaceholder}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label htmlFor="duration">Duration (min)</Label>
              <Input
                id="duration"
                type="number"
                min={3}
                max={180}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="persona">Personality</Label>
              <Select value={personality} onValueChange={setPersonality}>
                <SelectTrigger id="persona">
                  <SelectValue />
                </SelectTrigger>
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
              ]
                // Facebook hashtag warmer is like-only — hide Save/Follow there.
                .filter(([k]) => platform !== "facebook" || k === "like")
                .map(([k, label]) => (
                  <div key={k} className="flex items-center justify-between">
                    <Label
                      htmlFor={`act-${k}`}
                      className="text-sm text-foreground cursor-pointer"
                    >
                      {label}
                    </Label>
                    <Switch
                      id={`act-${k}`}
                      checked={actions[k]}
                      onCheckedChange={() => toggle(k)}
                    />
                  </div>
                ))}
              {platform === "facebook" && (
                <>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <Label
                      htmlFor="englishOnly"
                      className="text-sm text-foreground cursor-pointer"
                    >
                      English-only posts
                    </Label>
                    <Switch
                      id="englishOnly"
                      checked={englishOnly}
                      onCheckedChange={() => setEnglishOnly((v) => !v)}
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {mode === "A" && (
            <Card>
              <CardContent className="p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="relMin" className="text-sm text-foreground">
                    Niche relevance (AI)
                  </Label>
                  <span className="text-xs font-mono text-muted-foreground">
                    {relevanceMin <= 0
                      ? "off"
                      : `≥ ${Number(relevanceMin).toFixed(2)}`}
                  </span>
                </div>
                <input
                  id="relMin"
                  type="range"
                  min={0}
                  max={0.6}
                  step={0.05}
                  value={relevanceMin}
                  onChange={(e) => setRelevanceMin(Number(e.target.value))}
                  className="w-full accent-foreground cursor-pointer"
                />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Local MiniLM embeds each post and weights likes toward ones
                  semantically close to your keyword. Higher = stricter. 0 = like
                  regardless.
                </p>
                <Separator />
                <div className="flex items-center justify-between">
                  <Label
                    htmlFor="spamGuard"
                    className="text-sm text-foreground cursor-pointer"
                  >
                    Spam / scam guard
                  </Label>
                  <Switch
                    id="spamGuard"
                    checked={spamGuard}
                    onCheckedChange={() => setSpamGuard((v) => !v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label
                      htmlFor="deepRel"
                      className="text-sm text-foreground cursor-pointer"
                    >
                      Deep relevance (transcribe video)
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Whisper reads the video's audio — better on caption-thin
                      posts. Slower.
                    </p>
                  </div>
                  <Switch
                    id="deepRel"
                    checked={deepRelevance}
                    onCheckedChange={() => setDeepRelevance((v) => !v)}
                  />
                </div>
              </CardContent>
            </Card>
          )}

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
            <Counter
              label="done"
              value={
                status.maxItems > 0
                  ? `${status.processed}/${status.maxItems}`
                  : `${status.processed}`
              }
            />
            {platform === "facebook" ? (
              <>
                <Counter label="liked" value={status.liked} />
                <Counter label="loved" value={status.loved ?? 0} />
                <Counter label="skipped" value={status.skipped} />
              </>
            ) : (
              <>
                <Counter label="saved" value={status.saved} />
                <Counter label="liked" value={status.liked} />
                <Counter label="followed" value={status.followed} />
              </>
            )}
          </div>
          {status.etaMs > 0 && (
            <p className="text-xs text-muted-foreground text-right">
              time left {fmtMs(status.etaMs)}
            </p>
          )}
          <div
            ref={logRef}
            className="log-scroll rounded-lg bg-zinc-900 text-zinc-200 p-2.5 text-[11px] font-mono leading-relaxed h-52 overflow-y-auto whitespace-pre-wrap"
          >
            {(status.log || []).map((e, i) => (
              <div key={i}>
                <span className="text-zinc-500">{fmtClock(e.t)}</span> {e.msg}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        {!running ? (
          <Button
            className="flex-1 grad-blue border-0 text-white shadow-md"
            onClick={start}
            disabled={noTab}
          >
            <Play /> Start
          </Button>
        ) : (
          <>
            <Button className="flex-1" variant="secondary" onClick={togglePause}>
              {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
            </Button>
            <Button className="flex-1" variant="destructive" onClick={stop}>
              <Square /> Stop
            </Button>
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
          Click <ExternalLink className="inline size-3 -mt-0.5" /> to pop{" "}
          {platformCfg.name} into its own window — it keeps running there while
          you use other tabs. (A tab only scrolls while it's the visible tab of
          its window.)
        </p>
      )}
    </div>
  );
}

function StatusChip({ running, paused, halted, onBreak }) {
  if (halted)
    return (
      <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive">
        halted
      </span>
    );
  if (!running)
    return (
      <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
        idle
      </span>
    );
  if (onBreak)
    return (
      <span className="rounded-full bg-sky-400/15 px-2.5 py-1 text-[11px] font-medium text-sky-600">
        on break
      </span>
    );
  if (paused)
    return (
      <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-medium text-amber-600">
        paused
      </span>
    );
  return (
    <span
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{
        background: "hsl(var(--sw-ember) / 0.12)",
        color: "hsl(var(--sw-ember) / 0.95)",
      }}
    >
      <span
        className="ember-pulse h-1.5 w-1.5 rounded-full"
        style={{ background: "hsl(var(--sw-ember))" }}
      />
      running
    </span>
  );
}

function SummaryCard({ summary, onDismiss }) {
  const ok = summary.outcome === "complete";
  const badge = ok
    ? "bg-emerald-500/10 text-emerald-600"
    : summary.outcome === "abandoned"
      ? "bg-amber-400/15 text-amber-600"
      : (summary.outcome || "").startsWith("halt")
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="p-3.5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Last session</span>
          <span className={`text-[10px] rounded-full px-2 py-0.5 ${badge}`}>
            {summary.outcome}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {summary.platform} · {summary.keyword || summary.mode}
          {summary.personality ? ` · ${summary.personality}` : ""} ·{" "}
          {fmtMs(summary.durationMs)}
        </div>
        <div className="flex gap-3 text-[11px] text-muted-foreground">
          <span>seen {summary.processed}</span>
          <span>👍 {summary.liked}</span>
          <span>❤️ {summary.loved ?? 0}</span>
          <span>➕ {summary.followed ?? 0}</span>
          <span>skip {summary.skipped}</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs w-full" onClick={onDismiss}>
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }) {
  return (
    <Card>
      <CardContent className="p-2.5">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="text-sm font-normal truncate">{value}</div>
      </CardContent>
    </Card>
  );
}

function Counter({ label, value }) {
  return (
    <Card>
      <CardContent className="p-2 text-center">
        <div className="text-xl font-normal grad-blue-text leading-tight">
          {value}
        </div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
