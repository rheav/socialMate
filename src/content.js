import { franc } from "franc-min";
import {
  serializeLedger,
  restoreLedger,
  shouldContinue,
  scheduleNextBreak,
  breakLengthMs,
  commitmentDwellMs,
} from "./lib/sessionMath.js";

// socialMate — multi-platform content engine (Facebook / Instagram / TikTok).
// One content script injected on all three hosts. A shared core (state, pacing,
// safety, counters, persistence, run loops) drives per-platform ADAPTERS that
// carry the selectors + navigation for each site. Selectors target ARIA roles +
// accessible names / data-e2e hooks, never obfuscated classes.
//
// Modes (shared ids):
//   C = reels / for-you video    B = feed / explore    A = keyword / hashtag / search
//
// Selector provenance:
//   [VERIFIED]   live-tested. FB (all). IG reels Like/Save/Follow/advance mapped live
//                on a pt-br account — IG aria-labels are LOCALIZED (see L dictionary).
//                TikTok hooks are language-independent data-e2e, verified present in
//                the live DOM. TikTok Save (favorite) + Follow VERIFIED on a logged-in
//                session (favorite = count increments; follow = icon morphs +↔✓).

(() => {
  "use strict";
  if (window.__FBW_LOADED__) return;
  window.__FBW_LOADED__ = true;

  // ---- generation takeover ----
  // An extension reload/update re-injects this engine into a FRESH isolated world, so
  // the guard above doesn't stop the OLD one — only its chrome.* dies. If a run was
  // active, the old world kept its 1s tick (and the whole session state graph) alive
  // for the page's lifetime, once per reload. Newer generation announces; older stops
  // its timer and stands down. (Pattern from content/fb/comments-scrape.js.)
  const FBW_GEN = Date.now() + ":" + Math.random();
  let fbwSuperseded = false;
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__fbwEngineTakeover === undefined) return;
    if (e.data.__fbwEngineTakeover === FBW_GEN || fbwSuperseded) return;
    fbwSuperseded = true;
    try { clearInterval(S.tickTimer); } catch { /* pre-init */ }
    try { S.isRunning = false; } catch { /* pre-init */ }
  });
  window.postMessage({ __fbwEngineTakeover: FBW_GEN }, "*");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  // ---------- personalities (drive probabilistic Like/Follow) ----------
  const PERSONALITIES = {
    // engageChance gates whether a viewed post gets ANY action (save/like/follow);
    // the rest are watch-and-scroll only, so runs read as browsing, not farming.
    BINGE: {
      name: "Maratona",
      likeChance: 0.15,
      followChance: 0.04,
      engageChance: 0.25,
      watchMin: 0.7,
      watchMax: 1.0,
    },
    CASUAL: {
      name: "Casual",
      likeChance: 0.35,
      followChance: 0.08,
      engageChance: 0.4,
      watchMin: 0.15,
      watchMax: 0.5,
    },
    ENGAGED: {
      name: "Engajada",
      likeChance: 0.6,
      followChance: 0.15,
      engageChance: 0.65,
      watchMin: 0.4,
      watchMax: 0.8,
    },
  };

  // Break cadence per personality (ms). Breaks land BETWEEN items, count toward
  // the wall-clock session duration, and are skipped when the session would end
  // first. Tunable.
  const BREAKS = {
    BINGE: { everyMin: 12 * 60e3, everyMax: 20 * 60e3, lenMin: 20e3, lenMax: 60e3 },
    CASUAL: { everyMin: 5 * 60e3, everyMax: 9 * 60e3, lenMin: 60e3, lenMax: 180e3 },
    ENGAGED: { everyMin: 8 * 60e3, everyMax: 14 * 60e3, lenMin: 45e3, lenMax: 120e3 },
  };

  const STORAGE_KEY = "fbw_session";
  const MISS_LIMIT = 6; // consecutive selector misses → halt
  const EMPTY_SCROLL_LIMIT = 14; // feed scrolls with no actionable video → halt
  const MAX_CONSEC_LIKES = 8; // cap likes-in-a-row, then cool down (safety)
  const MAX_CONSEC_FOLLOWS = 5;
  const MAX_LIKES_PER_AUTHOR = 2; // per session — don't concentrate likes on one actor
  const MAX_LIKES_PER_HOUR = 60; // rolling rate ceiling (hard anti-runaway cap)
  // Commenting is far higher-risk than reacting — keep it rare and hard-capped.
  const MAX_COMMENTS_PER_HOUR = 10; // rolling hard ceiling
  const MAX_COMMENTS_PER_AUTHOR = 1; // never comment the same creator twice / session
  const SOFT_FAIL_LIMIT = 3; // reactions that click but don't register → soft-block backoff
  const SPAM_MIN = 0.34; // cosine to spam anchors above which a post is skipped
  const SEEN_KEY = "fbw_seen"; // cross-session post-id dedup (chrome.storage.local)
  const SEEN_CAP = 5000;
  const HISTORY_KEY = "fbw_history"; // per-run summaries for the History tab
  const SUMMARY_KEY = "fbw_last_summary"; // last run recap for the WarmTool summary card
  const LOG_CAP = 120;
  // A run reports itself through three surfaces, all of them in storage and all
  // of them read by the panel: `fbw_session` (live), `fbw_history` (last 50 runs),
  // `fbw_last_summary` (recap card). Nothing is written to disk — the structured
  // per-event telemetry that used to dump a JSON into ~/Downloads/social-mate/sessoes/
  // after every run was removed deliberately. Don't reintroduce a download here.

  function freshState() {
    return {
      isRunning: false,
      isPaused: false,
      startedAt: 0,
      willEndAt: 0,
      nextBreakAt: 0,
      breakUntil: 0,
      lastPersistAt: 0,
      // run config (persisted so a navigation/reload can resume the run)
      platform: "facebook",
      mode: "C",
      keyword: "",
      maxItems: 0,
      actions: { save: true, like: true, follow: false },
      // Which of FB's reactions the warmer may send (weighted mix, Like dominant).
      reactions: { like: true, love: true, haha: false, wow: false, care: false, sad: false, angry: false },
      reactionCounts: {},
      // Commenting (FB reels only, fully-watched only). phrases = plain strings,
      // the whole list is the random pool; a comment lands rarely + capped.
      commentSettings: { enabled: false, chance: 0.08, onlyFullyWatched: true, phrases: [] },
      englishOnly: false,
      relevanceMin: 0, // niche-relevance cosine gate for likes (0 = off)
      spamGuard: true, // skip scam/giveaway/spam posts (MiniLM anchor cosine)
      quickMode: false, // test mode: 3–10s dwell + short gaps, overrides watch pacing
      thresholds: { minLikes: 0, minComments: 0 },
      // Auto-capture: while warming, queue videos that clear these thresholds for
      // download/transcription and stash them in the Saved (favorites) tab.
      autoCapture: {
        enabled: false,
        minLikes: 0,
        minComments: 0,
        download: true,
        transcribe: true,
        favorite: true,
      },
      pacing: {
        minDelay: 4000,
        maxDelay: 9000,
        reelDwellMin: 6000,
        reelDwellMax: 15000,
        scrollMin: 300,
        scrollMax: 750,
      },
      personalityMode: null,
      userSelectedPersonality: null,
      // counters
      processed: 0,
      saved: 0,
      liked: 0,
      loved: 0,
      followed: 0,
      skipped: 0,
      commented: 0,
      // safety
      haltReason: null,
      missStreak: 0,
      consecLikes: 0,
      consecFollows: 0,
      consecComments: 0,
      warmupPosts: 0, // first N posts of a session = lurk only, no actions
      likeTimes: [], // rolling like timestamps for the per-hour rate cap
      authorLikes: {}, // authorKey -> likes this session (per-author throttle)
      commentTimes: [], // rolling comment timestamps for the per-hour comment cap
      authorComments: {}, // authorKey -> comments this session (per-author cap)
      commentedIds: new Set(), // reels commented this run (dedup)
      lastPhrase: null, // never post the same phrase back-to-back
      softFailStreak: 0, // consecutive reactions that clicked but didn't register
      // human realism (rolled once per session in start())
      sessionIntensity: 1, // per-session engagement mood multiplier
      browseOnly: false, // this whole session barely engages (just scrolls)
      lastCursor: null, // last synthetic cursor {x,y} — curved moves start here
      // log ring buffer
      log: [],
      // runtime-only
      tickTimer: null,
      loopActive: false,
      seenIds: new Set(), // post-id-keyed (FB posts — survives feed virtualization)
      capturedIds: new Set(), // posts already auto-captured this run (dedup)
    };
  }

  let S = freshState();

  function logLine(msg) {
    const entry = { t: Date.now(), msg };
    S.log.push(entry);
    if (S.log.length > LOG_CAP) S.log.shift();
    console.log("[SW]", msg);
    persistSoon();
  }

  // Debounced persist. Every log line used to write the whole session object —
  // sometimes several times per item — on top of the 30s heartbeat. The panel polls
  // a snapshot from memory, so the write never needed to be synchronous; what
  // matters is that the state is on disk before a navigation, and the explicit
  // persist() calls at the run's decision points still guarantee that.
  let persistTimer = null;
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, 400);
  }

  // ---- live progress log line ----
  // A single log entry that counts up in place while a timed action runs (the
  // panel polls the snapshot every 1s, so mutating the entry animates it), then
  // gets a ✅ + final elapsed. Used for dwell so you can see how long is left.
  function startProgress(icon, label, targetMs) {
    const entry = {
      t: Date.now(),
      startedAt: Date.now(),
      icon,
      label,
      targetMs: targetMs || 0,
      live: true,
      msg: `${icon} ${label} 0s${targetMs ? ` / ${Math.round(targetMs / 1000)}s` : ""}`,
    };
    S.log.push(entry);
    if (S.log.length > LOG_CAP) S.log.shift();
    return entry;
  }
  function tickProgress(entry) {
    if (!entry || !entry.live) return;
    const s = Math.floor((Date.now() - entry.startedAt) / 1000);
    entry.msg = `${entry.icon} ${entry.label} ${s}s${entry.targetMs ? ` / ${Math.round(entry.targetMs / 1000)}s` : ""}`;
  }
  function endProgress(entry) {
    if (!entry) return;
    const s = Math.max(1, Math.round((Date.now() - entry.startedAt) / 1000));
    entry.live = false;
    entry.msg = `✅ ${entry.label} ${s}s`;
    console.log("[SW]", entry.msg);
    persist();
  }

  // ---- display-only pt-BR labels for the run log ----
  // These translate internal codes to Portuguese ONLY at the point they're
  // rendered into a logLine()/startProgress() message string. The underlying
  // codes (A.noun, A.skipReason, reaction keys, comment-fail reasons, page
  // surfaces, S.actions keys) are left untouched everywhere else — they're also
  // written into `fbw_session`/`fbw_history`, so changing the values themselves
  // would alter what's persisted, not just what's shown.
  const NOUN_PT = { reel: "reel", video: "vídeo" };
  const nounPT = (n) => NOUN_PT[n] || n;
  const REACTION_PT = {
    like: "curtir",
    love: "amei",
    care: "cuidado",
    haha: "haha",
    wow: "uau",
    sad: "triste",
    angry: "grr",
  };
  const reactionPT = (k) => REACTION_PT[k] || k;
  const SURFACE_PT = {
    reels: "Reels",
    search: "pesquisa",
    hashtag: "hashtag",
    feed: "feed",
    explore: "explorar",
    foryou: "para você",
    video: "vídeo",
    unknown: "desconhecida",
  };
  const surfacePT = (s) => SURFACE_PT[s] || s;
  const ADAPTER_LABEL_PT = {
    reels: "Reels",
    explore: "explorar",
    "for-you": "para você",
    search: "busca",
  };
  const adapterLabelPT = (l) => ADAPTER_LABEL_PT[l] || l;
  const ACTION_PT = { save: "salvar", like: "curtir", follow: "seguir" };
  const actionPT = (k) => ACTION_PT[k] || k;
  const SKIP_REASON_PT = { LIVE: "ao vivo", "non-standard": "não padrão" };
  const skipReasonPT = (r) => SKIP_REASON_PT[r] || r || "não padrão";
  const COMMENT_FAIL_PT = {
    no_comment_button: "botão de comentário não encontrado",
    composer_never_opened: "caixa de comentário não abriu",
    typing_failed: "falha ao digitar",
    editor_not_cleared: "editor não foi limpo",
  };
  const commentFailPT = (r) => COMMENT_FAIL_PT[r] || r;

  function pickPersonality() {
    if (S.userSelectedPersonality)
      S.personalityMode = S.userSelectedPersonality;
    else {
      const keys = Object.keys(PERSONALITIES);
      S.personalityMode = keys[Math.floor(Math.random() * keys.length)];
    }
    return PERSONALITIES[S.personalityMode];
  }
  const persona = () => PERSONALITIES[S.personalityMode] || pickPersonality();

  // ---------- persistence ----------
  function persist() {
    S.lastPersistAt = Date.now();
    try {
      chrome.storage?.local?.set({
        [STORAGE_KEY]: {
          host: location.hostname,
          platform: S.platform,
          isRunning: S.isRunning,
          isPaused: S.isPaused,
          startedAt: S.startedAt,
          willEndAt: S.willEndAt,
          nextBreakAt: S.nextBreakAt,
          breakUntil: S.breakUntil,
          mode: S.mode,
          keyword: S.keyword,
          maxItems: S.maxItems,
          actions: S.actions,
          reactions: S.reactions,
          reactionCounts: S.reactionCounts,
          commentSettings: S.commentSettings,
          commented: S.commented,
          englishOnly: S.englishOnly,
          relevanceMin: S.relevanceMin,
          spamGuard: S.spamGuard,
          quickMode: S.quickMode,
          warmupPosts: S.warmupPosts,
          pacing: S.pacing,
          thresholds: S.thresholds,
          autoCapture: S.autoCapture,
          personalityMode: S.personalityMode,
          userSelectedPersonality: S.userSelectedPersonality,
          processed: S.processed,
          saved: S.saved,
          liked: S.liked,
          loved: S.loved,
          followed: S.followed,
          skipped: S.skipped,
          haltReason: S.haltReason,
          // A run navigates to its target surface (start → location.assign), which
          // kills this content script. Everything the rebuilt state needs to keep
          // being the SAME run has to survive here — the session mood and the
          // SAFETY LEDGER included, or the run silently restarts as a different
          // one with all of its rate limits back at zero.
          sessionIntensity: S.sessionIntensity,
          browseOnly: S.browseOnly,
          // Safety ledger — one contract, shared with the resume path below, so
          // the two ends can't drift again (see lib/sessionMath.js).
          ...serializeLedger(S),
          log: S.log.slice(-LOG_CAP),
          savedAt: Date.now(),
        },
      });
    } catch (e) {
      /* context invalidated on reload */
    }
  }

  function snapshot() {
    const now = Date.now();
    return {
      isRunning: S.isRunning,
      isPaused: S.isPaused,
      isAutoBreak: S.breakUntil > now,
      platform: S.platform,
      mode: S.mode,
      keyword: S.keyword,
      maxItems: S.maxItems,
      etaMs: S.willEndAt ? Math.max(0, S.willEndAt - now) : 0,
      processed: S.processed,
      saved: S.saved,
      liked: S.liked,
      loved: S.loved,
      reactionCounts: S.reactionCounts,
      commented: S.commented,
      followed: S.followed,
      skipped: S.skipped,
      personality: S.personalityMode
        ? PERSONALITIES[S.personalityMode].name
        : null,
      haltReason: S.haltReason,
      surface: pageSurface(),
      log: S.log.slice(-30),
    };
  }

  // ============================================================
  // platform detection (host is the source of truth for selectors)
  // ============================================================
  function platformForHost() {
    const h = location.hostname.replace(/^www\./, "").toLowerCase();
    if (h.endsWith("facebook.com")) return "facebook";
    if (h.endsWith("instagram.com")) return "instagram";
    if (h.endsWith("tiktok.com")) return "tiktok";
    return null;
  }

  function pageSurface() {
    const p = platformForHost();
    const path = (location.pathname || "/").toLowerCase();
    if (p === "facebook") {
      if (path.startsWith("/reel")) return "reels";
      if (path.startsWith("/search")) return "search";
      if (path.startsWith("/hashtag")) return "hashtag";
      return "feed";
    }
    if (p === "instagram") {
      if (path.startsWith("/reel")) return "reels";
      if (path.startsWith("/explore/tags")) return "hashtag";
      if (path.startsWith("/explore")) return "explore";
      return "feed";
    }
    if (p === "tiktok") {
      if (path.startsWith("/search")) return "search";
      if (path.startsWith("/tag")) return "hashtag";
      if (/\/@[^/]+\/video\//.test(path)) return "video";
      return "foryou";
    }
    return "unknown";
  }

  // ============================================================
  // safety / stop conditions (generic + per-platform)
  // ============================================================
  // detectStop serialises the whole document's innerText and runs a dozen regexes
  // over it. On Facebook's DOM that is the most expensive thing in the loop, and it
  // used to run once per 1s tick AND once per loop iteration — with every call site
  // evaluating it TWICE in a row. Cache the verdict briefly: a login wall or a
  // checkpoint does not appear and vanish inside 2s, so reading faster buys nothing.
  const STOP_CACHE_MS = 2000;
  let stopCache = { at: 0, reason: null };
  function detectStopCached() {
    const now = Date.now();
    if (now - stopCache.at < STOP_CACHE_MS) return stopCache.reason;
    stopCache = { at: now, reason: detectStopUncached() };
    return stopCache.reason;
  }
  function detectStopUncached() {
    const url = location.href.toLowerCase();
    const body = (document.body?.innerText || "").toLowerCase();
    if (
      /are you a robot|confirm your identity|prove you'?re human|enter the characters you see/.test(
        body,
      )
    )
      return "captcha";
    const p = platformForHost();
    if (p === "facebook") {
      if (url.includes("/checkpoint")) return "verificação de segurança";
      if (
        document.querySelector('input[name="email"]') &&
        document.querySelector('input[name="pass"]')
      )
        return "barreira de login";
      if (
        /you'?re temporarily blocked|going too fast|try again later|temporarily restricted|suspicious activity/.test(
          body,
        )
      )
        return "limite de taxa/bloqueio";
    } else if (p === "instagram") {
      if (url.includes("/challenge") || url.includes("/accounts/suspended"))
        return "verificação de segurança";
      if (
        document.querySelector('input[name="username"]') &&
        document.querySelector('input[name="password"]')
      )
        return "barreira de login";
      if (
        /we restrict certain activity|action blocked|try again later|please wait a few minutes|suspicious/.test(
          body,
        )
      )
        return "limite de taxa/bloqueio";
    } else if (p === "tiktok") {
      if (url.includes("/login")) return "barreira de login";
      if (
        /too many attempts|verify to continue|you'?re tapping too fast|something went wrong, tap to retry/.test(
          body,
        )
      )
        return "limite de taxa/bloqueio";
    }
    return null;
  }

  function halt(reason) {
    S.haltReason = reason;
    S.isRunning = false;
    logLine(`🛑 INTERROMPIDO: ${reason}`);
    clearInterval(S.tickTimer);
    logHistory("halt: " + reason);
    writeSummary("halt: " + reason);
    persist();
  }

  // A click that lands but doesn't register is Facebook's classic soft-block tell.
  // The posts loop has always halted on three in a row; the video loop (FB reels,
  // IG, TikTok) never even counted them, so a soft-blocked reels session kept
  // clicking into the void for its whole duration.
  function noteSoftFail() {
    S.softFailStreak++;
    logLine(`· reação não registrou (${S.softFailStreak}/${SOFT_FAIL_LIMIT})`);
    if (S.softFailStreak >= SOFT_FAIL_LIMIT)
      halt("possível bloqueio brando — as reações não estão registrando");
  }

  function note(found) {
    if (found) S.missStreak = 0;
    else {
      S.missStreak += 1;
      if (S.missStreak >= MISS_LIMIT) halt("seletores não encontrados");
    }
    return found;
  }

  // ============================================================
  // ARIA helpers — roles + accessible names, never classes
  // ============================================================
  function byRoleName(role, nameRe, root = document) {
    return Array.from(root.querySelectorAll(`[role="${role}"]`)).find((el) =>
      nameRe.test((el.getAttribute("aria-label") || el.innerText || "").trim()),
    );
  }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  async function waitFor(fn, timeout = 4000, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }
  // climb from a node to the enclosing clickable button/role=button (≤limit hops)
  function clickableAncestor(node, stopAt, limit = 8) {
    let n = node;
    for (let i = 0; n && n !== stopAt && i < limit; i++) {
      if (
        n.getAttribute &&
        (n.getAttribute("role") === "button" || n.tagName === "BUTTON")
      )
        return n;
      n = n.parentElement;
    }
    return node;
  }

  // ============================================================
  // pacing
  // ============================================================
  // Circadian multiplier — humans browse slower late at night / early morning.
  function circadian() {
    const h = new Date().getHours();
    if (h >= 0 && h < 6) return 1.8;
    if (h >= 6 && h < 9) return 1.3;
    if (h >= 23) return 1.5;
    return 1.0;
  }
  const actionGap = () =>
    S.quickMode
      ? sleep(rand(1000, 2500)) // test mode: keep the loop moving
      : sleep(Math.round(rand(S.pacing.minDelay, S.pacing.maxDelay) * circadian()));
  const watchFraction = () => {
    const p = persona();
    return p.watchMin + Math.random() * (p.watchMax - p.watchMin);
  };
  // Reels rails mix long-form video in (a 60s+ clip, even 20-min "reels") — a
  // human doesn't sit through those. Watch-full ("stay to the end") only applies
  // to genuinely short reels; longer items fall back to the fraction dwell. And
  // no single item ever dwells past MAX_DWELL_MS — that was the 60–100s stall.
  const WATCH_FULL_MAX_SEC = 40;
  // Ceiling on any single dwell. It must be JITTERED, not a constant: the reels
  // rail is mostly long-form, so the fraction dwell lands over the cap on most
  // items and every one of them clamps to the same number — a run where half the
  // watches are exactly 30.000s is a signature no human produces. Rolled per item.
  const MAX_DWELL_MS = () => rand(23000, 34000);
  // Dwell on the active video: watch-full adapters stay for the whole remaining
  // runtime; otherwise a personality-driven fraction of its length. Falls back
  // to the plain random dwell range when no duration is readable. Prefers the
  // active container's <video> — document-order lookups hit stale reel cards.
  // Returns true when the item was watched (near-)fully — the signal that gates
  // commenting. Quick mode + fraction/long-form watches return false.
  async function reelDwell(A, c) {
    if (S.quickMode) {
      const dwell = rand(3000, 10000);
      const prog = startProgress("⚡", "espera rápida", dwell);
      const t0 = Date.now();
      while (Date.now() - t0 < dwell && S.isRunning && !S.isPaused) {
        tickProgress(prog);
        await sleep(400);
      }
      endProgress(prog);
      return false;
    }
    const vid =
      (c && c.querySelector && c.querySelector("video")) || igActiveVideo();
    const capMs = MAX_DWELL_MS(); // rolled per item — never the same ceiling twice
    let dwell = null;
    let frac = null;
    let full = false;
    if (vid && isFinite(vid.duration) && vid.duration > 0) {
      if (A?.watchFull && vid.duration <= WATCH_FULL_MAX_SEC) {
        const remaining = Math.max(0, vid.duration - vid.currentTime) * 1000;
        dwell = Math.max(2000, Math.round(remaining + rand(400, 1200)));
        full = dwell <= capMs; // a genuine full watch (short reel, not capped)
      } else {
        frac = watchFraction();
        dwell = commitmentDwellMs(frac, vid.duration, S.pacing.reelDwellMin, S.pacing.reelDwellMax);
      }
    }
    if (dwell == null) dwell = rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    if (dwell > capMs) {
      dwell = capMs;
      full = false;
    }
    const label = `assistindo${frac != null ? ` (${Math.round(frac * 100)}%)` : full ? " (completo)" : ""}`;
    const prog = startProgress("👀", label, dwell);
    const t0 = Date.now();
    while (Date.now() - t0 < dwell && S.isRunning && !S.isPaused) {
      tickProgress(prog); // count up in place (panel poll animates it)
      await sleep(400);
    }
    endProgress(prog); // ✅ + final elapsed
    return full;
  }
  async function waitWhilePaused() {
    while (S.isRunning && S.isPaused) await sleep(500);
  }
  // Personality-driven break: fires between items when nextBreakAt is due.
  // Ignores pause (a break IS an idle pause); stop exits immediately.
  async function maybeBreak() {
    const prof = BREAKS[S.personalityMode];
    if (!prof || !S.nextBreakAt) return;
    const now = Date.now();
    if (now < S.nextBreakAt) return;
    const len = breakLengthMs(prof);
    if (S.willEndAt && now + len >= S.willEndAt) {
      S.nextBreakAt = S.willEndAt; // session ends first — skip the break
      return;
    }
    S.breakUntil = now + len;
    const prog = startProgress("☕", "pausa", len); // counts up in place like dwell
    persist();
    while (Date.now() < S.breakUntil && S.isRunning) {
      tickProgress(prog);
      await sleep(400);
    }
    endProgress(prog);
    S.breakUntil = 0;
    S.nextBreakAt = scheduleNextBreak(prof, Date.now());
    if (S.isRunning) logLine("▶ voltando da pausa");
    persist();
  }
  // Variable-velocity scroll with occasional scroll-up re-reads (human skim, not metronome).
  function humanScroll() {
    if (Math.random() < 0.15) {
      window.scrollBy({ top: -rand(120, 400), left: 0, behavior: "smooth" });
      return;
    }
    const by = Math.round(
      rand(S.pacing.scrollMin, S.pacing.scrollMax) *
        (0.6 + Math.random() * 0.9),
    );
    window.scrollBy({ top: by, left: rand(-2, 2), behavior: "smooth" });
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 20)
      window.scrollTo({
        top: Math.max(0, window.scrollY - rand(300, 900)),
        behavior: "smooth",
      });
  }
  const centerInViewport = (el) =>
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  // A few small scroll steps with pauses — reads as a human skimming the feed.
  // ~20% of steps get a long dwell (got-distracted pause).
  async function scrollBurst(min, max) {
    const steps = rand(min, max);
    for (let i = 0; i < steps && S.isRunning && !S.isPaused; i++) {
      humanScroll();
      await sleep(rand(700, 1900) * (Math.random() < 0.2 ? 2 : 1));
    }
  }

  // ---- synthetic pointer realism (avoid bare el.click(), the #1 bot tell) ----
  // Curved cursor travel — dispatch a trail of mousemove events along a quadratic
  // bezier from the last cursor position to the target, with ease-in-out timing,
  // jitter, and a slight overshoot-and-correct. People don't teleport the pointer
  // in a straight line. Movement events go to `document` (bubbling) so passing the
  // cursor over intermediate elements can't accidentally trip their hover handlers
  // (e.g. reopen a reaction picker mid-flight).
  async function moveCursorTo(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const tx = r.left + r.width * (0.3 + Math.random() * 0.4);
    const ty = r.top + r.height * (0.3 + Math.random() * 0.4);
    const from = S.lastCursor || {
      x: tx + rand(-320, 320),
      y: ty + rand(-260, 260),
    };
    const dist = Math.hypot(tx - from.x, ty - from.y);
    if (dist < 6) { S.lastCursor = { x: tx, y: ty }; return; }
    // control point offset perpendicular-ish to the path → a visible arc
    const cx = (from.x + tx) / 2 + rand(-90, 90);
    const cy = (from.y + ty) / 2 + rand(-90, 90);
    const steps = Math.min(22, Math.max(6, Math.round(dist / 28)));
    const fire = (x, y) => {
      const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerType: "mouse" };
      document.dispatchEvent(new PointerEvent("pointermove", { ...o, pointerId: 1 }));
      document.dispatchEvent(new MouseEvent("mousemove", o));
    };
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // ease-in-out
      const mt = 1 - e;
      const x = mt * mt * from.x + 2 * mt * e * cx + e * e * tx + rand(-2, 2);
      const y = mt * mt * from.y + 2 * mt * e * cy + e * e * ty + rand(-2, 2);
      fire(x, y);
      await sleep(rand(6, 22));
    }
    // occasional overshoot then settle back onto the target
    if (Math.random() < 0.35) {
      fire(tx + rand(4, 14), ty + rand(-6, 6));
      await sleep(rand(30, 80));
      fire(tx, ty);
    }
    S.lastCursor = { x: tx, y: ty };
  }

  function pointAt(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * (0.32 + Math.random() * 0.36);
    const y = r.top + r.height * (0.32 + Math.random() * 0.36);
    return {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      view: window,
    };
  }
  // Fire a full hover-in sequence WITHOUT the dwell — enter events included, so
  // React/FB register the element as hovered (the reaction picker highlights the
  // chip under the pointer, which is what its click commits).
  function hoverEvents(el) {
    const o = { ...pointAt(el), pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerover", { ...o, pointerId: 1 }));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...o, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseover", o));
    el.dispatchEvent(new MouseEvent("mouseenter", o));
    el.dispatchEvent(new MouseEvent("mousemove", o));
  }
  async function humanHover(el) {
    await moveCursorTo(el); // travel the cursor over before settling on the target
    hoverEvents(el);
    await sleep(rand(500, 1100));
  }
  // Press + release on an element that's already hovered — no extra dwell. Used
  // for reaction chips, where a slow hover lets FB's picker close before the click.
  function pressRelease(el) {
    const o = pointAt(el);
    el.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerId: 1, button: 0 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...o, button: 0 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerId: 1, button: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...o, button: 0 }));
    el.click();
  }
  async function humanClick(el) {
    await humanHover(el);
    const o = pointAt(el);
    el.dispatchEvent(
      new PointerEvent("pointerdown", { ...o, pointerId: 1, button: 0 }),
    );
    el.dispatchEvent(new MouseEvent("mousedown", { ...o, button: 0 }));
    await sleep(rand(50, 140));
    el.dispatchEvent(
      new PointerEvent("pointerup", { ...o, pointerId: 1, button: 0 }),
    );
    el.dispatchEvent(new MouseEvent("mouseup", { ...o, button: 0 }));
    el.click();
  }

  // ============================================================
  // HUMAN REALISM — session mood, engagement curve, idle, feints
  // ============================================================
  // Roll the session's "mood" once at start. ~1 in 6 sessions is browse-only
  // (barely engages — a person just scrolling); the rest get an intensity
  // multiplier so no two sessions have the same like-rate.
  function rollSessionMood() {
    S.browseOnly = Math.random() < 0.16;
    S.sessionIntensity = S.browseOnly
      ? rand(15, 25) / 100 // 0.15–0.25
      : rand(60, 135) / 100; // 0.60–1.35
    S.lastCursor = null;
  }

  // 0..1 curve over the session: low at the edges, peaks mid-session — people
  // warm up, then wind down; engagement isn't a flat rate. Falls back to 1 with
  // no clock. Raised half-sine: 0.35 at the ends → 1.0 at the midpoint.
  function engageCurve() {
    if (!S.startedAt || !S.willEndAt) return 1;
    const total = S.willEndAt - S.startedAt;
    if (total <= 0) return 1;
    const t = Math.min(1, Math.max(0, (Date.now() - S.startedAt) / total));
    return 0.35 + 0.65 * Math.sin(Math.PI * t);
  }

  // Scale any base engagement probability by the session mood × curve.
  function engageScale(base) {
    return Math.max(0, Math.min(1, base * S.sessionIntensity * engageCurve()));
  }

  // Rarely go idle between items — "got distracted / phone rang". Reuses the live
  // progress line so the log shows the countdown. Respects stop/pause; skipped if
  // the session would end during the idle.
  async function maybeIdle() {
    if (Math.random() >= 0.045) return;
    const ms = rand(18000, 85000);
    if (S.willEndAt && Date.now() + ms >= S.willEndAt) return;
    const prog = startProgress("💤", "inativo", ms);
    const t0 = Date.now();
    while (Date.now() - t0 < ms && S.isRunning && !S.isPaused) {
      tickProgress(prog);
      await sleep(500);
    }
    endProgress(prog);
  }

  // "Almost acted" feint — hover the like control, consider, then drift away
  // without clicking. A person who looked but didn't react. Returns true if it
  // ran (so the caller can count it as a browse, not a miss).
  async function maybeFeint(likeBtn) {
    if (!likeBtn || Math.random() >= 0.09) return false;
    await moveCursorTo(likeBtn);
    hoverEvents(likeBtn);
    await sleep(rand(500, 1500));
    likeBtn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    likeBtn.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerId: 1 }));
    logLine("· passou o mouse, não reagiu");
    return true;
  }

  // ============================================================
  // FACEBOOK adapters — all [VERIFIED] live
  // ============================================================
  // -- reels (Mode C) -- [VERIFIED live: pt-br, 2026-07-11]
  // Reel action-bar labels are LOCALIZED ("Curtir"/"Like") — matched with the
  // same exact-membership sets as posts (FB_LIKE_WORDS & co below; runtime-only
  // references, so the later declaration is fine). The "Change Position" slider
  // aria-label is NOT localized and anchors the ACTIVE card: FB keeps previous
  // cards in the DOM above the viewport, so document-order queries hit stale reels.
  function fbActiveReelContainer() {
    const slider = document.querySelector(
      'div[role="slider"][aria-label="Change Position"]',
    );
    if (!slider) return null;
    let n = slider;
    while (n && n !== document.body) {
      if (fbBarLikeBtn(n)) return n;
      n = n.parentElement;
    }
    return null;
  }
  const fbReelLikeButton = (c) => fbBarLikeBtn(c || document);
  const fbReelIsLiked = (c) => fbIsLikedBtn(fbReelLikeButton(c));
  async function fbSaveReel(c) {
    const kebab = Array.from(
      (c || document).querySelectorAll(
        '[role="button"][aria-label="Menu"][aria-haspopup="menu"]',
      ),
    ).find(visible);
    if (!kebab) return false;
    kebab.click();
    const menu = await waitFor(
      () => document.querySelector('[role="menu"]'),
      3000,
    );
    if (!menu) return false;
    await sleep(rand(200, 500));
    const item = byRoleName(
      "menuitem",
      /^(save|salvar|guardar|salva)\s+reel/i,
      menu,
    );
    if (!item) {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return false; // already saved or unavailable → don't count
    }
    item.click();
    await sleep(rand(400, 800));
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    return true;
  }
  async function fbFollowAuthor(root) {
    const btn = byRoleName(
      "button",
      /^(follow|seguir|suivre|segui)\b/i,
      root || document,
    );
    if (!btn || !visible(btn)) return false;
    btn.click();
    await sleep(rand(300, 700));
    return true;
  }
  // Advance = SPA soft-nav to the next /reel/<id>; the URL changes, scrollY stays 0.
  const FB_NEXT_CARD = [
    "next card",
    "próximo cartão",
    "siguiente tarjeta",
    "carte suivante",
    "scheda successiva",
  ];
  function fbNextReel() {
    const btn = Array.from(
      document.querySelectorAll('div[role="button"][aria-label]'),
    ).find((b) => FB_NEXT_CARD.includes(fbAria(b)) && visible(b));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  const FB_VIDEO = {
    label: "reels",
    noun: "reel",
    emoji: "🎞️",
    getContainer: fbActiveReelContainer,
    likeBtn: fbReelLikeButton,
    isLiked: fbReelIsLiked,
    save: (c) => fbSaveReel(c),
    follow: (c) => fbFollowAuthor(c),
    advance: fbNextReel,
    watchFull: true, // dwell the reel's whole runtime (long-form falls back to fraction)
    reactable: true, // FB reels support the full reaction picker (not just Like)
    commentable: true, // FB reels have an inline comment composer
  };

  // -- hashtag / search posts (Mode A) -- [VERIFIED live: pt-br + en, 2026-06-20]
  // FB action-bar aria-labels are LOCALIZED. Match by exact membership: the like
  // ACTION button is exactly "Curtir"/"Like"; the reaction-count tooltip is
  // "Curtir: 3,5 mil pessoas" (has a colon) so exact membership excludes it. A
  // liked post swaps the control to "Remover Curtir" / "Alterar reação Curtir".
  const FB_LIKE_WORDS = [
    "like",
    "curtir",
    "me gusta",
    "j’aime",
    "j'aime",
    "mi piace",
    "gefällt mir",
  ];
  const FB_UNLIKE_WORDS = [
    "remove like",
    "remover curtir",
    "descurtir", // reels use the shorter unlike label
    "unlike",
    "ya no me gusta",
    "je n’aime plus",
    "non mi piace più",
  ];
  const FB_CHANGE_PREFIX = [
    "change like reaction",
    "alterar reação",
    "cambiar la reacción",
    "modifier l’avis",
  ];
  const FB_MENU_PREFIX = [
    "actions for this post",
    "ações para este post",
    "acciones para esta publicación",
    "plus d’actions sur cette publication",
  ];
  const fbAria = (el) =>
    (el.getAttribute("aria-label") || "").trim().toLowerCase();
  function fbIsLikeBtn(el) {
    const a = fbAria(el);
    return (
      FB_LIKE_WORDS.includes(a) ||
      FB_UNLIKE_WORDS.includes(a) ||
      FB_CHANGE_PREFIX.some((w) => a.startsWith(w))
    );
  }
  function fbIsLikedBtn(el) {
    if (!el) return false;
    const a = fbAria(el);
    return (
      FB_UNLIKE_WORDS.includes(a) ||
      FB_CHANGE_PREFIX.some((w) => a.startsWith(w))
    );
  }
  // The like control inside a post — re-query after a click, since FB relabels/
  // replaces the node when the like state flips.
  function fbBarLikeBtn(root) {
    return (
      Array.from(root.querySelectorAll('[role="button"][aria-label]')).find(
        fbIsLikeBtn,
      ) || null
    );
  }
  // FB's 7 reactions. [VERIFIED live pt-br 2026-07-12]: hovering the like control
  // opens a picker of 39×39 chips whose accessible names are LOCALIZED —
  // Curtir · Amei · Força · Haha · Uau · Triste · Grr. Synthetic pointer events
  // (which is all a content script can send) DO open it, so the warmer can pick
  // any reaction, not just Like.
  //
  // `weight` = how often a human reaches for it, used to mix the reactions the
  // user enabled (Like dominates; anger/sadness are rare on a warming account).
  const FB_REACTIONS = {
    like:  { emoji: "👍", weight: 60, words: ["like", "curtir", "me gusta", "j’aime", "j'aime", "mi piace", "gefällt mir"] },
    love:  { emoji: "❤️", weight: 20, words: ["love", "amei", "me encanta", "j’adore", "j'adore", "adoro"] },
    haha:  { emoji: "😆", weight: 8,  words: ["haha", "ahah"] },
    wow:   { emoji: "😮", weight: 6,  words: ["wow", "uau", "me asombra", "waouh"] },
    care:  { emoji: "🤗", weight: 4,  words: ["care", "força", "me importa", "solidaire", "abbraccio"] },
    sad:   { emoji: "😢", weight: 1,  words: ["sad", "triste", "me entristece"] },
    angry: { emoji: "😡", weight: 1,  words: ["angry", "grr", "grrr", "me enoja"] },
  };
  const REACTION_KEYS = Object.keys(FB_REACTIONS);
  // Stable per-author key (profile id or slug) for the per-author like throttle.
  function fbAuthorKey(root) {
    const a = root.querySelector(
      'h2 a[href], h3 a[href], h4 a[href], strong a[href], a[href*="/profile.php?id="]',
    );
    const href = a ? a.getAttribute("href") || "" : "";
    const m = href.match(/profile\.php\?id=(\d+)/);
    if (m) return "id:" + m[1];
    const slug = href
      .split("?")[0]
      .replace(/^https?:\/\/[^/]+/, "")
      .replace(/\/+$/, "");
    return slug || (a && (a.textContent || "").trim().slice(0, 40)) || null;
  }
  // Stable per-post key so FB's virtualized feed recycling can't double-like/skip.
  function fbPostKey(root) {
    for (const a of root.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href") || "";
      const m =
        h.match(/\/(?:posts|videos|reel|permalink)\/([A-Za-z0-9.]+)/) ||
        h.match(/story_fbid=([A-Za-z0-9.]+)/) ||
        h.match(/\/stories\/\d+\/([A-Za-z0-9=]+)/);
      if (m) return m[1];
    }
    const s =
      (fbAuthorKey(root) || "") + "|" + fbGetPostText(root).slice(0, 80);
    let hsh = 5381;
    for (let i = 0; i < s.length; i++)
      hsh = ((hsh << 5) + hsh + s.charCodeAt(i)) | 0;
    return "h:" + (hsh >>> 0).toString(36);
  }
  const FB_SPONSORED_WORDS = [
    "sponsored",
    "patrocinado",
    "publicidad",
    "sponsorisé",
    "sponsorizzato",
    "gesponsert",
  ];
  function fbIsSponsored(root) {
    for (const e of root.querySelectorAll("a, span"))
      if (
        FB_SPONSORED_WORDS.includes(
          (e.textContent || "").trim().toLowerCase(),
        )
      )
        return true;
    return false;
  }
  // FB scrambles a post's real text with decoy nodes — most often the word
  // "Facebook" repeated, or a block whose lines are mostly single characters.
  // Reject those so the dir="auto" fallback doesn't poison the relevance embed.
  function fbIsScramble(t) {
    if (/(?:Facebook\s+){3,}/.test(t)) return true;
    const lines = t.split("\n");
    return (
      lines.length > 3 &&
      lines.filter((l) => l.trim().length <= 1).length / lines.length > 0.5
    );
  }
  function fbGetPostText(root) {
    const msg = root.querySelector(
      '[data-ad-comet-preview="message"], [data-ad-preview="message"]',
    );
    if (msg && (msg.innerText || "").trim()) return msg.innerText.trim();
    let best = "";
    for (const el of root.querySelectorAll(
      'div[dir="auto"], span[dir="auto"]',
    )) {
      const t = (el.innerText || "").trim();
      if (!t || fbIsScramble(t)) continue;
      if (t.length > best.length) best = t;
    }
    return best;
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top >= 60 && r.top < window.innerHeight - 120;
  }
  // Engagement counts live as innerText on the action-bar buttons themselves:
  // like button = total reactions, comment button = comments. FB localizes the
  // magnitude suffix AND the separators: en "76.8K" / "1.2M" use "." decimal,
  // pt-br "76,8 mil" / "1,2 mi" use "," decimal + "mil"/"mi" words (id "rb"/"jt").
  function parseCount(t) {
    let s = String(t || "")
      .trim()
      .toLowerCase();
    if (!s) return 0;
    // thousands: mil/k/rb/tis · millions: mi/mn/jt/m · billions: bi/b
    let mult = 1;
    const suf = s.match(/(mil|mi|mn|rb|jt|tis|bi|k|m|b)\.?$/);
    if (suf) {
      const u = suf[1];
      mult = /^(mil|rb|tis|k)$/.test(u)
        ? 1e3
        : /^(mi|mn|jt|m)$/.test(u)
          ? 1e6
          : 1e9;
      s = s.slice(0, suf.index).trim();
    }
    // With a suffix the lone separator is a decimal point ("76,8 mil" / "1.2k").
    // Without one, "," / "." are digit-grouping ("76.800" / "1,234") → strip them.
    const num =
      mult > 1
        ? parseFloat(s.replace(",", "."))
        : parseFloat(s.replace(/[.,\s]/g, ""));
    return isFinite(num) ? Math.round(num * mult) : 0;
  }
  const FB_COMMENT_WORDS = [
    "leave a comment",
    "deixe um comentário",
    "escribir un comentario",
    "écrire un commentaire",
    "commenta",
  ];
  function fbPostStats(p) {
    // Re-query the like control — FB's windowed hydration can swap a post's
    // inner nodes between enumeration and use, leaving p.likeBtn detached.
    const likeBtn = fbBarLikeBtn(p.root) || p.likeBtn;
    const cb = Array.from(
      p.root.querySelectorAll('[role="button"][aria-label]'),
    ).find((b) => FB_COMMENT_WORDS.includes(fbAria(b)));
    return {
      likes: parseCount(likeBtn && likeBtn.innerText),
      comments: parseCount(cb && cb.innerText),
    };
  }
  // Posts are the direct children of [role="feed"] carrying a like control. FB's
  // feed only grows (children are never removed), so this gates on the CHEAP
  // checks first — has-like-control, then in-viewport — and only computes the
  // expensive keys (post/author id, menu) for the one in-view candidate it
  // returns. Enumerating + hashing every accumulated child each pick was O(N)
  // on a feed that keeps growing.
  function fbPickPost() {
    const feed = document.querySelector('[role="feed"]');
    if (!feed) return null;
    for (const child of feed.children) {
      const likeBtn = fbBarLikeBtn(child);
      if (!likeBtn) continue; // not a post
      if (!inViewport(likeBtn)) continue; // off-screen — skip before any hashing
      const postKey = fbPostKey(child);
      if (postKey && S.seenIds.has(postKey)) continue;
      if (fbIsSponsored(child)) {
        if (postKey) S.seenIds.add(postKey);
        S.skipped++;
        continue;
      }
      const menuBtn =
        Array.from(child.querySelectorAll('[role="button"][aria-label]')).find(
          (b) => FB_MENU_PREFIX.some((w) => fbAria(b).startsWith(w)),
        ) || null;
      return {
        bar: child,
        root: child,
        likeBtn,
        menuBtn,
        authorKey: fbAuthorKey(child),
        postKey,
      };
    }
    return null;
  }

  // Language detection via franc (trigram model, offline, ~all ISO 639-3 langs).
  // englishOnly keeps eng + undetermined (too short to judge → don't drop it).
  function isEnglish(text) {
    const t = (text || "").trim();
    if (t.length < 12) return true; // too short to judge — let it through
    const code = franc(t, { minLength: 12 });
    return code === "eng" || code === "und";
  }

  // Niche relevance + spam: ask background→offscreen for the MiniLM cosine of this
  // text vs the keyword (and vs spam anchors). Fails open (score 1, spam 0) so a
  // model hiccup never blocks the warmer.
  function getRelevanceInfo(keyword, text, spam) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "FBW_RELEVANCE", keyword, text, spam: !!spam },
          (res) => {
            if (chrome.runtime.lastError) return resolve({ score: 1, spam: 0 });
            resolve({
              score: typeof res?.score === "number" ? res.score : 1,
              spam: typeof res?.spam === "number" ? res.spam : 0,
            });
          },
        );
      } catch {
        resolve({ score: 1, spam: 0 });
      }
    });
  }
  // ---- cross-session dedup (chrome.storage.local — NOT the page's IndexedDB) ----
  let seenSaveTimer = null;
  function persistSeen() {
    clearTimeout(seenSaveTimer);
    seenSaveTimer = setTimeout(() => {
      try {
        chrome.storage?.local?.set({
          [SEEN_KEY]: Array.from(S.seenIds).slice(-SEEN_CAP),
        });
      } catch {
        /* noop */
      }
    }, 1500);
  }
  async function loadSeen() {
    try {
      const r = await chrome.storage.local.get(SEEN_KEY);
      (r[SEEN_KEY] || []).forEach((k) => S.seenIds.add(k));
    } catch {
      /* noop */
    }
  }

  // ---- run history ----
  function logHistory(outcome) {
    try {
      chrome.storage.local.get(HISTORY_KEY).then((r) => {
        const hist = Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : [];
        hist.push({
          at: Date.now(),
          startedAt: S.startedAt,
          durationMs: Date.now() - (S.startedAt || Date.now()),
          platform: S.platform,
          mode: S.mode,
          keyword: S.keyword,
          processed: S.processed,
          liked: S.liked,
          loved: S.loved,
          skipped: S.skipped,
          // These four were missing, so the History tab under-reported next to the
          // summary card written from the same run.
          saved: S.saved,
          followed: S.followed,
          commented: S.commented,
          reactionCounts: { ...S.reactionCounts },
          outcome,
        });
        chrome.storage.local.set({ [HISTORY_KEY]: hist.slice(-50) });
      });
    } catch {
      /* noop */
    }
  }

  function writeSummary(outcome) {
    try {
      chrome.storage.local.set({
        [SUMMARY_KEY]: {
          outcome,
          platform: S.platform,
          mode: S.mode,
          keyword: S.keyword,
          startedAt: S.startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - (S.startedAt || Date.now()),
          processed: S.processed,
          saved: S.saved,
          liked: S.liked,
          loved: S.loved,
          followed: S.followed,
          skipped: S.skipped,
          personality: S.personalityMode ? PERSONALITIES[S.personalityMode].name : null,
        },
      });
    } catch {
      /* noop */
    }
  }

  // Center the post so its video fits the viewport, then dwell. FB autoplays
  // the video nearest viewport center, so centering is what starts playback.
  async function fbWatchPost(p) {
    const vid = p.root.querySelector("video");
    centerInViewport(vid || p.likeBtn);
    await sleep(rand(700, 1400));
    if (!vid) {
      await sleep(rand(S.pacing.minDelay, S.pacing.maxDelay));
      return;
    }
    // FB doesn't restart ended feed videos on its own; muted play() is allowed
    // and rewinds an ended video to the start.
    if (vid.paused) {
      try {
        await vid.play();
      } catch {
        /* ignore */
      }
      await sleep(300);
    }
    let dwell = null;
    let frac = null;
    if (S.quickMode) {
      dwell = rand(3000, 10000);
    } else if (isFinite(vid.duration) && vid.duration > 0) {
      frac = watchFraction();
      dwell = commitmentDwellMs(frac, vid.duration, S.pacing.reelDwellMin, S.pacing.reelDwellMax);
      const remaining = Math.max(2000, (vid.duration - vid.currentTime) * 1000);
      dwell = Math.min(dwell, remaining);
    }
    if (dwell == null) dwell = rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    dwell = Math.min(dwell, MAX_DWELL_MS());
    const prog = startProgress(
      "▶",
      `assistindo${frac != null ? ` (${Math.round(frac * 100)}%)` : ""}`,
      dwell,
    );
    const t0 = Date.now();
    while (Date.now() - t0 < dwell && S.isRunning && !S.isPaused) {
      tickProgress(prog);
      await sleep(400);
    }
    endProgress(prog);
  }

  // A reaction chip inside the open picker: a small square (≈39px) whose
  // accessible name matches the reaction's localized words. The size gate keeps
  // us off the action-bar button and the reaction-count tooltips, which share
  // the same words.
  function fbPickerChip(key) {
    const words = FB_REACTIONS[key].words;
    return Array.from(
      document.querySelectorAll('[role="button"][aria-label]'),
    ).find((b) => {
      if (!words.includes(fbAria(b))) return false;
      const r = b.getBoundingClientRect();
      return r.width >= 24 && r.width <= 70 && r.height >= 24 && r.height <= 70;
    });
  }
  // React with ANY of FB's reactions. "like" is the plain action-bar click;
  // everything else hovers the like control to open the picker (synthetic hover
  // is enough — verified live) and clicks the chip. Falls back to a plain Like
  // if the picker never surfaces, so a run never stalls on a missing picker.
  // Returns the reaction key that actually landed, or false. (A picker miss
  // degrades to "like", so the caller counts what really happened.)
  async function fbReactWith(p, key) {
    const btn = fbBarLikeBtn(p.root);
    if (!btn) return false;
    if (key === "like") {
      await humanClick(btn);
      await sleep(rand(300, 600));
      return fbIsLikedBtn(fbBarLikeBtn(p.root)) ? "like" : false;
    }
    // Open the picker by hovering the like control, then move onto the chip and
    // click it QUICKLY — a slow hover (humanClick's built-in dwell) let FB's
    // picker close/deselect, so the click committed a plain Like instead.
    await humanHover(btn);
    const chip = await waitFor(() => fbPickerChip(key), 2500);
    if (chip) {
      hoverEvents(chip); // highlight the chip (enter events)
      await sleep(rand(120, 280)); // brief — keep the picker alive
      hoverEvents(chip); // a second move so FB keeps it under the pointer
      pressRelease(chip); // immediate click, no extra dwell
      await sleep(rand(500, 900));
      if (fbIsLikedBtn(fbBarLikeBtn(p.root))) return key; // reaction landed
    }
    // Picker never opened, or the chip didn't register → degrade to a plain Like
    // (which reliably works) so the engagement still lands and we never mistake a
    // reaction-picker hiccup for a soft-block.
    const like = fbBarLikeBtn(p.root);
    if (like && !fbIsLikedBtn(like)) {
      await humanClick(like);
      await sleep(rand(300, 600));
    }
    return fbIsLikedBtn(fbBarLikeBtn(p.root)) ? "like" : false;
  }
  // Weighted pick among the reactions the user enabled (falls back to Like).
  function pickReaction() {
    const enabled = REACTION_KEYS.filter((k) => S.reactions?.[k]);
    if (!enabled.length) return "like";
    const total = enabled.reduce((n, k) => n + FB_REACTIONS[k].weight, 0);
    let roll = Math.random() * total;
    for (const k of enabled) {
      roll -= FB_REACTIONS[k].weight;
      if (roll <= 0) return k;
    }
    return enabled[enabled.length - 1];
  }

  // ---------- commenting (FB reels) ----------
  // Random phrase from the user's pool; avoid repeating the immediately-previous one.
  function pickPhrase() {
    const pool = (S.commentSettings.phrases || []).filter((t) => t && t.trim());
    if (!pool.length) return null;
    if (pool.length === 1) return pool[0];
    let t = pool[Math.floor(Math.random() * pool.length)];
    if (t === S.lastPhrase) t = pool[Math.floor(Math.random() * pool.length)];
    return t;
  }
  // The reel's comment button (right rail). aria-label is localized; its innerText
  // is the comment count. [VERIFIED live pt-br 2026-07-12]
  const FB_COMMENT_BTN = [
    "comment",
    "comentar",
    "comentario",
    "comentário",
    "commenter",
    "commenta",
    "kommentieren",
  ];
  function fbReelCommentBtn() {
    return Array.from(
      document.querySelectorAll('[role="button"][aria-label]'),
    ).find((b) => FB_COMMENT_BTN.includes(fbAria(b)) && visible(b));
  }
  // Reel author from the "Seguir/Follow <name>" button — the per-author comment key.
  function fbReelAuthorName(root) {
    for (const b of (root || document).querySelectorAll(
      '[role="button"][aria-label]',
    )) {
      const m = fbAria(b).match(/^(?:follow|seguir|suivre|segui|following|seguindo)\s+(.+)$/);
      if (m) return "name:" + m[1].slice(0, 40);
    }
    return null;
  }
  // The Lexical composer that opens under the reel when the comment button is
  // toggled on. contenteditable + data-lexical-editor. [VERIFIED live]
  function fbCommentBox() {
    return Array.from(
      document.querySelectorAll(
        '[role="textbox"][contenteditable="true"][data-lexical-editor="true"]',
      ),
    ).find(visible);
  }
  const FB_POST_COMMENT = [
    "post comment",
    "postar comentário",
    "publicar comentario",
    "publicar comentário",
    "publier le commentaire",
    "pubblica commento",
  ];
  function fbPostCommentBtn() {
    return Array.from(
      document.querySelectorAll('[role="button"][aria-label]'),
    ).find((b) => FB_POST_COMMENT.includes(fbAria(b)) && visible(b));
  }
  // Type into the Lexical editor with a human cadence, then post. Confirms by the
  // editor clearing (the rail count doesn't update live). Closes the composer on
  // its way out. Returns true only when the comment posted.
  // Returns { ok, reason } — the reason is the whole point. Four different things
  // can go wrong here and they need different fixes, so never collapse them into
  // a bare false: the run log has to say WHICH step lost the comment.
  // Enter is how a person actually sends a reel comment — Lexical submits on a
  // plain Enter (Shift+Enter newlines). It's also the fallback when the send
  // button can't be matched: FB only renders one on some surfaces, and its
  // accessible name is localised, so an aria-label list will always be partial.
  function fbPressEnter(box) {
    const opts = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    box.dispatchEvent(new KeyboardEvent("keydown", opts));
    box.dispatchEvent(new KeyboardEvent("keypress", opts));
    box.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  async function fbCommentReel(text) {
    const openBtn = fbReelCommentBtn();
    if (!openBtn) return { ok: false, reason: "no_comment_button" };
    await humanClick(openBtn); // toggles the inline composer open
    // The rail loads the comment drawer lazily; 3.5s was tight on a slow feed.
    const box = await waitFor(fbCommentBox, 6000);
    if (!box) return { ok: false, reason: "composer_never_opened" };
    box.focus();
    await sleep(rand(250, 500));
    // Type it out — execCommand('insertText') is the reliable Lexical path;
    // chunked with small gaps so it reads as typed, not pasted.
    for (const ch of text) {
      document.execCommand("insertText", false, ch);
      await sleep(rand(35, 90));
    }
    const typed = (fbCommentBox()?.innerText || "").trim();
    if (!typed) return { ok: false, reason: "typing_failed", typed };
    await sleep(rand(400, 900)); // a beat before sending

    const cleared = () => {
      const b = fbCommentBox();
      return !b || !(b.innerText || "").trim();
    };
    // Prefer the explicit send button; fall back to Enter when it isn't there.
    const post = await waitFor(fbPostCommentBtn, 2500);
    let via = "post_button";
    if (post) await humanClick(post);
    else {
      via = "enter";
      fbPressEnter(fbCommentBox() || box);
    }
    let ok = await waitFor(cleared, 3500);
    // Button was there but nothing happened → still try Enter before giving up.
    if (!ok && via === "post_button") {
      via = "post_button+enter";
      fbPressEnter(fbCommentBox() || box);
      ok = await waitFor(cleared, 3000);
    }
    const closeBtn = fbReelCommentBtn();
    if (closeBtn) await humanClick(closeBtn);
    // NB: "editor didn't clear" is not proof the comment failed — it may have
    // posted and the box kept its content. Flagged distinctly so it can't be
    // read as a hard failure without checking.
    return ok
      ? { ok: true, reason: "posted", via, typed }
      : { ok: false, reason: "editor_not_cleared", via, typed };
  }

  // Mode A on Facebook is LIKE-ONLY (scroll + watch + like/love). Organic pacing:
  // lurk first, react probabilistically by niche relevance, throttle per author,
  // cap likes/hour, use a human pointer trail and a read-before-react pause.
  async function fbDoPostActions(p) {
    const th = S.thresholds || {};
    if (th.minLikes || th.minComments) {
      const st = fbPostStats(p);
      if (
        (th.minLikes && st.likes < th.minLikes) ||
        (th.minComments && st.comments < th.minComments)
      ) {
        logLine(
          `· sem ação — abaixo do limite (${st.likes} curtidas / ${st.comments} comentários)`,
        );
        return;
      }
    }
    if (!S.actions.like) return;

    // Warm-up: lurk the first few posts of a session, no actions.
    if (S.processed < S.warmupPosts) {
      logLine(`· navegação de aquecimento (${S.processed + 1}/${S.warmupPosts})`);
      return;
    }

    const per = persona();
    const engage = engageScale(per.engageChance); // × session mood × curve
    if (Math.random() >= engage) {
      if (!(await maybeFeint(fbBarLikeBtn(p.root))))
        logLine(`· apenas navegou (engajamento ${Math.round(engage * 100)}%)`);
      return;
    }

    const relText = fbGetPostText(p.root);

    // One round-trip: niche cosine (+ spam cosine when guarding).
    let likeChance = per.likeChance;
    const needAI =
      (S.relevanceMin > 0 && (S.keyword || "").trim()) || S.spamGuard;
    if (needAI) {
      const { score, spam } = await getRelevanceInfo(
        S.keyword,
        relText,
        S.spamGuard,
      );
      if (S.spamGuard && spam >= SPAM_MIN) {
        logLine(`· spam/golpe, pulado (spam ${spam.toFixed(2)})`);
        return;
      }
      if (S.relevanceMin > 0 && (S.keyword || "").trim()) {
        if (score >= S.relevanceMin) {
          likeChance = Math.min(
            1,
            per.likeChance * (1 + (score - S.relevanceMin) * 2),
          );
          logLine(
            `· dentro do nicho (rel ${score.toFixed(2)}) → curtir ${Math.round(likeChance * 100)}%`,
          );
        } else {
          likeChance =
            per.likeChance * Math.max(0.05, score / S.relevanceMin) * 0.3;
          logLine(
            `· fora do nicho (rel ${score.toFixed(2)}) → curtir ${Math.round(likeChance * 100)}%`,
          );
        }
      }
    }
    if (Math.random() >= likeChance) {
      logLine(`· sem reação (dado ${Math.round(likeChance * 100)}%)`);
      return;
    }
    // Fresh query — the enumerated node may have been swapped by re-hydration.
    if (fbIsLikedBtn(fbBarLikeBtn(p.root))) {
      logLine("· já reagiu");
      return;
    }

    // Safety caps.
    if (S.consecLikes >= MAX_CONSEC_LIKES) {
      S.consecLikes = 0;
      logLine("· intervalo de reação");
      await sleep(rand(2000, 4000));
      return;
    }
    const nowT = Date.now();
    S.likeTimes = S.likeTimes.filter((t) => nowT - t < 3600000);
    if (S.likeTimes.length >= MAX_LIKES_PER_HOUR) {
      logLine("· limite horário de reações — pulando");
      return;
    }
    if (
      p.authorKey &&
      (S.authorLikes[p.authorKey] || 0) >= MAX_LIKES_PER_AUTHOR
    ) {
      logLine("· limite por autor — pular");
      return;
    }

    // Read-before-react: a human watches, then decides.
    await sleep(rand(900, 2500));

    // Pick a reaction from the ones the user enabled (weighted; Like dominates).
    const want = pickReaction();
    const got = await fbReactWith(p, want);
    if (got) {
      S.consecLikes++;
      S.likeTimes.push(Date.now());
      S.softFailStreak = 0;
      S.reactionCounts[got] = (S.reactionCounts[got] || 0) + 1;
      if (got === "like") S.liked++;
      else if (got === "love") S.loved++;
      if (p.authorKey)
        S.authorLikes[p.authorKey] = (S.authorLikes[p.authorKey] || 0) + 1;
      logLine(
        `${FB_REACTIONS[got].emoji} reagiu ${reactionPT(got)}${got !== want ? ` (não achou ${reactionPT(want)})` : ""}`,
      );
    } else {
      S.softFailStreak++;
      logLine(
        `· reação não registrou (${S.softFailStreak}/${SOFT_FAIL_LIMIT})`,
      );
      if (S.softFailStreak >= SOFT_FAIL_LIMIT)
        halt("possível bloqueio brando — reações não estão sendo registradas");
    }
  }

  // Auto-capture: while warming, when a video post clears the configured thresholds,
  // hand it to the same-tab transcription script (via a window event) to download
  // and/or transcribe it, and stash it in the Saved (favorites) tab. Fires at most
  // once per post — capturedIds dedup. The video was already played in fbWatchPost,
  // so the background has captured its fbcdn tracks by now.
  function fbMaybeAutoCapture(p) {
    const ac = S.autoCapture;
    if (!ac || !ac.enabled) return;
    if (!ac.download && !ac.transcribe && !ac.favorite) return;
    if (!p.root.querySelector("video")) return; // videos only
    if (p.postKey && S.capturedIds.has(p.postKey)) return;
    const st = fbPostStats(p);
    // 0 = threshold off. A video qualifies only when it clears every threshold set.
    if (ac.minLikes && st.likes < ac.minLikes) return;
    if (ac.minComments && st.comments < ac.minComments) return;
    if (p.postKey) S.capturedIds.add(p.postKey);
    const acts = [
      ac.transcribe && "transcrever",
      ac.download && "baixar",
      ac.favorite && "salvar",
    ]
      .filter(Boolean)
      .join("+");
    logLine(`⭐ captura automática (👍${st.likes} 💬${st.comments}) → ${acts}`);
    try {
      window.dispatchEvent(
        new CustomEvent("__fbw_auto_capture", {
          detail: {
            transcribe: !!ac.transcribe,
            download: !!ac.download,
            favorite: !!ac.favorite,
          },
        }),
      );
    } catch (e) {
      /* ignore */
    }
  }

  async function postsLoop(label) {
    if (S.loopActive) return;
    S.loopActive = true;
    logLine(
      `📜 sessão de ${label} iniciada (até ${new Date(S.willEndAt).toTimeString().slice(0, 5)}, aquecimento ${S.warmupPosts})`,
    );
    await loadSeen(); // merge cross-session dedup set
    // Preload the relevance model so the first scored post doesn't stall mid-run.
    if (S.relevanceMin > 0 || S.spamGuard)
      getRelevanceInfo(S.keyword, "warming up niche model", S.spamGuard).catch(
        () => {},
      );
    let emptyScrolls = 0;
    // Feed children only ever grow (batches of ~8 per pagination fetch); posts
    // hydrate lazily near the viewport. A growing child count during an empty
    // stretch means pagination/hydration is in flight — progress, not selector
    // loss — so it resets the empty-scroll counter instead of accruing misses.
    let lastFeedCount = 0;
    try {
      while (shouldContinue(S)) {
        await waitWhilePaused();
        await maybeBreak();
        if (!S.isRunning) break;
        {
          const stop = detectStopCached();
          if (stop) return halt(stop);
        }

        const p = fbPickPost();
        if (!p) {
          const feedCount =
            document.querySelector('[role="feed"]')?.children.length || 0;
          if (feedCount > lastFeedCount) {
            lastFeedCount = feedCount;
            emptyScrolls = 0;
          }
          humanScroll();
          await sleep(rand(1200, 2600));
          if (++emptyScrolls > EMPTY_SCROLL_LIMIT) {
            note(false);
            if (!S.isRunning) break;
          }
          continue;
        }
        emptyScrolls = 0;
        note(true);
        if (p.postKey) {
          S.seenIds.add(p.postKey);
          persistSeen();
        }
        if (S.englishOnly && !isEnglish(fbGetPostText(p.root))) {
          S.skipped++;
          logLine("· pulado (não está em inglês)");
          persist();
          humanScroll();
          await sleep(rand(900, 1800));
          continue;
        }
        await fbWatchPost(p);
        if (!S.isRunning || S.isPaused) continue;
        fbMaybeAutoCapture(p);
        await fbDoPostActions(p);
        S.processed++;
        logLine(`✓ post ${S.processed}${S.maxItems ? `/${S.maxItems}` : ""}`);
        persist();
        await actionGap();
        await maybeIdle(); // rare "got distracted" pause
        await scrollBurst(1, 3);
      }
      if (S.isRunning) finishRun();
    } finally {
      S.loopActive = false;
    }
  }

  // ============================================================
  // Localized accessible-name sets — IG/FB use localized aria-labels (this account
  // is pt-br); TikTok uses language-independent data-e2e. Add locales as needed.
  const L = {
    like: ["like", "curtir", "me gusta", "j’aime", "j'aime", "mi piace"],
    unlike: ["unlike", "descurtir", "ya no me gusta"],
    save: ["save", "salvar", "guardar", "enregistrer", "salva"],
    unsave: ["remove", "remover", "quitar", "retirer", "rimuovi"],
    follow: ["follow", "seguir", "suivre", "segui"],
    following: ["following", "seguindo", "siguiendo"],
    nextReel: [
      "navigate to next reel",
      "navegar para o próximo reel",
      "navegar al siguiente reel",
    ],
    pressPlay: [
      "press to play",
      "pressionar para reproduzir",
      "pulsa para reproducir",
    ],
  };
  const nameOf = (el) =>
    (el.getAttribute("aria-label") || el.textContent || "")
      .trim()
      .toLowerCase();
  const inSet = (el, set) => set.includes(nameOf(el));
  const findByName = (root, sel, set) =>
    Array.from((root || document).querySelectorAll(sel)).find((el) =>
      set.includes(nameOf(el)),
    );

  // INSTAGRAM adapters — reels like/save/follow/advance [VERIFIED live: pt-br + en].
  // ============================================================
  function igActiveVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) return null;
    if (vids.length === 1) return vids[0];
    for (const v of vids) if (!v.paused && v.currentTime > 0) return v;
    const cy = window.innerHeight / 2;
    let best = null,
      bd = Infinity;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.height <= 0) continue;
      const d = Math.abs(r.top + r.height / 2 - cy);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }
  // like svg = aria-label in the like OR unlike set (localized)
  function igLikeSvg(root) {
    return Array.from(
      (root || document).querySelectorAll('svg[role="img"][aria-label]'),
    ).find((s) => inSet(s, L.like) || inSet(s, L.unlike));
  }
  function igContainer() {
    const v = igActiveVideo();
    if (!v) return null;
    let n = v.parentElement;
    for (let i = 0; i < 15 && n && n !== document.body; i++) {
      if (igLikeSvg(n)) return n;
      n = n.parentElement;
    }
    return null;
  }
  function igLikeBtn(c) {
    if (!c) return null;
    const svg = igLikeSvg(c);
    return svg ? clickableAncestor(svg.parentElement, c, 6) : null;
  }
  const igIsLiked = (c) => {
    const s = igLikeSvg(c);
    return !!s && inSet(s, L.unlike);
  };
  function igNextReel() {
    const b = findByName(
      document,
      'div[role="button"][aria-label]',
      L.nextReel,
    );
    if (b) {
      b.click();
      return true;
    }
    const ctr = document.querySelector(
      '[aria-label="Reels navigation controls"]',
    );
    if (ctr) {
      const bs = ctr.querySelectorAll('div[role="button"]');
      if (bs.length >= 2) {
        bs[1].click();
        return true;
      }
    }
    return false;
  }
  function igResume() {
    const p = findByName(
      document,
      'div[role="button"][aria-label]',
      L.pressPlay,
    );
    if (p) {
      p.click();
      return true;
    }
    return false;
  }
  // IG bookmark: Save svg → enclosing button; saved flips Save→Remove (localized). [VERIFIED live]
  async function igSave(c) {
    const root = c || document;
    const svg = findByName(root, 'svg[role="img"][aria-label]', L.save);
    if (!svg) return false; // already saved or control absent
    clickableAncestor(svg.parentElement, root, 6).click();
    await sleep(rand(400, 800));
    return !!findByName(root, 'svg[role="img"][aria-label]', L.unsave);
  }
  // IG follow: role=button whose accessible text is Follow (localized) → flips to Following.
  async function igFollow(c) {
    const root = c || document;
    const btn = Array.from(
      root.querySelectorAll('button, [role="button"]'),
    ).find((x) => inSet(x, L.follow) && visible(x));
    if (!btn) return false;
    btn.click();
    await sleep(rand(400, 800));
    return true;
  }

  const IG_REELS = {
    label: "reels",
    noun: "reel",
    emoji: "🎞️",
    getContainer: igContainer,
    likeBtn: igLikeBtn,
    isLiked: igIsLiked,
    save: (c) => igSave(c),
    follow: (c) => igFollow(c),
    advance: igNextReel,
    resume: igResume,
  };
  // Mode A/B on IG (hashtag/explore grids) are not mapped live yet. Best-effort:
  // scroll the grid; act on whatever reel autoplays centered; advance by scrolling.
  const IG_FEED = {
    label: "explore",
    noun: "reel",
    emoji: "🧭",
    getContainer: igContainer,
    likeBtn: igLikeBtn,
    isLiked: igIsLiked,
    save: (c) => igSave(c),
    follow: (c) => igFollow(c),
    advance: () => {
      humanScroll();
      return true;
    },
    resume: igResume,
    scrollWhenEmpty: true,
  };

  // ============================================================
  // TIKTOK adapters — language-independent data-e2e. Like/save(favorite)/follow/advance
  // VERIFIED on a logged-in session (favorite count increments; follow icon morphs +↔✓).
  // ============================================================
  function ttActiveArticle() {
    const v = document.querySelector("article video");
    if (v) {
      const a =
        v.closest('article[data-e2e="recommend-list-item-container"]') ||
        v.closest("article");
      if (a) return a;
    }
    const list = Array.from(
      document.querySelectorAll(
        'article[data-e2e="recommend-list-item-container"], [class*="DivPlayerContainer"]',
      ),
    );
    if (!list.length) return null;
    const cx = innerWidth / 2,
      cy = innerHeight / 2;
    let best = null,
      bd = Infinity;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const d =
        (r.left + r.width / 2 - cx) ** 2 + (r.top + r.height / 2 - cy) ** 2;
      if (d < bd) {
        bd = d;
        best = el;
      }
    }
    return best;
  }
  // TikTok action hooks are language-independent data-e2e. Feed (For You) uses
  // *-icon / feed-follow; video detail (search) uses browse-*.
  function ttLikeBtn(c) {
    const root = c || document;
    const icon = root.querySelector(
      '[data-e2e="like-icon"], [data-e2e="browse-like-icon"]',
    );
    if (icon) return icon.closest("button, [role=button]") || icon;
    return root.querySelector('button[data-e2e="browse-like"]');
  }
  // liked when the like icon tints red (≈#fe2c55) — language-independent
  const ttIsLiked = (c) => {
    const span = (c || document).querySelector(
      '[data-e2e="like-icon"], [data-e2e="browse-like-icon"]',
    );
    if (span) {
      const m = getComputedStyle(span).color.match(/\d+/g);
      if (m && +m[0] > 200 && +m[1] < 90 && +m[2] < 120) return true;
    }
    return ttLikeBtn(c)?.getAttribute("aria-pressed") === "true";
  };
  function ttIsLive(c) {
    const badge = (c || document).querySelector('span[class*="SpanLiveBadge"]');
    return !!badge && /live/i.test(badge.textContent || "");
  }
  function ttAdvance() {
    const arrow = document.querySelector(
      'button[data-e2e="arrow-right"], button[aria-label*="next video" i]',
    );
    if (arrow && !arrow.disabled) {
      arrow.click();
      return true;
    }
    const items = document.getElementsByClassName(
      "TUXButton--secondary action-item",
    );
    if (items && items.length) {
      const t = items[items.length - 1];
      if (t && !t.disabled && t.getAttribute("aria-disabled") !== "true") {
        t.click();
        return true;
      }
    }
    return false;
  }
  // TikTok favorite (bookmark): favorite-icon (feed) / browse-favorite (detail).
  // [VERIFIED selectors live; persistence needs a logged-in TikTok session.]
  async function ttSave(c) {
    const root = c || document;
    const icon = root.querySelector(
      '[data-e2e="favorite-icon"], [data-e2e="browse-favorite-icon"]',
    );
    const btn = icon
      ? icon.closest("button, [role=button]")
      : root.querySelector('button[data-e2e="browse-favorite"]');
    if (!btn) return false;
    btn.click();
    await sleep(rand(400, 800));
    return true; // VERIFIED: favorite count increments on click
  }
  // TikTok follow: feed-follow (feed) / browse-follow (detail). Icon morphs +↔✓. [VERIFIED]
  async function ttFollow(c) {
    const root = c || document;
    const btn = root.querySelector(
      'button[data-e2e="feed-follow"], button[data-e2e="browse-follow"]',
    );
    if (!btn || !visible(btn)) return false;
    btn.click();
    await sleep(rand(400, 800));
    return true;
  }

  const TT_FORYOU = {
    label: "for-you",
    noun: "video",
    emoji: "🎵",
    getContainer: ttActiveArticle,
    likeBtn: ttLikeBtn,
    isLiked: ttIsLiked,
    save: (c) => ttSave(c),
    follow: (c) => ttFollow(c),
    advance: ttAdvance,
    shouldSkip: (c) => ttIsLive(c),
    skipReason: "LIVE",
  };

  // TikTok search (Mode A): navigate to results, open the first result, then swipe
  // through detail with arrow-right. End-of-results → reload for fresh tiles.
  function ttOpenFirstResult() {
    const tiles = Array.from(
      document.querySelectorAll(
        '[id*="column-item-video-container"] a[href*="/video/"], a[href*="/video/"]',
      ),
    );
    const tile = tiles.find(visible) || tiles[0];
    if (!tile) return false;
    tile.click();
    return true;
  }
  function ttSearchEnded() {
    const noMore = document.querySelector(
      '[class*="DivNoMoreResultsContainer"]',
    );
    return !!noMore && /no more results/i.test(noMore.textContent || "");
  }
  const TT_SEARCH = {
    label: "search",
    noun: "video",
    emoji: "🔎",
    getContainer: () =>
      document.querySelector('button[data-e2e="browse-like"]')
        ? document
        : null,
    likeBtn: ttLikeBtn,
    isLiked: ttIsLiked,
    save: (c) => ttSave(c),
    follow: (c) => ttFollow(c),
    advance: ttAdvance,
    shouldSkip: (c) => ttIsLive(c),
    skipReason: "LIVE",
    // open the first result if we're still on the grid
    async preLoop() {
      if (!document.querySelector('button[data-e2e="browse-like"]')) {
        if (ttOpenFirstResult()) {
          await sleep(rand(1500, 2500));
        }
      }
    },
    isEnd: ttSearchEnded,
    async onEnd() {
      persist();
      await sleep(1500);
      location.reload();
    },
  };

  // ============================================================
  // generic video/reel loop (used by FB reels, IG, TikTok)
  // ============================================================
  async function doVideoActions(A, c, watchedFull) {
    const per = persona();
    if (S.actions.save) {
      const ok = await A.save(c);
      if (ok) {
        S.saved++;
        logLine(`🔖 ${nounPT(A.noun)} salvo`);
      } else logLine(`· salvar ${nounPT(A.noun)}: já salvo / indisponível`);
      await sleep(rand(500, 1200));
    }
    const fbReact = A.reactable && platformForHost() === "facebook";
    const likeChance = engageScale(per.likeChance); // × session mood × curve
    if (S.actions.like && Math.random() >= likeChance) {
      // dice said don't react — occasionally hover-and-bail instead of nothing
      const feinted = await maybeFeint(
        fbReact ? fbBarLikeBtn(c) : A.likeBtn && A.likeBtn(c),
      );
    } else if (S.actions.like) {
      if (S.consecLikes >= MAX_CONSEC_LIKES) {
        S.consecLikes = 0;
        logLine("· intervalo de curtida");
        await sleep(rand(2000, 4000));
      } else if (!A.isLiked(c)) {
        // Facebook reels share the posts' reaction picker — pick a weighted
        // reaction (Like dominant). IG/TikTok have no picker → plain like.
        if (A.reactable && platformForHost() === "facebook") {
          const want = pickReaction();
          const t0 = Date.now();
          const got = await fbReactWith({ root: c }, want);
          if (got) {
            S.liked += got === "like" ? 1 : 0;
            if (got === "love") S.loved++;
            S.reactionCounts[got] = (S.reactionCounts[got] || 0) + 1;
            S.consecLikes++;
            S.softFailStreak = 0;
            logLine(
              `${FB_REACTIONS[got].emoji} reagiu ${reactionPT(got)} no ${nounPT(A.noun)}${got !== want ? ` (não achou ${reactionPT(want)})` : ""}`,
            );
          } else noteSoftFail();
        } else {
          const btn = A.likeBtn(c);
          if (btn) {
            await humanClick(btn);
            await sleep(rand(250, 500));
            const ok = A.isLiked(c);
            if (ok) {
              S.liked++;
              S.consecLikes++;
              S.softFailStreak = 0;
              logLine(`❤️ curtiu o ${nounPT(A.noun)}`);
            } else noteSoftFail();
          }
        }
      }
    }
    if (
      S.actions.follow &&
      S.consecFollows < MAX_CONSEC_FOLLOWS &&
      Math.random() < per.followChance
    ) {
      if (await A.follow(c)) {
        S.followed++;
        S.consecFollows++;
        logLine("➕ seguiu o autor");
      }
    }
    // Comment (FB reels only) — rare, capped, and only on reels we watched fully.
    await maybeComment(A, c, watchedFull);
  }

  // Gate + post a comment. All the safety lives here so the action itself stays
  // simple. Reels/FB only; skips silently unless every gate passes.
  async function maybeComment(A, c, watchedFull) {
    const cs = S.commentSettings;
    // Each gate below is named in an inline comment: a run where comments never
    // fire is a question ("which gate ate them?") and these are the candidates.
    if (
      !A.commentable ||
      platformForHost() !== "facebook" ||
      !cs.enabled ||
      !(cs.phrases || []).length
    )
      return; // not applicable at all
    if (cs.onlyFullyWatched && !watchedFull) return; // gate: not_fully_watched
    if (S.processed < S.warmupPosts) return; // gate: warmup
    if (S.consecComments >= 1) {
      S.consecComments = 0;
      return; // gate: back_to_back
    }
    if (Math.random() >= cs.chance) return; // gate: dice

    const reelId = (location.pathname.match(/\/reel\/(\d+)/) || [])[1] || null;
    if (reelId && S.commentedIds.has(reelId)) return; // gate: already_commented
    const authorKey = fbAuthorKey(c) || fbReelAuthorName(c);
    const nowT = Date.now();
    S.commentTimes = S.commentTimes.filter((t) => nowT - t < 3600000);
    if (S.commentTimes.length >= MAX_COMMENTS_PER_HOUR) {
      logLine("· limite horário de comentários — pular");
      return; // gate: hourly_cap
    }
    if (authorKey && (S.authorComments[authorKey] || 0) >= MAX_COMMENTS_PER_AUTHOR)
      return; // gate: author_cap

    const text = pickPhrase();
    if (!text) return; // gate: no_phrase
    await sleep(rand(800, 2200)); // read-before-comment beat
    const t0 = Date.now();
    const { ok, reason, typed, via } = await fbCommentReel(text);
    if (ok) {
      S.commented++;
      S.consecComments++;
      S.lastPhrase = text;
      S.commentTimes.push(Date.now());
      if (reelId) S.commentedIds.add(reelId);
      if (authorKey)
        S.authorComments[authorKey] = (S.authorComments[authorKey] || 0) + 1;
      S.softFailStreak = 0;
      logLine(`💬 comentou "${text.slice(0, 28)}"`);
    } else {
      S.softFailStreak++;
      logLine(
        `· comentário não foi publicado: ${commentFailPT(reason)} (${S.softFailStreak}/${SOFT_FAIL_LIMIT})`,
      );
      if (S.softFailStreak >= SOFT_FAIL_LIMIT)
        halt(`possível bloqueio brando — comentários não sendo publicados (${commentFailPT(reason)})`);
    }
  }

  async function videoLoop(A) {
    if (S.loopActive) return;
    S.loopActive = true;
    logLine(
      `${A.emoji || "🎞️"} sessão de ${adapterLabelPT(A.label)} iniciada (até ${new Date(S.willEndAt).toTimeString().slice(0, 5)})`,
    );
    let emptyScrolls = 0,
      endStreak = 0;
    try {
      if (A.preLoop) await A.preLoop();
      while (shouldContinue(S)) {
        await waitWhilePaused();
        await maybeBreak();
        if (!S.isRunning) break;
        {
          const stop = detectStopCached();
          if (stop) return halt(stop);
        }

        const c = A.getContainer();
        if (!c) {
          if (A.scrollWhenEmpty) {
            humanScroll();
            await sleep(rand(1200, 2600));
            if (++emptyScrolls > EMPTY_SCROLL_LIMIT) {
              halt("nenhum vídeo encontrado");
            }
          } else {
            note(false);
            if (A.resume) A.resume();
            await sleep(800);
          }
          continue;
        }
        emptyScrolls = 0;
        note(true);

        if (A.shouldSkip && A.shouldSkip(c)) {
          S.skipped++;
          logLine(`· pulado (${skipReasonPT(A.skipReason)})`);
          persist();
          if (!A.advance()) {
            if (A.onEnd && endStreak < 2) {
              endStreak++;
              await A.onEnd();
              return;
            }
            break;
          }
          await actionGap();
          continue;
        }

        const watchedFull = await reelDwell(A, c);
        if (!S.isRunning || S.isPaused) continue;
        await doVideoActions(A, c, watchedFull);
        S.processed++;
        logLine(`✓ ${nounPT(A.noun)} ${S.processed}${S.maxItems ? `/${S.maxItems}` : ""}`);
        persist();
        if (!shouldContinue(S)) break;

        if ((A.isEnd && A.isEnd()) || !A.advance()) {
          if (A.onEnd && endStreak < 2) {
            endStreak++;
            logLine("↻ fim dos resultados — atualizando");
            await A.onEnd();
            return;
          }
          logLine("⚠️ não foi possível avançar — encerrando");
          break;
        }
        endStreak = 0;
        await actionGap();
        await maybeIdle(); // rare "got distracted" pause
      }
      if (S.isRunning) finishRun();
    } finally {
      S.loopActive = false;
    }
  }

  function finishRun() {
    logLine(
      `✅ sessão concluída — processados ${S.processed}, curtidas ${S.liked}, amei ${S.loved}, pulados ${S.skipped}`,
    );
    S.isRunning = false;
    clearInterval(S.tickTimer);
    logHistory("complete");
    writeSummary("complete");
    persist();
  }

  // ============================================================
  // routing + navigation (per platform + mode)
  // ============================================================
  // FB warmer is hashtag-only: the keyword is always treated as a tag. Strip a
  // leading "#" and any spaces (hashtags are single-token) so plain "tarotreading"
  // or "#tarot reading" both land on /hashtag/<tag>. (S.keyword stays as typed for
  // the relevance embedding.)
  const fbTag = () =>
    (S.keyword || "").trim().replace(/^#/, "").replace(/\s+/g, "");
  function fbSearchUrl() {
    return `https://www.facebook.com/hashtag/${encodeURIComponent(fbTag())}`;
  }
  function fbOnCorrectSearch() {
    const tag = fbTag();
    if (!tag) return pageSurface() === "hashtag";
    return (
      pageSurface() === "hashtag" &&
      decodeURIComponent(location.pathname)
        .toLowerCase()
        .includes(tag.toLowerCase())
    );
  }

  // Returns a URL to navigate to before running, or null to run here.
  function targetUrlForMode() {
    const p = platformForHost();
    const surface = pageSurface();
    const kw = (S.keyword || "").trim();
    const tag = kw.replace(/^#/, "");

    if (p === "facebook") {
      if (S.mode === "C")
        return surface === "reels" ? null : "https://www.facebook.com/reel/";
      if (S.mode === "A") return fbOnCorrectSearch() ? null : fbSearchUrl();
      if (S.mode === "B")
        return surface === "feed" ? null : "https://www.facebook.com/";
    }
    if (p === "instagram") {
      if (S.mode === "C")
        return surface === "reels" ? null : "https://www.instagram.com/reels/";
      if (S.mode === "A") {
        const want = `/explore/tags/${encodeURIComponent(tag).toLowerCase()}`;
        return tag &&
          !decodeURIComponent(location.pathname)
            .toLowerCase()
            .startsWith(`/explore/tags/${tag.toLowerCase()}`)
          ? `https://www.instagram.com${want}/`
          : tag
            ? null
            : "https://www.instagram.com/explore/";
      }
      if (S.mode === "B")
        return surface === "explore"
          ? null
          : "https://www.instagram.com/explore/";
    }
    if (p === "tiktok") {
      if (S.mode === "C")
        return surface === "foryou" ? null : "https://www.tiktok.com/foryou";
      if (S.mode === "A") {
        if (kw.startsWith("#")) {
          return decodeURIComponent(location.pathname)
            .toLowerCase()
            .includes(`/tag/${tag.toLowerCase()}`)
            ? null
            : `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`;
        }
        const q = (new URLSearchParams(location.search).get("q") || "")
          .trim()
          .toLowerCase();
        return surface === "search" && q === kw.toLowerCase()
          ? null
          : `https://www.tiktok.com/search?q=${encodeURIComponent(kw)}`;
      }
    }
    return null;
  }

  function runEngine() {
    const p = platformForHost();
    if (p === "facebook") {
      if (S.mode === "C") videoLoop(FB_VIDEO);
      else if (S.mode === "A") postsLoop("hashtag");
      else postsLoop("feed");
    } else if (p === "instagram") {
      videoLoop(S.mode === "C" ? IG_REELS : IG_FEED);
    } else if (p === "tiktok") {
      videoLoop(S.mode === "A" ? TT_SEARCH : TT_FORYOU);
    } else {
      logLine("⚠️ site não suportado — nada para executar");
      S.isRunning = false;
      persist();
    }
  }

  // ---------- reel-thumbnail harvest (profile reels_tab) ----------
  // Thumbs are plain <img> tags inside a[href*="/reel/"] grid cards; the grid
  // lazy-loads on scroll, so scroll to the bottom until no new reels appear.
  function tick() {
    // Heartbeat runs even while paused — keeps savedAt fresh so the panel's
    // stale-session reconciler never misreads a long pause as an abandoned run.
    if (S.isRunning && Date.now() - S.lastPersistAt > 30000) persist();
    if (!S.isRunning || S.isPaused) return;
    const stopReason = detectStopCached();
    if (stopReason) {
      halt(stopReason);
      return;
    }
    if (S.willEndAt && Date.now() >= S.willEndAt) {
      logLine("⏲ limite de tempo da sessão atingido");
      finishRun();
    }
  }

  function start(settings) {
    const now = Date.now();
    clearInterval(S.tickTimer);
    S = freshState();
    S.isRunning = true;
    S.startedAt = now;
    S.platform = platformForHost() || settings.platform || "facebook";
    S.mode = settings.mode || "C";
    S.keyword = settings.keyword || "";
    S.maxItems = Math.max(0, Number(settings.maxItems) || 0);
    S.actions = {
      save: !!settings.save,
      like: !!settings.like,
      follow: !!settings.follow,
    };
    // Reaction mix. Default to Like + Love if the panel sent nothing usable.
    if (settings.reactions && REACTION_KEYS.some((k) => settings.reactions[k]))
      S.reactions = REACTION_KEYS.reduce(
        (o, k) => ((o[k] = !!settings.reactions[k]), o),
        {},
      );
    S.reactionCounts = {};
    // Commenting (FB reels). phrases arrive as plain strings; empty list = off.
    if (settings.comment) {
      const phrases = Array.isArray(settings.comment.phrases)
        ? settings.comment.phrases.map((t) => String(t || "").trim()).filter(Boolean)
        : [];
      S.commentSettings = {
        enabled: !!settings.comment.enabled && phrases.length > 0,
        chance: Math.min(0.5, Math.max(0, Number(settings.comment.chance) || 0.08)),
        onlyFullyWatched: settings.comment.onlyFullyWatched !== false,
        phrases,
      };
    }
    S.commented = 0;
    S.commentedIds = new Set();
    S.commentTimes = [];
    S.authorComments = {};
    S.lastPhrase = null;
    S.englishOnly = !!settings.englishOnly;
    S.relevanceMin = Math.max(0, Number(settings.relevanceMin) || 0);
    S.spamGuard = settings.spamGuard !== false; // default on
    S.quickMode = !!settings.quickMode;
    S.warmupPosts = rand(2, 4); // lurk-first browse before any reactions
    if (settings.thresholds)
      S.thresholds = {
        minLikes: Number(settings.thresholds.minLikes) || 0,
        minComments: Number(settings.thresholds.minComments) || 0,
      };
    if (settings.autoCapture)
      S.autoCapture = {
        enabled: !!settings.autoCapture.enabled,
        minLikes: Number(settings.autoCapture.minLikes) || 0,
        minComments: Number(settings.autoCapture.minComments) || 0,
        download: settings.autoCapture.download !== false,
        transcribe: settings.autoCapture.transcribe !== false,
        favorite: settings.autoCapture.favorite !== false,
      };
    if (settings.pacing) S.pacing = { ...S.pacing, ...settings.pacing };
    const durationMin = Math.max(3, Number(settings.durationMinutes) || 15);
    S.willEndAt = now + 60000 * durationMin;
    const map = {
      binge: "BINGE",
      casual: "CASUAL",
      engage: "ENGAGED",
      engaged: "ENGAGED",
    };
    if (settings.personality && map[settings.personality]) {
      S.userSelectedPersonality = map[settings.personality];
      S.personalityMode = map[settings.personality];
    } else pickPersonality();
    S.nextBreakAt = scheduleNextBreak(BREAKS[S.personalityMode], now);
    rollSessionMood(); // per-session engagement intensity + browse-only chance

    logLine(
      `▶️ ${S.platform} · modo ${S.mode}${S.keyword ? ` "${S.keyword}"` : ""} · ${durationMin}min${S.maxItems ? ` · limite ${S.maxItems}` : ""} · ${
        Object.entries(S.actions)
          .filter(([, v]) => v)
          .map(([k]) => actionPT(k))
          .join("+") || "observar"
      } · ${persona().name}${S.browseOnly ? " · 👀apenas navegação" : ` · humor ${S.sessionIntensity.toFixed(2)}`}${S.quickMode ? " · ⚡rápido" : ""}`,
    );
    persist();

    const target = targetUrlForMode();
    if (target) {
      logLine(`↪ navegando até o destino`);
      location.assign(target);
      return;
    }
    runEngine();
    S.tickTimer = setInterval(tick, 1000);
  }

  function stop() {
    if (!S.isRunning) return;
    logLine("⏹ interrompido pelo usuário");
    S.isRunning = false;
    S.isPaused = false;
    clearInterval(S.tickTimer);
    logHistory("stopped");
    writeSummary("stopped");
    persist();
  }
  function togglePause() {
    // No run in flight → nothing to pause. Without this the flag was persisted
    // anyway and the resume path honours `isPaused`, so a later run could come
    // back pre-paused with no way for the user to tell why.
    if (!S.isRunning) return;
    S.isPaused = !S.isPaused;
    logLine(S.isPaused ? "⏸ pausado" : "▶️ retomado");
    persist();
  }

  // ============================================================
  // message API (side panel → content). Names kept FBW_* for panel compat.
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    switch (msg?.type) {
      case "FBW_START":
        try {
          start(msg.settings || {});
          sendResponse({ ok: true, ...snapshot() });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
        return true;
      case "FBW_TOGGLE_PAUSE":
        togglePause();
        sendResponse({ ok: true, ...snapshot() });
        return true;
      case "FBW_STOP":
        stop();
        sendResponse({ ok: true, ...snapshot() });
        return true;
      case "FBW_STATUS":
        sendResponse(snapshot());
        return true;
      default:
        return false;
    }
  });

  // ============================================================
  // resume after navigation / reload (guard by host↔platform)
  // ============================================================
  (async () => {
    try {
      const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (!saved || !saved.isRunning) return;
      const here = platformForHost();
      if (
        !here ||
        (saved.platform && saved.platform !== here) ||
        saved.host !== location.hostname
      )
        return;
      if (saved.willEndAt && Date.now() >= saved.willEndAt) {
        // Clock ran out while the page was navigating — record it as complete
        // from the persisted counters instead of dropping it.
        Object.assign(S, freshState(), {
          platform: saved.platform || here,
          mode: saved.mode || "C",
          keyword: saved.keyword || "",
          startedAt: saved.startedAt || 0,
          processed: saved.processed || 0,
          saved: saved.saved || 0,
          liked: saved.liked || 0,
          loved: saved.loved || 0,
          followed: saved.followed || 0,
          skipped: saved.skipped || 0,
          personalityMode: saved.personalityMode || null,
        });
        logHistory("complete");
        writeSummary("complete");
        chrome.storage.local.set({ [STORAGE_KEY]: { isRunning: false } });
        return;
      }
      Object.assign(S, freshState(), {
        isRunning: true,
        isPaused: !!saved.isPaused,
        startedAt: saved.startedAt || Date.now(),
        // Pre-0.34 sessions persisted willEndAt: 0 (no time cap) — never resume
        // unbounded; give them the default 15-minute clock from now.
        willEndAt: saved.willEndAt || Date.now() + 15 * 60000,
        breakUntil: saved.breakUntil > Date.now() ? saved.breakUntil : 0,
        nextBreakAt: saved.nextBreakAt || 0,
        platform: saved.platform || here,
        mode: saved.mode || "C",
        keyword: saved.keyword || "",
        maxItems: saved.maxItems || 0,
        actions: saved.actions || { save: true, like: true, follow: false },
        reactions: saved.reactions || freshState().reactions,
        reactionCounts: saved.reactionCounts || {},
        commentSettings: saved.commentSettings || freshState().commentSettings,
        commented: saved.commented || 0,
        englishOnly: !!saved.englishOnly,
        relevanceMin: saved.relevanceMin || 0,
        spamGuard: saved.spamGuard !== false,
        quickMode: !!saved.quickMode,
        warmupPosts: saved.warmupPosts || 0,
        thresholds: saved.thresholds || { minLikes: 0, minComments: 0 },
        autoCapture: saved.autoCapture || freshState().autoCapture,
        pacing: { ...freshState().pacing, ...(saved.pacing || {}) },
        personalityMode: saved.personalityMode || null,
        userSelectedPersonality: saved.userSelectedPersonality || null,
        processed: saved.processed || 0,
        saved: saved.saved || 0,
        liked: saved.liked || 0,
        loved: saved.loved || 0,
        followed: saved.followed || 0,
        skipped: saved.skipped || 0,
        haltReason: null,
        log: Array.isArray(saved.log) ? saved.log.slice(-LOG_CAP) : [],
        // same run, not a new one: keep its rolled mood
        sessionIntensity:
          typeof saved.sessionIntensity === "number" ? saved.sessionIntensity : 1,
        browseOnly: !!saved.browseOnly,
        // Safety ledger — MUST be restored or the rate caps reset on every
        // navigation and stop capping anything. Mirror of persist().
        ...restoreLedger(saved),
      });
      if (!S.personalityMode) pickPersonality();
      if (!S.nextBreakAt || S.nextBreakAt < Date.now())
        S.nextBreakAt = scheduleNextBreak(BREAKS[S.personalityMode], Date.now());

      const target = targetUrlForMode();
      if (target) {
        logLine("↪ retomando — navegando até o destino");
        persist();
        location.assign(target);
        return;
      }
      logLine("🔄 sessão retomada em " + surfacePT(pageSurface()));
      runEngine();
      S.tickTimer = setInterval(tick, 1000);
    } catch (e) {
      /* ignore */
    }
  })();
})();
