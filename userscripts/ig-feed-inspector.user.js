// ==UserScript==
// @name         IG Feed Inspector (fb-warmer MVP)
// @namespace    fb-warmer
// @version      0.2.0
// @description  Captures Instagram feed/reels media data and renders it in a floating panel. Hooks JSON.parse (transport-agnostic) so it survives IG's cached fetch + strict CSP.
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

// WHY @grant unsafeWindow + JSON.parse hook:
//  - @grant none injects a page <script>, which Instagram's CSP blocks -> script never runs.
//    @grant unsafeWindow makes Tampermonkey run us in its isolated world (CSP-immune) while
//    `unsafeWindow` still points at the page's real window so our hooks affect page code.
//  - IG caches `fetch` early, so a late fetch-wrap misses feed requests; IG also parses
//    responses with the native Response.json(). The one path everything funnels through is
//    `JSON.parse`, resolved globally per call -> hooking it captures every feed response.

(function () {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const store = new Map();
  let panelEl, listEl, countEl;

  // ---- deep-walk any JSON, yield objects that look like a media item ----
  function* findMedia(obj, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    const looksLikeMedia =
      obj.video_versions ||
      (obj.code && obj.image_versions2) ||
      (obj.media_type != null && (obj.image_versions2 || obj.carousel_media));
    if (looksLikeMedia) yield obj;
    if (Array.isArray(obj)) {
      for (const v of obj) yield* findMedia(v, seen);
    } else {
      for (const k in obj) yield* findMedia(obj[k], seen);
    }
  }

  function scan(root) {
    let added = 0;
    try {
      for (const m of findMedia(root)) {
        const key = String(m.pk || m.id || m.code || '');
        if (key && !store.has(key)) { store.set(key, m); added++; }
      }
    } catch (_) {}
    if (added) scheduleRender();
  }

  // ---- PRIMARY hook: JSON.parse (catches every feed/reels response) ----
  const origParse = W.JSON.parse;
  W.JSON.parse = function (text, reviver) {
    const out = origParse.apply(this, arguments);
    if (out && typeof out === 'object') scan(out);
    return out;
  };

  // ---- bonus hooks (harmless if they never fire) ----
  try {
    const origFetch = W.fetch;
    W.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try {
          const url = (res && res.url) || '';
          if (/\/graphql|\/api\/v1\//.test(url)) {
            res.clone().text().then((t) => { try { scan(JSON.parse(t)); } catch (_) {} }).catch(() => {});
          }
        } catch (_) {}
        return res;
      });
    };
  } catch (_) {}

  // ---- pull the fields we care about out of a raw media object ----
  function extract(m) {
    const user = m.user || m.owner || {};
    const img = m.image_versions2 && m.image_versions2.candidates && m.image_versions2.candidates[0];
    const vid = m.video_versions && m.video_versions[0];
    return {
      id: m.id || m.pk || null,
      code: m.code || null,
      permalink: m.code ? `https://www.instagram.com/reel/${m.code}/` : null,
      username: user.username || null,
      full_name: user.full_name || null,
      verified: !!user.is_verified,
      thumb: img ? img.url : null,
      video: vid ? vid.url : null,
      media_type: m.media_type,
      is_video: !!m.video_versions,
      duration: m.video_duration != null ? Math.round(m.video_duration) : null,
      likes: m.like_count != null ? m.like_count : null,
      comments: m.comment_count != null ? m.comment_count : null,
      plays: m.play_count != null ? m.play_count : (m.ig_play_count != null ? m.ig_play_count : (m.view_count != null ? m.view_count : null)),
      taken_at: m.taken_at || null,
      caption: (m.caption && m.caption.text) || null,
      raw: m,
    };
  }

  // ---- UI ----
  const fmt = (n) => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
  const dur = (s) => s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function buildPanel() {
    if (!document.body) return;
    panelEl = document.createElement('div');
    panelEl.id = 'ig-inspector';
    panelEl.innerHTML = `
      <div class="igi-head">
        <strong>IG Feed Inspector</strong>
        <span id="igi-count">0</span>
        <span style="flex:1"></span>
        <button id="igi-export">Export</button>
        <button id="igi-clear">Clear</button>
        <button id="igi-min">_</button>
      </div>
      <div class="igi-list" id="igi-list"></div>`;
    document.body.appendChild(panelEl);
    listEl = panelEl.querySelector('#igi-list');
    countEl = panelEl.querySelector('#igi-count');

    panelEl.querySelector('#igi-clear').onclick = () => { store.clear(); render(); };
    panelEl.querySelector('#igi-min').onclick = () => panelEl.classList.toggle('igi-collapsed');
    panelEl.querySelector('#igi-export').onclick = () => {
      const data = [...store.values()].map((m) => { const e = extract(m); delete e.raw; return e; });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ig-feed.json';
      a.click();
    };

    const style = document.createElement('style');
    style.textContent = `
      #ig-inspector{position:fixed;top:12px;right:12px;width:360px;max-height:88vh;z-index:2147483647;
        background:#0d0d0f;color:#eee;font:12px/1.4 -apple-system,system-ui,sans-serif;
        border:1px solid #333;border-radius:10px;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.5)}
      #ig-inspector.igi-collapsed .igi-list{display:none}
      .igi-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #222}
      .igi-head strong{color:#fff}
      #igi-count{background:#2d6cdf;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px}
      .igi-head button{background:#1c1c20;color:#ccc;border:1px solid #333;border-radius:5px;padding:2px 7px;cursor:pointer;font-size:11px}
      .igi-head button:hover{background:#2a2a30}
      .igi-list{overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px}
      .igi-card{display:flex;gap:8px;background:#141417;border:1px solid #222;border-radius:8px;padding:8px}
      .igi-card img{width:64px;height:96px;object-fit:cover;border-radius:5px;background:#222;flex:none}
      .igi-meta{min-width:0;flex:1}
      .igi-user{color:#fff;font-weight:600}
      .igi-verif{color:#3897f0}
      .igi-stats{display:flex;gap:10px;color:#9aa;margin:3px 0}
      .igi-cap{color:#bbb;max-height:48px;overflow:hidden;margin-top:2px}
      .igi-links{display:flex;gap:8px;margin-top:4px}
      .igi-links a{color:#5b9bff;text-decoration:none}
      .igi-raw{margin-top:4px;color:#777;cursor:pointer;user-select:none}
      .igi-raw pre{white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;background:#000;padding:6px;border-radius:5px;color:#8c8}
    `;
    document.head.appendChild(style);
  }

  function render() {
    if (!panelEl) { buildPanel(); if (!panelEl) return; }
    countEl.textContent = store.size;
    listEl.innerHTML = '';
    for (const raw of store.values()) {
      const it = extract(raw);
      const card = document.createElement('div');
      card.className = 'igi-card';
      card.innerHTML = `
        ${it.thumb ? `<img src="${it.thumb}" loading="lazy">` : '<div style="width:64px;height:96px;background:#222;border-radius:5px"></div>'}
        <div class="igi-meta">
          <div class="igi-user">@${it.username || '?'} ${it.verified ? '<span class="igi-verif">✓</span>' : ''}
            ${it.duration != null ? `<span style="color:#888;font-weight:400">· ${dur(it.duration)}</span>` : ''}</div>
          <div class="igi-stats">
            <span>♥ ${fmt(it.likes)}</span>
            <span>💬 ${fmt(it.comments)}</span>
            <span>▶ ${fmt(it.plays)}</span>
          </div>
          <div class="igi-cap">${it.caption ? it.caption.replace(/</g, '&lt;') : '<i style="color:#555">no caption</i>'}</div>
          <div class="igi-links">
            ${it.permalink ? `<a href="${it.permalink}" target="_blank">reel</a>` : ''}
            ${it.video ? `<a href="${it.video}" target="_blank">video</a>` : ''}
            ${it.thumb ? `<a href="${it.thumb}" target="_blank">thumb</a>` : ''}
          </div>
          <div class="igi-raw">▸ raw</div>
        </div>`;
      const rawToggle = card.querySelector('.igi-raw');
      rawToggle.onclick = () => {
        if (rawToggle.querySelector('pre')) { rawToggle.innerHTML = '▸ raw'; return; }
        rawToggle.innerHTML = '▾ raw<pre>' + JSON.stringify(it.raw, null, 2).replace(/</g, '&lt;') + '</pre>';
      };
      listEl.appendChild(card);
    }
  }

  // build empty panel as soon as <body> exists
  if (document.body) buildPanel();
  else document.addEventListener('DOMContentLoaded', buildPanel);
})();
