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
  let done = false;
  let lastError = null;
  let generation = 0;        // bumps on clear/surface change to abandon in-flight loops

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function appVersion() {
    try {
      return JSON.parse(document.querySelector("#__PWS_DATA__").textContent).appVersion || APP_VERSION_FALLBACK;
    } catch {
      return APP_VERSION_FALLBACK;
    }
  }

  const csrfToken = () => document.cookie.match(/csrftoken=([^;]+)/)?.[1] || null;
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
    harvesting = true; done = false; lastError = null; pages = 0; surfaceKey = surface.key;
    try {
      if (surface.kind === "board" || surface.kind === "section") {
        const board = await fetchBoard(surface);
        let bookmark = null;
        for (let i = 0; i < maxPages; i++) {
          if (gen !== generation) return;
          const env = await resourceGet("BoardFeedResource", PIN.boardFeedOptions(board, bookmark), surface);
          if (!env.ok) throw new Error(env.error);
          ingest(env.results, surface.key);
          pages++;
          bookmark = env.bookmark;
          if (env.isEnd) break;
          await sleep(350);
        }
      } else if (surface.kind === "search") {
        let bookmark = null;
        for (let i = 0; i < maxPages; i++) {
          if (gen !== generation) return;
          const opts = { query: surface.query, scope: "pins", rs: "typed", appliedProductFilters: "---", bookmarks: bookmark ? [bookmark] : [] };
          const env = await resourcePost("BaseSearchResource", opts, surface);
          if (!env.ok) throw new Error(env.error);
          ingest(env.results, surface.key);
          pages++;
          bookmark = env.bookmark;
          if (env.isEnd) break;
          await sleep(350);
        }
      } else {
        throw new Error("Open a board, a board section, or a search page.");
      }
      done = true;
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
        // never shows another board's pins.
        if (surfaceKey && surfaceKey !== surface.key) { store = new Map(); generation++; harvesting = false; done = false; pages = 0; }
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
      sendResponse({ records: Array.from(store.values()), harvesting, pages, done, error: lastError, surfaceKey });
      return;
    }

    if (msg?.type === "FBW_PIN_CLEAR") {
      store = new Map(); generation++; harvesting = false; done = false; pages = 0; lastError = null;
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
