// FB Comment Scraper — isolated content script.
//
// On a single reel/post permalink, a floating "Scrape comments" button harvests
// the whole comment thread (top-level + replies) into a JSON file for mining
// hooks / objections / sentiment. Comments render as [role="article"] nodes and
// paginate on scroll; we auto-scroll the comment panel, expand replies, read
// each article from the DOM (robust + locale-tolerant via aria-label), and hand
// the records to the background for download.
//
// Import-free (FB CSP can break a CRXJS module loader) — the pure helpers below
// mirror src/lib/fbComments.js, which is the unit-tested source of truth.

if (location.hostname.endsWith("facebook.com") && !window.__fbwCommentsInit) {
  window.__fbwCommentsInit = true;

  // ---- generation takeover (an extension reload leaves the old world's timers
  // running; only its chrome.* dies). Newer generation announces; older stands down.
  const GEN = Date.now() + ":" + Math.random();
  let disabled = false;
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__fbwCmTakeover && e.data.__fbwCmTakeover !== GEN && !disabled) {
      disabled = true;
      cancelFlag = true;
    }
  });
  window.postMessage({ __fbwCmTakeover: GEN }, "*");

  // ============================================================
  // pure helpers (mirror of src/lib/fbComments.js + fbReels.parseCount)
  // ============================================================
  const UNIT = { k: 1e3, mil: 1e3, m: 1e6, mi: 1e6, b: 1e9 };
  function parseCount(text) {
    if (text == null) return null;
    const s = String(text).trim().toLowerCase().replace(/\s+/g, "");
    const m = s.match(/^([\d.,]+)([a-zçã]+)?$/);
    if (!m) return null;
    const unit = m[2] || "";
    const mult = unit ? UNIT[unit] : 1;
    if (unit && mult == null) return null;
    let n;
    if (mult === 1) n = parseInt(m[1].replace(/[.,]/g, ""), 10);
    else n = parseFloat(m[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * mult) : null;
  }
  function parseReactions(aria) {
    if (!aria) return 0;
    const m = String(aria).match(/([\d.,]+\s*(?:mil|mi|k|m|b)?)\s*(?:rea(?:ç|c)|react)/i);
    if (!m) return 0;
    const n = parseCount(m[1].replace(/\s+/g, ""));
    return n == null ? 0 : n;
  }
  const COMMENT_PREFIX = /^(?:coment[áa]rio de|comment(?:ed)? by|comentario de|commentaire de|commento di|kommentar von)\s+/i;
  const TRAILING_TIME = /\s*(?:h[áa]|hace|il y a|vor|fa)\s+.+$|\s*\d+\s*(?:s|sem|semana?s?|min|minuto?s?|h|hora?s?|d|dia?s?|w|week?s?|day?s?|hr?s?|mo|month?s?|y|year?s?|ano?s?)\.?$/i;
  function parseAuthorFromAria(aria) {
    if (!aria) return { name: null, time: null };
    const body = String(aria).replace(COMMENT_PREFIX, "");
    const tm = body.match(TRAILING_TIME);
    const time = tm ? tm[0].trim() : null;
    const name = body.replace(TRAILING_TIME, "").trim() || null;
    return { name: name && name.length <= 80 ? name : null, time };
  }
  function cleanAuthorUrl(href) {
    if (!href) return { url: null, id: null };
    try {
      const u = new URL(href, "https://www.facebook.com");
      if (u.pathname === "/profile.php") {
        const id = u.searchParams.get("id");
        return { url: id ? `https://www.facebook.com/profile.php?id=${id}` : u.origin + u.pathname, id: id || null };
      }
      const slug = u.pathname.replace(/^\/+|\/+$/g, "");
      return { url: `https://www.facebook.com${u.pathname.replace(/\/+$/, "")}`, id: slug || null };
    } catch {
      return { url: String(href).split("?")[0], id: null };
    }
  }
  function dedupeKey(rec) {
    return rec.comment_id || (rec.author?.id || "?") + "|" + String(rec.text || "").slice(0, 40);
  }

  // ============================================================
  // surface + post identity
  // ============================================================
  function postIdentity() {
    const p = location.pathname, s = location.search;
    let id =
      (p.match(/\/reel\/(\d+)/) || [])[1] ||
      (p.match(/\/videos\/(\d+)/) || [])[1] ||
      (new URLSearchParams(s).get("v")) ||
      (s.match(/story_fbid=(\d+)/) || [])[1] ||
      (p.match(/\/posts\/(\w+)/) || [])[1] ||
      null;
    const url = id && /\/reel\//.test(p)
      ? `https://www.facebook.com/reel/${id}`
      : id && (new URLSearchParams(s).get("v"))
        ? `https://www.facebook.com/watch/?v=${id}`
        : location.href.split("?")[0];
    return { post_id: id, post_url: url };
  }

  // ============================================================
  // DOM readers (all scoped to a single article, never its nested replies)
  // ============================================================
  const isCommentArticle = (a) => /coment|comment/i.test(a.getAttribute("aria-label") || "");
  const ownArticle = (node, article) => node.closest('[role="article"]') === article;

  // Identify a comment from its permalink link (the reel/watch link that carries
  // comment_id, plus reply_comment_id when it's a reply). Replies are rendered as
  // FLAT siblings (not nested articles), so this param is the reliable signal:
  //   top-level → { comment_id: <comment_id>, parent_id: null, is_reply: false }
  //   reply     → { comment_id: <reply_comment_id>, parent_id: <comment_id>, is_reply: true }
  // `[?&]comment_id=` matches only the parent param (the "reply_comment_id" one is
  // preceded by "_", not ?/&), so the two never cross.
  function commentRefs(article) {
    for (const a of article.querySelectorAll("a[href]")) {
      if (!ownArticle(a, article)) continue;
      const href = a.getAttribute("href") || "";
      if (!/\/(reel|watch|posts|videos)\b/.test(href) || !/comment_id=/.test(href)) continue;
      const parent = (href.match(/[?&]comment_id=([\w.]+)/) || [])[1] || null;
      const reply = (href.match(/reply_comment_id=([\w.]+)/) || [])[1] || null;
      if (reply) return { comment_id: reply, parent_id: parent, is_reply: true };
      return { comment_id: parent, parent_id: null, is_reply: false };
    }
    return { comment_id: null, parent_id: null, is_reply: false };
  }
  function authorOf(article) {
    for (const a of article.querySelectorAll("a[href]")) {
      if (!ownArticle(a, article)) continue;
      const href = a.getAttribute("href") || "";
      if (!/comment_id=/.test(href)) continue;
      if (/\/(reel|watch|posts|videos|photo)\b|story_fbid|story\.php/.test(href)) continue; // permalink, not author
      const name = (a.innerText || "").trim().split("\n")[0];
      if (!name) continue; // avatar link has the same href but empty text — skip it
      const { url, id } = cleanAuthorUrl(href);
      return { name: name.length <= 80 ? name : null, url, id };
    }
    return { name: null, url: null, id: null };
  }
  function reactionsOf(article) {
    for (const e of article.querySelectorAll("[aria-label]")) {
      if (!ownArticle(e, article)) continue;
      const al = e.getAttribute("aria-label") || "";
      if (/rea(ç|c)/i.test(al) && /\d/.test(al)) return parseReactions(al);
    }
    return 0;
  }
  const BADGE_RE = /^(superf[ãa]|top fan|fã n[º°]|mais ativo)/i;
  function badgesOf(article) {
    const out = [];
    for (const n of article.querySelectorAll("span, div")) {
      if (!ownArticle(n, article) || n.children.length) continue;
      const t = (n.textContent || "").trim();
      if (BADGE_RE.test(t) && !out.includes(t)) out.push(t.slice(0, 30));
    }
    return out;
  }
  const SKIP_TEXT = /^(responder|reply|répondre|responder|curtir|like|gostei|superf[ãa]|top fan|autor|author|editado|edited|ver tradução|see translation|traduzir|translate)$/i;
  function textOf(article) {
    let best = "";
    for (const n of article.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      if (!ownArticle(n, article)) continue;      // exclude nested reply text
      if (n.closest("a") || n.closest('[role="button"]')) continue; // author link / buttons
      const t = (n.innerText || "").trim();
      if (!t || SKIP_TEXT.test(t)) continue;
      if (t.length < 15 && TRAILING_TIME.test(t)) continue; // bare time chip
      if (t.length > best.length) best = t;
    }
    return best;
  }
  function extractComment(article, postUrl) {
    const aria = article.getAttribute("aria-label") || "";
    const fromAria = parseAuthorFromAria(aria);
    const author = authorOf(article);
    if (!author.name) author.name = fromAria.name;
    const { comment_id, parent_id, is_reply } = commentRefs(article);
    const permalink = comment_id
      ? is_reply
        ? `${postUrl}/?comment_id=${parent_id}&reply_comment_id=${comment_id}`
        : `${postUrl}/?comment_id=${comment_id}`
      : null;
    return {
      comment_id,
      permalink,
      author,
      text: textOf(article),
      reactions: reactionsOf(article),
      time_relative: fromAria.time,
      is_reply,
      parent_id,
      badges: badgesOf(article),
    };
  }

  // ============================================================
  // harvest engine
  // ============================================================
  let cancelFlag = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base) => base + Math.floor(Math.random() * 350);

  function allCommentArticles() {
    return [...document.querySelectorAll('[role="article"]')].filter(isCommentArticle);
  }
  // The immersive reel viewer paginates comments via a "Ver mais comentários" /
  // "View more comments" BUTTON, not infinite scroll — and the only real scroll
  // container on that surface is the REEL FEED (scrolling it navigates to the
  // next reel). So we drive loading by clicking the load-more button and only
  // ever nudge the comment RAIL, never the reel feed.
  const LOAD_MORE_RE = /ver mais coment[áa]rios|view (?:more )?comments?|mais coment[áa]rios|carregar mais coment|show more comments?|load more comments?/i;
  async function clickLoadMore() {
    // Scope to the comment rail — the whole doc has hundreds of buttons once
    // comments load (each comment has like/reply); the load-more lives in the rail.
    const scope = document.querySelector('[role="complementary"]') || document;
    let clicked = 0;
    for (const b of scope.querySelectorAll('[role="button"]')) {
      const t = (b.textContent || "").trim();
      if (t.length <= 40 && LOAD_MORE_RE.test(t)) {
        try { b.click(); clicked++; } catch {}
        await sleep(jitter(350));
      }
    }
    return clicked;
  }
  function nudgeRail() {
    const rail = document.querySelector('[role="complementary"]');
    if (rail && rail.scrollHeight > rail.clientHeight) rail.scrollTop = rail.scrollHeight;
    const arts = (rail || document).querySelectorAll('[role="article"]'); // NodeList, no copy
    arts[arts.length - 1]?.scrollIntoView({ block: "end" });
  }
  // Expand truncated long comments ("Ver mais" inside a comment) so full text is
  // captured — scoped to comment articles so it never hits unrelated "See more".
  const SEE_MORE_RE = /^(ver mais|see more|voir plus|ver más|mehr anzeigen|mostra altro)$/i;
  async function expandTruncated() {
    for (const b of document.querySelectorAll('[role="article"] [role="button"], [role="article"] [dir="auto"] [role="button"]')) {
      if (clickedToggles.has(b)) continue;
      if (SEE_MORE_RE.test((b.textContent || "").trim())) {
        clickedToggles.add(b);
        try { b.click(); } catch {}
        await sleep(jitter(180));
      }
    }
  }

  // Open the comment panel if no comment article is present yet.
  async function ensureCommentsOpen() {
    if (allCommentArticles().length) return true;
    const btn = [...document.querySelectorAll('[role="button"],[aria-label]')].find((b) =>
      /^(comentar|comment|coment[áa]rios?|comments?)$/i.test((b.getAttribute("aria-label") || "").trim()),
    );
    if (btn) { btn.click(); await sleep(1500); }
    return allCommentArticles().length > 0;
  }

  // Best-effort: switch the comment sort to "All / Newest" for the complete set.
  async function selectAllSort() {
    const trigger = [...document.querySelectorAll('[role="button"]')].find((b) =>
      /mais relevantes|most relevant|todos os coment|all comments|mais recentes|newest/i.test((b.textContent || "").trim()),
    );
    if (!trigger) return "relevant";
    trigger.click();
    await sleep(700);
    const opt = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="button"]')].find((m) =>
      /todos os coment|all comments|mais recentes|newest/i.test((m.textContent || "").trim()),
    );
    if (opt) {
      const mode = /recentes|newest/i.test(opt.textContent || "") ? "newest" : "all";
      opt.click();
      await sleep(1500);
      return mode;
    }
    // close the menu we opened
    document.body.click();
    return "relevant";
  }

  // Expand every "Ver N respostas / View N replies" toggle (bounded passes).
  const clickedToggles = new WeakSet();
  async function expandReplies() {
    for (let pass = 0; pass < 30 && !cancelFlag; pass++) {
      const toggles = [...document.querySelectorAll('[role="button"], span[dir="auto"]')].filter((b) => {
        const t = (b.textContent || "").trim();
        return /(?:ver|view|voir|mostrar)\s+.*(?:respostas?|replies|répon|respuestas?)|(?:respostas?|replies)\s*\(\d+\)/i.test(t) && !clickedToggles.has(b);
      });
      if (!toggles.length) break;
      for (const t of toggles) {
        if (cancelFlag) break;
        clickedToggles.add(t);
        try { t.click(); } catch {}
        await sleep(jitter(500));
      }
      await sleep(jitter(700));
    }
  }

  // Assemble the export envelope from the live map: each top-level comment
  // followed by its replies, then any orphan replies.
  function buildDoc(map, post_url, post_id, sortMode, live) {
    const recs = [...map.values()];
    const tops = recs.filter((r) => !r.is_reply);
    const repliesByParent = new Map();
    for (const r of recs) if (r.is_reply) {
      const k = r.parent_id || "_";
      (repliesByParent.get(k) || repliesByParent.set(k, []).get(k)).push(r);
    }
    const ordered = [];
    for (const t of tops) {
      ordered.push(t);
      const kids = repliesByParent.get(t.comment_id);
      if (kids) ordered.push(...kids);
    }
    for (const r of recs) if (r.is_reply && !ordered.includes(r)) ordered.push(r);
    return {
      post_url, post_id,
      scraped_at: new Date().toISOString(),
      sort_mode: sortMode || "relevant",
      scraping: !!live, // true while a scrape is in progress
      count: ordered.length,
      reply_count: ordered.filter((r) => r.is_reply).length,
      comments: ordered,
    };
  }

  async function harvest() {
    const { post_id, post_url } = postIdentity();
    const map = new Map();
    // Read each article node at most once during the growth loops (extractComment
    // is heavy — several querySelectorAll + innerText reflows). A `full` pass
    // re-reads everything to pick up late-arriving reactions / expanded text.
    const seen = new WeakSet();
    const collectFrom = (arts, full) => {
      for (const a of arts) {
        if (!full && seen.has(a)) continue;
        seen.add(a);
        const rec = extractComment(a, post_url);
        if (!rec.text && !rec.reactions && !rec.author.name) continue; // empty node
        map.set(dedupeKey(rec), rec);
      }
    };
    // Stream to storage as we go so the side-panel Comments tool fills in live.
    // Throttled + growth-gated so the whole array isn't re-serialized every tick.
    let lastFlush = 0, lastSize = -1;
    const flush = async (force) => {
      if (!contextAlive()) { cancelFlag = true; return; } // context died → stop the loop
      if (!force && (Date.now() - lastFlush < 1400 || map.size === lastSize)) return;
      lastFlush = Date.now();
      lastSize = map.size;
      await storeComments(buildDoc(map, post_url, post_id, harvest._sortMode, true));
    };

    // 1) click "Ver mais comentários" until the count stops growing and the
    //    button is gone. (Nudging the rail helps surfaces that also lazy-load.)
    let stable = 0, prev = -1;
    for (let i = 0; i < 400 && stable < 4 && !cancelFlag; i++) {
      const clicked = await clickLoadMore();
      nudgeRail();
      await sleep(jitter(clicked ? 900 : 650));
      const arts = allCommentArticles(); // one query per tick, reused below
      collectFrom(arts);
      setLabel(`Scraping… ${map.size}`);
      await flush();
      const n = arts.length;
      if (n === prev && !clicked) stable++;
      else stable = 0;
      prev = n;
    }
    // 2) expand replies + truncated bodies, then a FULL re-read (reactions load
    //    late; "Ver mais" reveals full text).
    if (!cancelFlag) {
      await expandReplies();
      await expandTruncated();
      await sleep(jitter(600));
      collectFrom(allCommentArticles(), true);
      setLabel(`Scraping… ${map.size}`);
      await flush();
    }
    // 3) one more load-more sweep in case expanding revealed new tails
    if (!cancelFlag) {
      for (let i = 0; i < 40 && stable < 3 && !cancelFlag; i++) {
        const clicked = await clickLoadMore();
        nudgeRail();
        await sleep(jitter(700));
        const arts = allCommentArticles();
        collectFrom(arts);
        await flush();
        const n = arts.length;
        if (n === prev && !clicked) stable++;
        else stable = 0;
        prev = n;
      }
    }
    collectFrom(allCommentArticles(), true); // final authoritative full read
    return buildDoc(map, post_url, post_id, harvest._sortMode, false);
  }

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  }

  // ============================================================
  // trigger + progress (the button lives in the reel rail, built by
  // transcription/inject.js in this same isolated world; we talk to it via
  // window events). setLabel forwards the live count as the button's tooltip.
  // ============================================================
  let running = false;
  // The extension context can die mid-scrape (reload / auto-update); once it does
  // every chrome.* call throws. Detect it so the loop bails cleanly instead of
  // logging a wall of "context invalidated" errors.
  const contextAlive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };
  function progress(state, tip) {
    window.dispatchEvent(new CustomEvent("__fbwScrapeProgress", { detail: { state, tip } }));
  }
  function setLabel(text, cls) {
    progress(cls === "ok" ? "ok" : "busy", text);
  }
  // Persist the scrape for the side-panel Comments tool. While STREAMING we write
  // only the single-post live key (fbw_comments_live) so each throttled flush
  // re-serializes ~one post, not the whole 8-post archive. The FINAL write merges
  // the post into the archive (fbw_comments, ≤8 posts) and clears the live key.
  async function storeComments(doc) {
    try {
      if (doc.scraping) {
        await chrome.storage.local.set({ fbw_comments_live: doc });
        return;
      }
      const r = await chrome.storage.local.get("fbw_comments");
      const map = r.fbw_comments || {};
      map[doc.post_id || "post_" + Date.now()] = doc;
      const kept = Object.fromEntries(
        Object.entries(map)
          .sort((a, b) => (Date.parse(b[1].scraped_at) || 0) - (Date.parse(a[1].scraped_at) || 0))
          .slice(0, 8),
      );
      await chrome.storage.local.set({ fbw_comments: kept, fbw_comments_live: null });
    } catch {}
  }
  // Fired by the rail's comment button (transcription/inject.js). Second fire
  // while running = cancel.
  async function runScrape() {
    if (disabled) return;
    if (running) { cancelFlag = true; progress("busy", "Stopping…"); return; }
    running = true; cancelFlag = false;
    progress("busy", "Opening comments…");
    try {
      await ensureCommentsOpen();
      harvest._sortMode = await selectAllSort();
      const doc = await harvest();
      if (!contextAlive()) return; // reloaded/updated mid-scrape → nothing to persist
      await storeComments(doc);
      const filename = `socialmate-comments/fb-${doc.post_id || "post"}-${stamp()}.json`;
      chrome.runtime.sendMessage({ type: "FBW_DL_JSON", filename, data: doc }).catch(() => {});
      progress("ok", cancelFlag ? `Stopped · ${doc.count} saved` : `✓ ${doc.count} comments`);
    } catch (err) {
      progress("busy", "Failed — retry");
      // Drop a half-written live key so the panel doesn't show a stuck "scraping" post.
      try { if (contextAlive()) await chrome.storage.local.set({ fbw_comments_live: null }); } catch {}
      console.warn("[fbw] comment scrape failed", err);
    } finally {
      running = false;
      setTimeout(() => { if (!running) progress("idle", null); }, 4500);
    }
  }
  window.addEventListener("__fbwScrapeComments", runScrape);
}
