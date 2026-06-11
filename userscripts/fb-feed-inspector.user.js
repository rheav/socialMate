// ==UserScript==
// @name         FB Feed Inspector (fb-warmer MVP / EXPERIMENTAL)
// @namespace    fb-warmer
// @version      0.1.0
// @description  Attempts to capture Facebook hashtag/search feed data by tapping the messages FB's Web Worker posts back to the page, then renders them in a floating panel. Experimental — see debug line.
// @match        https://www.facebook.com/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

// WHY this is different from the IG userscript:
//  Validated (2026-06-07): Facebook fetches AND parses the feed GraphQL response
//  INSIDE a dedicated/shared Web Worker. The main thread never calls JSON.parse /
//  Response.text / TextDecoder on the feed, and FB's CSP `worker-src` blocks blob:
//  workers, so we cannot inject hooks into the worker. The only thing the main thread
//  CAN see is the data the worker postMessages back. So we wrap Worker / SharedWorker /
//  MessagePort at document-start and deep-scan every inbound message for post objects.
//  This MAY need tuning depending on FB's message format — the panel shows a debug line
//  (messages tapped / posts found) and an Export of raw candidates to help refine.

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const store = new Map(); // post_id -> extracted post
  const dbg = { msgs: 0, scanned: 0, posts: 0, taps: 0 };
  let panelEl, listEl, countEl, dbgEl;

  // ---------- extraction helpers (FB Comet Story shape) ----------
  const MAX_NODES = 60000;
  function walk(root, visit) {
    let n = 0;
    const seen = new Set();
    (function rec(o) {
      if (!o || typeof o !== "object" || seen.has(o) || n > MAX_NODES) return;
      seen.add(o);
      n++;
      visit(o);
      if (Array.isArray(o)) {
        for (const v of o) rec(v);
      } else {
        for (const k in o) {
          try {
            rec(o[k]);
          } catch (_) {}
        }
      }
    })(root);
  }
  function deepest(o, pred) {
    let best = null;
    walk(o, (x) => {
      const v = pred(x);
      if (v != null && (best == null || String(v).length > String(best).length))
        best = v;
    });
    return best;
  }
  function first(o, pred) {
    let found = null;
    walk(o, (x) => {
      if (found == null) {
        const v = pred(x);
        if (v != null) found = v;
      }
    });
    return found;
  }
  function extract(story) {
    const actor = first(story, (x) =>
      x && x.name && x.id && /^(User|Page)$/.test(x.__typename || "")
        ? { name: x.name, id: x.id, type: x.__typename }
        : null,
    );
    const message =
      deepest(story, (x) =>
        x && x.__typename === "TextWithEntities" && typeof x.text === "string"
          ? x.text
          : null,
      ) ||
      first(story, (x) =>
        x && typeof x.text === "string" && x.text.length > 8 ? x.text : null,
      );
    const count = (key) =>
      first(story, (x) =>
        x && x[key] && typeof x[key] === "object" && x[key].count != null
          ? x[key].count
          : null,
      );
    const media = first(story, (x) =>
      x && (x.__typename === "Video" || x.__typename === "Photo")
        ? {
            type: x.__typename,
            id: x.id,
            url:
              x.playable_url ||
              x.browser_native_hd_url ||
              x.browser_native_sd_url ||
              (x.image && x.image.uri) ||
              null,
          }
        : null,
    );
    return {
      post_id: story.post_id,
      permalink: story.post_id
        ? `https://www.facebook.com/${story.post_id}`
        : null,
      actor,
      message,
      reactions: count("reaction_count") ?? count("i18n_reaction_count"),
      comments: count("comment_count") ?? count("i18n_comment_count"),
      shares: count("share_count") ?? count("i18n_share_count"),
      creation_time: first(story, (x) =>
        x && typeof x.creation_time === "number" ? x.creation_time : null,
      ),
      media,
      raw: story,
    };
  }

  // ---------- find post/story objects inside an arbitrary message payload ----------
  function harvest(data) {
    if (!data || typeof data !== "object") return;
    dbg.scanned++;
    const stories = [];
    walk(data, (x) => {
      if (x && x.__typename === "Story" && x.post_id) stories.push(x);
    });
    for (const st of stories) {
      const prev = store.get(st.post_id);
      const cur = extract(st);
      // keep the richer of old/new (FB may deliver the same post partially twice)
      const score = (p) =>
        p
          ? [p.actor, p.message, p.reactions, p.media, p.creation_time].filter(
              (v) => v != null,
            ).length
          : -1;
      if (!prev || score(cur) >= score(prev)) {
        store.set(st.post_id, cur);
      }
      dbg.posts = store.size;
    }
    if (stories.length) scheduleRender();
    updateDbg();
  }

  // ---------- tap an object's inbound 'message' events ----------
  function tapMessages(target, label) {
    if (!target || target.__fbiTapped) return;
    try {
      Object.defineProperty(target, "__fbiTapped", { value: true });
    } catch (_) {
      return;
    }
    dbg.taps++;
    const handler = (e) => {
      dbg.msgs++;
      try {
        harvest(e && e.data);
      } catch (_) {}
    };
    try {
      target.addEventListener && target.addEventListener("message", handler);
    } catch (_) {}
    // also chain onmessage assignments (FB often sets worker.onmessage = fn)
    try {
      let cur = null;
      Object.defineProperty(target, "onmessage", {
        configurable: true,
        get() {
          return cur;
        },
        set(fn) {
          cur = fn;
        },
      });
      target.addEventListener &&
        target.addEventListener("message", (e) => {
          if (typeof cur === "function") return cur.call(target, e);
        });
    } catch (_) {}
    try {
      target.start && target.start();
    } catch (_) {}
  }

  // ---------- wrap Worker / SharedWorker / MessageChannel at document-start ----------
  try {
    const OW = W.Worker;
    if (OW) {
      W.Worker = function (url, opts) {
        const w = new OW(url, opts);
        try {
          tapMessages(w, "worker");
        } catch (_) {}
        return w;
      };
      W.Worker.prototype = OW.prototype;
    }
  } catch (_) {}

  try {
    const OS = W.SharedWorker;
    if (OS) {
      W.SharedWorker = function (url, opts) {
        const s = new OS(url, opts);
        try {
          tapMessages(s.port, "sharedport");
        } catch (_) {}
        return s;
      };
      W.SharedWorker.prototype = OS.prototype;
    }
  } catch (_) {}

  try {
    const OMC = W.MessageChannel;
    if (OMC) {
      W.MessageChannel = function () {
        const ch = new OMC();
        try {
          tapMessages(ch.port1, "port1");
          tapMessages(ch.port2, "port2");
        } catch (_) {}
        return ch;
      };
      W.MessageChannel.prototype = OMC.prototype;
    }
  } catch (_) {}

  // global fallback: also listen on window (some workers post to the page directly)
  try {
    W.addEventListener("message", (e) => {
      dbg.msgs++;
      try {
        harvest(e.data);
      } catch (_) {}
    });
  } catch (_) {}

  // ---------- UI ----------
  const fmt = (n) =>
    n == null
      ? "–"
      : n >= 1e6
        ? (n / 1e6).toFixed(1) + "M"
        : n >= 1e3
          ? (n / 1e3).toFixed(1) + "K"
          : String(n);

  function buildPanel() {
    if (!document.body || panelEl) return;
    panelEl = document.createElement("div");
    panelEl.id = "fb-inspector";
    panelEl.innerHTML = `
      <div class="fbi-head">
        <strong>FB Feed Inspector</strong><span id="fbi-count">0</span>
        <span style="flex:1"></span>
        <button id="fbi-export">Export</button>
        <button id="fbi-min">_</button>
      </div>
      <div class="fbi-dbg" id="fbi-dbg">waiting for worker messages…</div>
      <div class="fbi-list" id="fbi-list"></div>`;
    document.body.appendChild(panelEl);
    listEl = panelEl.querySelector("#fbi-list");
    countEl = panelEl.querySelector("#fbi-count");
    dbgEl = panelEl.querySelector("#fbi-dbg");
    panelEl.querySelector("#fbi-min").onclick = () =>
      panelEl.classList.toggle("fbi-collapsed");
    panelEl.querySelector("#fbi-export").onclick = () => {
      const data = [...store.values()].map(({ raw, ...r }) => r);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "fb-feed.json";
      a.click();
    };
    const style = document.createElement("style");
    style.textContent = `
      #fb-inspector{position:fixed;top:12px;right:12px;width:360px;max-height:88vh;z-index:2147483647;
        background:#0d0d0f;color:#eee;font:12px/1.4 -apple-system,system-ui,sans-serif;border:1px solid #333;
        border-radius:10px;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.5)}
      #fb-inspector.fbi-collapsed .fbi-list,#fb-inspector.fbi-collapsed .fbi-dbg{display:none}
      .fbi-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #222}
      .fbi-head strong{color:#fff}#fbi-count{background:#1877f2;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px}
      .fbi-head button{background:#1c1c20;color:#ccc;border:1px solid #333;border-radius:5px;padding:2px 7px;cursor:pointer;font-size:11px}
      .fbi-dbg{padding:5px 10px;color:#7a8;border-bottom:1px solid #222;font-family:ui-monospace,monospace;font-size:11px}
      .fbi-list{overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px}
      .fbi-card{background:#141417;border:1px solid #222;border-radius:8px;padding:8px}
      .fbi-user{color:#fff;font-weight:600}
      .fbi-stats{display:flex;gap:10px;color:#9aa;margin:3px 0}
      .fbi-msg{color:#bbb;max-height:48px;overflow:hidden;margin-top:2px;white-space:pre-wrap}
      .fbi-links a{color:#5b9bff;text-decoration:none;margin-right:8px}
      .fbi-raw{margin-top:4px;color:#777;cursor:pointer;user-select:none}
      .fbi-raw pre{white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;background:#000;padding:6px;border-radius:5px;color:#8c8}
    `;
    document.head.appendChild(style);
    render();
  }

  function updateDbg() {
    if (!dbgEl) return;
    dbgEl.textContent = `msgs:${dbg.msgs}  taps:${dbg.taps}  scanned:${dbg.scanned}  posts:${dbg.posts}`;
  }

  let queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  }

  function render() {
    if (!panelEl) {
      buildPanel();
      if (!panelEl) return;
    }
    countEl.textContent = store.size;
    updateDbg();
    listEl.innerHTML = "";
    for (const it of store.values()) {
      const card = document.createElement("div");
      card.className = "fbi-card";
      card.innerHTML = `
        <div class="fbi-user">${it.actor ? it.actor.name + (it.actor.type === "Page" ? " 📄" : "") : "@?"}</div>
        <div class="fbi-stats"><span>👍 ${fmt(it.reactions)}</span><span>💬 ${fmt(it.comments)}</span><span>↗ ${fmt(it.shares)}</span>${it.media ? `<span>${it.media.type === "Video" ? "🎬" : "🖼"}</span>` : ""}</div>
        <div class="fbi-msg">${it.message ? it.message.replace(/</g, "&lt;").slice(0, 200) : '<i style="color:#555">no text</i>'}</div>
        <div class="fbi-links">${it.permalink ? `<a href="${it.permalink}" target="_blank">post</a>` : ""}${it.media && it.media.url ? `<a href="${it.media.url}" target="_blank">media</a>` : ""}</div>
        <div class="fbi-raw">▸ raw</div>`;
      const rt = card.querySelector(".fbi-raw");
      rt.onclick = () => {
        if (rt.querySelector("pre")) {
          rt.innerHTML = "▸ raw";
          return;
        }
        rt.innerHTML =
          "▾ raw<pre>" +
          JSON.stringify(it.raw, null, 2).replace(/</g, "&lt;").slice(0, 6000) +
          "</pre>";
      };
      listEl.appendChild(card);
    }
  }

  if (document.body) buildPanel();
  else document.addEventListener("DOMContentLoaded", buildPanel);
  // keep debug line alive even before any posts
  setInterval(updateDbg, 1000);
})();
