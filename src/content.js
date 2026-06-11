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
    BINGE:   { name: "Binge Watcher",   likeChance: 0.15, followChance: 0.04, engageChance: 0.25 },
    CASUAL:  { name: "Casual Scroller", likeChance: 0.35, followChance: 0.08, engageChance: 0.40 },
    ENGAGED: { name: "Engaged User",    likeChance: 0.60, followChance: 0.15, engageChance: 0.65 },
  };

  const STORAGE_KEY = "fbw_session";
  const MISS_LIMIT = 6;          // consecutive selector misses → halt
  const EMPTY_SCROLL_LIMIT = 14; // feed scrolls with no actionable video → halt
  const MAX_CONSEC_LIKES = 8;    // cap likes-in-a-row, then cool down (safety)
  const MAX_CONSEC_FOLLOWS = 5;
  const LOG_CAP = 120;

  function freshState() {
    return {
      isRunning: false,
      isPaused: false,
      startedAt: 0,
      willEndAt: 0,
      // run config (persisted so a navigation/reload can resume the run)
      platform: "facebook",
      mode: "C",
      keyword: "",
      targetN: 10,
      actions: { save: true, like: true, follow: false },
      englishOnly: false,
      thresholds: { minLikes: 0, minComments: 0 },
      pacing: { minDelay: 4000, maxDelay: 9000, reelDwellMin: 6000, reelDwellMax: 15000, scrollMin: 300, scrollMax: 750 },
      personalityMode: null,
      userSelectedPersonality: null,
      // counters
      processed: 0,
      saved: 0,
      liked: 0,
      followed: 0,
      skipped: 0,
      // safety
      haltReason: null,
      missStreak: 0,
      consecLikes: 0,
      consecFollows: 0,
      // log ring buffer
      log: [],
      // runtime-only
      tickTimer: null,
      loopActive: false,
      seen: new WeakSet(),
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
    if (S.userSelectedPersonality) S.personalityMode = S.userSelectedPersonality;
    else {
      const keys = Object.keys(PERSONALITIES);
      S.personalityMode = keys[Math.floor(Math.random() * keys.length)];
    }
    return PERSONALITIES[S.personalityMode];
  }
  const persona = () => PERSONALITIES[S.personalityMode] || pickPersonality();

  // ---------- persistence ----------
  function persist() {
    try {
      chrome.storage?.local?.set({
        [STORAGE_KEY]: {
          host: location.hostname, platform: S.platform,
          isRunning: S.isRunning, isPaused: S.isPaused,
          startedAt: S.startedAt, willEndAt: S.willEndAt,
          mode: S.mode, keyword: S.keyword, targetN: S.targetN,
          actions: S.actions, englishOnly: S.englishOnly, pacing: S.pacing, thresholds: S.thresholds,
          personalityMode: S.personalityMode, userSelectedPersonality: S.userSelectedPersonality,
          processed: S.processed, saved: S.saved, liked: S.liked, followed: S.followed, skipped: S.skipped,
          haltReason: S.haltReason, log: S.log.slice(-LOG_CAP), savedAt: Date.now(),
        },
      });
    } catch (e) { /* context invalidated on reload */ }
  }

  function snapshot() {
    const now = Date.now();
    return {
      isRunning: S.isRunning, isPaused: S.isPaused,
      platform: S.platform, mode: S.mode, keyword: S.keyword, targetN: S.targetN,
      etaMs: S.willEndAt ? Math.max(0, S.willEndAt - now) : 0,
      processed: S.processed, saved: S.saved, liked: S.liked, followed: S.followed, skipped: S.skipped,
      personality: S.personalityMode ? PERSONALITIES[S.personalityMode].name : null,
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
    if (/are you a robot|confirm your identity|prove you'?re human|enter the characters you see/.test(body))
      return "captcha";
    const p = platformForHost();
    if (p === "facebook") {
      if (url.includes("/checkpoint")) return "checkpoint";
      if (document.querySelector('input[name="email"]') && document.querySelector('input[name="pass"]'))
        return "login wall";
      if (/you'?re temporarily blocked|going too fast|try again later|temporarily restricted|suspicious activity/.test(body))
        return "rate-limit/block";
    } else if (p === "instagram") {
      if (url.includes("/challenge") || url.includes("/accounts/suspended")) return "checkpoint";
      if (document.querySelector('input[name="username"]') && document.querySelector('input[name="password"]'))
        return "login wall";
      if (/we restrict certain activity|action blocked|try again later|please wait a few minutes|suspicious/.test(body))
        return "rate-limit/block";
    } else if (p === "tiktok") {
      if (url.includes("/login")) return "login wall";
      if (/too many attempts|verify to continue|you'?re tapping too fast|something went wrong, tap to retry/.test(body))
        return "rate-limit/block";
    }
    return null;
  }

  function halt(reason) {
    S.haltReason = reason;
    S.isRunning = false;
    logLine(`🛑 HALTED: ${reason}`);
    clearInterval(S.tickTimer);
    persist();
  }

  function note(found) {
    if (found) S.missStreak = 0;
    else { S.missStreak += 1; if (S.missStreak >= MISS_LIMIT) halt("selectors not found"); }
    return found;
  }

  // ============================================================
  // ARIA helpers — roles + accessible names, never classes
  // ============================================================
  function byRoleName(role, nameRe, root = document) {
    return Array.from(root.querySelectorAll(`[role="${role}"]`))
      .find((el) => nameRe.test((el.getAttribute("aria-label") || el.innerText || "").trim()));
  }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  async function waitFor(fn, timeout = 4000, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }
  // climb from a node to the enclosing clickable button/role=button (≤limit hops)
  function clickableAncestor(node, stopAt, limit = 8) {
    let n = node;
    for (let i = 0; n && n !== stopAt && i < limit; i++) {
      if (n.getAttribute && (n.getAttribute("role") === "button" || n.tagName === "BUTTON")) return n;
      n = n.parentElement;
    }
    return node;
  }

  // ============================================================
  // pacing
  // ============================================================
  const actionGap = () => sleep(rand(S.pacing.minDelay, S.pacing.maxDelay));
  const reelDwell = () => sleep(rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax));
  async function waitWhilePaused() {
    while (S.isRunning && S.isPaused) await sleep(500);
  }
  function humanScroll() {
    const by = rand(S.pacing.scrollMin, S.pacing.scrollMax);
    window.scrollBy({ top: by, left: 0, behavior: "smooth" });
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 20)
      window.scrollTo({ top: Math.max(0, window.scrollY - rand(300, 900)), behavior: "smooth" });
  }
  const centerInViewport = (el) => el.scrollIntoView({ behavior: "smooth", block: "center" });
  // A few small scroll steps with pauses — reads as a human skimming the feed.
  async function scrollBurst(min, max) {
    const steps = rand(min, max);
    for (let i = 0; i < steps && S.isRunning && !S.isPaused; i++) {
      humanScroll();
      await sleep(rand(800, 2000));
    }
  }

  // ============================================================
  // FACEBOOK adapters — all [VERIFIED] live
  // ============================================================
  // -- reels (Mode C) --
  function fbActiveReelContainer() {
    const slider = document.querySelector('div[role="slider"][aria-label="Change Position"]');
    if (!slider) return null;
    let n = slider;
    while (n && n !== document.body) {
      if (n.querySelector('div[role="button"][aria-label="Like"], div[role="button"][aria-label="Remove Like"]')) return n;
      n = n.parentElement;
    }
    return null;
  }
  function fbReelLikeButton(c) {
    return (c || document).querySelector('div[role="button"][aria-label="Like"], div[role="button"][aria-label="Remove Like"]');
  }
  const fbReelIsLiked = (c) => {
    const b = fbReelLikeButton(c);
    return !!b && /remove like/i.test(b.getAttribute("aria-label") || "");
  };
  async function fbSaveReel() {
    const kebab = Array.from(document.querySelectorAll('[role="button"][aria-label="Menu"][aria-haspopup="menu"]')).find(visible);
    if (!kebab) return false;
    kebab.click();
    const menu = await waitFor(() => document.querySelector('[role="menu"]'), 3000);
    if (!menu) return false;
    await sleep(rand(200, 500));
    const item = byRoleName("menuitem", /^save reel/i, menu);
    if (!item) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false; // already saved or unavailable → don't count
    }
    item.click();
    await sleep(rand(400, 800));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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
    const btn = document.querySelector('div[role="button"][aria-label="Next Card"]');
    if (btn) { btn.click(); return true; }
    return false;
  }

  const FB_VIDEO = {
    label: "reels", noun: "reel", emoji: "🎞️",
    getContainer: fbActiveReelContainer,
    likeBtn: fbReelLikeButton,
    isLiked: fbReelIsLiked,
    save: () => fbSaveReel(),
    follow: (c) => fbFollowAuthor(c),
    advance: fbNextReel,
  };

  // -- feed / search posts (Modes B, A) -- [VERIFIED]
  // Already-liked posts swap aria-label "Like" → "Remove Like" + "Change Like reaction",
  // so the bar-walk must accept all three or it climbs into a container holding a
  // DIFFERENT post's Like button (wrong bar, wrong likeBtn, like lands on wrong post).
  const FB_LIKEISH = '[role="button"][aria-label="Like"], [role="button"][aria-label="Remove Like"], [role="button"][aria-label="Change Like reaction"]';
  function fbEnumeratePosts() {
    const commentBtns = Array.from(document.querySelectorAll('[role="button"][aria-label="Leave a comment"]'));
    const posts = [];
    for (const cb of commentBtns) {
      let bar = cb, d = 0;
      while (bar && bar !== document.body && d < 8) {
        if (bar.querySelector(FB_LIKEISH) && bar.querySelector('[aria-label^="Send this to friends"]')) break;
        bar = bar.parentElement; d++;
      }
      if (!bar || bar === document.body) continue;
      let root = bar, rd = 0, menuBtn = null;
      while (root && root !== document.body && rd < 20) {
        const m = root.querySelector('[role="button"][aria-label^="Actions for this post"]');
        if (m) { menuBtn = m; break; }
        root = root.parentElement; rd++;
      }
      const likeBtn = bar.querySelector(FB_LIKEISH);
      if (!likeBtn) continue;
      posts.push({ bar, root: root || bar, likeBtn, menuBtn });
    }
    return posts;
  }
  function fbIsSponsored(root) {
    for (const e of root.querySelectorAll("a, span")) if ((e.textContent || "").trim() === "Sponsored") return true;
    return false;
  }
  function fbGetPostText(root) {
    const msg = root.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
    if (msg && (msg.innerText || "").trim()) return msg.innerText.trim();
    let best = "";
    for (const el of root.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      const t = (el.innerText || "").trim();
      if (t.length > best.length) best = t;
    }
    return best;
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top >= 60 && r.top < window.innerHeight - 120;
  }
  // Engagement counts live as innerText on the action-bar buttons themselves:
  // like button = total reactions ("1.7K"), comment button = comments ("2.4K").
  function parseCount(t) {
    const m = String(t || "").trim().replace(/,/g, "").match(/^([\d.]+)\s*([KM])?$/i);
    if (!m) return 0;
    const mult = /k/i.test(m[2] || "") ? 1e3 : /m/i.test(m[2] || "") ? 1e6 : 1;
    return Math.round(parseFloat(m[1]) * mult);
  }
  function fbPostStats(p) {
    const cb = p.bar.querySelector('[role="button"][aria-label="Leave a comment"]');
    return { likes: parseCount(p.likeBtn && p.likeBtn.innerText), comments: parseCount(cb && cb.innerText) };
  }
  function fbPickPost() {
    for (const p of fbEnumeratePosts()) {
      if (S.seen.has(p.bar)) continue;
      if (!inViewport(p.likeBtn)) continue;
      if (fbIsSponsored(p.root)) { S.seen.add(p.bar); S.skipped++; continue; }
      return p;
    }
    return null;
  }
  async function fbSavePost(p) {
    if (!p.menuBtn) return false;
    p.menuBtn.click();
    const menu = await waitFor(() => document.querySelector('[role="menu"]'), 3000);
    if (!menu) return false;
    await sleep(rand(200, 500));
    const row = Array.from(menu.querySelectorAll('[role="button"], [role="menuitem"]'))
      .find((r) => /^save (post|video|reel)/i.test((r.innerText || "").trim()));
    if (!row) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false;
    }
    row.click();
    const done = await waitFor(() => {
      const b = document.querySelector('[role="button"][aria-label="Done"]');
      return b && b.getBoundingClientRect().width > 0 ? b : null;
    }, 2500);
    if (done) { await sleep(rand(300, 600)); done.click(); await sleep(rand(300, 600)); }
    if (document.querySelector('[role="dialog"]') || document.querySelector('[role="menu"]'))
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  }

  // Heuristic English detection — rejects Arabic / Burmese / CJK / Cyrillic / etc.
  function isEnglish(text) {
    if (!text || text.length < 8) return false;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const nonLatin = (text.match(/[Ͱ-ϿЀ-ӿ֐-׿؀-ۿ܀-ݏऀ-ॿ฀-๿က-႟぀-ヿ㐀-鿿가-힯]/g) || []).length;
    if (latin === 0) return false;
    if (nonLatin > latin * 0.25) return false;
    const stop = /\b(the|and|you|your|for|are|with|this|that|have|will|from|what|when|how|our|out|about|into|reading|love|today|free|message|dm)\b/i;
    return latin >= 12 && (stop.test(text) || latin / (latin + nonLatin) > 0.9);
  }

  // Center the post so its video fits the viewport, then dwell. FB autoplays
  // the video nearest viewport center, so centering is what starts playback.
  async function fbWatchPost(p) {
    const vid = p.root.querySelector("video");
    centerInViewport(vid || p.likeBtn);
    await sleep(rand(700, 1400));
    if (!vid) { await sleep(rand(S.pacing.minDelay, S.pacing.maxDelay)); return; }
    // FB doesn't restart ended feed videos on its own; muted play() is allowed
    // and rewinds an ended video to the start.
    if (vid.paused) { try { await vid.play(); } catch { /* ignore */ } await sleep(300); }
    let dwell = rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    if (isFinite(vid.duration) && vid.duration > 0) {
      const remaining = Math.max(2000, (vid.duration - vid.currentTime) * 1000);
      dwell = Math.min(dwell, remaining);
    }
    logLine(`▶ watching video ~${Math.round(dwell / 1000)}s`);
    const t0 = Date.now();
    while (Date.now() - t0 < dwell && S.isRunning && !S.isPaused) await sleep(400);
  }

  async function fbDoPostActions(p) {
    const th = S.thresholds || {};
    if (th.minLikes || th.minComments) {
      const st = fbPostStats(p);
      if ((th.minLikes && st.likes < th.minLikes) || (th.minComments && st.comments < th.minComments)) {
        logLine(`· no action — below threshold (${st.likes} likes / ${st.comments} comments)`);
        return;
      }
    }
    const per = persona();
    if (Math.random() >= per.engageChance) {
      logLine(`· browsed only (engage dice ${Math.round(per.engageChance * 100)}%)`);
      return;
    }
    if (S.actions.save) {
      const ok = await fbSavePost(p);
      if (ok) { S.saved++; logLine("🔖 saved post"); }
      else logLine("· save post: did not register (FB menu)");
      await sleep(rand(500, 1200));
    }
    if (S.actions.like) {
      if (S.consecLikes >= MAX_CONSEC_LIKES) {
        S.consecLikes = 0; logLine("· like cooldown"); await sleep(rand(2000, 4000));
      } else if (Math.random() >= per.likeChance) {
        logLine(`· like skipped (persona dice ${Math.round(per.likeChance * 100)}%)`);
      } else {
        const label = (p.likeBtn.getAttribute("aria-label") || "").trim();
        if (/^(remove like|change like reaction)$/i.test(label)) {
          logLine("· already liked");
        } else if (label.toLowerCase() === "like") {
          p.likeBtn.click(); await sleep(rand(300, 600));
          if ((p.likeBtn.getAttribute("aria-label") || "").trim().toLowerCase() !== "like") { S.liked++; S.consecLikes++; logLine("❤️ liked post"); }
          else logLine("· like click did not register");
        } else {
          logLine(`· like button unrecognized ("${label}")`);
        }
      }
    }
    if (S.actions.follow && S.consecFollows < MAX_CONSEC_FOLLOWS && Math.random() < per.followChance) {
      if (await fbFollowAuthor(p.root)) { S.followed++; S.consecFollows++; logLine("➕ followed author"); }
    }
  }

  async function postsLoop(label) {
    if (S.loopActive) return;
    S.loopActive = true;
    logLine(`📜 ${label} run started (target ${S.targetN})`);
    let emptyScrolls = 0;
    try {
      while (S.isRunning && S.processed < S.targetN) {
        await waitWhilePaused();
        if (!S.isRunning) break;
        if (detectStop()) return halt(detectStop());

        const p = fbPickPost();
        if (!p) {
          humanScroll();
          await sleep(rand(1200, 2600));
          if (++emptyScrolls > 10) { note(false); if (!S.isRunning) break; }
          continue;
        }
        emptyScrolls = 0; note(true);
        S.seen.add(p.bar);
        if (S.englishOnly && !isEnglish(fbGetPostText(p.root))) {
          S.skipped++; logLine("· skip (non-English)"); persist();
          humanScroll(); await sleep(rand(900, 1800)); continue;
        }
        await fbWatchPost(p);
        if (!S.isRunning || S.isPaused) continue;
        await fbDoPostActions(p);
        S.processed++;
        logLine(`✓ post ${S.processed}/${S.targetN}`);
        persist();
        await actionGap();
        await scrollBurst(1, 3);
      }
      if (S.isRunning) finishRun();
    } finally { S.loopActive = false; }
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
    nextReel: ["navigate to next reel", "navegar para o próximo reel", "navegar al siguiente reel"],
    pressPlay: ["press to play", "pressionar para reproduzir", "pulsa para reproducir"],
  };
  const nameOf = (el) => (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
  const inSet = (el, set) => set.includes(nameOf(el));
  const findByName = (root, sel, set) =>
    Array.from((root || document).querySelectorAll(sel)).find((el) => set.includes(nameOf(el)));

  // INSTAGRAM adapters — reels like/save/follow/advance [VERIFIED live: pt-br + en].
  // ============================================================
  function igActiveVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) return null;
    if (vids.length === 1) return vids[0];
    for (const v of vids) if (!v.paused && v.currentTime > 0) return v;
    const cy = window.innerHeight / 2;
    let best = null, bd = Infinity;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.height <= 0) continue;
      const d = Math.abs(r.top + r.height / 2 - cy);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  // like svg = aria-label in the like OR unlike set (localized)
  function igLikeSvg(root) {
    return Array.from((root || document).querySelectorAll('svg[role="img"][aria-label]'))
      .find((s) => inSet(s, L.like) || inSet(s, L.unlike));
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
  const igIsLiked = (c) => { const s = igLikeSvg(c); return !!s && inSet(s, L.unlike); };
  function igNextReel() {
    const b = findByName(document, 'div[role="button"][aria-label]', L.nextReel);
    if (b) { b.click(); return true; }
    const ctr = document.querySelector('[aria-label="Reels navigation controls"]');
    if (ctr) { const bs = ctr.querySelectorAll('div[role="button"]'); if (bs.length >= 2) { bs[1].click(); return true; } }
    return false;
  }
  function igResume() {
    const p = findByName(document, 'div[role="button"][aria-label]', L.pressPlay);
    if (p) { p.click(); return true; }
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
    const btn = Array.from(root.querySelectorAll('button, [role="button"]'))
      .find((x) => inSet(x, L.follow) && visible(x));
    if (!btn) return false;
    btn.click();
    await sleep(rand(400, 800));
    return true;
  }

  const IG_REELS = {
    label: "reels", noun: "reel", emoji: "🎞️",
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
    label: "explore", noun: "reel", emoji: "🧭",
    getContainer: igContainer,
    likeBtn: igLikeBtn,
    isLiked: igIsLiked,
    save: (c) => igSave(c),
    follow: (c) => igFollow(c),
    advance: () => { humanScroll(); return true; },
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
      const a = v.closest('article[data-e2e="recommend-list-item-container"]') || v.closest("article");
      if (a) return a;
    }
    const list = Array.from(document.querySelectorAll('article[data-e2e="recommend-list-item-container"], [class*="DivPlayerContainer"]'));
    if (!list.length) return null;
    const cx = innerWidth / 2, cy = innerHeight / 2;
    let best = null, bd = Infinity;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const d = (r.left + r.width / 2 - cx) ** 2 + (r.top + r.height / 2 - cy) ** 2;
      if (d < bd) { bd = d; best = el; }
    }
    return best;
  }
  // TikTok action hooks are language-independent data-e2e. Feed (For You) uses
  // *-icon / feed-follow; video detail (search) uses browse-*.
  function ttLikeBtn(c) {
    const root = c || document;
    const icon = root.querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"]');
    if (icon) return icon.closest("button, [role=button]") || icon;
    return root.querySelector('button[data-e2e="browse-like"]');
  }
  // liked when the like icon tints red (≈#fe2c55) — language-independent
  const ttIsLiked = (c) => {
    const span = (c || document).querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"]');
    if (span) { const m = getComputedStyle(span).color.match(/\d+/g); if (m && +m[0] > 200 && +m[1] < 90 && +m[2] < 120) return true; }
    return ttLikeBtn(c)?.getAttribute("aria-pressed") === "true";
  };
  function ttIsLive(c) {
    const badge = (c || document).querySelector('span[class*="SpanLiveBadge"]');
    return !!badge && /live/i.test(badge.textContent || "");
  }
  function ttAdvance() {
    const arrow = document.querySelector('button[data-e2e="arrow-right"], button[aria-label*="next video" i]');
    if (arrow && !arrow.disabled) { arrow.click(); return true; }
    const items = document.getElementsByClassName("TUXButton--secondary action-item");
    if (items && items.length) {
      const t = items[items.length - 1];
      if (t && !t.disabled && t.getAttribute("aria-disabled") !== "true") { t.click(); return true; }
    }
    return false;
  }
  // TikTok favorite (bookmark): favorite-icon (feed) / browse-favorite (detail).
  // [VERIFIED selectors live; persistence needs a logged-in TikTok session.]
  async function ttSave(c) {
    const root = c || document;
    const icon = root.querySelector('[data-e2e="favorite-icon"], [data-e2e="browse-favorite-icon"]');
    const btn = icon ? icon.closest("button, [role=button]") : root.querySelector('button[data-e2e="browse-favorite"]');
    if (!btn) return false;
    btn.click();
    await sleep(rand(400, 800));
    return true; // VERIFIED: favorite count increments on click
  }
  // TikTok follow: feed-follow (feed) / browse-follow (detail). Icon morphs +↔✓. [VERIFIED]
  async function ttFollow(c) {
    const root = c || document;
    const btn = root.querySelector('button[data-e2e="feed-follow"], button[data-e2e="browse-follow"]');
    if (!btn || !visible(btn)) return false;
    btn.click();
    await sleep(rand(400, 800));
    return true;
  }

  const TT_FORYOU = {
    label: "for-you", noun: "video", emoji: "🎵",
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
    const tiles = Array.from(document.querySelectorAll('[id*="column-item-video-container"] a[href*="/video/"], a[href*="/video/"]'));
    const tile = tiles.find(visible) || tiles[0];
    if (!tile) return false;
    tile.click();
    return true;
  }
  function ttSearchEnded() {
    const noMore = document.querySelector('[class*="DivNoMoreResultsContainer"]');
    return !!noMore && /no more results/i.test(noMore.textContent || "");
  }
  const TT_SEARCH = {
    label: "search", noun: "video", emoji: "🔎",
    getContainer: () => (document.querySelector('button[data-e2e="browse-like"]') ? document : null),
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
        if (ttOpenFirstResult()) { await sleep(rand(1500, 2500)); }
      }
    },
    isEnd: ttSearchEnded,
    async onEnd() { persist(); await sleep(1500); location.reload(); },
  };

  // ============================================================
  // generic video/reel loop (used by FB reels, IG, TikTok)
  // ============================================================
  async function doVideoActions(A, c) {
    const per = persona();
    if (S.actions.save) {
      const ok = await A.save(c);
      if (ok) { S.saved++; logLine(`🔖 saved ${A.noun}`); }
      else logLine(`· save ${A.noun}: already saved / unavailable`);
      await sleep(rand(500, 1200));
    }
    if (S.actions.like && Math.random() < per.likeChance) {
      if (S.consecLikes >= MAX_CONSEC_LIKES) {
        S.consecLikes = 0; logLine("· like cooldown"); await sleep(rand(2000, 4000));
      } else if (!A.isLiked(c)) {
        const btn = A.likeBtn(c);
        if (btn) { btn.click(); await sleep(rand(250, 500)); if (A.isLiked(c)) { S.liked++; S.consecLikes++; logLine(`❤️ liked ${A.noun}`); } }
      }
    }
    if (S.actions.follow && S.consecFollows < MAX_CONSEC_FOLLOWS && Math.random() < per.followChance) {
      if (await A.follow(c)) { S.followed++; S.consecFollows++; logLine("➕ followed author"); }
    }
  }

  async function videoLoop(A) {
    if (S.loopActive) return;
    S.loopActive = true;
    logLine(`${A.emoji || "🎞️"} ${A.label} run started (target ${S.targetN})`);
    let emptyScrolls = 0, endStreak = 0;
    try {
      if (A.preLoop) await A.preLoop();
      while (S.isRunning && S.processed < S.targetN) {
        await waitWhilePaused();
        if (!S.isRunning) break;
        if (detectStop()) return halt(detectStop());

        const c = A.getContainer();
        if (!c) {
          if (A.scrollWhenEmpty) {
            humanScroll(); await sleep(rand(1200, 2600));
            if (++emptyScrolls > EMPTY_SCROLL_LIMIT) { halt("no videos found"); }
          } else {
            note(false); if (A.resume) A.resume(); await sleep(800);
          }
          continue;
        }
        emptyScrolls = 0; note(true);

        if (A.shouldSkip && A.shouldSkip(c)) {
          S.skipped++; logLine(`· skip (${A.skipReason || "non-standard"})`); persist();
          if (!A.advance()) { if (A.onEnd && endStreak < 2) { endStreak++; await A.onEnd(); return; } break; }
          await actionGap(); continue;
        }

        await reelDwell();
        if (!S.isRunning || S.isPaused) continue;
        await doVideoActions(A, c);
        S.processed++;
        logLine(`✓ ${A.noun} ${S.processed}/${S.targetN}`);
        persist();
        if (S.processed >= S.targetN) break;

        if ((A.isEnd && A.isEnd()) || !A.advance()) {
          if (A.onEnd && endStreak < 2) { endStreak++; logLine("↻ end of results — refreshing"); await A.onEnd(); return; }
          logLine("⚠️ cannot advance — ending"); break;
        }
        endStreak = 0;
        await actionGap();
      }
      if (S.isRunning) finishRun();
    } finally { S.loopActive = false; }
  }

  function finishRun() {
    logLine(`✅ run complete — processed ${S.processed}, saved ${S.saved}, liked ${S.liked}, followed ${S.followed}`);
    S.isRunning = false;
    clearInterval(S.tickTimer);
    persist();
  }

  // ============================================================
  // routing + navigation (per platform + mode)
  // ============================================================
  function fbSearchUrl() {
    const kw = (S.keyword || "").trim();
    if (kw.startsWith("#")) return `https://www.facebook.com/hashtag/${encodeURIComponent(kw.slice(1))}`;
    return `https://www.facebook.com/search/posts/?q=${encodeURIComponent(kw)}`;
  }
  function fbOnCorrectSearch() {
    const kw = (S.keyword || "").trim();
    if (!kw) return pageSurface() === "search" || pageSurface() === "hashtag";
    if (kw.startsWith("#"))
      return pageSurface() === "hashtag" &&
        decodeURIComponent(location.pathname).toLowerCase().includes(kw.slice(1).toLowerCase());
    if (pageSurface() !== "search") return false;
    const q = (new URLSearchParams(location.search).get("q") || "").trim().toLowerCase();
    return q === kw.toLowerCase();
  }

  // Returns a URL to navigate to before running, or null to run here.
  function targetUrlForMode() {
    const p = platformForHost();
    const surface = pageSurface();
    const kw = (S.keyword || "").trim();
    const tag = kw.replace(/^#/, "");

    if (p === "facebook") {
      if (S.mode === "C") return surface === "reels" ? null : "https://www.facebook.com/reel/";
      if (S.mode === "A") return fbOnCorrectSearch() ? null : fbSearchUrl();
      if (S.mode === "B") return surface === "feed" ? null : "https://www.facebook.com/";
    }
    if (p === "instagram") {
      if (S.mode === "C") return surface === "reels" ? null : "https://www.instagram.com/reels/";
      if (S.mode === "A") {
        const want = `/explore/tags/${encodeURIComponent(tag).toLowerCase()}`;
        return tag && !decodeURIComponent(location.pathname).toLowerCase().startsWith(`/explore/tags/${tag.toLowerCase()}`)
          ? `https://www.instagram.com${want}/` : (tag ? null : "https://www.instagram.com/explore/");
      }
      if (S.mode === "B") return surface === "explore" ? null : "https://www.instagram.com/explore/";
    }
    if (p === "tiktok") {
      if (S.mode === "C") return (surface === "foryou") ? null : "https://www.tiktok.com/foryou";
      if (S.mode === "A") {
        if (kw.startsWith("#")) {
          return decodeURIComponent(location.pathname).toLowerCase().includes(`/tag/${tag.toLowerCase()}`)
            ? null : `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`;
        }
        const q = (new URLSearchParams(location.search).get("q") || "").trim().toLowerCase();
        return (surface === "search" && q === kw.toLowerCase()) ? null : `https://www.tiktok.com/search?q=${encodeURIComponent(kw)}`;
      }
    }
    return null;
  }

  function runEngine() {
    const p = platformForHost();
    if (p === "facebook") {
      if (S.mode === "C") videoLoop(FB_VIDEO);
      else if (S.mode === "A") postsLoop("search");
      else postsLoop("feed");
    } else if (p === "instagram") {
      videoLoop(S.mode === "C" ? IG_REELS : IG_FEED);
    } else if (p === "tiktok") {
      videoLoop(S.mode === "A" ? TT_SEARCH : TT_FORYOU);
    } else {
      logLine("⚠️ unsupported host — nothing to run");
      S.isRunning = false; persist();
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
    const name = (document.querySelector("h1")?.textContent || "").trim() || document.title;
    const links = Array.from(document.querySelectorAll("a"));
    const txt = (a) => (a.textContent || "").trim();
    const followers = txt(links.find((a) => /\bfollowers\b/i.test(txt(a)) && /\d/.test(txt(a))) || {}) || null;
    const following = txt(links.find((a) => /\bfollowing\b/i.test(txt(a)) && /\d/.test(txt(a))) || {}) || null;
    const svgs = Array.from(document.querySelectorAll('svg[role="img"][aria-label]')).filter((s) => s.querySelector("image"));
    const bySize = (a, b) => (b.clientWidth || 0) - (a.clientWidth || 0);
    const svg =
      svgs.find((s) => (s.getAttribute("aria-label") || "").trim() === name) ||
      svgs.filter((s) => !/your profile/i.test(s.getAttribute("aria-label") || "")).sort(bySize)[0];
    const im = svg && svg.querySelector("image");
    const avatar = im ? (im.getAttribute("xlink:href") || im.getAttribute("href")) : null;
    return { name, followers, following, avatar, url: location.href };
  }

  function tick() {
    if (!S.isRunning || S.isPaused) return;
    if (detectStop()) { halt(detectStop()); return; }
    if (S.willEndAt && Date.now() >= S.willEndAt) { logLine("⏲ session time cap reached"); finishRun(); }
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
    S.targetN = Math.max(1, settings.targetN || 10);
    S.actions = { save: !!settings.save, like: !!settings.like, follow: !!settings.follow };
    S.englishOnly = !!settings.englishOnly;
    if (settings.thresholds) S.thresholds = { minLikes: Number(settings.thresholds.minLikes) || 0, minComments: Number(settings.thresholds.minComments) || 0 };
    if (settings.pacing) S.pacing = { ...S.pacing, ...settings.pacing };
    S.willEndAt = settings.sessionCapMinutes ? now + 60000 * settings.sessionCapMinutes : 0;
    const map = { binge: "BINGE", casual: "CASUAL", engage: "ENGAGED", engaged: "ENGAGED" };
    if (settings.personality && map[settings.personality]) {
      S.userSelectedPersonality = map[settings.personality]; S.personalityMode = map[settings.personality];
    } else pickPersonality();

    logLine(`▶️ ${S.platform} · mode ${S.mode}${S.keyword ? ` "${S.keyword}"` : ""} · N=${S.targetN} · ${Object.entries(S.actions).filter(([, v]) => v).map(([k]) => k).join("+") || "observe"} · ${persona().name}`);
    persist();

    const target = targetUrlForMode();
    if (target) { logLine(`↪ navigating to target surface`); location.assign(target); return; }
    runEngine();
    S.tickTimer = setInterval(tick, 1000);
  }

  function stop() {
    logLine("⏹ stopped by user");
    S.isRunning = false; S.isPaused = false;
    clearInterval(S.tickTimer);
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
        try { start(msg.settings || {}); sendResponse({ ok: true, ...snapshot() }); }
        catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
        return true;
      case "FBW_TOGGLE_PAUSE": togglePause(); sendResponse({ ok: true, ...snapshot() }); return true;
      case "FBW_STOP": stop(); sendResponse({ ok: true, ...snapshot() }); return true;
      case "FBW_STATUS": sendResponse(snapshot()); return true;
      case "FBW_PAGE_INFO":
        try { sendResponse({ ok: true, info: fbPageInfo() }); }
        catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
        return true;
      case "FBW_COLLECT_REEL_THUMBS":
        collectReelThumbs()
          .then((thumbs) => sendResponse({ ok: true, thumbs }))
          .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true;
      default: return false;
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
      if (!here || (saved.platform && saved.platform !== here) || saved.host !== location.hostname) return;
      if (saved.willEndAt && Date.now() >= saved.willEndAt) {
        chrome.storage.local.set({ [STORAGE_KEY]: { isRunning: false } }); return;
      }
      Object.assign(S, freshState(), {
        isRunning: true, isPaused: !!saved.isPaused,
        startedAt: saved.startedAt || Date.now(), willEndAt: saved.willEndAt || 0,
        platform: saved.platform || here,
        mode: saved.mode || "C", keyword: saved.keyword || "", targetN: saved.targetN || 10,
        actions: saved.actions || { save: true, like: true, follow: false },
        englishOnly: !!saved.englishOnly,
        thresholds: saved.thresholds || { minLikes: 0, minComments: 0 },
        pacing: { ...freshState().pacing, ...(saved.pacing || {}) },
        personalityMode: saved.personalityMode || null, userSelectedPersonality: saved.userSelectedPersonality || null,
        processed: saved.processed || 0, saved: saved.saved || 0, liked: saved.liked || 0,
        followed: saved.followed || 0, skipped: saved.skipped || 0,
        haltReason: null, log: Array.isArray(saved.log) ? saved.log.slice(-LOG_CAP) : [],
      });
      if (!S.personalityMode) pickPersonality();

      const target = targetUrlForMode();
      if (target) { logLine("↪ resuming — navigating to target surface"); persist(); location.assign(target); return; }
      logLine("🔄 resumed run on " + pageSurface());
      runEngine();
      S.tickTimer = setInterval(tick, 1000);
    } catch (e) { /* ignore */ }
  })();
})();
