import { franc } from "franc-min";
import {
  shouldContinue,
  scheduleNextBreak,
  breakLengthMs,
  commitmentDwellMs,
} from "./lib/sessionMath.js";

// socialWarmer — multi-platform content engine (Facebook / Instagram / TikTok).
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  // ---------- personalities (drive probabilistic Like/Follow) ----------
  const PERSONALITIES = {
    // engageChance gates whether a viewed post gets ANY action (save/like/follow);
    // the rest are watch-and-scroll only, so runs read as browsing, not farming.
    BINGE: {
      name: "Binge Watcher",
      likeChance: 0.15,
      followChance: 0.04,
      engageChance: 0.25,
      watchMin: 0.7,
      watchMax: 1.0,
    },
    CASUAL: {
      name: "Casual Scroller",
      likeChance: 0.35,
      followChance: 0.08,
      engageChance: 0.4,
      watchMin: 0.15,
      watchMax: 0.5,
    },
    ENGAGED: {
      name: "Engaged User",
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
  const LOVE_REACTION_CHANCE = 0.18; // of likes, send Love (❤️) instead of plain Like
  const SOFT_FAIL_LIMIT = 3; // reactions that click but don't register → soft-block backoff
  const SPAM_MIN = 0.34; // cosine to spam anchors above which a post is skipped
  const SEEN_KEY = "fbw_seen"; // cross-session post-id dedup (chrome.storage.local)
  const SEEN_CAP = 5000;
  const HISTORY_KEY = "fbw_history"; // per-run summaries for the History tab
  const LOG_CAP = 120;

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
      englishOnly: false,
      relevanceMin: 0, // niche-relevance cosine gate for likes (0 = off)
      spamGuard: true, // skip scam/giveaway/spam posts (MiniLM anchor cosine)
      deepRelevance: false, // transcribe video audio and fold into the relevance text
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
      // safety
      haltReason: null,
      missStreak: 0,
      consecLikes: 0,
      consecFollows: 0,
      warmupPosts: 0, // first N posts of a session = lurk only, no actions
      likeTimes: [], // rolling like timestamps for the per-hour rate cap
      authorLikes: {}, // authorKey -> likes this session (per-author throttle)
      softFailStreak: 0, // consecutive reactions that clicked but didn't register
      // log ring buffer
      log: [],
      // runtime-only
      tickTimer: null,
      loopActive: false,
      seen: new WeakSet(), // element-keyed (IG/TikTok video loops)
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
    persist();
  }

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
          englishOnly: S.englishOnly,
          relevanceMin: S.relevanceMin,
          spamGuard: S.spamGuard,
          deepRelevance: S.deepRelevance,
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
      targetN: S.maxItems, // legacy alias — WarmTool switches to maxItems in the UI task
      etaMs: S.willEndAt ? Math.max(0, S.willEndAt - now) : 0,
      processed: S.processed,
      saved: S.saved,
      liked: S.liked,
      loved: S.loved,
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
  function detectStop() {
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
      if (url.includes("/checkpoint")) return "checkpoint";
      if (
        document.querySelector('input[name="email"]') &&
        document.querySelector('input[name="pass"]')
      )
        return "login wall";
      if (
        /you'?re temporarily blocked|going too fast|try again later|temporarily restricted|suspicious activity/.test(
          body,
        )
      )
        return "rate-limit/block";
    } else if (p === "instagram") {
      if (url.includes("/challenge") || url.includes("/accounts/suspended"))
        return "checkpoint";
      if (
        document.querySelector('input[name="username"]') &&
        document.querySelector('input[name="password"]')
      )
        return "login wall";
      if (
        /we restrict certain activity|action blocked|try again later|please wait a few minutes|suspicious/.test(
          body,
        )
      )
        return "rate-limit/block";
    } else if (p === "tiktok") {
      if (url.includes("/login")) return "login wall";
      if (
        /too many attempts|verify to continue|you'?re tapping too fast|something went wrong, tap to retry/.test(
          body,
        )
      )
        return "rate-limit/block";
    }
    return null;
  }

  function halt(reason) {
    S.haltReason = reason;
    S.isRunning = false;
    logLine(`🛑 HALTED: ${reason}`);
    clearInterval(S.tickTimer);
    logHistory("halt: " + reason);
    persist();
  }

  function note(found) {
    if (found) S.missStreak = 0;
    else {
      S.missStreak += 1;
      if (S.missStreak >= MISS_LIMIT) halt("selectors not found");
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
    sleep(Math.round(rand(S.pacing.minDelay, S.pacing.maxDelay) * circadian()));
  const watchFraction = () => {
    const p = persona();
    return p.watchMin + Math.random() * (p.watchMax - p.watchMin);
  };
  // Dwell on the active video for a personality-driven fraction of its length;
  // fall back to the plain random dwell range when no duration is readable.
  async function reelDwell() {
    const vid = igActiveVideo(); // generic: nearest playing/centered <video>
    let dwell = null;
    let frac = null;
    if (vid && isFinite(vid.duration) && vid.duration > 0) {
      frac = watchFraction();
      dwell = commitmentDwellMs(frac, vid.duration, S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    }
    if (dwell == null) dwell = rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    logLine(
      `👀 dwell ~${Math.round(dwell / 1000)}s${frac != null ? ` (${Math.round(frac * 100)}%)` : ""}`,
    );
    const t0 = Date.now();
    while (Date.now() - t0 < dwell && S.isRunning && !S.isPaused) await sleep(400);
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
    logLine(`☕ break ~${Math.round(len / 1000)}s`);
    persist();
    while (Date.now() < S.breakUntil && S.isRunning) await sleep(400);
    S.breakUntil = 0;
    S.nextBreakAt = scheduleNextBreak(prof, Date.now());
    if (S.isRunning) logLine("▶ back from break");
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
  async function humanHover(el) {
    const o = pointAt(el);
    el.dispatchEvent(new PointerEvent("pointerover", { ...o, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseover", o));
    el.dispatchEvent(new MouseEvent("mousemove", o));
    await sleep(rand(500, 1100));
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
  // FACEBOOK adapters — all [VERIFIED] live
  // ============================================================
  // -- reels (Mode C) --
  function fbActiveReelContainer() {
    const slider = document.querySelector(
      'div[role="slider"][aria-label="Change Position"]',
    );
    if (!slider) return null;
    let n = slider;
    while (n && n !== document.body) {
      if (
        n.querySelector(
          'div[role="button"][aria-label="Like"], div[role="button"][aria-label="Remove Like"]',
        )
      )
        return n;
      n = n.parentElement;
    }
    return null;
  }
  function fbReelLikeButton(c) {
    return (c || document).querySelector(
      'div[role="button"][aria-label="Like"], div[role="button"][aria-label="Remove Like"]',
    );
  }
  const fbReelIsLiked = (c) => {
    const b = fbReelLikeButton(c);
    return !!b && /remove like/i.test(b.getAttribute("aria-label") || "");
  };
  async function fbSaveReel() {
    const kebab = Array.from(
      document.querySelectorAll(
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
    const item = byRoleName("menuitem", /^save reel/i, menu);
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
    const btn = byRoleName("button", /^follow\b/i, root || document);
    if (!btn || !visible(btn)) return false;
    btn.click();
    await sleep(rand(300, 700));
    return true;
  }
  function fbNextReel() {
    const btn = document.querySelector(
      'div[role="button"][aria-label="Next Card"]',
    );
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
    save: () => fbSaveReel(),
    follow: (c) => fbFollowAuthor(c),
    advance: fbNextReel,
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
  const FB_LOVE_WORDS = [
    "amei",
    "love",
    "me encanta",
    "j’adore",
    "j'adore",
    "adoro",
  ];
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
  // Posts are the direct children of [role="feed"] that carry a like control.
  function fbEnumeratePosts() {
    const feed = document.querySelector('[role="feed"]');
    if (!feed) return [];
    const posts = [];
    for (const child of feed.children) {
      const likeBtn = fbBarLikeBtn(child);
      if (!likeBtn) continue;
      const menuBtn =
        Array.from(child.querySelectorAll('[role="button"][aria-label]')).find(
          (b) => FB_MENU_PREFIX.some((w) => fbAria(b).startsWith(w)),
        ) || null;
      posts.push({
        bar: child,
        root: child,
        likeBtn,
        menuBtn,
        authorKey: fbAuthorKey(child),
        postKey: fbPostKey(child),
      });
    }
    return posts;
  }
  function fbIsSponsored(root) {
    for (const e of root.querySelectorAll("a, span"))
      if ((e.textContent || "").trim() === "Sponsored") return true;
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
    const cb = Array.from(
      p.root.querySelectorAll('[role="button"][aria-label]'),
    ).find((b) => FB_COMMENT_WORDS.includes(fbAria(b)));
    return {
      likes: parseCount(p.likeBtn && p.likeBtn.innerText),
      comments: parseCount(cb && cb.innerText),
    };
  }
  function fbPickPost() {
    for (const p of fbEnumeratePosts()) {
      if (p.postKey && S.seenIds.has(p.postKey)) continue;
      if (!inViewport(p.likeBtn)) continue;
      if (fbIsSponsored(p.root)) {
        if (p.postKey) S.seenIds.add(p.postKey);
        S.skipped++;
        continue;
      }
      return p;
    }
    return null;
  }
  async function fbSavePost(p) {
    if (!p.menuBtn) return false;
    p.menuBtn.click();
    const menu = await waitFor(
      () => document.querySelector('[role="menu"]'),
      3000,
    );
    if (!menu) return false;
    await sleep(rand(200, 500));
    const row = Array.from(
      menu.querySelectorAll('[role="button"], [role="menuitem"]'),
    ).find((r) => /^save (post|video|reel)/i.test((r.innerText || "").trim()));
    if (!row) {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return false;
    }
    row.click();
    const done = await waitFor(() => {
      const b = document.querySelector('[role="button"][aria-label="Done"]');
      return b && b.getBoundingClientRect().width > 0 ? b : null;
    }, 2500);
    if (done) {
      await sleep(rand(300, 600));
      done.click();
      await sleep(rand(300, 600));
    }
    if (
      document.querySelector('[role="dialog"]') ||
      document.querySelector('[role="menu"]')
    )
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    return true;
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
  // Quick partial transcript of the in-view video (background resolves the captured
  // fbcdn audio track → offscreen Whisper, ~12s cap). Empty string on any failure.
  // franc (ISO 639-3) → Whisper language name, for the quick-transcript speed hint.
  // Unknown / undetermined → null (let Whisper auto-detect).
  const WHISPER_LANG = {
    por: "portuguese",
    eng: "english",
    spa: "spanish",
    fra: "french",
    ita: "italian",
    deu: "german",
    nld: "dutch",
    rus: "russian",
    jpn: "japanese",
    kor: "korean",
    cmn: "chinese",
    arb: "arabic",
    hin: "hindi",
    ind: "indonesian",
    tur: "turkish",
  };
  function whisperLangFor(text) {
    const t = (text || "").trim();
    if (t.length < 12) return null;
    return WHISPER_LANG[franc(t, { minLength: 12 })] || null;
  }
  function getQuickTranscript(candidates, lang) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "FBW_QUICK_TRANSCRIBE", candidates, lang },
          (res) => {
            if (chrome.runtime.lastError) return resolve("");
            resolve(res?.text || "");
          },
        );
      } catch {
        resolve("");
      }
    });
  }
  // Numeric media-id candidates from a post — the background intersects them with
  // the fbcdn tracks it captured to target THIS video's audio, not a prefetched
  // neighbour's. Mirrors grabVideoIdCandidates in the transcription content script.
  function fbVideoIdCandidates(root) {
    if (!root) return [];
    const ids = new Set();
    for (const a of root.querySelectorAll("a[href]")) {
      const m = (a.getAttribute("href") || "").match(
        /[?&]v=(\d+)|\/videos\/(\d+)|\/reel\/(\d+)/,
      );
      if (m) ids.add(m[1] || m[2] || m[3]);
    }
    const big = (root.outerHTML || "").match(/\d{15,19}/g);
    if (big) for (const n of big.slice(0, 40)) ids.add(n);
    return Array.from(ids);
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
          platform: S.platform,
          mode: S.mode,
          keyword: S.keyword,
          processed: S.processed,
          liked: S.liked,
          loved: S.loved,
          skipped: S.skipped,
          outcome,
        });
        chrome.storage.local.set({ [HISTORY_KEY]: hist.slice(-50) });
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
    if (isFinite(vid.duration) && vid.duration > 0) {
      frac = watchFraction();
      dwell = commitmentDwellMs(frac, vid.duration, S.pacing.reelDwellMin, S.pacing.reelDwellMax);
      const remaining = Math.max(2000, (vid.duration - vid.currentTime) * 1000);
      dwell = Math.min(dwell, remaining);
    }
    if (dwell == null) dwell = rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    logLine(
      `▶ watching video ~${Math.round(dwell / 1000)}s${frac != null ? ` (${Math.round(frac * 100)}%)` : ""}`,
    );
    const t0 = Date.now();
    while (Date.now() - t0 < dwell && S.isRunning && !S.isPaused)
      await sleep(400);
  }

  // Plain Like via a synthetic pointer sequence (not bare el.click()).
  async function fbReactLike(p) {
    const btn = fbBarLikeBtn(p.root);
    if (!btn) return false;
    await humanClick(btn);
    await sleep(rand(300, 600));
    return fbIsLikedBtn(fbBarLikeBtn(p.root));
  }
  // Love (❤️): hover the like control to open the reaction picker, click "Amei".
  // Falls back to a plain Like if the picker doesn't surface.
  async function fbReactLove(p) {
    const btn = fbBarLikeBtn(p.root);
    if (!btn) return false;
    await humanHover(btn);
    const love = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('[role="button"][aria-label]'),
        ).find((b) => {
          const r = b.getBoundingClientRect();
          return (
            FB_LOVE_WORDS.includes(fbAria(b)) &&
            r.width > 0 &&
            r.width < 80 &&
            r.height > 0
          );
        }),
      2500,
    );
    if (!love) {
      await humanClick(btn);
      await sleep(rand(300, 600));
      return fbIsLikedBtn(fbBarLikeBtn(p.root));
    }
    await humanClick(love);
    await sleep(rand(400, 800));
    return fbIsLikedBtn(fbBarLikeBtn(p.root));
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
          `· no action — below threshold (${st.likes} likes / ${st.comments} comments)`,
        );
        return;
      }
    }
    if (!S.actions.like) return;

    // Warm-up: lurk the first few posts of a session, no actions.
    if (S.processed < S.warmupPosts) {
      logLine(`· warm-up browse (${S.processed + 1}/${S.warmupPosts})`);
      return;
    }

    const per = persona();
    if (Math.random() >= per.engageChance) {
      logLine(
        `· browsed only (engage dice ${Math.round(per.engageChance * 100)}%)`,
      );
      return;
    }

    // Build the relevance text: caption, optionally + a quick video transcript.
    let relText = fbGetPostText(p.root);
    if (S.deepRelevance && p.root.querySelector("video")) {
      const tx = await getQuickTranscript(
        fbVideoIdCandidates(p.root),
        whisperLangFor(relText),
      );
      if (tx) {
        relText = (relText + " " + tx).trim();
        logLine(`· +transcript (${tx.length}c)`);
      }
    }

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
        logLine(`· spam/scam, skip (spam ${spam.toFixed(2)})`);
        return;
      }
      if (S.relevanceMin > 0 && (S.keyword || "").trim()) {
        if (score >= S.relevanceMin) {
          likeChance = Math.min(
            1,
            per.likeChance * (1 + (score - S.relevanceMin) * 2),
          );
          logLine(
            `· on-niche (rel ${score.toFixed(2)}) → like ${Math.round(likeChance * 100)}%`,
          );
        } else {
          likeChance =
            per.likeChance * Math.max(0.05, score / S.relevanceMin) * 0.3;
          logLine(
            `· off-niche (rel ${score.toFixed(2)}) → like ${Math.round(likeChance * 100)}%`,
          );
        }
      }
    }
    if (Math.random() >= likeChance) {
      logLine(`· no react (dice ${Math.round(likeChance * 100)}%)`);
      return;
    }
    if (fbIsLikedBtn(p.likeBtn)) {
      logLine("· already reacted");
      return;
    }

    // Safety caps.
    if (S.consecLikes >= MAX_CONSEC_LIKES) {
      S.consecLikes = 0;
      logLine("· react cooldown");
      await sleep(rand(2000, 4000));
      return;
    }
    const nowT = Date.now();
    S.likeTimes = S.likeTimes.filter((t) => nowT - t < 3600000);
    if (S.likeTimes.length >= MAX_LIKES_PER_HOUR) {
      logLine("· hourly react cap — skipping");
      return;
    }
    if (
      p.authorKey &&
      (S.authorLikes[p.authorKey] || 0) >= MAX_LIKES_PER_AUTHOR
    ) {
      logLine("· per-author cap — skip");
      return;
    }

    // Read-before-react: a human watches, then decides.
    await sleep(rand(900, 2500));

    const useLove = Math.random() < LOVE_REACTION_CHANCE;
    const ok = await (useLove ? fbReactLove(p) : fbReactLike(p));
    if (ok) {
      S.consecLikes++;
      S.likeTimes.push(Date.now());
      S.softFailStreak = 0;
      if (useLove) S.loved++;
      else S.liked++;
      if (p.authorKey)
        S.authorLikes[p.authorKey] = (S.authorLikes[p.authorKey] || 0) + 1;
      logLine(useLove ? "❤️ loved post" : "👍 liked post");
    } else {
      S.softFailStreak++;
      logLine(
        `· reaction did not register (${S.softFailStreak}/${SOFT_FAIL_LIMIT})`,
      );
      if (S.softFailStreak >= SOFT_FAIL_LIMIT)
        halt("possible soft-block — reactions not registering");
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
      ac.transcribe && "transcribe",
      ac.download && "download",
      ac.favorite && "save",
    ]
      .filter(Boolean)
      .join("+");
    logLine(`⭐ auto-capture (👍${st.likes} 💬${st.comments}) → ${acts}`);
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
      `📜 ${label} run started (until ${new Date(S.willEndAt).toTimeString().slice(0, 5)}, warm-up ${S.warmupPosts})`,
    );
    await loadSeen(); // merge cross-session dedup set
    // Preload the relevance model so the first scored post doesn't stall mid-run.
    if (S.relevanceMin > 0 || S.spamGuard)
      getRelevanceInfo(S.keyword, "warming up niche model", S.spamGuard).catch(
        () => {},
      );
    let emptyScrolls = 0;
    try {
      while (shouldContinue(S)) {
        await waitWhilePaused();
        await maybeBreak();
        if (!S.isRunning) break;
        if (detectStop()) return halt(detectStop());

        const p = fbPickPost();
        if (!p) {
          humanScroll();
          await sleep(rand(1200, 2600));
          if (++emptyScrolls > 10) {
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
          logLine("· skip (non-English)");
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
  async function doVideoActions(A, c) {
    const per = persona();
    if (S.actions.save) {
      const ok = await A.save(c);
      if (ok) {
        S.saved++;
        logLine(`🔖 saved ${A.noun}`);
      } else logLine(`· save ${A.noun}: already saved / unavailable`);
      await sleep(rand(500, 1200));
    }
    if (S.actions.like && Math.random() < per.likeChance) {
      if (S.consecLikes >= MAX_CONSEC_LIKES) {
        S.consecLikes = 0;
        logLine("· like cooldown");
        await sleep(rand(2000, 4000));
      } else if (!A.isLiked(c)) {
        const btn = A.likeBtn(c);
        if (btn) {
          btn.click();
          await sleep(rand(250, 500));
          if (A.isLiked(c)) {
            S.liked++;
            S.consecLikes++;
            logLine(`❤️ liked ${A.noun}`);
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
        logLine("➕ followed author");
      }
    }
  }

  async function videoLoop(A) {
    if (S.loopActive) return;
    S.loopActive = true;
    logLine(
      `${A.emoji || "🎞️"} ${A.label} run started (until ${new Date(S.willEndAt).toTimeString().slice(0, 5)})`,
    );
    let emptyScrolls = 0,
      endStreak = 0;
    try {
      if (A.preLoop) await A.preLoop();
      while (shouldContinue(S)) {
        await waitWhilePaused();
        await maybeBreak();
        if (!S.isRunning) break;
        if (detectStop()) return halt(detectStop());

        const c = A.getContainer();
        if (!c) {
          if (A.scrollWhenEmpty) {
            humanScroll();
            await sleep(rand(1200, 2600));
            if (++emptyScrolls > EMPTY_SCROLL_LIMIT) {
              halt("no videos found");
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
          logLine(`· skip (${A.skipReason || "non-standard"})`);
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

        await reelDwell();
        if (!S.isRunning || S.isPaused) continue;
        await doVideoActions(A, c);
        S.processed++;
        logLine(`✓ ${A.noun} ${S.processed}${S.maxItems ? `/${S.maxItems}` : ""}`);
        persist();
        if (!shouldContinue(S)) break;

        if ((A.isEnd && A.isEnd()) || !A.advance()) {
          if (A.onEnd && endStreak < 2) {
            endStreak++;
            logLine("↻ end of results — refreshing");
            await A.onEnd();
            return;
          }
          logLine("⚠️ cannot advance — ending");
          break;
        }
        endStreak = 0;
        await actionGap();
      }
      if (S.isRunning) finishRun();
    } finally {
      S.loopActive = false;
    }
  }

  function finishRun() {
    logLine(
      `✅ run complete — processed ${S.processed}, liked ${S.liked}, loved ${S.loved}, skipped ${S.skipped}`,
    );
    S.isRunning = false;
    clearInterval(S.tickTimer);
    logHistory("complete");
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
      logLine("⚠️ unsupported host — nothing to run");
      S.isRunning = false;
      persist();
    }
  }

  // ---------- reel-thumbnail harvest (profile reels_tab) ----------
  // Thumbs are plain <img> tags inside a[href*="/reel/"] grid cards; the grid
  // lazy-loads on scroll, so scroll to the bottom until no new reels appear.
  async function collectReelThumbs() {
    const found = new Map();
    const harvest = () => {
      for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
        const m = (a.getAttribute("href") || "").match(/\/reel\/(\d+)/);
        const img = a.querySelector("img");
        if (m && img && img.src) found.set(m[1], img.src);
      }
    };
    harvest();
    let stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      const before = found.size;
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      await sleep(1500);
      harvest();
      stable = found.size === before ? stable + 1 : 0;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    return Array.from(found, ([id, url]) => ({ id, url }));
  }

  // Profile-header info so the panel can show WHAT is being downloaded.
  // The page avatar is the svg whose aria-label equals the page name; the FIRST
  // svg image in the DOM is the logged-in user's own nav avatar ("Your profile").
  function fbPageInfo() {
    const name =
      (document.querySelector("h1")?.textContent || "").trim() ||
      document.title;
    const links = Array.from(document.querySelectorAll("a"));
    const txt = (a) => (a.textContent || "").trim();
    const followers =
      txt(
        links.find((a) => /\bfollowers\b/i.test(txt(a)) && /\d/.test(txt(a))) ||
          {},
      ) || null;
    const following =
      txt(
        links.find((a) => /\bfollowing\b/i.test(txt(a)) && /\d/.test(txt(a))) ||
          {},
      ) || null;
    const svgs = Array.from(
      document.querySelectorAll('svg[role="img"][aria-label]'),
    ).filter((s) => s.querySelector("image"));
    const bySize = (a, b) => (b.clientWidth || 0) - (a.clientWidth || 0);
    const svg =
      svgs.find((s) => (s.getAttribute("aria-label") || "").trim() === name) ||
      svgs
        .filter(
          (s) => !/your profile/i.test(s.getAttribute("aria-label") || ""),
        )
        .sort(bySize)[0];
    const im = svg && svg.querySelector("image");
    const avatar = im
      ? im.getAttribute("xlink:href") || im.getAttribute("href")
      : null;
    return { name, followers, following, avatar, url: location.href };
  }

  function tick() {
    if (!S.isRunning || S.isPaused) return;
    if (Date.now() - S.lastPersistAt > 30000) persist();
    if (detectStop()) {
      halt(detectStop());
      return;
    }
    if (S.willEndAt && Date.now() >= S.willEndAt) {
      logLine("⏲ session time cap reached");
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
    S.englishOnly = !!settings.englishOnly;
    S.relevanceMin = Math.max(0, Number(settings.relevanceMin) || 0);
    S.spamGuard = settings.spamGuard !== false; // default on
    S.deepRelevance = !!settings.deepRelevance;
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

    logLine(
      `▶️ ${S.platform} · mode ${S.mode}${S.keyword ? ` "${S.keyword}"` : ""} · ${durationMin}m${S.maxItems ? ` · cap ${S.maxItems}` : ""} · ${
        Object.entries(S.actions)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join("+") || "observe"
      } · ${persona().name}`,
    );
    persist();

    const target = targetUrlForMode();
    if (target) {
      logLine(`↪ navigating to target surface`);
      location.assign(target);
      return;
    }
    runEngine();
    S.tickTimer = setInterval(tick, 1000);
  }

  function stop() {
    logLine("⏹ stopped by user");
    S.isRunning = false;
    S.isPaused = false;
    clearInterval(S.tickTimer);
    logHistory("stopped");
    persist();
  }
  function togglePause() {
    S.isPaused = !S.isPaused;
    logLine(S.isPaused ? "⏸ paused" : "▶️ resumed");
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
      case "FBW_PAGE_INFO":
        try {
          sendResponse({ ok: true, info: fbPageInfo() });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
        return true;
      case "FBW_COLLECT_REEL_THUMBS":
        collectReelThumbs()
          .then((thumbs) => sendResponse({ ok: true, thumbs }))
          .catch((e) =>
            sendResponse({ ok: false, error: String(e?.message || e) }),
          );
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
        chrome.storage.local.set({ [STORAGE_KEY]: { isRunning: false } });
        return;
      }
      Object.assign(S, freshState(), {
        isRunning: true,
        isPaused: !!saved.isPaused,
        startedAt: saved.startedAt || Date.now(),
        willEndAt: saved.willEndAt || 0,
        breakUntil: saved.breakUntil > Date.now() ? saved.breakUntil : 0,
        nextBreakAt: saved.nextBreakAt || 0,
        platform: saved.platform || here,
        mode: saved.mode || "C",
        keyword: saved.keyword || "",
        maxItems: saved.maxItems || 0,
        actions: saved.actions || { save: true, like: true, follow: false },
        englishOnly: !!saved.englishOnly,
        relevanceMin: saved.relevanceMin || 0,
        spamGuard: saved.spamGuard !== false,
        deepRelevance: !!saved.deepRelevance,
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
      });
      if (!S.personalityMode) pickPersonality();
      if (!S.nextBreakAt || S.nextBreakAt < Date.now())
        S.nextBreakAt = scheduleNextBreak(BREAKS[S.personalityMode], Date.now());

      const target = targetUrlForMode();
      if (target) {
        logLine("↪ resuming — navigating to target surface");
        persist();
        location.assign(target);
        return;
      }
      logLine("🔄 resumed run on " + pageSurface());
      runEngine();
      S.tickTimer = setInterval(tick, 1000);
    } catch (e) {
      /* ignore */
    }
  })();
})();
