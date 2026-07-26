import * as PIN from "../../lib/pinMedia.js"; // CRXJS bundles content-script imports
import { buildSavedEntry } from "../../lib/shared/savedEntry.js";

// Pinterest capture — the ONLY active-fetch platform in this extension.
//
// FB/IG/TikTok all capture passively (webRequest / JSON.parse hook / fetch tee)
// because their feed APIs are signed or issued off the main thread. Pinterest's
// /resource/* API is unsigned, cookie-authenticated and cursor-paginated, so we can
// simply call it ourselves from the page's own origin and walk the whole board —
// no scrolling, no MAIN-world hook, no bridge.
//
// Isolated world is fine: a same-origin fetch from a content script carries the
// page's cookies, including the httpOnly _auth/_pinterest_sess we can never read.
(() => {
  if (window.__fbwPinInit) return;
  window.__fbwPinInit = true;

  const APP_VERSION_FALLBACK = "d97c852"; // observed 2026-07-25; stale values still work

  let store = new Map();     // pin id -> record
  // Every other store in the extension is capped; this one was not, so a
  // multi-thousand-pin board held all of it (item URL lists included) for the tab's
  // lifetime. 4000 is comfortably above the 40-page × 25 harvest ceiling, so a
  // single run is never truncated — this only bounds many runs in one tab.
  const STORE_CAP = 4000;
  function capStore() {
    while (store.size > STORE_CAP) store.delete(store.keys().next().value);
  }
  let surfaceKey = null;
  let harvesting = false;
  let pages = 0;
  let done = false;          // true ONLY when the feed itself reported the end (env.isEnd)
  let hitCap = false;        // true when maxPages was exhausted while pins remained — NOT complete
  let lastError = null;
  let generation = 0;        // bumps on clear/surface change to abandon in-flight loops

  // Resume state for "Harvest again for more" (see harvest() below). Cleared
  // whenever the store itself is cleared, so a fresh surface always starts fresh.
  let lastBookmark = null;
  let lastSurfaceKey = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // #__PWS_DATA__ is Pinterest's whole SSR state blob — parsing it is not free, and
  // appVersion cannot change for the lifetime of the page, so parse it once and cache.
  let cachedAppVersion = null;
  function appVersion() {
    if (cachedAppVersion) return cachedAppVersion;
    try {
      cachedAppVersion = JSON.parse(document.querySelector("#__PWS_DATA__").textContent).appVersion || APP_VERSION_FALLBACK;
    } catch {
      cachedAppVersion = APP_VERSION_FALLBACK;
    }
    return cachedAppVersion;
  }

  // Boundary-anchored so a cookie whose name merely ENDS with csrftoken (e.g.
  // xcsrftoken) can't win the match if it happens to appear before the real one.
  const csrfToken = () => document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] || null;
  // _auth is httpOnly so we can't read it; its absence here proves nothing. The
  // reliable signal is whether the API answers, so treat a 403 as "log in".
  const looksLoggedIn = () => !!csrfToken();

  async function resourceGet(name, options, surface) {
    const url = PIN.resourceGetUrl(name, options, surface.sourceUrl);
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: PIN.resourceHeaders({ appVersion: appVersion(), sourceUrl: surface.sourceUrl, handler: surface.handler }),
    });
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    return PIN.parseEnvelope(await res.json());
  }

  async function resourcePost(name, options, surface) {
    const res = await fetch(`/resource/${name}/get/`, {
      method: "POST",
      credentials: "include",
      headers: {
        ...PIN.resourceHeaders({ appVersion: appVersion(), sourceUrl: surface.sourceUrl, handler: surface.handler, csrfToken: csrfToken() }),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        source_url: surface.sourceUrl,
        data: JSON.stringify({ options, context: {} }),
      }).toString(),
    });
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    return PIN.parseEnvelope(await res.json());
  }

  // The board id is NOT in the DOM on the current site — no #initial-state script, no
  // "board_id" in __PWS_DATA__, no board_id regex hit (all verified dead 2026-07-25).
  // BoardResource by username+slug is the only reliable lookup.
  async function fetchBoard(surface) {
    const env = await resourceGet(
      "BoardResource",
      { field_set_key: "profile_grid_item", is_mobile_fork: true, username: surface.username, slug: surface.slug },
      surface,
    );
    const b = env.data;
    if (!env.ok || !b?.id) throw new Error(env.error || "pasta não encontrada");
    return { id: b.id, name: b.name || surface.slug, url: b.url || `/${surface.username}/${surface.slug}/`, pin_count: b.pin_count ?? null, section_count: b.section_count ?? null };
  }

  async function fetchSections(board, surface) {
    try {
      const env = await resourceGet("BoardSectionsResource", { board_id: board.id, redux_normalize_feed: true }, surface);
      return (env.results || []).map((s) => ({ id: s.id, title: s.title, slug: s.slug, pin_count: s.pin_count ?? null }));
    } catch {
      return [];
    }
  }

  function ingest(pins, key) {
    for (const p of pins) {
      if (!p || p.type !== "pin" || !p.id) continue;   // feeds interleave "story" ad slots
      const rec = PIN.pinToRecord(p, key);
      if (!rec.items.length) continue;                  // nothing downloadable
      store.set(rec.id, rec);
    }
    capStore();
  }

  async function harvest(maxPages) {
    const gen = ++generation;
    const surface = PIN.surfaceOf(location.href);

    // The panel's Harvest is expected to start fresh on a new surface — but the
    // FBW_PIN_CONTEXT handler below only clears on a surface change every 5s, which
    // is far too slow to guard the natural flow: harvest board A, SPA-navigate to
    // board B (the panel still shows A), press Harvest within that window. Without
    // this, B's pins get folded straight into A's still-live store, and since
    // surfaceKey is about to be set to B's key below, the 5s poll never even notices
    // a change afterwards. Clear here too, keyed off the same surfaceKey the poll uses.
    if (surfaceKey !== surface.key) store = new Map();

    // Resume support ("Harvest again for more"): only pick up from lastBookmark when
    // this press is for the SAME surface as the run that stopped on the page cap.
    // Any other case — a different surface, a run that reached a genuine end
    // (env.isEnd), or no bookmark on record — starts fresh from page 1. `pages` is
    // cumulative across a resumed run so the counter reflects the whole harvest, not
    // just the latest maxPages-page slice.
    const resuming = surface.key === lastSurfaceKey && hitCap && lastBookmark != null;
    const bookmarkStart = resuming ? lastBookmark : null;
    if (!resuming) { pages = 0; lastBookmark = null; }
    surfaceKey = surface.key;
    lastSurfaceKey = surface.key;

    harvesting = true; done = false; hitCap = false; lastError = null;
    try {
      // A section surface intentionally harvests the WHOLE parent board, not just that
      // section: filter_section_pins:false (baked into PIN.boardFeedOptions) already
      // returns sectioned pins in the main board feed, so a separate per-section fetch
      // would only be a filing convenience, not new data. surface.sectionSlug is
      // deliberately unused below — this is a known, accepted limitation, not a bug.
      //
      // The loop below can end two ways: env.isEnd (the feed itself ran out — a genuine
      // finish) or maxPages exhausted while a bookmark was still outstanding (the cap
      // stopped it, more pins remain). Track which one happened via reachedEnd rather
      // than comparing pages to maxPages afterwards, so a board that naturally ends on
      // exactly the last allowed page still reports "complete", not "capped".
      let reachedEnd = false;
      let finalBookmark = null;
      if (surface.kind === "board" || surface.kind === "section") {
        const board = await fetchBoard(surface);
        let bookmark = bookmarkStart;
        for (let i = 0; i < maxPages; i++) {
          if (gen !== generation) return;
          const env = await resourceGet("BoardFeedResource", PIN.boardFeedOptions(board, bookmark), surface);
          // Re-check after the await: generation can bump WHILE this request is in flight
          // (FBW_PIN_CLEAR, or the surface-change reset in FBW_PIN_CONTEXT). The top-of-loop
          // check above only catches a bump that happened before the fetch started — this
          // check is the one that actually stops a stale page's results from being written
          // into a cleared or superseded store.
          if (gen !== generation) return;
          if (!env.ok) throw new Error(env.error);
          ingest(env.results, surface.key);
          pages++;
          bookmark = env.bookmark;
          if (env.isEnd) { reachedEnd = true; break; }
          await sleep(350);
        }
        finalBookmark = bookmark;
      } else if (surface.kind === "search") {
        let bookmark = bookmarkStart;
        for (let i = 0; i < maxPages; i++) {
          if (gen !== generation) return;
          const opts = { query: surface.query, scope: "pins", rs: "typed", appliedProductFilters: "---", bookmarks: bookmark ? [bookmark] : [] };
          const env = await resourcePost("BaseSearchResource", opts, surface);
          // Re-check after the await — see comment on the board/section loop above; the
          // same in-flight-bump hazard applies here.
          if (gen !== generation) return;
          if (!env.ok) throw new Error(env.error);
          ingest(env.results, surface.key);
          pages++;
          bookmark = env.bookmark;
          if (env.isEnd) { reachedEnd = true; break; }
          await sleep(350);
        }
        finalBookmark = bookmark;
      } else {
        throw new Error("Abra uma pasta, uma subpasta ou uma página de pesquisa.");
      }
      if (reachedEnd) { done = true; lastBookmark = null; }
      else { hitCap = true; lastBookmark = finalBookmark; } // outstanding bookmark — resume point for next Harvest
    } catch (e) {
      lastError = e.message || String(e);
    } finally {
      if (gen === generation) harvesting = false;
    }
  }

  // Turn an HLS pointer into a real progressive MP4. Guessing the path fails; the
  // variant filename has to come from the master manifest.
  async function resolveHls(hlsUrl) {
    const master = await (await fetch(hlsUrl)).text();
    const variants = PIN.parseHlsMaster(master);
    if (!variants.length) throw new Error("sem variantes HLS");
    for (const url of PIN.mp4CandidatesFromHls(hlsUrl, variants[0].file)) {
      try {
        const r = await fetch(url, { headers: { range: "bytes=0-1023" } });
        if (r.ok || r.status === 206) return url;
      } catch { /* try next */ }
    }
    throw new Error("sem MP4 correspondente para este stream HLS");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FBW_PING") { sendResponse({ ok: true }); return; }

    if (msg?.type === "FBW_PIN_CONTEXT") {
      (async () => {
        const surface = PIN.surfaceOf(location.href);
        // Surface changed under us (SPA nav) — drop stale records so the panel
        // never shows another board's pins, and drop the resume bookmark with them
        // so a later Harvest on this new surface starts from page 1, not A's cursor.
        if (surfaceKey && surfaceKey !== surface.key) { store = new Map(); generation++; harvesting = false; done = false; hitCap = false; pages = 0; lastBookmark = null; lastSurfaceKey = null; }
        surfaceKey = surface.key;
        const out = { ok: true, loggedIn: looksLoggedIn(), surface, board: null, sections: [], error: null };
        try {
          if (surface.kind === "board" || surface.kind === "section") {
            out.board = await fetchBoard(surface);
            out.sections = await fetchSections(out.board, surface);
          }
        } catch (e) {
          out.error = e.message || String(e);
        }
        sendResponse(out);
      })();
      return true; // async
    }

    if (msg?.type === "FBW_PIN_HARVEST") {
      // Refuse a concurrent press. The resume cursor lives in three shared
      // mutables (hitCap / lastBookmark / lastSurfaceKey) which the in-flight run
      // has ALREADY reset, so a second press read hitCap:false and silently
      // restarted from page 1 — losing the cursor and the cumulative `pages`.
      if (harvesting) {
        sendResponse({ started: false, reason: "já coletando" });
        return;
      }
      const n = Number(msg.maxPages);
      harvest(Number.isInteger(n) && n > 0 ? Math.min(40, n) : 40);
      sendResponse({ started: true });
      return;
    }

    if (msg?.type === "FBW_PIN_STATE") {
      sendResponse({ records: Array.from(store.values()), harvesting, pages, done, hitCap, error: lastError, surfaceKey });
      return;
    }

    if (msg?.type === "FBW_PIN_CLEAR") {
      // An explicit Clear always means "start over" — drop the resume bookmark too,
      // so the next Harvest walks from page 1 instead of quietly picking up a cursor
      // into pins the user just asked to forget.
      store = new Map(); generation++; harvesting = false; done = false; hitCap = false; pages = 0; lastError = null; lastBookmark = null; lastSurfaceKey = null;
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "FBW_PIN_RESOLVE") {
      (async () => {
        try {
          const rec = store.get(String(msg.id));
          const item = rec?.items?.[msg.itemIndex ?? 0];
          if (!item) throw new Error("pin desconhecido");
          sendResponse({ ok: true, url: item.hls ? await resolveHls(item.url) : item.url });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true; // async
    }
  });

  // ============================================================
  // In-page overlay — Baixar/Salvar buttons on pin tiles + the closeup view.
  // Facebook, Instagram and TikTok all inject on-page action buttons; Pinterest's
  // only download path used to be the panel's Board tool. This closes that gap.
  //
  // Mirrors src/content/ig/bridge.js's overlay conventions (style injected once,
  // debounced MutationObserver, dataset-marked idempotence so recycled/virtualized
  // tiles never get double-decorated) adapted to Pinterest's multi-column masonry
  // grid. Toggle via sw_pin_overlay in chrome.storage.local (default ON).
  // ============================================================
  const MAX_TILES_PER_PASS = 48; // hard cap — Pinterest's grid mutates constantly

  const PIN_SVG = {
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    save: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    ok: '<polyline points="20 6 9 17 4 12"/>',
    err: '<line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>',
  };
  const pinIcon = (name, size = 15) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${PIN_SVG[name]}</svg>`;

  let overlayOn = true;
  let ovlStyleAdded = false;
  let ovlTimer = null;
  // Mirror of fbw_saved's keys — drives the yellow "already saved" highlight,
  // kept in sync by storage.onChanged (never re-read the whole map per pass).
  let savedSet = new Set();
  function refreshSaved(map) { savedSet = new Set(Object.keys(map || {})); }

  function ensureOvlStyle() {
    if (ovlStyleAdded) return;
    ovlStyleAdded = true;
    const s = document.createElement("style");
    s.textContent = `
      .sw-pin-acts{position:absolute;top:8px;left:8px;display:flex;flex-direction:column;gap:6px;z-index:6}
      .sw-pin-acts.sw-pin-closeup{position:fixed;top:84px;right:20px;left:auto;z-index:2147483000}
      .sw-pinbtn{display:grid;place-items:center;width:27px;height:27px;border-radius:8px;cursor:pointer;color:#fff;
        background:rgba(0,0,0,.68);border:1px solid rgba(150,180,255,.4);box-shadow:0 0 8px rgba(70,130,255,.25);
        transition:background .15s,color .15s}
      .sw-pinbtn:hover{background:rgba(0,0,0,.82)}
      .sw-pinbtn.busy{color:#93c5fd;cursor:default}
      .sw-pinbtn.busy svg{animation:sw-pin-spin 1s linear infinite}
      .sw-pinbtn.ok{color:#34d399;border-color:rgba(52,211,153,.6)}
      .sw-pinbtn.err{color:#f87171;border-color:rgba(248,113,113,.6)}
      .sw-pinbtn.sw-pin-saved{color:#facc15;border-color:rgba(250,204,21,.55);box-shadow:0 0 8px rgba(250,204,21,.3)}
      .sw-pinbtn.sw-pin-saved svg{fill:#facc15}
      @keyframes sw-pin-spin{to{transform:rotate(360deg)}}`;
    (document.head || document.documentElement).appendChild(s);
  }

  // Every pin tile currently in the DOM, deduped by pin id. [data-test-id="pin"]
  // and [data-test-id="pinWrapper"] both match — sometimes on the very same
  // logical pin (nested elements) — so keep only the first element seen per id.
  function pinTiles() {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[data-test-id="pin"], [data-test-id="pinWrapper"]')) {
      const a = el.querySelector('a[href*="/pin/"]');
      const m = a && (a.getAttribute("href") || "").match(/\/pin\/([^/?]+)/);
      const id = m && m[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push([el, id]);
    }
    return out;
  }

  // Resolve a pin's downloadable record, in priority order:
  //   1. The in-memory store (harvested by the panel) — free and exact.
  //   2. A single-pin fetch via the SAME resourceGet the harvest loop uses, so the
  //      mandatory x-pinterest-pws-handler header and the GET-must-not-send-
  //      x-csrftoken rule are honored automatically. field_set_key:"detailed"
  //      goes through PIN.pinToRecord (which calls PIN.mediaItems() internally),
  //      never raw image-signature guessing — see pinMedia.js's pickImage comment
  //      for why that 403s.
  // The fetched record is cached into `store` so a repeat click, or the closeup
  // view landing on the same pin, never refetches.
  async function recordFor(id) {
    const cached = store.get(String(id));
    if (cached) return cached;
    const surface = { sourceUrl: `/pin/${id}/`, handler: "www/pin/[id].js" };
    const env = await resourceGet("PinResource", { id, field_set_key: "detailed" }, surface);
    if (!env.ok || !env.data) throw new Error(env.error || "pin não encontrado");
    const rec = PIN.pinToRecord(env.data, PIN.surfaceOf(location.href).key);
    if (!rec.items.length) throw new Error("nenhuma mídia disponível para baixar");
    store.set(rec.id, rec);
    return rec;
  }

  function setBtnState(btn, state) {
    btn.classList.remove("busy", "ok", "err");
    if (state === "busy") { btn.classList.add("busy"); btn.innerHTML = pinIcon(btn.dataset.kind); }
    else if (state === "ok") { btn.classList.add("ok"); btn.innerHTML = pinIcon("ok"); }
    else if (state === "err") { btn.classList.add("err"); btn.innerHTML = pinIcon("err"); }
    else btn.innerHTML = pinIcon(btn.dataset.kind);
  }

  async function runDownload(id, btn) {
    if (btn.classList.contains("busy")) return;
    setBtnState(btn, "busy");
    try {
      const rec = await recordFor(id);
      const multi = rec.items.length > 1;
      for (let i = 0; i < rec.items.length; i++) {
        const item = rec.items[i];
        // ~80% of Pinterest videos are HLS-only — a raw .m3u8 downloads as a
        // useless text playlist, so resolve to a real MP4 first (same helper the
        // panel's downloadRecord() uses, just called in-process here).
        const url = item.hls ? await resolveHls(item.url) : item.url;
        const ext = PIN.extFromUrl(url, item.kind);
        // The background answers { ok:false, error } on failure; dropping that
        // reply is what let a failed download flash green. `platform` matches
        // every other sender so background logic keyed on it can't skip us.
        const res = await chrome.runtime.sendMessage({
          type: "FBW_DL_MEDIA",
          platform: "pinterest",
          kind: item.kind,
          url,
          filename: PIN.filenameFor(rec, ext, multi ? i + 1 : null),
        });
        if (!res || res.ok === false) throw new Error(res?.error || "download falhou");
      }
      setBtnState(btn, "ok");
    } catch {
      setBtnState(btn, "err");
    } finally {
      setTimeout(() => { if (btn.isConnected) setBtnState(btn, "idle"); }, 2500);
    }
  }

  // Toggle: first tap saves, second removes — matches PinBoardTool.jsx's save()
  // shape EXACTLY (same fbw_saved map, same fields, including sourceUrl) so a pin
  // saved from the page and one saved from the panel are indistinguishable in the
  // shared Library.
  async function runSave(id, btn) {
    if (btn.classList.contains("busy")) return;
    setBtnState(btn, "busy");
    try {
      const rec = await recordFor(id);
      // The background owns and serializes this write (one shape, one writer).
      const entry = buildSavedEntry({
        id: rec.id,
        platform: "pinterest",
        thumb: rec.thumb || null,
        caption: rec.title || rec.description || null,
        authorName: rec.username || null,
        username: rec.username || null,
        counts: { like: rec.saves, comment: rec.comments },
        code: rec.id,
        // TranscriptsPanel can only rebuild FB/IG permalinks, so Pinterest always
        // carries its own.
        sourceUrl: rec.permalink,
      });
      if (!entry) throw new Error("pin sem id");
      const saveRes = await chrome.runtime.sendMessage({ type: "FBW_SAVED_TOGGLE", entry });
      if (!saveRes || saveRes.ok === false) throw new Error(saveRes?.error || "falha ao salvar");
      setBtnState(btn, "ok");
    } catch {
      setBtnState(btn, "err");
    } finally {
      setTimeout(() => { if (btn.isConnected) setBtnState(btn, "idle"); }, 2500);
    }
  }

  function mkBtn(kind, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sw-pinbtn";
    b.dataset.kind = kind;
    b.title = title;
    b.innerHTML = pinIcon(kind);
    // Only ever suppress the click ON THIS BUTTON — never a blanket capture that
    // could swallow clicks elsewhere on the tile.
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(b);
    });
    return b;
  }

  function buildActs(id) {
    const wrap = document.createElement("div");
    wrap.className = "sw-pin-acts";
    wrap.appendChild(mkBtn("dl", "Baixar", (btn) => runDownload(id, btn)));
    const saveBtn = mkBtn("save", savedSet.has(id) ? "Salvo — toque para remover" : "Salvar", (btn) => runSave(id, btn));
    if (savedSet.has(id)) saveBtn.classList.add("sw-pin-saved");
    wrap.appendChild(saveBtn);
    return wrap;
  }

  function closeupPinId() {
    return (location.pathname.match(/\/pin\/([^/?]+)/) || [])[1] || null;
  }
  // The closeup view (where a user lands after clicking a pin) gets its own
  // floating Baixar/Salvar stack — reuses buildActs() so it never drifts from the
  // grid-tile buttons' behavior. Positioned fixed (CSS modifier) rather than
  // anchored inside the closeup DOM, since that subtree's exact layout isn't
  // something we control and can change under us.
  function maintainCloseup() {
    const existing = document.getElementById("sw-pin-closeup");
    const open = document.querySelector('[data-test-id="closeup-body"]');
    const id = open ? closeupPinId() : null;
    if (!id) { existing?.remove(); return; }
    const sig = savedSet.has(id) ? "1" : "0";
    if (existing && existing.dataset.pinId === id && existing.dataset.sig === sig) return; // unchanged
    existing?.remove();
    const fresh = buildActs(id);
    fresh.id = "sw-pin-closeup";
    fresh.classList.add("sw-pin-closeup");
    fresh.dataset.pinId = id;
    fresh.dataset.sig = sig;
    (document.body || document.documentElement).appendChild(fresh);
  }

  // Perf-critical: Pinterest's masonry grid mutates constantly (scroll, resize,
  // recycled/virtualized tiles). Pass 1 does zero layout reads — rect reads only
  // happen for tiles that actually need (re)building — and the observer is
  // disconnected while we append our own nodes so we never re-trigger ourselves.
  function renderOverlays() {
    if (document.visibilityState !== "visible") return;
    if (!overlayOn) {
      if (document.querySelector(".sw-pin-acts")) {
        ovlObserver.disconnect();
        document.querySelectorAll(".sw-pin-acts").forEach((e) => e.remove());
        observeBody();
      }
      return;
    }
    // Pass 1 (no layout): which tiles need (re)building? Recheck every pass —
    // Pinterest recycles DOM nodes across different pins as the grid scrolls, so a
    // stale id marker (or a saved-state flip) must trigger a rebuild, not a skip.
    const toBuild = [];
    for (const [tile, id] of pinTiles()) {
      const sig = savedSet.has(id) ? "1" : "0";
      if (tile.dataset.swPinId === id && tile.dataset.swPinSig === sig && tile.querySelector(":scope > .sw-pin-acts")) continue;
      toBuild.push([tile, id, sig]);
    }
    // Hard cap per pass — a big board can have dozens of tiles mounted at once;
    // scheduleRender() below picks up whatever didn't fit on the next debounced tick.
    const capped = toBuild.slice(0, MAX_TILES_PER_PASS);

    ensureOvlStyle();
    ovlObserver.disconnect();
    for (const [tile, id, sig] of capped) {
      const rect = tile.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) continue; // not laid out yet — retry next pass
      tile.querySelectorAll(":scope > .sw-pin-acts").forEach((e) => e.remove());
      tile.dataset.swPinId = id;
      tile.dataset.swPinSig = sig;
      // The tile's <a> is position:static, so give the tile itself a positioning
      // context for our absolutely-positioned button stack.
      if (getComputedStyle(tile).position === "static") tile.style.position = "relative";
      tile.appendChild(buildActs(id));
    }
    maintainCloseup();
    observeBody();

    if (toBuild.length > capped.length) scheduleRender(); // more tiles queued — catch up next pass
  }
  // Debounced, then run at idle so bursts of grid mutations cost one off-path pass.
  function scheduleRender() {
    clearTimeout(ovlTimer);
    ovlTimer = setTimeout(() => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(renderOverlays, { timeout: 700 });
      else renderOverlays();
    }, 300);
  }

  chrome.storage?.local?.get(["sw_pin_overlay", "fbw_saved"]).then((r) => {
    if (r?.sw_pin_overlay != null) overlayOn = !!r.sw_pin_overlay; // default ON when unset
    refreshSaved(r?.fbw_saved);
    scheduleRender();
  });
  chrome.storage?.onChanged?.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.sw_pin_overlay) overlayOn = !!ch.sw_pin_overlay.newValue;
    if (ch.fbw_saved) refreshSaved(ch.fbw_saved.newValue);
    if (ch.sw_pin_overlay || ch.fbw_saved) scheduleRender();
  });
  const ovlObserver = new MutationObserver(scheduleRender);
  const observeBody = () => ovlObserver.observe(document.body, { childList: true, subtree: true });
  observeBody();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleRender();
  });
  scheduleRender();
})();
