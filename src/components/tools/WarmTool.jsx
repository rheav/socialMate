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
import { ToolBar, ActionButton, ToolIconButton } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { PLATFORMS } from "@/lib/platforms";
import { useContentLink } from "@/lib/useContentLink";
import { isStaleSession } from "@/lib/sessionMath";
import { startPolling } from "@/lib/poll";

const MODE_NAME = { A: "Palavra-chave", B: "Feed", C: "Reels" };
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
  { k: "like", emoji: "👍", name: "Curtir" },
  { k: "love", emoji: "❤️", name: "Amei" },
  { k: "care", emoji: "🤗", name: "Cuidado" },
  { k: "haha", emoji: "😆", name: "Haha" },
  { k: "wow", emoji: "😮", name: "Uau" },
  { k: "sad", emoji: "😢", name: "Triste" },
  { k: "angry", emoji: "😡", name: "Grr" },
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
    // Debounced: the deps include every text field, so this used to fire a full
    // storage write on EVERY keystroke — each character of a comment phrase, each
    // digit of the duration.
    const t = setTimeout(() => {
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
    }, 300);
    return () => clearTimeout(t);
  }, [pacing, thresholds, autoCapture, duration, maxItems, quickMode, reactions, comment]);

  const [status, setStatus] = useState(null);
  // The panel↔content-script link (tab binding, failure reporting, recovery)
  // lives in one shared hook — see lib/contentLink.js for why.
  const { link, noTab, fixing, send, revive, openTab, ensureTab, tabId } =
    useContentLink(platform);
  // Anything the ENGINE itself refused, or that this form got wrong. Distinct
  // from `link`: the tab answered, it just said no — and that answer used to be
  // dropped on the floor by `if (res?.ok)`.
  const [runError, setRunError] = useState(null);
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

  // Background traffic: a lone miss is tolerated (the hook only escalates after
  // a run of them), so an SPA navigation doesn't flash a banner.
  const poll = useCallback(async () => {
    const st = await send({ type: "FBW_STATUS" });
    if (st) setStatus(st);
  }, [send]);

  // reset mode when the platform changes (the hook re-binds the tab itself)
  useEffect(() => {
    setMode(PLATFORMS[platform].defaultMode);
    setRunError(null);
  }, [platform]);

  const running = !!status?.isRunning;

  useEffect(() => {
    // 1s while a run is live (the log and counters animate); back off to 4s when
    // idle — an idle panel was waking the content script every second for a status
    // object that never changed. startPolling fires immediately, so switching
    // cadence still refreshes at once.
    const stopPoll = startPolling(poll, running ? 1000 : 4000);
    const onClosed = (closedId) => {
      if (closedId === tabId.current) tabId.current = null;
    };
    const hasTabs = typeof chrome !== "undefined" && chrome?.tabs?.onRemoved;
    if (hasTabs) chrome.tabs.onRemoved.addListener(onClosed);
    return () => {
      stopPoll();
      if (hasTabs) chrome.tabs.onRemoved.removeListener(onClosed);
    };
  }, [poll, running]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log]);

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
    setRunError(null);
    if (mode === "A" && !keyword.trim()) {
      // This used to be a bare `return`: the click did nothing and said nothing,
      // which is indistinguishable from the extension being broken.
      setRunError(
        platform === "facebook"
          ? "Digite uma hashtag antes de iniciar (ex.: tarotreading)."
          : "Digite uma palavra-chave ou hashtag antes de iniciar.",
      );
      return;
    }
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
      // Gated exactly like the toggle that sets it (facebook + mode A). It was
      // being sent for every platform with its hidden default of `true`, so if the
      // IG/TT engines ever honour it users would get a silent English-only filter
      // they cannot see or turn off.
      englishOnly: platform === "facebook" && mode === "A" ? englishOnly : false,
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
    // userAction: the user is waiting on this click, so a dead link is reported
    // immediately instead of after a run of misses.
    const res = await send(
      { type: "FBW_START", settings },
      { userAction: true, action: "iniciar o aquecimento" },
    );
    // null → the link is down; the banner already explains it and offers the fix.
    if (res == null) return;
    if (res.ok) {
      setStatus(res);
      return;
    }
    // The engine answered and REFUSED (wrong page, bad settings). Its reason is
    // the most useful thing we have; `if (res?.ok)` used to discard it.
    setRunError(res.error || "O motor recusou a inicialização nesta página.");
  };
  const togglePause = async () => {
    setRunError(null);
    const r = await send(
      { type: "FBW_TOGGLE_PAUSE" },
      { userAction: true, action: paused ? "retomar o aquecimento" : "pausar o aquecimento" },
    );
    if (r) setStatus(r);
  };
  const stop = async () => {
    setRunError(null);
    const r = await send(
      { type: "FBW_STOP" },
      { userAction: true, action: "parar o aquecimento" },
    );
    if (r) setStatus(r);
  };

  // Pop the bound tab into its OWN window (kept unfocused) so it keeps scrolling
  // while you work elsewhere.
  const detach = async () => {
    setRunError(null);
    const id = await ensureTab(); // reports "no tab" through the banner
    if (id == null) return;
    if (typeof chrome === "undefined" || !chrome?.windows?.create) return;
    try {
      await chrome.windows.create({ tabId: id, focused: false });
    } catch (e) {
      // Almost always "tab is already alone in its window" — harmless, but say
      // so rather than making the button look broken.
      setRunError(
        `Não foi possível mover a aba para outra janela: ${e?.message || e}`,
      );
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
        ? "Reels do Facebook: assiste cada reel até o fim e avança — curte aleatoriamente conforme a personalidade. Localizado (en/pt-br/es/fr/it). Mantenha a aba visível ou destaque-a em outra janela."
        : "Hashtag do Facebook: primeiro observa, assiste ao vídeo de cada post, curte/ama aleatoriamente conforme a personalidade — posts suspeitos são pulados automaticamente, com limite por autor e limite por hora.";
    if (platform === "instagram")
      return mode === "C"
        ? "Reels do Instagram: curte, salva e segue com verificação (rótulos localizados já tratados)."
        : "Explorar/hashtag do Instagram: melhor esforço — curte os reels centralizados enquanto rola a tela.";
    return mode === "A"
      ? "Pesquisa no TikTok: curte, favorita e segue com verificação; abre os resultados e desliza por eles."
      : "Para Você do TikTok: curte, favorita e segue com verificação.";
  })();

  return (
    <div className="space-y-3">
      <ToolBar className="justify-end">
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
      </ToolBar>
      {running && !paused && !halted && !status?.isAutoBreak ? (
        <div className="heat-bar" />
      ) : null}

      {halted && (
        <div className="rounded-md bg-destructive/10 text-destructive text-sm font-medium px-3 py-2">
          Interrompido automaticamente: {status.haltReason}
        </div>
      )}
      {/* One banner for every link failure — and the only place that fixes it.
          Renders null while the link is healthy. */}
      <ContentLinkBanner
        link={link}
        platformName={platformCfg.name}
        fixing={fixing}
        onRevive={revive}
        onOpenTab={openTab}
      />
      {runError && (
        <div className="flex min-w-0 items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 break-words">{runError}</span>
          <button
            type="button"
            onClick={() => setRunError(null)}
            className="ml-auto shrink-0 underline"
          >
            ok
          </button>
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
                  ? "Hashtag (sem # necessário)"
                  : "Palavra-chave ou #hashtag"}
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
              <Label htmlFor="duration">Duração (min)</Label>
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
              <Label htmlFor="persona">Personalidade</Label>
              <Select value={personality} onValueChange={setPersonality}>
                <SelectTrigger id="persona">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="random">Aleatória</SelectItem>
                  <SelectItem value="binge">Maratona</SelectItem>
                  <SelectItem value="casual">Casual</SelectItem>
                  <SelectItem value="engage">Engajada</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Card>
            <CardContent className="p-3.5 space-y-3">
              {[
                ["save", "Salvar"],
                ["like", "Curtir"],
                ["follow", "Seguir"],
              ]
                // Facebook hashtag warmer is like-only — hide Save/Follow there.
                .filter(([k]) => platform !== "facebook" || k === "like")
                .map(([k, label]) => (
                  <div key={k} className="flex min-w-0 items-center justify-between gap-2">
                    <Label
                      htmlFor={`act-${k}`}
                      className="text-sm text-foreground cursor-pointer"
                    >
                      {label}
                    </Label>
                    <Switch
                      id={`act-${k}`}
                      className="shrink-0"
                      checked={actions[k]}
                      onCheckedChange={() => toggle(k)}
                    />
                  </div>
                ))}

              {/* FB reactions: pick which ones the warmer sends (weighted mix,
                  Like dominant). Only meaningful when Like is on. */}
              {platform === "facebook" && actions.like && (
                <div className="space-y-1.5">
                  <Label className="text-sm text-foreground">Reações</Label>
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
                            "sw-hoverable flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs " +
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
                    Uma mistura ponderada das que você escolher — Curtir na
                    maioria das vezes, as outras aparecem ocasionalmente (abre
                    o seletor de reações do Facebook em cada post).
                  </p>
                </div>
              )}
              {/* English filter only runs in the posts loop — hide it on Reels. */}
              {platform === "facebook" && mode === "A" && (
                <>
                  <Separator />
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <Label
                      htmlFor="englishOnly"
                      className="text-sm text-foreground cursor-pointer"
                    >
                      Somente posts em inglês
                    </Label>
                    <Switch
                      id="englishOnly"
                      className="shrink-0"
                      checked={englishOnly}
                      onCheckedChange={() => setEnglishOnly((v) => !v)}
                    />
                  </div>
                </>
              )}
              <Separator />
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0">
                  <Label
                    htmlFor="quickMode"
                    className="text-sm text-foreground cursor-pointer"
                  >
                    ⚡ Modo rápido
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    3–10s por item, intervalos curtos — para testes.
                  </p>
                </div>
                <Switch
                  id="quickMode"
                  className="shrink-0"
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
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="min-w-0">
                    <Label
                      htmlFor="commentOn"
                      className="text-sm text-foreground cursor-pointer"
                    >
                      💬 Comentar nos reels
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Raramente publica uma das suas frases — só em reels
                      assistidos até o fim.
                    </p>
                  </div>
                  <Switch
                    id="commentOn"
                    className="shrink-0"
                    checked={comment.enabled}
                    onCheckedChange={() =>
                      setComment((c) => ({ ...c, enabled: !c.enabled }))
                    }
                  />
                </div>

                {comment.enabled && (
                  <>
                    <div className="space-y-1.5">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                        <Label htmlFor="cchance" className="text-sm text-foreground">
                          Com que frequência
                        </Label>
                        <span className="min-w-0 break-words text-xs font-mono text-muted-foreground">
                          {Math.round((comment.chance || 0) * 100)}% das visualizações completas
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
                        Frases ({comment.phrases.length})
                      </Label>
                      <div className="space-y-1.5 max-h-44 overflow-y-auto pr-0.5">
                        {comment.phrases.map((p) => (
                          <div key={p.id} className="flex min-w-0 items-center gap-1.5">
                            <Input
                              value={p.text}
                              onChange={(e) => patchPhrase(p.id, e.target.value)}
                              className="h-8 min-w-0 flex-1 text-xs"
                            />
                            <button
                              type="button"
                              onClick={() => removePhrase(p.id)}
                              title="Remover frase"
                              className="grid size-8 flex-none place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <ToolBar>
                        <Input
                          value={phraseDraft}
                          onChange={(e) => setPhraseDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addPhrase();
                            }
                          }}
                          placeholder="Adicione uma frase (com emoji ✨)…"
                          className="h-8 min-w-0 flex-1 text-xs"
                        />
                        <ActionButton
                          type="button"
                          icon={Plus}
                          label="Adicionar"
                          hint="Adicionar esta frase ao conjunto"
                          variant="secondary"
                          className="h-8"
                          onClick={addPhrase}
                          disabled={!phraseDraft.trim()}
                        />
                      </ToolBar>
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
            <Stat label="Modo" value={MODE_NAME[status.mode] || status.mode} />
            <Stat label="Personalidade" value={status.personality || "—"} />
          </div>
          {/* 4 counters × pt-BR labels ("concluído", "seguidos") do not fit one
              row at the minimum panel width, so they fold to 2×2 there. The
              @container comes from ToolBar's wrapper. */}
          <ToolBar className="grid grid-cols-2 gap-2 @min-[308.05px]/toolbar:grid-cols-4">
            <Counter
              label="concluído"
              value={
                status.maxItems > 0
                  ? `${status.processed}/${status.maxItems}`
                  : `${status.processed}`
              }
            />
            {platform === "facebook" ? (
              <>
                <Counter label="curtidos" value={status.liked} />
                <Counter label="amados" value={status.loved ?? 0} />
                <Counter label="pulados" value={status.skipped} />
              </>
            ) : (
              <>
                <Counter label="salvos" value={status.saved} />
                <Counter label="curtidos" value={status.liked} />
                <Counter label="seguidos" value={status.followed} />
              </>
            )}
          </ToolBar>
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
              tempo restante {fmtMs(status.etaMs)}
            </p>
          )}
          {/* break-words: log lines carry hashtags/URLs with no break
              opportunity — without it a single long token widens the panel. */}
          <div
            ref={logRef}
            className="console log-scroll rounded-lg p-2.5 text-[11px] font-mono leading-relaxed h-52 overflow-y-auto break-words whitespace-pre-wrap"
          >
            {(status.log || []).map((e, i) => (
              <div key={i}>
                <span className="text-[#d9e0ee]/45">{fmtClock(e.t)}</span> {e.msg}
              </div>
            ))}
          </div>
        </div>
      )}

      <ToolBar className="gap-2">
        {!running ? (
          // DELIBERATELY NOT DISABLED. It used to be `disabled={noTab ||
          // needReload}`, and needReload is sticky until a later ping happens to
          // succeed — so the button could sit dead while the user clicked it,
          // with only a small hint to explain why. A disabled control answers
          // "no" without ever saying why or how to proceed. Enabled, the click
          // always produces something: the run starts, or the banner above names
          // the failure and offers the one-click repair. The ping/flag detection
          // is untouched — it now drives the banner instead of a dead button.
          <ActionButton
            icon={Play}
            label="Iniciar"
            size="default"
            className="h-9 basis-0 grow shadow-sm"
            onClick={start}
          />
        ) : (
          <>
            <ActionButton
              icon={paused ? Play : Pause}
              label={paused ? "Retomar" : "Pausar"}
              size="default"
              className="h-9 basis-0 grow"
              variant="secondary"
              onClick={togglePause}
            />
            <ActionButton
              icon={Square}
              label="Parar"
              size="default"
              className="h-9 basis-0 grow"
              variant="destructive"
              onClick={stop}
            />
          </>
        )}
        <ToolIconButton
          icon={ExternalLink}
          label={`Abrir o ${platformCfg.name} em sua própria janela`}
          hint={`Mover o ${platformCfg.name} para sua própria janela para continuar rolando enquanto você trabalha em outras abas`}
          className="size-9"
          onClick={detach}
        />
      </ToolBar>
      {!noTab && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Clique em <ExternalLink className="inline size-3 -mt-0.5" /> para
          abrir o {platformCfg.name} em sua própria janela — ele continua
          rodando lá enquanto você usa outras abas. (Uma aba só rola enquanto
          é a aba visível da sua janela.)
        </p>
      )}
    </div>
  );
}

function StatusChip({ running, paused, halted, onBreak }) {
  if (halted)
    return (
      <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive">
        interrompido
      </span>
    );
  if (!running)
    return (
      <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
        inativo
      </span>
    );
  if (onBreak)
    return (
      <span className="rounded-full bg-sky/15 px-2.5 py-1 text-[11px] font-medium text-sky">
        em pausa
      </span>
    );
  if (paused)
    return (
      <span className="rounded-full bg-amber/15 px-2.5 py-1 text-[11px] font-medium text-amber">
        pausado
      </span>
    );
  return (
    <span
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{
        background: "color-mix(in oklab, var(--sw-live) 14%, transparent)",
        color: "var(--sw-live)",
      }}
    >
      <span
        className="ember-pulse h-1.5 w-1.5 rounded-full"
        style={{ background: "var(--sw-live)" }}
      />
      em execução
    </span>
  );
}

// Display-only translation of the persisted outcome code (fbw_last_summary /
// fbw_history keep the raw English value — other code may read it — this maps
// it to Portuguese purely for the badge text).
const OUTCOME_LABEL = { complete: "concluída", abandoned: "abandonada" };
function outcomeLabel(outcome) {
  if (!outcome) return outcome;
  if (OUTCOME_LABEL[outcome]) return OUTCOME_LABEL[outcome];
  if (outcome.startsWith("halt")) return "interrompida";
  return outcome;
}

function SummaryCard({ summary, onDismiss }) {
  const ok = summary.outcome === "complete";
  const badge = ok
    ? "bg-good/10 text-good"
    : summary.outcome === "abandoned"
      ? "bg-amber/15 text-amber"
      : (summary.outcome || "").startsWith("halt")
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="p-3.5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Última sessão</span>
          <span className={`text-[10px] rounded-full px-2 py-0.5 ${badge}`}>
            {outcomeLabel(summary.outcome)}
          </span>
        </div>
        <div className="break-words text-xs text-muted-foreground">
          {summary.platform} · {summary.keyword || summary.mode}
          {summary.personality ? ` · ${summary.personality}` : ""} ·{" "}
          {fmtMs(summary.durationMs)}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>vistos {summary.processed}</span>
          <span>👍 {summary.liked}</span>
          <span>❤️ {summary.loved ?? 0}</span>
          <span>➕ {summary.followed ?? 0}</span>
          <span>pulados {summary.skipped}</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs w-full" onClick={onDismiss}>
          Fechar
        </Button>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }) {
  return (
    <Card>
      <CardContent className="p-2.5">
        <div className="truncate text-[11px] text-muted-foreground" title={label}>{label}</div>
        <div className="text-sm font-normal truncate">{value}</div>
      </CardContent>
    </Card>
  );
}

function Counter({ label, value }) {
  return (
    <Card>
      <CardContent className="p-2 text-center">
        <div className="truncate text-xl font-semibold leading-tight text-primary">
          {value}
        </div>
        <div className="truncate text-[10px] text-muted-foreground" title={label}>{label}</div>
      </CardContent>
    </Card>
  );
}
