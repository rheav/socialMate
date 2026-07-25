// FB Reels-tab capture — isolated content script.
//
// Facebook's profile reels grid paginates OFF the main thread (a JSON.parse hook
// captures nothing — verified live), so unlike Instagram we read the grid tiles
// straight from the DOM: reel id, thumbnail, and the localized VIEW COUNT text.
// The first batch's comment/share counts are enriched from the initial embedded
// <script type="application/json"> blocks. Likes/reactions aren't on the grid at
// all. The tool serves this as a sortable list to the side panel; no on-page UI.
//
// Import-free (like ig/bridge.js): FB's CSP can break a CRXJS module loader, so
// this stays a direct content script. parseCount mirrors src/lib/fbReels.js
// (which is the unit-tested source of truth).

if (location.hostname.endsWith("facebook.com") && !window.__fbwFbReelsInit) {
  window.__fbwFbReelsInit = true;

  const UNIT = {
    k: 1e3, mil: 1e3, rb: 1e3, tis: 1e3, tys: 1e3, tusen: 1e3,
    m: 1e6, mi: 1e6, mio: 1e6, jt: 1e6, mln: 1e6,
    b: 1e9, mrd: 1e9, bi: 1e9,
  };
  function parseCount(text) {
    if (text == null) return null;
    const s = String(text).trim().toLowerCase().replace(/\s+/g, "");
    if (!s) return null;
    const m = s.match(/^([\d.,]+)([a-zçã]+)?$/);
    if (!m) return null;
    const unitWord = m[2] || "";
    const mult = unitWord ? UNIT[unitWord] : 1;
    if (unitWord && mult == null) return null;
    let num;
    if (mult === 1) num = parseInt(m[1].replace(/[.,]/g, ""), 10);
    else num = parseFloat(m[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
    return Number.isFinite(num) ? Math.round(num * mult) : null;
  }

  const isReelsTab = () =>
    /[?&]sk=reels_tab/.test(location.search) ||
    /reels_tab/.test(location.href) ||
    /\/reels(\/|$)/.test(location.pathname);

  // The reels-tab has no <h1>; the profile name is a span inside a link back to
  // this same profile. Resolve the profile identifier from the URL (id= or the
  // vanity path segment), then take the highest name-like link that points to
  // it. Skips the follower/tab links that also point at the profile.
  const TAB_WORDS = /^(tudo|sobre|reels|fotos|mais|amigos|seguidores|posts|about|photos|more|friends|followers|videos|v[íi]deos)$/i;
  function ownerName() {
    const u = new URL(location.href);
    let key = u.searchParams.get("id");
    if (!key) {
      const m = u.pathname.match(/^\/([^/]+)/);
      if (m && m[1] !== "profile.php") key = m[1];
    }
    const main = document.querySelector('[role="main"]') || document;
    let best = null;
    for (const a of main.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (key && href.indexOf(key) < 0) continue;
      let t = (a.textContent || "").replace(/\s+/g, " ").trim();
      t = t.replace(/\s*(conta verificada|verified account)$/i, "").trim();
      if (!t || t.length < 2 || t.length > 50) continue;
      if (TAB_WORDS.test(t) || /seguidor|follower|seguindo|following|\d/.test(t)) continue;
      const top = a.getBoundingClientRect().top;
      if (!best || top < best.top) best = { t, top };
    }
    return best ? best.t.slice(0, 60) : null;
  }

  // Grid tiles: <a href="/reel/ID"> with an <img> thumbnail and the view-count
  // text. Size-gated to skip the tab-bar "Reels" link and other small anchors.
  function scanTiles() {
    const out = new Map();
    for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
      const r = a.getBoundingClientRect();
      if (r.width < 100 || r.height < 150) continue;
      const id = (a.getAttribute("href").match(/\/reel\/(\d+)/) || [])[1];
      if (!id) continue;
      const img = a.querySelector("img");
      const thumb = (img && (img.currentSrc || img.src)) || null;
      const viewText = (a.innerText || "").trim().split("\n")[0].trim();
      const views = parseCount(viewText);
      const prev = out.get(id) || {};
      out.set(id, {
        id,
        thumb: thumb || prev.thumb || null,
        views: views != null ? views : prev.views ?? null,
        viewText: viewText || prev.viewText || null,
      });
    }
    return out;
  }

  // Enrich the first batch from embedded JSON: each reel node carries a
  // `feedback` object (total_comment_count, share_count_reduced) and a `url`
  // that names the reel id. Paginated reels aren't here (off-thread) → null.
  function scanEmbeddedStats(ids) {
    const map = {};
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent || "";
      if (t.indexOf("total_comment_count") < 0) continue;
      let data;
      try { data = JSON.parse(t); } catch { continue; }
      (function walk(o, depth) {
        if (!o || typeof o !== "object" || depth > 32) return;
        if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
        if (o.feedback && o.url) {
          const rid = (String(o.url).match(/\/reel\/(\d+)/) || [])[1];
          if (rid && ids.has(rid) && !map[rid]) {
            const fb = o.feedback;
            map[rid] = {
              comments: fb.total_comment_count != null ? Number(fb.total_comment_count) : null,
              shares: fb.share_count_reduced != null ? parseInt(fb.share_count_reduced, 10) : null,
            };
          }
        }
        for (const k in o) walk(o[k], depth + 1);
      })(data, 0);
    }
    return map;
  }

  function collect() {
    const tiles = scanTiles();
    const stats = scanEmbeddedStats(new Set(tiles.keys()));
    const records = [];
    for (const [id, rec] of tiles) {
      const st = stats[id] || {};
      records.push({
        id,
        thumb: rec.thumb,
        views: rec.views,
        viewText: rec.viewText,
        comments: st.comments ?? null,
        shares: st.shares ?? null,
        taken_at: null,
      });
    }
    return records;
  }

  // Auto-scroll the lazy grid to the bottom until it stops growing, then collect
  // every tile. FB's grid is scroll-driven, so this is the only way to get the
  // full reel list (the initial DOM holds ~20).
  async function harvest() {
    // FB appends the next batch after a network round-trip, which lags a short
    // poll — so wait generously per step and require several consecutive
    // no-growth reads before calling it done (a single slow batch mustn't end it).
    let stable = 0, prev = -1;
    for (let i = 0; i < 80 && stable < 5; i++) {
      window.scrollTo({ top: document.body.scrollHeight });
      await new Promise((r) => setTimeout(r, 1400));
      const n = document.querySelectorAll('a[href*="/reel/"]').length;
      stable = n === prev ? stable + 1 : 0;
      prev = n;
    }
    window.scrollTo({ top: 0 });
    await new Promise((r) => setTimeout(r, 400));
    return collect();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FBW_FB_REELS_LIST") {
      sendResponse({ records: collect(), owner: ownerName(), onReelsTab: isReelsTab() });
      return; // sync
    }
    if (msg?.type === "FBW_FB_REELS_HARVEST") {
      harvest().then((records) =>
        sendResponse({ records, owner: ownerName(), onReelsTab: isReelsTab() }),
      );
      return true; // async
    }
  });
}
