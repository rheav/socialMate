import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, Square, ExternalLink, Plus, Trash2 } from "lucide-react";
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
// Seed comment phrases — short, human, emoji-flavored (mystic/astro niche).
const DEFAULT_PHRASES = [
  "I claim this ✨",
  "Yesss! 🙌",
  "This is for me 🔮",
  "Needed this today 🙏",
  "Claiming it ⭐",
  "So true 💫",
  "Wow 😍",
  "Thank you 🌙",
  "This spoke to me ❤️",
  "Sending love 💖",
  "Meant to see this 🌟",
  "Grateful 🙏✨",
];
let _pid = 0;
const newPhrase = (text) => ({ id: `p${Date.now().toString(36)}${_pid++}`, text });
// FB's 7 reactions (order = how the picker lays them out).
const REACTION_OPTS = [
  { k: "like", emoji: "👍", name: "Like" },
  { k: "love", emoji: "❤️", name: "Love" },
  { k: "care", emoji: "🤗", name: "Care" },
  { k: "haha", emoji: "😆", name: "Haha" },
  { k: "wow", emoji: "😮", name: "Wow" },
  { k: "sad", emoji: "😢", name: "Sad" },
  { k: "angry", emoji: "😡", name: "Angry" },
];
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
  // Which FB reactions the warmer may send (weighted mix, Like dominant).
  const [reactions, setReactions] = useState({
    like: true, love: true, haha: false, wow: false, care: false, sad: false, angry: false,
  });
  // Commenting (FB reels): enable + chance + editable phrase pool + draft input.
  const [comment, setComment] = useState({
    enabled: false,
    chance: 0.08,
    onlyFullyWatched: true,
    phrases: DEFAULT_PHRASES.map(newPhrase),
  });
  const [phraseDraft, setPhraseDraft] = useState("");
  const [quickMode, setQuickMode] = useState(false); // test mode: 3–10s dwell + short gaps
  // Relevance/spam knobs are no longer surfaced: spam guard stays ON via the
  // engine default; the niche-relevance gate is off (a hashtag feed is already
  // on-niche). Deep relevance (Whisper-for-relevance) was removed entirely.
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
      if (o?.quickMode != null) setQuickMode(o.quickMode);
      if (o?.reactions) setReactions((r) => ({ ...r, ...o.reactions }));
      if (o?.comment) {
        // stored phrases are plain strings → rehydrate to {id,text}
        const phrases = Array.isArray(o.comment.phrases)
          ? o.comment.phrases.map((t) => newPhrase(t))
          : DEFAULT_PHRASES.map(newPhrase);
        setComment((c) => ({
          ...c,
          ...o.comment,
          phrases: phrases.length ? phrases : DEFAULT_PHRASES.map(newPhrase),
        }));
      }
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
        quickMode,
        reactions,
        comment: {
          enabled: comment.enabled,
          chance: comment.chance,
          onlyFullyWatched: comment.onlyFullyWatched,
          phrases: comment.phrases.map((p) => p.text),
        },
      },
    });
  }, [pacing, thresholds, autoCapture, duration, maxItems, quickMode, reactions, comment]);

  const [status, setStatus] = useState(null);
  const [noTab, setNoTab] = useState(false);
  const [needReload, setNeedReload] = useState(false); // tab exists, engine unreachable
  const statusMisses = useRef(0);
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
      // Tab exists but the engine doesn't answer — content script missing
      // (tab predates the extension load/reload). Surface it after a few
      // misses instead of failing Start silently.
      tabId.current = null;
      statusMisses.current += 1;
      if (statusMisses.current >= 3) setNeedReload(true);
      return;
    }
    statusMisses.current = 0;
    setNeedReload(false);
    setStatus(st);
  }, [send, platform]);

  const reloadPlatformTab = async () => {
    const t = tabId.current ?? (await resolvePlatformTab(platform));
    if (t == null || typeof chrome === "undefined" || !chrome?.tabs?.reload)
      return;
    try {
      await chrome.tabs.reload(t);
      statusMisses.current = 0;
      setNeedReload(false);
    } catch {
      /* tab gone — next poll re-resolves */
    }
  };

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
      // FB warmer is like-only (panel hides Save/Follow there) — force the
      // hidden defaults off so reels runs don't save/follow every card.
      ...(platform === "facebook" ? { save: false, follow: false } : {}),
      englishOnly,
      quickMode,
      personality,
      // Reaction mix only applies to the Facebook engine; ensure Like is on if
      // the user cleared everything.
      reactions: reactions.like || Object.values(reactions).some(Boolean)
        ? reactions
        : { ...reactions, like: true },
      // Comments only meaningful on FB reels — engine ignores it elsewhere.
      comment: {
        enabled: comment.enabled,
        chance: Number(comment.chance) || 0.08,
        onlyFullyWatched: comment.onlyFullyWatched,
        phrases: comment.phrases.map((p) => p.text.trim()).filter(Boolean),
      },
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

  // Comment phrase-list editing (mirrors the ugc-factory headlines UX).
  const addPhrase = () => {
    const t = phraseDraft.trim();
    if (!t) return;
    setComment((c) => ({ ...c, phrases: [...c.phrases, newPhrase(t)] }));
    setPhraseDraft("");
  };
  const removePhrase = (id) =>
    setComment((c) => ({ ...c, phrases: c.phrases.filter((p) => p.id !== id) }));
  const patchPhrase = (id, text) =>
    setComment((c) => ({
      ...c,
      phrases: c.phrases.map((p) => (p.id === id ? { ...p, text } : p)),
    }));

  const modeTabs = platformCfg.modes;

  const hint = (() => {
    if (platform === "facebook")
      return mode === "C"
        ? "Facebook reels: watches each reel to the end, then advances — Likes randomly by personality. Localized (en/pt-br/es/fr/it). Keep the tab visible or pop it out."
        : "Facebook hashtag: lurks first, watches each post's video, Likes/Loves randomly by personality — scam posts skipped automatically, per-author throttle, hourly cap.";
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
      {!noTab && needReload && (
        <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2 flex items-center justify-between gap-2">
          <span>
            The {platformCfg.name} tab isn&apos;t responding — it needs a reload.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs shrink-0"
            onClick={reloadPlatformTab}
          >
            Reload tab
          </Button>
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

              {/* FB reactions: pick which ones the warmer sends (weighted mix,
                  Like dominant). Only meaningful when Like is on. */}
              {platform === "facebook" && actions.like && (
                <div className="space-y-1.5">
                  <Label className="text-sm text-foreground">Reactions</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {REACTION_OPTS.map(({ k, emoji, name }) => {
                      const on = reactions[k];
                      return (
                        <button
                          key={k}
                          type="button"
                          title={name}
                          onClick={() =>
                            setReactions((r) => ({ ...r, [k]: !r[k] }))
                          }
                          className={
                            "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors " +
                            (on
                              ? "border-transparent bg-primary/12 text-foreground ring-1 ring-primary/40"
                              : "border-border text-muted-foreground hover:bg-accent")
                          }
                        >
                          <span className={on ? "" : "opacity-50 grayscale"}>{emoji}</span>
                          {name}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    A weighted mix of the ones you pick — Like most often, the
                    rest sprinkled in (opens FB's reaction picker per post).
                  </p>
                </div>
              )}
              {/* English filter only runs in the posts loop — hide it on Reels. */}
              {platform === "facebook" && mode === "A" && (
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
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <Label
                    htmlFor="quickMode"
                    className="text-sm text-foreground cursor-pointer"
                  >
                    ⚡ Quick mode
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    3–10s per item, short gaps — for testing.
                  </p>
                </div>
                <Switch
                  id="quickMode"
                  checked={quickMode}
                  onCheckedChange={() => setQuickMode((v) => !v)}
                />
              </div>
            </CardContent>
          </Card>

          {/* Comments — FB reels only. Rare, fully-watched reels, editable pool. */}
          {platform === "facebook" && mode === "C" && (
            <Card>
              <CardContent className="p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label
                      htmlFor="commentOn"
                      className="text-sm text-foreground cursor-pointer"
                    >
                      💬 Comment on reels
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Rarely posts one of your phrases — only on reels watched to
                      the end.
                    </p>
                  </div>
                  <Switch
                    id="commentOn"
                    checked={comment.enabled}
                    onCheckedChange={() =>
                      setComment((c) => ({ ...c, enabled: !c.enabled }))
                    }
                  />
                </div>

                {comment.enabled && (
                  <>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="cchance" className="text-sm text-foreground">
                          How often
                        </Label>
                        <span className="text-xs font-mono text-muted-foreground">
                          {Math.round((comment.chance || 0) * 100)}% of full watches
                        </span>
                      </div>
                      <input
                        id="cchance"
                        type="range"
                        min={0.02}
                        max={0.3}
                        step={0.01}
                        value={comment.chance}
                        onChange={(e) =>
                          setComment((c) => ({ ...c, chance: Number(e.target.value) }))
                        }
                        className="w-full accent-primary cursor-pointer"
                      />
                    </div>

                    <Separator />

                    <div className="space-y-1.5">
                      <Label className="text-sm text-foreground">
                        Phrases ({comment.phrases.length})
                      </Label>
                      <div className="space-y-1.5 max-h-44 overflow-y-auto pr-0.5">
                        {comment.phrases.map((p) => (
                          <div key={p.id} className="flex items-center gap-1.5">
                            <Input
                              value={p.text}
                              onChange={(e) => patchPhrase(p.id, e.target.value)}
                              className="h-8 text-xs"
                            />
                            <button
                              type="button"
                              onClick={() => removePhrase(p.id)}
                              title="Remove phrase"
                              className="grid size-8 flex-none place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={phraseDraft}
                          onChange={(e) => setPhraseDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addPhrase();
                            }
                          }}
                          placeholder="Add a phrase (with emoji ✨)…"
                          className="h-8 text-xs"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-8 shrink-0"
                          onClick={addPhrase}
                          disabled={!phraseDraft.trim()}
                        >
                          <Plus className="size-3.5" /> Add
                        </Button>
                      </div>
                    </div>
                  </>
                )}
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
          {platform === "facebook" &&
            (status.reactionCounts || status.commented) && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                {REACTION_OPTS.filter((o) => status.reactionCounts?.[o.k]).map(
                  (o) => (
                    <span key={o.k}>
                      {o.emoji} {status.reactionCounts[o.k]}
                    </span>
                  ),
                )}
                {status.commented ? <span>💬 {status.commented}</span> : null}
              </div>
            )}
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
            className="flex-1 grad-blue border-0 text-primary-foreground shadow-md"
            onClick={start}
            disabled={noTab || needReload}
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
