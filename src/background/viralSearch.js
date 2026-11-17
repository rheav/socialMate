// The Hub's "Busca viral" (relay command `search.run`, socialMate 1.40): one keyword
// search on Instagram or TikTok, read by the page's own capture in a small window of
// ours, handed back as rows. No request of its own: the page asks for its results as
// it scrolls, and the capture scripts (ig/bridge, tt/tt-relay) keep them as usual.
//
// Measured 2026-11-16 in a 440×780 unfocused window: each scroll to the bottom of
// /explore/search/keyword/?q= brings 24 more results
// (PolarisKeywordSearchExplorePageRelayPaginationQuery), whose views the IG capture
// then asks media/info for; TikTok's /search/video answers /api/search/item/full/
// with 12 videos a page, views and the author's followers included. A window that
// other windows cover is "hidden" and stops at the first page.

const WINDOW = { focused: false, type: "normal", width: 440, height: 780, left: 0, top: 0 }; // the Spy's TikTok window
export const SEARCH_LIMIT = 60;
const SCROLL_ROUNDS = 8; // the page paces them itself (scrollGapMs)
const POLL_MS = 3000;
const DEADLINE_MS = 80_000; // under the Hub's 120 s of silence, with progress in between
const STALE_POLLS = 4; // no new result for this many polls: the search is over
const FIRST_RESULT_POLLS = 10;
const IG_SETTLE_MS = 6000; // the views of the last page arrive after it
const LOGIN_URL = /instagram\.com\/(accounts\/login|challenge)|tiktok\.com\/login/;

const MSG = {
  instagram: { list: "FBW_IG_LIST", scroll: "FBW_IG_SCROLL" },
  tiktok: { list: "FBW_TT_LIST", scroll: "FBW_TT_SCROLL" },
};

/** The words searched: no leading # (Instagram's hashtag page crashes, measured 2026-10-19), one space, 80 chars. */
export function searchQuery(q) {
  return String(q || "").trim().replace(/^#+/, "").trim().replace(/\s+/g, " ").slice(0, 80);
}

export function searchUrl(platform, q) {
  const s = encodeURIComponent(searchQuery(q));
  return platform === "instagram"
    ? `https://www.instagram.com/explore/search/keyword/?q=${s}`
    : `https://www.tiktok.com/search/video?q=${s}`;
}

/** The surface both capture scripts file this search's results under. */
export function searchSurface(q) {
  return "search:" + searchQuery(q).toLowerCase();
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The videos this search found, as the Hub shows them; photos and other surfaces left out. */
export function searchRows(platform, records, q, limit = SEARCH_LIMIT) {
  const surface = searchSurface(q);
  const rows = [];
  const seen = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.surface !== surface) continue;
    let row = null;
    if (platform === "instagram") {
      if (r.media_type !== "video" || !r.code) continue;
      row = {
        id: String(r.pk || r.code), url: `https://www.instagram.com/reel/${r.code}/`, author: r.username || null,
        caption: r.caption ? String(r.caption).slice(0, 200) : null, cover: r.thumb || r.image || null,
        views: num(r.play_count), likes: num(r.like_count), comments: num(r.comment_count), shares: null,
        followers: num(r.user_follower_count), takenAt: num(r.taken_at), duration: num(r.duration),
      };
    } else {
      if (r.__kind !== "video" || !r.id || (Array.isArray(r.images) && r.images.length)) continue;
      row = {
        id: String(r.id), url: `https://www.tiktok.com/@${r.username || "_"}/video/${r.id}`, author: r.username || null,
        caption: r.desc ? String(r.desc).slice(0, 200) : null, cover: r.cover || null,
        views: num(r.play_count), likes: num(r.digg_count), comments: num(r.comment_count), shares: num(r.share_count),
        followers: num(r.user_follower_count), takenAt: num(r.create_time), duration: num(r.duration),
      };
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * `run(msg, reply)` is the relay's `search.run` handler: `{ platform, q, limit }`.
 * `isBlocked(platform)` is the Spy's pause after a 429 or a login wall.
 */
export function createViralSearch({ windows, tabs, isBlocked, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  let running = false;
  async function list(tabId, platform) {
    try { return (await tabs.sendMessage(tabId, { type: MSG[platform].list }))?.records || null; } catch { return null; }
  }
  async function run(msg, reply) {
    const platform = msg?.platform === "instagram" || msg?.platform === "tiktok" ? msg.platform : null;
    const q = searchQuery(msg?.q);
    const limit = Math.max(1, Math.min(SEARCH_LIMIT, Number(msg?.limit) || SEARCH_LIMIT));
    if (!platform || !q) { reply.result(false, { error: "bad_request" }); return; }
    if (running) { reply.result(false, { error: "busy" }); return; }
    if (await isBlocked(platform)) { reply.result(false, { error: "rate_limited" }); return; }
    running = true;
    let win = null;
    try {
      win = await windows.create({ url: searchUrl(platform, q), ...WINDOW });
      const tabId = win?.tabs?.[0]?.id;
      if (tabId == null) { reply.result(false, { error: "no_window" }); return; }
      const start = now();
      let rows = [];
      let scrolled = false;
      let stale = 0;
      while (now() - start < DEADLINE_MS) {
        await sleep(POLL_MS);
        // Logged out, the search page turns into the login page (measured on Instagram 2026-11-16).
        let at = "";
        try { at = (await tabs.get(tabId))?.url || ""; } catch { /* closed */ }
        if (LOGIN_URL.test(at)) { reply.result(false, { error: "login_required" }); return; }
        const records = await list(tabId, platform);
        if (!records) continue; // the page's scripts are not up yet
        if (!scrolled) {
          scrolled = true;
          try { await tabs.sendMessage(tabId, { type: MSG[platform].scroll, rounds: SCROLL_ROUNDS }); } catch { /* the list still counts */ }
        }
        // The page's store only grows; a shorter answer (a reload, a cleared store) keeps what came.
        const next = searchRows(platform, records, q, limit);
        if (next.length > rows.length) { rows = next; stale = 0; } else stale += 1;
        reply.progress({ found: rows.length });
        // Before the first result the page may still be loading: up to 30 s of grace.
        if (rows.length >= limit || stale >= (rows.length ? STALE_POLLS : FIRST_RESULT_POLLS)) break;
      }
      if (platform === "instagram" && rows.length) {
        await sleep(IG_SETTLE_MS);
        const settled = searchRows(platform, (await list(tabId, platform)) || [], q, limit);
        if (settled.length >= rows.length) rows = settled;
      }
      reply.result(true, { platform, q, results: rows });
    } finally {
      running = false;
      if (win?.id != null) { try { await windows.remove(win.id); } catch { /* closed already */ } }
    }
  }
  return { run };
}
