// TikTok bridge — isolated content-script world.
//
// Receives the MAIN-world fetch/XHR capture (relayed via window.postMessage),
// keeps a surface-scoped video map + a per-video comment store, answers the side
// panel (FBW_TT_LIST / FBW_TT_COMMENTS / FBW_TT_CLEAR), AND injects an on-page
// action overlay (save / download / transcribe / scrape comments / like) so you
// can act on the current video without opening the panel.
//
// Kept import-free on purpose: an ES import would make CRXJS wrap this in a
// dynamic-import loader, which TikTok's strict CSP can kill (that would break all
// capture). So the few helpers it needs are inlined.

if (location.hostname.endsWith("tiktok.com") && !window.__fbwTtInit) {
  window.__fbwTtInit = true;

  // ---- generation takeover ----
  // An extension reload/update re-injects this file into a FRESH isolated world, so
  // the __fbwTtInit guard above does not stop the OLD world — only its chrome.* dies.
  // Without this, every reload left another 1s interval, another scroll listener and
  // another full store running for the page's lifetime. Newer generation announces;
  // older tears itself down. (Same pattern as content/fb/comments-scrape.js.)
  const GEN = Date.now() + ":" + Math.random();
  let disabled = false;
  const onTakeover = (e) => {
    if (e.source !== window || !e.data || e.data.__fbwTtTakeover === undefined) return;
    if (e.data.__fbwTtTakeover === GEN || disabled) return;
    disabled = true;
    clearInterval(overlayInterval);
    clearTimeout(overlayTimer);
    window.removeEventListener("scroll", scheduleOverlay);
    window.removeEventListener("message", onRelay);
    window.removeEventListener("message", onTakeover);
    document.removeEventListener("visibilitychange", scheduleOverlay);
    document.getElementById("sw-tt-acts")?.remove();
    byId.clear();
    comments.clear();
    stories.clear();
    lists.clear();
  };
  window.addEventListener("message", onTakeover);
  window.postMessage({ __fbwTtTakeover: GEN }, "*");

  const byId = new Map(); // aweme id -> record; insertion order preserved for the list
  const comments = new Map(); // aweme_id -> { items: Map<cid, comment> }
  const stories = new Map(); // owner username -> Map<id, story item>  (TikTok stories)
  const lists = new Map(); // list_id -> { meta, items: Map<id, rec> }  (playlists/collections)
  // Bumped on every ingest. The panel sends its last seen value and we answer
  // { unchanged: true } when nothing moved, instead of structured-cloning the whole
  // store across processes every 2.5s.
  // One counter per store. A single shared counter meant a video ingest — which
  // happens constantly while the FYP streams — invalidated the comments, stories and
  // lists polls as well, so each of those re-serialised its whole payload every
  // 2.5s even though nothing in it had changed.
  const ver = { videos: 0, comments: 0, stories: 0, lists: 0 };
  const bump = (k) => { ver[k] += 1; };
  // Local mirror of the saved-post ids, kept in sync by one storage.onChanged
  // listener. The overlay used to chrome.storage.local.get("fbw_saved") on EVERY
  // 1s tick, deserializing the entire saved map (base64 thumbs included) into the
  // page process once a second.
  let savedIds = new Set();
  // The video whose comments were most recently fetched == the one you're viewing.
  // Lets the panel auto-follow the current video instead of sticking on a stale one.
  let lastCommentAweme = null;

  // Every store is capped — outer AND inner. Capping only the outer Map (as an
  // earlier version did) still lets a single scraped thread or a huge playlist grow
  // without limit, and the panel serializes all of it on every poll.
  const cap = (m, n) => { while (m.size > n) m.delete(m.keys().next().value); };

  function ingestStory(r) {
    const owner = r.reel_owner || r.username || "unknown";
    let S = stories.get(owner);
    if (!S) { S = new Map(); stories.set(owner, S); }
    bump("stories");
    const prev = S.get(r.id) || {};
    for (const k in r) if (r[k] != null || !(k in prev)) prev[k] = r[k];
    S.set(r.id, prev);
    cap(S, 100);
    cap(stories, 40);
  }
  function ingestListMeta(r) {
    let L = lists.get(r.list_id);
    if (!L) { L = { meta: {}, items: new Map() }; lists.set(r.list_id, L); }
    bump("lists");
    for (const k in r) if (r[k] != null) L.meta[k] = r[k];
    cap(lists, 60);
  }
  function ingestListVideo(r) {
    let L = lists.get(r.list_id);
    if (!L) { L = { meta: { list_id: r.list_id }, items: new Map() }; lists.set(r.list_id, L); }
    bump("lists");
    L.items.set(r.id, r);
    cap(L.items, 300);
    cap(lists, 60); // this path creates entries too, so it must cap as well
  }

  function surfaceKey() {
    const p = location.pathname;
    let m;
    if ((m = p.match(/^\/@([^/]+)/))) return "profile:" + decodeURIComponent(m[1]).toLowerCase();
    if ((m = p.match(/^\/tag\/([^/]+)/))) return "tag:" + decodeURIComponent(m[1]).toLowerCase();
    if (p.startsWith("/search")) {
      const q = new URLSearchParams(location.search).get("q");
      return "search:" + (q ? q.toLowerCase() : "");
    }
    if (p.startsWith("/foryou") || p === "/") return "feed";
    if (p.startsWith("/explore")) return "explore";
    return "feed";
  }

  // The aweme id of the video the user is currently on. URL first (detail pages +
  // FYP once TikTok rewrites the path), then the most-centered <video>'s nearest
  // /video/<id> link, then the last video whose comments loaded.
  function currentAwemeId(centered) {
    const m = location.pathname.match(/\/video\/(\d+)/);
    if (m) return m[1];
    const v = centered !== undefined ? centered : mostCenteredVideo();
    if (v) {
      let el = v;
      for (let i = 0; i < 8 && el; i++) {
        const a = el.querySelector?.('a[href*="/video/"]');
        const mm = a && (a.getAttribute("href") || "").match(/\/video\/(\d+)/);
        if (mm) return mm[1];
        el = el.parentElement;
      }
    }
    return lastCommentAweme;
  }

  function mostCenteredVideo() {
    let best = null, bestScore = -Infinity;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) continue;
      const visible = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (visible <= 0) continue;
      const score = visible - Math.abs(r.top + r.height / 2 - innerHeight / 2);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  function ingestComment(r) {
    if (!r.aweme_id || !r.cid) return;
    lastCommentAweme = r.aweme_id;
    let C = comments.get(r.aweme_id);
    if (!C) { C = { aweme_id: r.aweme_id, items: new Map() }; comments.set(r.aweme_id, C); }
    bump("comments");
    const prev = C.items.get(r.cid) || {};
    for (const k in r) if (r[k] != null || !(k in prev)) prev[k] = r[k];
    C.items.set(r.cid, prev);
    cap(C.items, 500); // a scraped thread is unbounded upstream
    cap(comments, 60);
  }

  const onRelay = (e) => {
    if (e.source !== window || !e.data || !e.data.__fbwTt) return;
    if (disabled) return;
    const surface = surfaceKey();
    for (const r of e.data.records || []) {
      if (r.__kind === "comment") { ingestComment(r); continue; }
      if (r.__kind === "tt_list") { ingestListMeta(r); continue; }
      if (r.__kind === "tt_story") { ingestStory(r); continue; }
      if (!r.id) continue;
      r.surface = surface;
      if (!r.username && surface.startsWith("profile:")) r.username = surface.slice("profile:".length);
      const prev = byId.get(r.id) || {};
      for (const k in r) if (r[k] != null || !(k in prev)) prev[k] = r[k];
      byId.set(r.id, prev);
      if (r.list_id) ingestListVideo(prev); // playlist/collection membership
    }
    while (byId.size > 500) byId.delete(byId.keys().next().value);
    bump("videos"); // lets the panel poll short-circuit when nothing changed
    scheduleOverlay();
  };
  window.addEventListener("message", onRelay);

  // Mirror fbw_saved ids locally (see savedIds above).
  const refreshSaved = (map) => { savedIds = new Set(Object.keys(map || {})); };
  chrome.storage?.local?.get("fbw_saved").then((r) => refreshSaved(r?.fbw_saved)).catch(() => {});
  const onSavedChanged = (ch, area) => {
    if (area === "local" && ch.fbw_saved) { refreshSaved(ch.fbw_saved.newValue); scheduleOverlay(); }
  };
  chrome.storage?.onChanged?.addListener(onSavedChanged);

  let lastReplayReq = 0;
  function requestReplay() {
    const now = Date.now();
    if (now - lastReplayReq < 600) return;
    lastReplayReq = now;
    window.postMessage({ __fbwTtReq: true }, location.origin);
  }
  requestReplay();
  setTimeout(requestReplay, 700);
  setTimeout(requestReplay, 1800);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Every poll carries the panel's last seen `version`; when nothing has been
    // ingested since, answer with a tiny {unchanged} instead of structured-cloning
    // the whole store across processes.
    if (msg?.type === "FBW_TT_LIST") {
      if (msg.since === ver.videos) {
        // surface/current are cheap and CHANGE without a new capture (SPA nav,
        // scrolling the feed), so they ship even when the store has not moved.
        sendResponse({ unchanged: true, version: ver.videos, surface: surfaceKey(), current: currentAwemeId() });
        return;
      }
      sendResponse({ records: Array.from(byId.values()), surface: surfaceKey(), current: currentAwemeId(), version: ver.videos });
      return;
    }
    if (msg?.type === "FBW_TT_COMMENTS") {
      if (msg.since === ver.comments) {
        sendResponse({ unchanged: true, version: ver.comments, current: lastCommentAweme || currentAwemeId() });
        return;
      }
      const videos = [];
      for (const C of comments.values()) {
        videos.push({ aweme_id: C.aweme_id, meta: byId.get(C.aweme_id) || null, comments: Array.from(C.items.values()) });
      }
      // `current` = the video the user is viewing → the panel auto-selects it.
      sendResponse({ videos, current: lastCommentAweme || currentAwemeId(), version: ver.comments });
      return;
    }
    if (msg?.type === "FBW_TT_STORIES") {
      if (msg.since === ver.stories) { sendResponse({ unchanged: true, version: ver.stories }); return; }
      const out = [];
      for (const [owner, S] of stories) out.push({ owner, items: Array.from(S.values()) });
      sendResponse({ owners: out, version: ver.stories });
      return;
    }
    if (msg?.type === "FBW_TT_LISTS") {
      if (msg.since === ver.lists) { sendResponse({ unchanged: true, version: ver.lists }); return; }
      const out = [];
      for (const [, L] of lists) out.push({ ...L.meta, items: Array.from(L.items.values()) });
      sendResponse({ lists: out, version: ver.lists });
      return;
    }
    if (msg?.type === "FBW_TT_CLEAR") {
      byId.clear();
      comments.clear();
      stories.clear();
      lists.clear();
      lastCommentAweme = null;
      bump("videos"); bump("comments"); bump("stories"); bump("lists");
      requestReplay(); // re-pull the current surface so the panel isn't left empty
      sendResponse?.({ ok: true });
      return;
    }
    if (msg?.type === "FBW_PING") { sendResponse?.({ ok: true }); }
  });

  // ============================================================
  // On-page action overlay — a floating stack pinned to the window's right edge
  // (clear of TikTok's own action rail, which hugs the video). Acts on the current
  // video: save / download / transcribe (need the captured record for the media
  // URL), scrape-comments (open + auto-scroll the comment panel → passive capture),
  // like (click TikTok's native control). No blur (repaints jank the feed).
  // ============================================================
  const TT_SVG = {
    save: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    tx: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  };
  const icon = (name, size = 19) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${TT_SVG[name]}</svg>`;

  let styleAdded = false;
  function ensureStyle() {
    if (styleAdded) return;
    styleAdded = true;
    const s = document.createElement("style");
    s.textContent = `
      #sw-tt-acts{position:fixed;top:50%;right:16px;transform:translateY(-50%);z-index:2147482000;
        display:flex;flex-direction:column;gap:9px}
      .sw-ttbtn{position:relative;display:grid;place-items:center;width:42px;height:42px;border-radius:12px;cursor:pointer;color:#fff;
        background:rgba(20,20,24,.92);border:1px solid rgba(150,185,255,.45);box-shadow:0 2px 10px rgba(0,0,0,.4);
        transition:background .15s,color .15s,transform .1s}
      .sw-ttbtn:hover{background:rgba(40,44,60,.96);transform:translateY(-1px)}
      .sw-ttbtn.ok{color:#34d399;border-color:rgba(52,211,153,.6)}
      .sw-ttbtn.err{color:#f87171;border-color:rgba(248,113,113,.6)}
      .sw-ttbtn.on{color:#facc15;border-color:rgba(250,204,21,.6)}
      .sw-ttbtn.on svg{fill:#facc15}
      .sw-ttbtn[disabled]{opacity:.4;cursor:default}
      .sw-ttbtn[data-tip]:hover::after{content:attr(data-tip);position:absolute;right:calc(100% + 8px);top:50%;
        transform:translateY(-50%);background:rgba(17,20,32,.97);color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        padding:5px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.5);border:1px solid rgba(150,185,255,.28)}`;
    (document.head || document.documentElement).appendChild(s);
  }

  const ext = (url, kind) => {
    const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp)(\?|$)/i);
    if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
    return kind === "video" ? "mp4" : "jpg";
  };
  const sanit = (s) => String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  const ttName = (rec, e) => `tt-${sanit(rec.username || rec.nickname)}-${rec.id}.${e}`;

  // Video-detail pages don't fetch the open video via item_list (its data is in the
  // SSR hydration blob), so byId won't have it. Map the blob's itemStruct as a
  // fallback (id-matched so a stale blob after SPA nav is ignored).
  function mapItem(it) {
    const v = it.video || {}, a = it.author || {}, s = it.statsV2 || it.stats || {};
    const n = (x) => (x == null ? null : typeof x === "number" ? x : Number.isFinite(+x) ? +x : null);
    // highest-res gear
    let hd = null;
    for (const g of (Array.isArray(v.bitrateInfo) ? v.bitrateInfo : [])) {
      const pa = g.PlayAddr || {}, url = (pa.UrlList && pa.UrlList[0]) || null;
      if (!url) continue;
      const score = (n(pa.Width) || 0) * (n(pa.Height) || 0) * 1e6 + (n(g.Bitrate) || 0);
      if (!hd || score > hd.score) hd = { url, res: `${n(pa.Width)}x${n(pa.Height)}`, score };
    }
    const subs = Array.isArray(v.subtitleInfos) ? v.subtitleInfos : [];
    const sp = subs.find((x) => /eng/i.test(x.LanguageCodeName || "")) || subs[0];
    const sub = sp ? { url: sp.Url || (sp.UrlList && sp.UrlList[0]) || null, lang: sp.LanguageCodeName || null, format: (sp.Format || "webvtt").toLowerCase() } : null;
    return {
      id: String(it.id || v.id || ""), username: a.uniqueId || null, nickname: a.nickname || null,
      play_count: n(s.playCount), digg_count: n(s.diggCount), comment_count: n(s.commentCount),
      share_count: n(s.shareCount), collect_count: n(s.collectCount), repost_count: n(s.repostCount),
      video: v.playAddr || null, download_url: v.downloadAddr || v.playAddr || null,
      hd_url: (hd && hd.url) || v.downloadAddr || v.playAddr || null, hd_res: hd ? hd.res : null,
      subtitle: sub && sub.url ? sub : null,
      cover: v.cover || v.originCover || null, dynamic_cover: v.dynamicCover || null,
      duration: n(v.duration), desc: (it.desc || "").slice(0, 500) || null, create_time: n(it.createTime),
      hashtags: Array.isArray(it.challenges) ? it.challenges.map((c) => c && c.title).filter(Boolean) : [],
      pinned: !!it.isPinnedItem, surface: surfaceKey(),
    };
  }
  // Memoized per aweme id INCLUDING failures. The blob is hundreds of KB to a few
  // MB; on the FYP feed (or after any SPA nav) the id never matches, so an unmemoized
  // version re-parsed the whole thing on every 1s tick, forever.
  const ssrTried = new Set();
  function ssrRecord(awemeId) {
    if (ssrTried.has(awemeId)) return null; // already parsed once for this id
    ssrTried.add(awemeId);
    cap(ssrTried, 200);
    try {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!el) return null;
      const scope = (JSON.parse(el.textContent).__DEFAULT_SCOPE__) || {};
      const it = scope["webapp.video-detail"]?.itemInfo?.itemStruct;
      if (!it || String(it.id) !== String(awemeId)) return null;
      const r = mapItem(it);
      return r.id ? r : null;
    } catch {
      return null;
    }
  }
  function currentRecord(centered) {
    const id = currentAwemeId(centered);
    if (!id) return null;
    let rec = byId.get(id);
    if (!rec || !(rec.video || rec.download_url)) {
      const ssr = ssrRecord(id);
      if (ssr) { rec = { ...(rec || {}), ...ssr }; byId.set(id, rec); } // cache so the panel sees it too
    }
    return rec || null;
  }
  function flash(btn, cls = "ok") { btn.classList.add(cls); setTimeout(() => btn.classList.remove(cls), 1300); }

  // Library record shape — GENERATED from src/lib/shared/savedEntry.js (this
  // script cannot import; run `npm run gen:inline`). The background owns and
  // serializes the write, so a panel toggle and a page toggle can't clobber.
// <<< inline:src/lib/shared/counts.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/counts.js and run `npm run gen:inline`.
// Localized count parsing/formatting. INLINED into content scripts — see
// src/lib/shared/README.md before editing (no imports allowed in this file).

// Localized abbreviated-count multipliers. FB/IG/TikTok render counts abbreviated
// with a locale word or suffix: pt-br "mil"/"mi", en "K"/"M", plus other locales'
// short forms. A missing entry here means a real count parses as null, which is
// how the comment scraper used to lose reaction counts on non-pt/en UIs.
const COUNT_UNITS = {
  k: 1e3, mil: 1e3, rb: 1e3, tis: 1e3, tys: 1e3, tusen: 1e3,
  m: 1e6, mi: 1e6, mio: 1e6, jt: 1e6, mln: 1e6,
  b: 1e9, mrd: 1e9, bi: 1e9,
};

/**
 * Parse a localized count string into a number, or null.
 *   "14 mil" -> 14000   "1,5 mil" -> 1500   "1.2M" -> 1200000   "543" -> 543
 * When a unit word/suffix is present the numeric part is a small decimal, so a
 * comma is the decimal separator (pt-br "1,5"). Without a unit the value is a
 * plain integer whose separators are thousands groups and are stripped.
 */
function parseCount(text) {
  if (text == null) return null;
  const s = String(text).trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/^([\d.,]+)([a-zçã]+)?$/);
  if (!m) return null;
  const rawNum = m[1];
  const unitWord = m[2] || "";
  const mult = unitWord ? COUNT_UNITS[unitWord] : 1;
  if (unitWord && mult == null) return null; // unknown suffix → not a count
  let num;
  if (mult === 1) {
    // Plain integer: strip thousands separators (either "." or ",").
    num = parseInt(rawNum.replace(/[.,]/g, ""), 10);
  } else {
    // Abbreviated decimal: last separator is the decimal point.
    const norm = rawNum.replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    num = parseFloat(norm);
  }
  if (!Number.isFinite(num)) return null;
  return Math.round(num * mult);
}

// Display formatting. 964490 -> "964.5K". Null renders as an em dash rather than
// "0" — an unknown count and a zero count are different facts. Counts are stored
// raw and formatted here at render time.
function fmtCount(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
// >>> inline:end

// <<< inline:src/lib/shared/savedEntry.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/savedEntry.js and run `npm run gen:inline`.
// The ONE shape of a saved-Library record, and the permalink rules behind it.
// INLINED into content scripts — see src/lib/shared/README.md before editing
// (no imports allowed in this file).
//
// This exists because `fbw_saved` used to be written from ten places (six panel
// tools, three page overlays, the transcription rail) with five different shapes:
//
//   * counts were pre-formatted strings, sometimes via an UNGUARDED fmtCount(null)
//     (so whatever that returned got persisted instead of null), and Pinterest
//     stored the literal string "—" for views where everything else stored null;
//   * `sourceUrl` was present in some and absent in others, and VideoCard falls
//     back to `facebook.com/reel/<id>` when it's missing — a dead link for a
//     TikTok or Pinterest item;
//   * TikTok stored a signed, expiring CDN URL as `thumb`.
//
// Counts are stored as RAW NUMBERS (or null) — never formatted. Formatting is a
// render-time concern, and storing numbers keeps the Library sortable. VideoCard
// tolerates strings for records written before schema 2.

const SAVED_SCHEMA = 2;

// Absolute permalink back to the item, per platform. Centralized because a
// missing sourceUrl silently degrades into a wrong Facebook link.
function savedSourceUrl(platform, { code, id, username } = {}) {
  const key = code || id;
  switch (platform) {
    case "instagram":
      return key ? `https://www.instagram.com/p/${key}/` : null;
    case "tiktok":
      return username && id ? `https://www.tiktok.com/@${username}/video/${id}` : null;
    case "facebook":
      return key ? `https://www.facebook.com/reel/${key}` : null;
    case "pinterest":
      return key ? `https://www.pinterest.com/pin/${key}/` : null;
    default:
      return null;
  }
}

// Profile URL. FB/IG are stored relative (VideoCard prepends the origin);
// TikTok/Pinterest are absolute, and prepending an origin to those would nest one
// URL inside another and produce a dead link.
function savedAuthorUrl(platform, username) {
  if (!username) return null;
  switch (platform) {
    case "instagram":
      return `/${username}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${username}`;
    case "pinterest":
      return `https://www.pinterest.com/${username}/`;
    case "facebook":
      return null; // FB reels grids expose no reliable author URL
    default:
      return null;
  }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Build a Library record. `id` and `platform` are required; everything else
 * degrades to null rather than to a wrong value.
 *
 * counts: { like, comment, view, share, save } — raw numbers or null.
 * Pass `sourceUrl` to override the derived permalink (Pinterest carries its own).
 */
function buildSavedEntry({
  id,
  platform,
  thumb = null,
  caption = null,
  authorName = null,
  username = null,
  authorUrl,
  counts = {},
  code = null,
  pk = null,
  mediaType = null,
  sourceUrl,
  now = Date.now(),
} = {}) {
  if (!id || !platform) return null;
  return {
    schema: SAVED_SCHEMA,
    videoId: String(id),
    platform,
    thumb: thumb || null,
    caption: caption || null,
    author: {
      name: authorName || username || "desconhecido",
      url: authorUrl !== undefined ? authorUrl : savedAuthorUrl(platform, username),
    },
    // `views` keeps its legacy key so existing VideoCard markup is unchanged.
    counts: {
      like: num(counts.like),
      comment: num(counts.comment),
      views: num(counts.view ?? counts.views),
      share: num(counts.share),
      save: num(counts.save),
    },
    code: code || null,
    pk: pk || null,
    media_type: mediaType || null,
    sourceUrl:
      sourceUrl !== undefined
        ? sourceUrl
        : savedSourceUrl(platform, { code, id, username }),
    updatedAt: now,
  };
}
// >>> inline:end

  async function ttSave(rec) {
    const entry = buildSavedEntry({
      id: rec.id,
      platform: "tiktok",
      thumb: rec.cover || rec.dynamic_cover || null,
      caption: rec.desc || null,
      authorName: rec.username || rec.nickname || null,
      username: rec.username || null,
      counts: {
        like: rec.digg_count,
        comment: rec.comment_count,
        view: rec.play_count,
        share: rec.share_count,
        save: rec.collect_count,
      },
      code: rec.id,
    });
    if (!entry) throw new Error("registro sem id");
    const res = await chrome.runtime.sendMessage({ type: "FBW_SAVED_TOGGLE", entry });
    if (!res || res.ok === false) throw new Error(res?.error || "falha ao salvar");
    return res.saved;
  }
  // Returns only after the background has actually answered: its { ok:false }
  // reply used to be dropped, so a failed download still flashed green.
  async function ttDownload(rec) {
    // Always the highest-quality rendition available.
    const url = rec.hd_url || rec.download_url || rec.video;
    if (!url) return false;
    try {
      const res = await chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", platform: "tiktok", kind: "video", url, filename: ttName(rec, ext(url, "video")) });
      return !(!res || res.ok === false);
    } catch {
      return false;
    }
  }
  function ttTranscribe(rec) {
    if (!rec.video && !rec.subtitle) return false;
    chrome.runtime.sendMessage({
      type: "FBW_TRANSCRIBE", videoId: rec.id, mediaUrl: rec.video, platform: "tiktok",
      // Caption-first: if TikTok ships an ASR track, transcribe from it (no Whisper).
      captionUrl: rec.subtitle && rec.subtitle.url ? rec.subtitle.url : null,
      captionFormat: rec.subtitle && rec.subtitle.format ? rec.subtitle.format : null,
      caption: rec.desc || null,
      author: { name: rec.username || rec.nickname || "unknown", url: rec.username ? `https://www.tiktok.com/@${rec.username}` : null },
      thumb: rec.cover || rec.dynamic_cover || null,
      sourceUrl: rec.username ? `https://www.tiktok.com/@${rec.username}/video/${rec.id}` : null,
      // Raw numbers — VideoCard formats at render time (schema 2).
      counts: { like: rec.digg_count ?? null, comment: rec.comment_count ?? null, views: rec.play_count ?? null },
    }).catch(() => {});
    return true;
  }
  function nativeClick(el) {
    if (!el) return false;
    const b = el.closest('button,[role="button"],a') || el;
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    b.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    b.click();
    return true;
  }
  function ttLike() {
    const el = document.querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"]');
    return nativeClick(el);
  }
  // Open the comment panel and auto-scroll it a few times so the passive fetch hook
  // bulk-captures the thread (top-level + reply pages) into the store.
  async function ttScrape() {
    const open = document.querySelector('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]');
    if (open) nativeClick(open);
    await new Promise((r) => setTimeout(r, 900));
    const box = document.querySelector('[data-e2e="comment-list"], [class*="CommentListContainer"], [class*="DivCommentListContainer"]');
    for (let i = 0; i < 8; i++) {
      if (box) box.scrollTop = box.scrollHeight;
      else window.scrollBy(0, 700);
      // expand a couple of "view replies" toggles if present
      document.querySelectorAll('[data-e2e="view-more-1"], [class*="DivViewRepliesContainer"] span').forEach((n, idx) => { if (idx < 4) nativeClick(n); });
      await new Promise((r) => setTimeout(r, 650));
    }
    return true;
  }

  let overlayTimer = null;
  function scheduleOverlay() {
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(maintainOverlay, 250);
  }
  function buildOverlay() {
    ensureStyle();
    const wrap = document.createElement("div");
    wrap.id = "sw-tt-acts";
    const mk = (name, tip, fn) => {
      const b = document.createElement("button");
      b.className = "sw-ttbtn";
      b.type = "button";
      b.dataset.act = name;
      b.setAttribute("data-tip", tip);
      b.innerHTML = icon(name);
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(b); });
      return b;
    };
    wrap.appendChild(mk("save", "Salvar na Biblioteca", async (b) => {
      const rec = currentRecord(); if (!rec) return flash(b, "err");
      try {
        const saved = await ttSave(rec);
        b.classList.toggle("on", saved);
        flash(b, "ok");
      } catch (e) {
        flash(b, "err");
        console.warn("[fbw] tt save failed", e);
      }
    }));
    wrap.appendChild(mk("dl", "Baixar vídeo", async (b) => flash(b, (await ttDownload(currentRecord() || {})) ? "ok" : "err")));
    wrap.appendChild(mk("tx", "Transcrever", (b) => flash(b, ttTranscribe(currentRecord() || {}) ? "ok" : "err")));
    wrap.appendChild(mk("msg", "Coletar comentários", async (b) => { await ttScrape(); flash(b, "ok"); }));
    wrap.appendChild(mk("heart", "Curtir", (b) => flash(b, ttLike() ? "ok" : "err")));
    return wrap;
  }
  function maintainOverlay() {
    if (disabled || document.visibilityState !== "visible") return;
    // ONE layout pass per tick: mostCenteredVideo() reads a rect per <video>, and it
    // used to run twice (once here, once inside currentAwemeId()). Resolve it here
    // and thread it down.
    const centered = mostCenteredVideo();
    const onVideo = /\/video\/\d+/.test(location.pathname) || location.pathname.startsWith("/foryou") || location.pathname === "/" || !!centered;
    let wrap = document.getElementById("sw-tt-acts");
    if (!onVideo) { if (wrap) wrap.remove(); return; }
    if (!wrap) { wrap = buildOverlay(); (document.body || document.documentElement).appendChild(wrap); }
    // Reflect saved state + enable/disable media actions for the current record.
    const rec = currentRecord(centered);
    const sb = wrap.querySelector('[data-act="save"]');
    if (sb) sb.classList.toggle("on", !!(rec && savedIds.has(rec.id))); // mirrored, no storage read
    const hasMedia = !!(rec && (rec.video || rec.download_url));
    for (const act of ["dl", "tx"]) {
      const b = wrap.querySelector(`[data-act="${act}"]`);
      if (b) b.toggleAttribute("disabled", !hasMedia);
    }
  }
  const overlayInterval = setInterval(maintainOverlay, 2000);
  window.addEventListener("scroll", scheduleOverlay, { passive: true });
  document.addEventListener("visibilitychange", scheduleOverlay);
  scheduleOverlay();
}
