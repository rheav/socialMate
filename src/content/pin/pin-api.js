import * as PIN from "../../lib/pinMedia.js"; // CRXJS bundles content-script imports

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
    if (!env.ok || !b?.id) throw new Error(env.error || "board not found");
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
    if (surfaceKey && surfaceKey !== surface.key) store = new Map();

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
        throw new Error("Open a board, a board section, or a search page.");
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
    if (!variants.length) throw new Error("no HLS variants");
    for (const url of PIN.mp4CandidatesFromHls(hlsUrl, variants[0].file)) {
      try {
        const r = await fetch(url, { headers: { range: "bytes=0-1023" } });
        if (r.ok || r.status === 206) return url;
      } catch { /* try next */ }
    }
    throw new Error("no MP4 twin for this HLS stream");
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
      harvest(Math.max(1, Math.min(40, msg.maxPages || 40)));
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
          if (!item) throw new Error("unknown pin");
          sendResponse({ ok: true, url: item.hls ? await resolveHls(item.url) : item.url });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true; // async
    }
  });
})();
