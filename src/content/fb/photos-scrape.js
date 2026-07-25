// FB profile-photos harvester — isolated content script.
//
// Collects every photo tile on a profile's Photos tab and then resolves each one
// to a FULL-RESOLUTION fbcdn URL, which the side panel's "Fotos" tool packs into
// a ZIP. No on-page UI; everything is driven by FBW_FBPHOTOS_* messages from the
// panel, mirroring the request/response shape of src/content/pin/pin-api.js.
//
// WHY this has to automate the page instead of reading an API (all verified live
// on a real profile, 2026-07-25 — see src/lib/fbPhotos.js for the long version):
//   • a grid tile's <img> is a 414×414 thumbnail, with no srcset;
//   • the CDN URL cannot be widened — fbcdn signs the `stp=` transform inside the
//     `oh=` HMAC, so dropping it or forcing `stp=dst-jpg` both answer 403;
//   • the permalink is useless — GET /photo/?fbid=… returns ~1 MB of HTML with
//     ZERO `scontent` URLs (same for /photo/download/?fbid=…), because Facebook
//     fetches photo media over GraphQL after hydration.
// The theater viewer IS the source: opening a photo loads a large
// <img data-visualcompletion="media-vc-image">, and its "next photo" control
// advances the whole set with a pushState — no page load, ~100 ms per step
// because Facebook preloads the neighbours. Walking the set is therefore far
// cheaper than reopening tiles one at a time, and it is the primary strategy
// below; reopening a tile is only the recovery path when a stream ends or stalls.
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
  const MAX_PHOTOS = 300;        // photos resolved per run
  const MAX_STEPS = 420;         // theater advances per run (guards a looping set)
  const NEXT_TIMEOUT_MS = 6000;  // give up on one "next" and re-anchor from the grid
  const TILE_MIN_PX = 60;        // below this an <a href*="fbid="> is page chrome, not a tile

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
  const photoBaseFromUrl = (url) =>
    (String(url || "").match(/\/(\d+_\d+_\d+)_[a-z]\.(?:jpg|jpeg|png|webp|gif)/i) || [])[1] || null;
  function parseBoxFromUrl(url) {
    const s = String(url || "");
    const m =
      s.match(/[?&]cstp=mx(\d+)x(\d+)/) || s.match(/[?&]ctp=s(\d+)x(\d+)/) || s.match(/[?&]stp=[^&]*?_s(\d+)x(\d+)/);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }
  function pickBest(candidates) {
    let best = null;
    let bestArea = -1;
    for (const c of candidates || []) {
      if (!c || !c.url) continue;
      let w = Number(c.width) || 0;
      let h = Number(c.height) || 0;
      if (!w || !h) {
        const box = parseBoxFromUrl(c.url);
        if (box) { w = box.width; h = box.height; }
      }
      const area = w * h;
      if (area > bestArea) { best = { url: c.url, width: w || null, height: h || null }; bestArea = area; }
    }
    return best;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // House convention (see comments-scrape.js): a fixed base plus up to 350 ms of
  // jitter, so the click cadence never looks like a metronome.
  const jitter = (base) => base + Math.floor(Math.random() * 350);
  const contextAlive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  // ============================================================
  // live state (read by FBW_FBPHOTOS_STATE)
  // ============================================================
  let store = new Map(); // fbid -> { fbid, set, thumb, full, width, height, permalink }
  let scraping = false;
  let cancelFlag = false;
  let phase = "idle";    // idle | scrolling | walking | done
  let scrolls = 0;
  let steps = 0;
  let lastError = null;
  let hitCap = false;    // a cap stopped the run while work remained
  let capReason = null;  // "scroll" | "photos" | "steps" — which cap, so the panel can say which
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
      out.push({ el: a, fbid, set: setFromHref(href), thumb: src && !/^data:/.test(src) ? src : null });
    }
    return out;
  }

  function ingestTiles() {
    const tiles = scanTiles();
    for (const t of tiles) upsert(t.fbid, { set: t.set, thumb: t.thumb });
    return tiles.length;
  }

  // Auto-scroll the lazy grid until it stops growing. Same shape as
  // reels-capture.js's harvest(): generous per-step wait plus a stability counter,
  // because a single slow batch must not be mistaken for the end of the list.
  async function scrollGrid(gen) {
    phase = "scrolling";
    const startY = window.scrollY;
    let stable = 0;
    let prev = -1;
    for (scrolls = 0; scrolls < MAX_SCROLLS && stable < SCROLL_STABLE; scrolls++) {
      if (cancelFlag || gen !== generation) break;
      window.scrollTo({ top: document.body.scrollHeight });
      await sleep(SCROLL_STEP_MS);
      const n = ingestTiles();
      stable = n === prev ? stable + 1 : 0;
      prev = n;
    }
    // More tiles were still arriving when the scroll budget ran out.
    if (scrolls >= MAX_SCROLLS && stable < SCROLL_STABLE) { hitCap = true; capReason = "scroll"; }
    window.scrollTo({ top: startY });
    await sleep(400);
    ingestTiles();
  }

  // ============================================================
  // theater
  // ============================================================
  const theaterImg = () => document.querySelector('[data-visualcompletion="media-vc-image"]');
  const currentFbid = () => fbidFromHref(location.href);

  // aria-label first (exact, and the labels are stable), geometry second. The
  // label is localized, so the regex covers the languages this extension is used
  // in; the geometric fallback — the RIGHTMOST tall, thin [role="button"], which
  // is the full-height 32px hit strip the viewer paints down each edge — keeps
  // the walk working in a locale nobody listed.
  const NEXT_LABEL =
    /pr[óo]xim[ao]\s+(?:foto|imagem)|next\s+photo|foto\s+siguiente|siguiente\s+foto|photo\s+suivante|n[äa]chstes\s+foto|foto\s+successiva/i;
  function nextControl() {
    const buttons = [...document.querySelectorAll('[role="button"]')];
    const labelled = buttons.find((b) => NEXT_LABEL.test(b.getAttribute("aria-label") || ""));
    if (labelled) return labelled;
    let best = null;
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.width > 60 || r.height < window.innerHeight * 0.6) continue;
      if (!best || r.left > best.rect.left) best = { el: b, rect: r };
    }
    return best ? best.el : null;
  }

  // Read the best rendition of the photo on screen. All renditions of one photo
  // share an fbcdn filename stem, so every <img> with that stem is a candidate —
  // which is how the 414px grid thumbnail and the 1254px theater image get
  // compared instead of guessed between.
  function captureCurrent() {
    const el = theaterImg();
    if (!el || !el.src || !/scontent/.test(el.src)) return null;
    const base = photoBaseFromUrl(el.src);
    const candidates = [{ url: el.src, width: el.naturalWidth, height: el.naturalHeight }];
    if (base) {
      for (const img of document.querySelectorAll('img[src*="scontent"]')) {
        if (img === el || photoBaseFromUrl(img.src) !== base) continue;
        candidates.push({ url: img.src, width: img.naturalWidth, height: img.naturalHeight });
      }
    }
    return pickBest(candidates);
  }

  async function waitFor(test, timeout, step = 120) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (cancelFlag) return false;
      if (test()) return true;
      await sleep(step);
    }
    return false;
  }

  async function openTile(tile) {
    // A real bubbling click: React's own handler intercepts it and pushState's
    // into the theater. A plain location assignment would be a full page load and
    // would throw away the grid we just scrolled.
    tile.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return waitFor(() => !!theaterImg() && currentFbid() === tile.fbid, 8000);
  }

  async function closeTheater() {
    if (!theaterImg()) return;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    await waitFor(() => !theaterImg(), 4000);
  }

  // Advance inside the theater. Returns the new fbid, or null when the set ended
  // (no control), stalled, or looped back onto a photo we already walked.
  async function advance(seenIds) {
    const from = currentFbid();
    const fromSrc = theaterImg()?.src || "";
    const ctl = nextControl();
    if (ctl) ctl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    else {
      // Last resort — the viewer also answers the keyboard, which survives a DOM
      // rewrite that breaks both the label and the geometry heuristics.
      for (const t of [document, document.body]) {
        t.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true }));
      }
    }
    const moved = await waitFor(() => {
      const id = currentFbid();
      const img = theaterImg();
      return !!id && id !== from && !!img && img.src !== fromSrc;
    }, NEXT_TIMEOUT_MS);
    if (!moved) return null;
    const id = currentFbid();
    return seenIds.has(id) ? null : id;
  }

  // Walk every collected photo. The set the theater traverses is the same stream
  // the grid shows, so one open + N advances covers the whole tab; a profile whose
  // grid mixes streams (the cover photo and the profile picture live in their own
  // `set=a.…` albums) just costs one extra open each, because any tile still
  // unresolved after a stream ends becomes the next anchor.
  async function walk(gen) {
    phase = "walking";
    const walked = new Set();
    steps = 0;

    for (;;) {
      if (cancelFlag || gen !== generation || !contextAlive()) return;
      if (walked.size >= MAX_PHOTOS || steps >= MAX_STEPS) { hitCap = true; capReason = walked.size >= MAX_PHOTOS ? "photos" : "steps"; return; }

      // Re-scan each time: the grid is the authority on order, and the theater's
      // own pushState navigation can remount it.
      const tiles = scanTiles();
      const anchor = tiles.find((t) => !walked.has(t.fbid) && !store.get(t.fbid)?.full);
      if (!anchor) return; // everything the grid knows about is resolved

      if (!(await openTile(anchor))) {
        // Could not get into the theater for this tile — mark it walked so the
        // loop moves on instead of retrying it forever.
        walked.add(anchor.fbid);
        await closeTheater();
        continue;
      }

      // Advance through this stream until it ends, loops, or a cap stops us.
      for (;;) {
        if (cancelFlag || gen !== generation) { await closeTheater(); return; }
        const id = currentFbid();
        if (id) {
          walked.add(id);
          const best = captureCurrent();
          if (best) upsert(id, { full: best.url, width: best.width, height: best.height, set: setFromHref(location.href) });
        }
        steps++;
        if (walked.size >= MAX_PHOTOS || steps >= MAX_STEPS) { hitCap = true; capReason = walked.size >= MAX_PHOTOS ? "photos" : "steps"; await closeTheater(); return; }
        await sleep(jitter(420));
        const next = await advance(walked);
        if (!next) break;
      }
      await closeTheater();
      await sleep(jitter(500));
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
    steps = 0;
    scrolls = 0;
    try {
      if (!isPhotosSurface(location.href) && !theaterImg())
        throw new Error("Abra a aba Fotos do perfil (…&sk=photos) e tente de novo.");
      // While the theater is open the grid is still mounted but laid out at 0×0,
      // so every tile would fail the size gate. Always start from the grid.
      await closeTheater();
      ingestTiles();
      await scrollGrid(gen);
      if (!cancelFlag && gen === generation) await walk(gen);
      phase = cancelFlag ? "idle" : "done";
    } catch (e) {
      lastError = e.message || String(e);
      phase = "idle";
    } finally {
      await closeTheater().catch(() => {});
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
        inTheater: !!theaterImg(),
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
      // `el` is deliberately never stored — a DOM node cannot be structured-cloned
      // across the message boundary.
      sendResponse({
        records: Array.from(store.values()),
        scraping,
        phase,
        scrolls,
        steps,
        hitCap,
        capReason,
        error: lastError,
        owner: ownerName(),
        ownerKey: surfaceKey,
        caps: { photos: MAX_PHOTOS, scrolls: MAX_SCROLLS, steps: MAX_STEPS },
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
      steps = 0;
      hitCap = false;
      capReason = null;
      lastError = null;
      surfaceKey = null;
      sendResponse({ ok: true });
      return;
    }
  });
}
