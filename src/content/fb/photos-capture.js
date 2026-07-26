// FB photos capture — runs in the PAGE's MAIN world at document_start.
//
// ===========================================================================
// THE ONE FACT THIS FILE EXISTS FOR — the next reader will not guess it:
//
//   Facebook's photos-grid GraphQL row carries TWO renditions of the same photo.
//
//     image.uri        → the SQUARE CROP the grid tile paints.
//                        e.g. `stp=c0.241.941.941a_dst-jpg_tt6` — a 941×941
//                        square cut out of a 941×1672 original. The 241 px off
//                        the top and the ~490 off the bottom are NOT in the file.
//
//     viewer_image.uri → the FULL, UNCROPPED photo.
//                        e.g. `stp=dst-jpg_tt6&cstp=mx941x1672&ctp=s941x1672`,
//                        with the real `width`/`height` sitting right beside it.
//
//   The whole frame is therefore already on the wire while the grid is merely
//   scrolling. That is what retired the previous design (open every photo in the
//   theater lightbox and read the big <img> out of it, ~57 s for 43 photos):
//   the lightbox was never the only source of the full image, just the slowest.
//
//   Measured on the reference profile (2026-07-25): 43 of 43 photos resolved,
//   every captured viewer_image.uri free of a crop token, and a fetched file
//   decoded to exactly the 941×1672 the row reported.
// ===========================================================================
//
// WHY MAIN WORLD: an isolated content script gets its own JS globals, so it
// cannot patch the page's XMLHttpRequest — and the grid pages over XHR, not
// fetch (verified live: 17 XHR GraphQL responses, 0 via fetch). We only tee the
// bodies of requests the page made itself; nothing is forged and nothing is
// signed by us, so there is no account-flagging surface. Same shape as
// src/content/tt/tt-capture.js; the isolated half is src/content/fb/photos-scrape.js.
//
// TWO SOURCES, because one does not cover the grid:
//   • XHR GraphQL responses — every grid page AFTER the first (35 of 43 here).
//   • Inline <script type="application/json"> hydration blocks — the FIRST grid
//     page is server-rendered and never requested, so no XHR hook can ever see
//     it. Those were exactly the 8 photos missing above (grid positions 2..9).
//     Sweeping the blocks closes the gap without a reload or a re-scroll.
//
// TRANSPORT DETAIL: a GraphQL response can be MULTI-LINE — @defer streams one
// JSON object per line — so a single JSON.parse of the whole body throws. Split
// on "\n" and parse each non-empty line on its own.

(function () {
  if (window.__fbwFbPhotosCapInit) return;
  window.__fbwFbPhotosCapInit = true;

  // Replay buffer caps. The MAIN world survives extension reloads and lives as
  // long as the tab, so every store here has to evict (oldest first) instead of
  // growing for the session's lifetime — the lesson from tt-capture.js.
  const MAX_ROWS = 800;
  // Walk limits. Depth alone does not bound a WIDE payload (a 50k-element array
  // is depth 2), so both are needed; a photo row sits ~10 levels down.
  const MAX_DEPTH = 25;
  const NODE_BUDGET = 60000;

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const all = new Map(); // id -> record, for replay
  const sent = new Set(); // ids already relayed, so a re-parse is not a re-send

  // Depth/breadth-capped search for photo rows. The row is identified by the
  // presence of `viewer_image.uri` — the shape is stable across the grid query
  // and the SSR hydration blob, and `id` on the same object IS the tile's fbid
  // (verified: 35 of 35 captured ids matched a grid tile href on the reference
  // profile). NOTE the fbcdn filename stem is a DIFFERENT id — never use it as a
  // photo identifier, only as a join key.
  function collect(o, seen, depth, out) {
    if (!o || typeof o !== "object" || depth > MAX_DEPTH || seen.has(o)) return;
    if (seen.size > NODE_BUDGET) return;
    seen.add(o);
    if (Array.isArray(o)) {
      for (const v of o) collect(v, seen, depth + 1, out);
      return;
    }
    const vi = o.viewer_image;
    if (vi && typeof vi.uri === "string" && o.id != null) {
      out.push({
        id: String(o.id),
        full: vi.uri,
        width: num(vi.width),
        height: num(vi.height),
        // The square crop, when the row carries one (this query does not, other
        // photo surfaces do). It is only ever used as a JOIN KEY — its fbcdn
        // stem matches the grid tile's <img src> — and never as a download URL.
        // Handing the crop over as if it were the photo is the exact bug this
        // whole file exists to remove.
        thumb: o.image && typeof o.image.uri === "string" ? o.image.uri : null,
      });
    }
    for (const k in o) collect(o[k], seen, depth + 1, out);
  }

  function remember(rows) {
    const fresh = [];
    for (const r of rows) {
      if (!r.id || !r.full) continue;
      all.set(r.id, r);
      if (!sent.has(r.id)) {
        sent.add(r.id);
        fresh.push(r);
      }
    }
    while (all.size > MAX_ROWS) all.delete(all.keys().next().value);
    while (sent.size > MAX_ROWS * 2) sent.delete(sent.values().next().value);
    if (fresh.length) post(fresh);
  }

  const post = (records) => {
    try {
      window.postMessage({ __fbwFbPh: true, records }, location.origin);
    } catch (_) {}
  };

  function ingest(text) {
    // Cheap gate FIRST. facebook.com fires a lot of GraphQL that has nothing to
    // do with photos; a native substring scan over a string we already hold is
    // orders of magnitude cheaper than parsing it, and this hook sits on the
    // page's own request path.
    if (typeof text !== "string" || text.indexOf("viewer_image") === -1) return;
    const out = [];
    for (const line of text.split("\n")) {
      if (!line || line.indexOf("viewer_image") === -1) continue;
      try {
        collect(JSON.parse(line), new Set(), 0, out);
      } catch (_) {
        // one bad line in a @defer stream must not discard the good ones
      }
    }
    remember(out);
  }

  // The server-rendered first page. Scanned nodes are remembered so a repeat
  // sweep (SPA navigation injects more blocks) never re-parses the same 60 KB.
  const swept = new WeakSet();
  // The eager sweeps run on every facebook.com page load, so gate them on the
  // photos surface — elsewhere they were an indexOf over megabytes of hydration
  // blobs (and a JSON.parse of any that mentioned viewer_image) for nothing. The
  // replay path (__fbwFbPhReq, sent only when the panel asks) sweeps regardless, so
  // a surface this check misjudges still resolves on demand.
  function onPhotosSurface() {
    try {
      const u = new URL(location.href);
      if (/(^|&)sk=photos/.test(u.search.slice(1))) return true;
      return /\/photos(_[a-z]+)?\/?$/.test(u.pathname) || /\/photo(\.php)?\/?$/.test(u.pathname);
    } catch (_) {
      return true; // never skip because a URL failed to parse
    }
  }
  function sweepIfPhotos() {
    if (onPhotosSurface()) sweepInline();
  }

  function sweepInline() {
    let nodes;
    try {
      nodes = document.querySelectorAll('script[type="application/json"]');
    } catch (_) {
      return;
    }
    for (const s of nodes) {
      if (swept.has(s)) continue;
      swept.add(s);
      const t = s.textContent;
      if (!t || t.indexOf("viewer_image") === -1) continue;
      const out = [];
      try {
        collect(JSON.parse(t), new Set(), 0, out);
      } catch (_) {
        continue;
      }
      remember(out);
    }
  }

  const interesting = (u) => typeof u === "string" && u.indexOf("graphql") !== -1;

  // ---- XHR tee (this is the one that fires on facebook.com) ----
  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fbwPhUrl = url;
    return oOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (interesting(this.__fbwPhUrl)) {
      this.addEventListener("load", () => {
        // responseText throws for responseType "json"/"arraybuffer"; those are
        // not the grid's transport, so skipping them is correct, not a loss.
        try {
          ingest(this.responseText);
        } catch (_) {}
      });
    }
    return oSend.apply(this, arguments);
  };

  // ---- fetch tee (belt-and-suspenders; unused today, cheap to keep) ----
  const oFetch = window.fetch;
  if (typeof oFetch === "function") {
    window.fetch = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      const p = oFetch.apply(this, args);
      if (interesting(url)) {
        p.then((res) => {
          res
            .clone()
            .text()
            .then((t) => ingest(t))
            .catch(() => {});
        }).catch(() => {});
      }
      return p;
    };
  }

  // The isolated half attaches at document_idle — after capture has already
  // started — so it must be able to ask for everything buffered. The same
  // request also re-sweeps the inline blocks, which is how a photo that was
  // server-rendered (or hydrated during an SPA navigation) gets resolved
  // without reloading the tab.
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__fbwFbPhReq) return;
    sweepInline();
    post(Array.from(all.values()));
  });

  // At document_start the document is empty; sweep once it has content.
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", sweepIfPhotos, { once: true });
  else sweepIfPhotos();
  window.addEventListener("load", sweepIfPhotos, { once: true });
})();
