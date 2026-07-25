// FB profile-photos harvester — ISOLATED content script.
//
// Two jobs in one file, exactly like tt-relay.js is to tt-capture.js:
//   1. RELAY. It receives the MAIN-world capture (src/content/fb/photos-capture.js)
//      over window.postMessage and can ask it to replay its buffer, because this
//      world attaches at document_idle — after capture has already started.
//   2. HARVEST. It scrolls the Photos grid, which is the ONLY thing needed to
//      make Facebook request the next page of photos, then joins each grid tile
//      to the captured full-size URL and hands the result to the panel's "Fotos"
//      tool, which packs it into a ZIP.
//
// THE FULL IMAGE IS FREE. A photos-grid GraphQL row carries `image.uri` (the
// SQUARE CROP the tile paints) AND `viewer_image.uri` (the FULL, UNCROPPED photo,
// with its real width/height). See photos-capture.js for the measurements. So
// this file no longer opens photos in the theater lightbox, no longer clicks
// anything, and never navigates the tab: collection costs exactly what paging
// the grid costs. The previous design walked the lightbox for ~57 s to get the
// same pixels.
//
// A tile whose GraphQL row was never seen has NO full URL, and this file will not
// substitute the cropped thumbnail for it. It stays unresolved, is counted, and
// the panel says so. (`thumb` is still kept — it is the grid preview the panel
// renders, and its fbcdn stem is the fallback join key.)
//
// Import-free on purpose, like reels-capture.js / comments-scrape.js: Facebook's
// CSP can break a CRXJS module loader on this origin. The helpers below mirror
// src/lib/fbPhotos.js, which is the unit-tested source of truth — change both.

if (location.hostname.endsWith("facebook.com") && !window.__fbwFbPhotosInit) {
  window.__fbwFbPhotosInit = true;

  // ---- generation takeover. An extension reload leaves the OLD world's timers
  // running (only its chrome.* dies), so a newer generation announces itself and
  // the older one stands down instead of both driving the same page.
  const GEN = Date.now() + ":" + Math.random();
  let disabled = false;
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__fbwPhTakeover && e.data.__fbwPhTakeover !== GEN && !disabled) {
      disabled = true;
      cancelFlag = true;
    }
  });
  window.postMessage({ __fbwPhTakeover: GEN }, "*");

  // ============================================================
  // caps — every one of these is surfaced in the panel, never a silent truncation
  // ============================================================
  const MAX_SCROLLS = 60;        // ≈85 s of grid paging; enough for several hundred tiles
  const SCROLL_STABLE = 5;       // consecutive no-growth reads before the grid is "done"
  const SCROLL_STEP_MS = 1400;   // FB appends the next batch after a network round-trip
  const MAX_PHOTOS = 300;        // photos kept per run
  const MAX_CAPTURED = 800;      // captured GraphQL rows held for joining
  const TILE_MIN_PX = 60;        // below this an <a href*="fbid="> is page chrome, not a tile
  // After the grid stops growing, give the capture a couple of chances to hand
  // over rows this world had not received yet (it attached late, or a hydration
  // block landed during an SPA navigation). This is the "resolve it" half of the
  // unresolved-photo policy; whatever survives it is reported, not faked.
  const RESOLVE_PASSES = 2;
  const RESOLVE_WAIT_MS = 800;

  // ============================================================
  // pure helpers (mirror of src/lib/fbPhotos.js)
  // ============================================================
  const fbidFromHref = (href) => (String(href || "").match(/[?&#]fbid=(\d+)/) || [])[1] || null;
  const setFromHref = (href) => {
    const m = String(href || "").match(/[?&#]set=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  function ownerKeyFromUrl(href) {
    try {
      const u = new URL(String(href), "https://www.facebook.com");
      const id = u.searchParams.get("id");
      if (id) return id;
      const seg = u.pathname.split("/").filter(Boolean)[0] || null;
      if (!seg || seg === "profile.php" || seg === "photo" || seg === "photo.php") return null;
      return /^[A-Za-z0-9.-]+$/.test(seg) ? seg : null;
    } catch {
      return null;
    }
  }
  function ownerNameFromTitle(title) {
    const t = String(title || "").replace(/^\(\d+\+?\)\s*/, "").replace(/\s*[|·]\s*Facebook\s*$/i, "").trim();
    if (!t || /^facebook$/i.test(t)) return null;
    const m = t.match(/^(?:fotos?|photos?)\s+(?:de|do|da|of)\s+(.+)$/i);
    const name = (m ? m[1] : t).trim();
    return name ? name.slice(0, 60) : null;
  }
  function isPhotosSurface(href) {
    try {
      const u = new URL(String(href), "https://www.facebook.com");
      if (/(^|&)sk=photos/.test(u.search.slice(1))) return true;
      return /\/photos(_[a-z]+)?\/?$/.test(u.pathname);
    } catch {
      return false;
    }
  }
  // All renditions of one photo share this fbcdn filename stem, so it joins a
  // grid tile's <img src> to the captured viewer_image URI even if Facebook ever
  // stops using the fbid as the GraphQL node id.
  const photoBaseFromUrl = (url) =>
    (String(url || "").match(/\/(\d+_\d+_\d+)_[a-z]\.(?:jpg|jpeg|png|webp|gif)/i) || [])[1] || null;
  // Which cap has bitten, or null. Mirrors fbPhotos.js `harvestCap` — the caps
  // themselves are unreachable on a real profile (43 photos against 300), so the
  // exported twin is where they are actually exercised.
  function harvestCap({ photos = 0, scrolls = 0, growing = false }) {
    if (photos >= MAX_PHOTOS) return "photos";
    if (scrolls >= MAX_SCROLLS && growing) return "scroll";
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ============================================================
  // live state (read by FBW_FBPHOTOS_STATE)
  // ============================================================
  // fbid -> { fbid, set, thumb, full, width, height, permalink }
  //   thumb — the grid tile's own image: a square CROP most of the time, kept
  //           only as a preview and as a join key. Never downloaded as "the photo".
  //   full  — viewer_image.uri: the whole frame. Absent ⇒ unresolved, and it stays
  //           absent rather than quietly falling back to `thumb`.
  let store = new Map();
  let scraping = false;
  let cancelFlag = false;
  let phase = "idle";    // idle | scrolling | resolving | done
  let scrolls = 0;
  let lastError = null;
  let hitCap = false;    // a cap stopped the run while work remained
  let capReason = null;  // "scroll" | "photos" — which cap, so the panel can say which
  let surfaceKey = null; // profile key the store belongs to
  let generation = 0;

  const ownerName = () => ownerNameFromTitle(document.title);

  function upsert(fbid, patch) {
    const cur = store.get(fbid) || { fbid, set: null, thumb: null, full: null, width: null, height: null, permalink: null };
    for (const k of Object.keys(patch)) if (patch[k] != null) cur[k] = patch[k];
    if (!cur.permalink && cur.fbid) {
      cur.permalink = `https://www.facebook.com/photo/?fbid=${cur.fbid}` + (cur.set ? `&set=${encodeURIComponent(cur.set)}` : "");
    }
    store.set(fbid, cur);
    return cur;
  }

  // ============================================================
  // relay — the MAIN-world capture (photos-capture.js) posts here
  // ============================================================
  const capById = new Map();   // GraphQL node id (== fbid) -> captured row
  const capByStem = new Map(); // fbcdn filename stem -> captured row

  function rememberCaptured(rows) {
    let added = 0;
    for (const r of rows || []) {
      if (!r || !r.id || !r.full) continue;
      capById.set(String(r.id), r);
      const stem = photoBaseFromUrl(r.thumb) || photoBaseFromUrl(r.full);
      if (stem) capByStem.set(stem, r);
      added++;
    }
    while (capById.size > MAX_CAPTURED) capById.delete(capById.keys().next().value);
    while (capByStem.size > MAX_CAPTURED) capByStem.delete(capByStem.keys().next().value);
    if (added) applyCaptured();
  }

  // id first (it IS the fbid), the thumbnail's fbcdn stem second.
  function captureFor(rec) {
    const byId = capById.get(String(rec.fbid));
    if (byId) return byId;
    const stem = rec.thumb ? photoBaseFromUrl(rec.thumb) : null;
    return (stem && capByStem.get(stem)) || null;
  }

  function applyCaptured() {
    for (const rec of store.values()) {
      if (rec.full) continue;
      const hit = captureFor(rec);
      if (hit) {
        rec.full = hit.full;
        rec.width = hit.width;
        rec.height = hit.height;
      }
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__fbwFbPh || disabled) return;
    rememberCaptured(e.data.records);
  });

  let lastReplayReq = 0;
  function requestReplay(force) {
    const now = Date.now();
    if (!force && now - lastReplayReq < 600) return;
    lastReplayReq = now;
    window.postMessage({ __fbwFbPhReq: true }, location.origin);
  }
  // The capture started at document_start; catch up on whatever it already holds.
  requestReplay();
  setTimeout(() => requestReplay(true), 900);
  setTimeout(() => requestReplay(true), 2200);

  const unresolvedCount = () => {
    let n = 0;
    for (const rec of store.values()) if (!rec.full) n++;
    return n;
  };

  // ============================================================
  // grid
  // ============================================================
  // Every photo tile currently mounted, in visual order. `[role="main"]` scopes
  // out the left rail / notification jewel; the size gate drops the tab-strip and
  // any other small anchor that happens to carry an fbid.
  function scanTiles() {
    const main = document.querySelector('[role="main"]');
    if (!main) return [];
    const out = [];
    const seen = new Set();
    for (const a of main.querySelectorAll('a[href*="fbid="]')) {
      const href = a.getAttribute("href") || "";
      const fbid = fbidFromHref(href);
      if (!fbid || seen.has(fbid)) continue;
      const r = a.getBoundingClientRect();
      if (r.width < TILE_MIN_PX || r.height < TILE_MIN_PX) continue;
      const img = a.querySelector("img");
      const src = img && (img.currentSrc || img.src);
      seen.add(fbid);
      out.push({ fbid, set: setFromHref(href), thumb: src && !/^data:/.test(src) ? src : null });
    }
    return out;
  }

  function ingestTiles() {
    const tiles = scanTiles();
    for (const t of tiles) {
      // The photo cap bites HERE: the store is the only thing that grows now, so
      // this is the single place a truncation can happen. Reported, never silent.
      if (!store.has(t.fbid) && harvestCap({ photos: store.size })) {
        hitCap = true;
        capReason = "photos";
        break;
      }
      upsert(t.fbid, { set: t.set, thumb: t.thumb });
    }
    applyCaptured(); // rows for these tiles may already be in hand
    return tiles.length;
  }

  // Auto-scroll the lazy grid until it stops growing. Scrolling is the WHOLE
  // collection mechanism now: each page of tiles Facebook appends is a GraphQL
  // response the MAIN-world capture tees, full image included. Same shape as
  // reels-capture.js's harvest(): generous per-step wait plus a stability
  // counter, because a single slow batch must not be mistaken for the end.
  async function scrollGrid(gen) {
    phase = "scrolling";
    const startY = window.scrollY;
    let stable = 0;
    let prev = -1;
    for (scrolls = 0; scrolls < MAX_SCROLLS && stable < SCROLL_STABLE; scrolls++) {
      if (cancelFlag || gen !== generation) break;
      if (hitCap && capReason === "photos") break; // the store filled up mid-scroll
      window.scrollTo({ top: document.body.scrollHeight });
      await sleep(SCROLL_STEP_MS);
      const n = ingestTiles();
      stable = n === prev ? stable + 1 : 0;
      prev = n;
    }
    // More tiles were still arriving when the scroll budget ran out. `growing`
    // is the whole point: reaching MAX_SCROLLS on a grid that had already
    // stopped growing is not a truncation and must not be reported as one.
    if (!hitCap && harvestCap({ scrolls, growing: stable < SCROLL_STABLE }) === "scroll") { hitCap = true; capReason = "scroll"; }
    window.scrollTo({ top: startY });
    await sleep(400);
    ingestTiles();
  }

  // Ask the capture to replay (and to re-sweep the server-rendered hydration
  // blocks, which is where the FIRST page of the grid lives — it is never
  // requested, so no network hook can see it). Anything still without a `full`
  // after this is genuinely unresolved and gets reported as such.
  async function resolveGaps(gen) {
    phase = "resolving";
    for (let i = 0; i < RESOLVE_PASSES; i++) {
      if (cancelFlag || gen !== generation || !unresolvedCount()) return;
      requestReplay(true);
      await sleep(RESOLVE_WAIT_MS);
      applyCaptured();
    }
  }

  async function run() {
    if (disabled || scraping) return;
    const gen = ++generation;
    const key = ownerKeyFromUrl(location.href);
    // A different profile than the one in the store means the panel is looking at
    // new data; keep nothing from the old one.
    if (surfaceKey && surfaceKey !== key) store = new Map();
    surfaceKey = key;

    scraping = true;
    cancelFlag = false;
    hitCap = false;
    capReason = null;
    lastError = null;
    scrolls = 0;
    try {
      if (!isPhotosSurface(location.href))
        throw new Error("Abra a aba Fotos do perfil (…&sk=photos) e tente de novo.");
      ingestTiles();
      await scrollGrid(gen);
      if (!cancelFlag && gen === generation) await resolveGaps(gen);
      phase = cancelFlag ? "idle" : "done";
    } catch (e) {
      lastError = e.message || String(e);
      phase = "idle";
    } finally {
      if (gen === generation) scraping = false;
    }
  }

  // ============================================================
  // messages — same request/response shape as pin-api.js
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FBW_FBPHOTOS_CONTEXT") {
      sendResponse({
        ok: true,
        onPhotos: isPhotosSurface(location.href),
        owner: ownerName(),
        ownerKey: ownerKeyFromUrl(location.href),
        tiles: scanTiles().length,
        url: location.href,
      });
      return; // sync
    }

    if (msg?.type === "FBW_FBPHOTOS_SCRAPE") {
      run();
      sendResponse({ started: true });
      return;
    }

    if (msg?.type === "FBW_FBPHOTOS_STATE") {
      sendResponse({
        records: Array.from(store.values()),
        scraping,
        phase,
        scrolls,
        captured: capById.size,
        hitCap,
        capReason,
        error: lastError,
        owner: ownerName(),
        ownerKey: surfaceKey,
        caps: { photos: MAX_PHOTOS, scrolls: MAX_SCROLLS },
      });
      return;
    }

    if (msg?.type === "FBW_FBPHOTOS_STOP") {
      cancelFlag = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "FBW_FBPHOTOS_CLEAR") {
      store = new Map();
      generation++;
      cancelFlag = true;
      scraping = false;
      phase = "idle";
      scrolls = 0;
      hitCap = false;
      capReason = null;
      lastError = null;
      surfaceKey = null;
      sendResponse({ ok: true });
      return;
    }
  });
}
