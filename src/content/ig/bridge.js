// Instagram bridge — isolated content-script world.
//
// Unlike Facebook (media hidden in a worker → webRequest + DASH mux), Instagram
// serves a direct progressive MP4 on the <video> element and parses metadata on the
// main thread. So we read the URL straight off the DOM and get rich metadata from
// the MAIN-world JSON.parse capture (relayed via window.postMessage). We publish the
// in-view video to the panel and, on request, hand the background the direct MP4 URL.

if (location.hostname.endsWith("instagram.com") && !window.__fbwIgInit) {
  window.__fbwIgInit = true;

  // ================== IN-PAGE OVERLAY SETTINGS ==================
  // Tweak the look of the on-Instagram stats overlay here, then rebuild
  // (`npm run build`) and Reload ↻ the extension. (The side-panel card's
  // matching styles live in src/components/tools/IgSortTool.jsx.)
  const OVL = {
    blurPx: 4, // backdrop blur strength behind the rail
    bgOpacity: 0.42, // rail background darkness (0–1)
    fontPrimary: 17, // headline (views) font size, px
    fontRow: 13, // other rows font size, px
    iconPrimary: 17, // headline icon size, px
    iconRow: 14, // row icon size, px
    glow: "rgba(70,130,255,.28)", // blue outer glow
    borderColor: "rgba(150,180,255,.38)", // blue border
    radius: 13, // rail corner radius, px
    btnSize: 27, // action-button size, px
    gap: 8, // rail distance from the tile edge, px
    // ER weights — IG Sorter defaults (comments & reposts each count 4×).
    erLike: 1,
    erComment: 4,
    erRepost: 4,
  };
  // =============================================================

  // code/pk -> record (lookups, e.g. publishCurrent) + canonical-id list (deduped)
  const igMedia = {};
  const byId = new Map(); // code||pk -> record; insertion order preserved for the list

  // Stories & highlights (passive): reel_id -> { meta, items: Map<pk,item> }.
  // Kept separate from byId so stories never leak into the Sort grid. Owner-
  // scoped for display, not surface-scoped (the /stories/ URL has no surface).
  const reels = new Map();
  function ingestReel(r) {
    if (!r.reel_id) return;
    let R = reels.get(r.reel_id);
    if (!R) { R = { meta: { reel_id: r.reel_id }, items: new Map() }; reels.set(r.reel_id, R); }
    if (r.__kind === "reel") {
      for (const k in r) if (r[k] != null) R.meta[k] = r[k]; // coalesce meta
    } else { // story item
      const prev = R.items.get(r.pk) || {};
      for (const k in r) if (r[k] != null || !(k in prev)) prev[k] = r[k];
      R.items.set(r.pk, prev);
    }
    while (reels.size > 60) reels.delete(reels.keys().next().value); // cap
  }

  // The IG surface the current records belong to — scopes the Sort list to the
  // hashtag/profile you're viewing (IG is an SPA, so records accumulate across surfaces).
  function surfaceKey() {
    const p = location.pathname;
    let m;
    if ((m = p.match(/\/explore\/tags\/([^/]+)/))) return "tag:" + decodeURIComponent(m[1]);
    if (p.startsWith("/explore")) return "explore";
    if ((m = p.match(/^\/([^/]+)\/?(?:reels\/?)?$/))) {
      const u = m[1];
      if (!["explore", "reels", "p", "reel", "direct", "stories", "accounts"].includes(u))
        return "profile:" + u;
    }
    return "feed";
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__fbwIg) return;
    const surface = surfaceKey();
    for (const r of e.data.records || []) {
      // Stories/highlights route to their own store (no surface, no overlay).
      if (r.__kind === "reel" || r.__kind === "story") { ingestReel(r); continue; }
      r.surface = surface;
      // The profile's own Reels-tab items omit the username → label them with the
      // profile owner (from the surface) so the panel shows @name, not @unknown.
      if (!r.username && surface.startsWith("profile:"))
        r.username = surface.slice("profile:".length);
      const id = r.code || r.pk;
      if (id) {
        // Coalesce: later payloads add fields (play_count, repost) or drop them
        // (null) — never let a null clobber a value we already captured.
        const prev = byId.get(id) || {};
        for (const k in r) if (r[k] != null || !(k in prev)) prev[k] = r[k];
        byId.set(id, prev);
      }
      if (r.code) igMedia[r.code] = r;
      if (r.pk) igMedia[r.pk] = r;
    }
    // Cap memory across long SPA sessions: evict the oldest records (Map keeps
    // insertion order) once the buffer outgrows what the panel usefully lists.
    while (byId.size > 500) {
      const k = byId.keys().next().value;
      const old = byId.get(k);
      byId.delete(k);
      if (old?.code) delete igMedia[old.code];
      if (old?.pk) delete igMedia[old.pk];
    }
    scheduleRender();
  });

  // MAIN-world capture starts at document_start (before this listener exists) → ask it
  // to replay its buffer, on init and whenever we're missing the current record.
  let lastReplayReq = 0;
  function requestReplay() {
    const now = Date.now();
    if (now - lastReplayReq < 600) return;
    lastReplayReq = now;
    window.postMessage({ __fbwIgReq: true }, location.origin);
  }
  requestReplay();
  setTimeout(requestReplay, 700);
  setTimeout(requestReplay, 1800);

  const fmt = (n) =>
    n == null ? null : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);

  // ---- pick the most-centered in-view video (same as FB) ----
  function pickActiveVideo() {
    const vh = window.innerHeight, vw = window.innerWidth;
    let best = null, bestScore = -Infinity;
    document.querySelectorAll("video").forEach((v) => {
      const r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 100) return;
      const visH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      const visW = Math.min(r.right, vw) - Math.max(r.left, 0);
      if (visH <= 0 || visW <= 0) return;
      const visArea = visH * visW;
      if (visArea / (r.width * r.height) < 0.35) return;
      const dist = Math.abs(r.top + r.height / 2 - vh / 2);
      const score = visArea - dist * 350;
      if (score > bestScore) { bestScore = score; best = v; }
    });
    return best;
  }

  // post/reel shortcode for the video — nearest permalink, else the page URL
  function grabCode(videoEl) {
    let el = videoEl;
    for (let i = 0; i < 12 && el; i++) {
      const a = el.querySelector?.('a[href*="/p/"], a[href*="/reel/"]');
      if (a) { const m = (a.getAttribute("href") || "").match(/\/(?:p|reel)\/([^/]+)/); if (m) return m[1]; }
      el = el.parentElement;
    }
    return location.pathname.match(/\/(?:p|reel)\/([^/]+)/)?.[1] || null;
  }

  function grabThumb(videoEl, rec) {
    if (rec?.thumb) return rec.thumb;
    try {
      if (videoEl.readyState >= 2 && videoEl.videoWidth) {
        const cv = document.createElement("canvas");
        cv.width = 120;
        cv.height = Math.round(120 * (videoEl.videoHeight / videoEl.videoWidth)) || 180;
        cv.getContext("2d").drawImage(videoEl, 0, 0, cv.width, cv.height);
        return cv.toDataURL("image/jpeg", 0.6);
      }
    } catch {}
    return videoEl.poster || null;
  }

  // DOM fallbacks when the JSON record isn't captured yet
  function domAuthor() {
    const a = (document.querySelector("article header") || document.querySelector("header"))?.querySelector('a[href^="/"]');
    const name = a?.textContent?.trim();
    return name ? { name, url: a.getAttribute("href") } : null;
  }
  function domCaption() {
    let best = null;
    document.querySelectorAll('h1, span[dir="auto"], div[dir="auto"]').forEach((n) => {
      if (best) return;
      const t = (n.innerText || "").trim();
      if (t.length > 20 && (/#\w/.test(t) || t.length > 40)) best = t.slice(0, 2000);
    });
    return best;
  }

  function grabMeta(videoEl) {
    const code = grabCode(videoEl);
    const rec = (code && igMedia[code]) || null;
    if (code && !rec) requestReplay(); // missing → ask MAIN to resend its buffer
    // video.src is often a blob: (MSE) here, so prefer the direct video_versions URL.
    const mediaUrl = rec?.video || (videoEl.src && /^https?:/.test(videoEl.src) ? videoEl.src : null);
    const author = rec
      ? { name: rec.full_name || rec.username, url: rec.username ? `/${rec.username}/` : null }
      : domAuthor();
    const counts = rec
      ? { like: fmt(rec.like_count), comment: fmt(rec.comment_count), views: fmt(rec.play_count) }
      : null;
    return {
      videoId: code || rec?.pk || null,
      platform: "instagram",
      mediaUrl,
      thumb: grabThumb(videoEl, rec),
      author,
      caption: rec?.caption || domCaption(),
      counts: counts && (counts.like || counts.comment || counts.views) ? counts : null,
    };
  }

  // ---- publish the in-view video to the panel ----
  let lastKey = null;
  function publishCurrent() {
    if (document.visibilityState !== "visible") return;
    const v = pickActiveVideo();
    if (!v) {
      if (lastKey !== null) { lastKey = null; chrome.runtime.sendMessage({ type: "FBW_CURRENT", current: null }).catch(() => {}); }
      return;
    }
    const meta = grabMeta(v);
    const key = (meta.videoId || "") + "|" + (meta.caption || "").slice(0, 40) + "|" + (meta.mediaUrl ? "1" : "0");
    if (key === lastKey) return;
    lastKey = key;
    chrome.runtime.sendMessage({ type: "FBW_CURRENT", current: meta }).catch(() => {});
  }
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; publishCurrent(); }); };
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("visibilitychange", publishCurrent);
  setInterval(publishCurrent, 1000);
  publishCurrent();

  // ---- run a job on request from the panel (relayed by background) ----
  function run(kind) {
    const v = pickActiveVideo();
    if (!v) return;
    const meta = grabMeta(v);
    if (!meta.mediaUrl) return;
    if (kind === "transcribe") chrome.runtime.sendMessage({ type: "FBW_TRANSCRIBE", ...meta }).catch(() => {});
    else chrome.runtime.sendMessage({ type: "FBW_DOWNLOAD", videoId: meta.videoId, mediaUrl: meta.mediaUrl }).catch(() => {});
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FBW_IG_LIST") {
      sendResponse({ records: Array.from(byId.values()), surface: surfaceKey() });
      return;
    }
    if (msg?.type === "FBW_IG_REELS") {
      const out = [];
      for (const R of reels.values()) out.push({ ...R.meta, items: Array.from(R.items.values()) });
      sendResponse({ reels: out });
      return;
    }
    if (msg?.type === "FBW_RUN_TRANSCRIBE") run("transcribe");
    if (msg?.type === "FBW_RUN_DOWNLOAD") run("download");
    if (msg?.type === "FBW_PING") { lastKey = null; publishCurrent(); sendResponse?.({ ok: true }); }
  });

  // ============================================================
  // In-page stats overlay — annotate profile/grid tiles we have data for with
  // views/likes/comments (lucide-style SVG on a gradient). Toggle via the panel
  // (sw_ig_overlay). pointer-events:none so tile clicks still open the post.
  // ============================================================
  // Compact count, inlined so bridge.js stays a DIRECT content script — no ES
  // import means CRXJS won't wrap it in a loader/dynamic-import, which can fail
  // on Instagram's strict CSP (and would kill capture + FBW_IG_LIST + overlay).
  const fmtCount = (n) =>
    n == null
      ? "—"
      : n >= 1e6
        ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
        : n >= 1e3
          ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K"
          : String(n);
  // Engagement rate by views: (likes + comments + reposts) / views × 100, or null.
  const erOf = (r) => {
    const v = r.play_count;
    if (!v || v <= 0) return null;
    const eng =
      OVL.erLike * (r.like_count || 0) +
      OVL.erComment * (r.comment_count || 0) +
      OVL.erRepost * (r.repost || 0);
    return (eng / v) * 100;
  };
  const fmtDateOvl = (t) => {
    if (!t) return "";
    const d = new Date(t * 1000);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };
  // Date decoded from the IG media id (works even when taken_at is absent).
  const dateFromPkOvl = (pk) => {
    const raw = String(pk || "").split("_")[0];
    if (!/^\d{6,}$/.test(raw)) return "";
    try {
      const ms = (BigInt(raw) >> 23n) + 1314220021721n;
      const d = new Date(Number(ms));
      return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    } catch {
      return "";
    }
  };
  // ER label — never collapses to "0.0%".
  const fmtErOvl = (er) => {
    if (er == null) return null;
    if (er === 0) return "0%";
    if (er >= 10) return er.toFixed(1) + "%";
    if (er >= 0.1) return er.toFixed(2) + "%";
    return Number(er.toPrecision(2)) + "%";
  };
  // Filename helpers (inlined — bridge stays import-free).
  const sanit = (s) => String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  const igExt = (url, kind) => {
    const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
    if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
    return kind === "video" ? "mp4" : "jpg";
  };
  const igName = (rec, ext, idx) => {
    const base = `ig-${sanit(rec.username)}-${rec.code || rec.pk || Date.now()}`;
    return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
  };
  // Shape an IG record for the shared Saved tab (VideoCard reads author/counts).
  const igSavedShape = (rec, id) => ({
    videoId: id,
    platform: "instagram",
    thumb: rec.thumb || rec.image || null,
    caption: rec.caption || null,
    author: { name: rec.username || rec.full_name || "unknown", url: rec.username ? `/${rec.username}/` : null },
    counts: {
      like: rec.like_count != null ? fmtCount(rec.like_count) : null,
      comment: rec.comment_count != null ? fmtCount(rec.comment_count) : null,
      views: rec.play_count != null ? fmtCount(rec.play_count) : null,
    },
    code: rec.code || null,
    pk: rec.pk || null,
    media_type: rec.media_type || null,
    updatedAt: Date.now(),
  });

  let overlayOn = true;
  let ovlStyleAdded = false;
  let ovlTimer = null;

  // Live mirror of the shared saved store (yellow-filled bookmark on tiles).
  // Transcription is panel-only — keeps the in-page script lean.
  let savedSet = new Set();
  function refreshSaved(map) {
    savedSet = new Set(Object.keys(map || {}));
  }

  const OVL_SVG = {
    eye: '<circle cx="12" cy="12" r="3"/><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    repost: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    cal: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    save: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    img: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
    filetext: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  };
  function ovlIcon(name, size) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${OVL_SVG[name]}</svg>`;
  }
  function ensureOvlStyle() {
    if (ovlStyleAdded) return;
    ovlStyleAdded = true;
    const s = document.createElement("style");
    s.textContent = `
      .sw-ovl{position:absolute;right:${OVL.gap}px;bottom:${OVL.gap}px;display:flex;flex-direction:column;gap:4px;
        padding:8px 11px;border-radius:${OVL.radius}px;background:rgba(0,0,0,${OVL.bgOpacity});
        -webkit-backdrop-filter:blur(${OVL.blurPx}px) saturate(125%);backdrop-filter:blur(${OVL.blurPx}px) saturate(125%);
        border:1px solid ${OVL.borderColor};box-shadow:0 0 12px ${OVL.glow},inset 0 0 0 1px rgba(160,190,255,.12);
        color:#fff;pointer-events:none;z-index:5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        text-shadow:0 1px 2px rgba(0,0,0,.45)}
      .sw-ovl-row{display:flex;align-items:center;gap:6px;font-size:${OVL.fontRow}px;font-weight:700;line-height:1;white-space:nowrap}
      .sw-ovl-row.primary{font-size:${OVL.fontPrimary}px;font-weight:800}
      .sw-ovl svg{flex:none}
      .sw-acts{position:absolute;top:7px;left:7px;display:flex;flex-direction:column;gap:5px;z-index:6}
      .sw-actbtn{display:grid;place-items:center;width:${OVL.btnSize}px;height:${OVL.btnSize}px;border-radius:8px;cursor:pointer;color:#fff;
        background:rgba(0,0,0,${OVL.bgOpacity});-webkit-backdrop-filter:blur(${OVL.blurPx}px);backdrop-filter:blur(${OVL.blurPx}px);
        border:1px solid ${OVL.borderColor};box-shadow:0 0 8px ${OVL.glow};transition:background .15s}
      .sw-actbtn:hover{background:rgba(0,0,0,.66)}
      .sw-actbtn.sw-saved{color:#facc15;border-color:rgba(250,204,21,.55);box-shadow:0 0 8px rgba(250,204,21,.3)}
      .sw-actbtn.sw-saved svg{fill:#facc15}
      .sw-stdl{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:8px}
      .sw-stbtn{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;cursor:pointer;color:#fff;
        border:1px solid ${OVL.borderColor};background:rgba(0,0,0,.55);
        -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);box-shadow:0 0 10px ${OVL.glow};transition:background .15s,color .15s}
      .sw-stbtn:hover{background:rgba(0,0,0,.78)}
      .sw-stbtn.ok{color:#34d399;border-color:rgba(52,211,153,.6)}`;
    (document.head || document.documentElement).appendChild(s);
  }
  function tileCode(a) {
    const m = (a.getAttribute("href") || "").match(/\/(?:p|reel)\/([^/]+)/);
    return m ? m[1] : null;
  }
  function buildOvl(rec, code) {
    const el = document.createElement("div");
    el.className = "sw-ovl";
    el.dataset.code = code;
    const hasViews = rec.play_count != null;
    const rows = [];
    // Vertical rail: views headline (reels), then likes, comments, reposts, ER, date.
    if (hasViews)
      rows.push(`<div class="sw-ovl-row primary">${ovlIcon("eye", OVL.iconPrimary)}<span>${fmtCount(rec.play_count)}</span></div>`);
    rows.push(`<div class="sw-ovl-row${hasViews ? "" : " primary"}">${ovlIcon("heart", OVL.iconRow)}<span>${fmtCount(rec.like_count)}</span></div>`);
    rows.push(`<div class="sw-ovl-row">${ovlIcon("msg", OVL.iconRow)}<span>${fmtCount(rec.comment_count)}</span></div>`);
    if (rec.repost != null)
      rows.push(`<div class="sw-ovl-row">${ovlIcon("repost", OVL.iconRow)}<span>${fmtCount(rec.repost)}</span></div>`);
    const e = fmtErOvl(erOf(rec));
    if (e != null)
      rows.push(`<div class="sw-ovl-row">${ovlIcon("zap", OVL.iconRow)}<span>${e}</span></div>`);
    const d = fmtDateOvl(rec.taken_at) || dateFromPkOvl(rec.pk);
    if (d) rows.push(`<div class="sw-ovl-row">${ovlIcon("cal", OVL.iconRow)}<span>${d}</span></div>`);
    el.innerHTML = rows.join("");
    return el;
  }
  // ---- in-page action buttons (save / download / thumbnail) ----
  function ovlDownload(rec) {
    if (rec.media_type === "carousel" && Array.isArray(rec.carousel)) {
      let i = 0;
      for (const ch of rec.carousel) {
        i += 1;
        const vid = ch.media_type === "video" && ch.video;
        const url = vid ? ch.video : ch.image;
        if (!url) continue;
        chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: vid ? "video" : "image", url, filename: igName(rec, igExt(url, vid ? "video" : "image"), i) });
      }
    } else if (rec.video) {
      chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: "video", url: rec.video, filename: igName(rec, igExt(rec.video, "video")) });
    } else if (rec.image) {
      chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: "image", url: rec.image, filename: igName(rec, igExt(rec.image, "image")) });
    }
  }
  function ovlThumb(rec) {
    const url = rec.image || rec.thumb;
    if (!url) return;
    const ext = igExt(url, "image");
    chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: "image", url, filename: igName(rec, ext).replace(new RegExp("\\." + ext + "$"), "-thumb." + ext) });
  }
  // Toggle: first tap saves to the shared Library, second removes.
  async function ovlSave(rec) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      const id = rec.code || rec.pk;
      if (map[id]) delete map[id];
      else map[id] = igSavedShape(rec, id);
      await chrome.storage.local.set({ fbw_saved: map });
    } catch {
      /* ignore */
    }
  }
  function buildActs(rec) {
    const wrap = document.createElement("div");
    wrap.className = "sw-acts";
    const mk = (icon, title, fn) => {
      const b = document.createElement("button");
      b.className = "sw-actbtn";
      b.type = "button";
      b.title = title;
      b.innerHTML = ovlIcon(icon, 15);
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); });
      return b;
    };
    const id = rec.code || rec.pk;
    const saveBtn = mk(
      "save",
      savedSet.has(id) ? "Saved — tap to remove" : "Save to Library",
      () => ovlSave(rec),
    );
    if (savedSet.has(id)) saveBtn.classList.add("sw-saved");
    wrap.appendChild(saveBtn);
    wrap.appendChild(mk("dl", "Download media", () => ovlDownload(rec)));
    wrap.appendChild(mk("img", "Download thumbnail", () => ovlThumb(rec)));
    return wrap;
  }
  // Perf-critical: IG mutates the DOM constantly (virtualized feeds), so this
  // pass must be cheap. Pass 1 does zero layout reads — rect/computedStyle only
  // run for tiles that actually need (re)building — and the observer is
  // disconnected while we append our own nodes so we never re-trigger ourselves.
  function renderOverlays() {
    if (document.visibilityState !== "visible") return;
    if (!overlayOn) {
      if (document.querySelector(".sw-ovl, .sw-acts")) {
        ovlObserver.disconnect();
        document.querySelectorAll(".sw-ovl, .sw-acts").forEach((e) => e.remove());
        observeBody();
      }
      return;
    }
    // Pass 1 (no layout): which tiles need building? Rebuild when the tile's
    // data changed — late-arriving full-stats fields (views/reposts) and saved
    // state must update already-annotated tiles.
    const toBuild = [];
    for (const a of document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]')) {
      const code = tileCode(a);
      if (!code) continue;
      const rec = byId.get(code);
      if (!rec) continue;
      // No stats captured (yet) → no rail. Prevents empty blur boxes on tiles
      // whose record came from a stats-less payload.
      if (rec.like_count == null && rec.comment_count == null && rec.play_count == null) continue;
      const sig = [
        rec.play_count, rec.like_count, rec.comment_count, rec.repost,
        rec.taken_at, savedSet.has(code) ? 1 : 0,
      ].join("|");
      if (a.dataset.swCode === code && a.dataset.swSig === sig && a.querySelector(":scope > .sw-ovl")) continue;
      toBuild.push([a, code, rec, sig]);
    }
    if (!toBuild.length) return;
    ensureOvlStyle();
    ovlObserver.disconnect();
    for (const [a, code, rec, sig] of toBuild) {
      // Real thumbnails only. Grid tiles have <img>; Reels-tab tiles use a
      // background-image DIV, so match by rendered size. Small/unsized anchors
      // stay unstamped and retry once they lay out.
      const rect = a.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      a.querySelectorAll(":scope > .sw-ovl, :scope > .sw-acts").forEach((e) => e.remove());
      a.dataset.swCode = code;
      a.dataset.swSig = sig;
      if (getComputedStyle(a).position === "static") a.style.position = "relative";
      a.appendChild(buildOvl(rec, code));
      a.appendChild(buildActs(rec));
    }
    observeBody();
  }
  // Debounced, then run at idle so bursts of IG mutations cost one off-path pass.
  function scheduleRender() {
    clearTimeout(ovlTimer);
    ovlTimer = setTimeout(() => {
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(renderOverlays, { timeout: 700 });
      else renderOverlays();
    }, 300);
  }

  chrome.storage?.local?.get(["sw_ig_overlay", "fbw_saved"]).then((r) => {
    if (r?.sw_ig_overlay != null) overlayOn = !!r.sw_ig_overlay;
    refreshSaved(r?.fbw_saved);
    scheduleRender();
  });
  chrome.storage?.onChanged?.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.sw_ig_overlay) overlayOn = !!ch.sw_ig_overlay.newValue;
    if (ch.fbw_saved) refreshSaved(ch.fbw_saved.newValue);
    if (ch.sw_ig_overlay || ch.fbw_saved) scheduleRender();
  });
  const ovlObserver = new MutationObserver(scheduleRender);
  const observeBody = () =>
    ovlObserver.observe(document.body, { childList: true, subtree: true });
  observeBody();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleRender();
  });
  scheduleRender();

  // ============================================================
  // In-viewer download buttons for stories & highlights.
  // The fullscreen viewer shows ONE item at a time and its <video> src is a
  // blob: (MSE), so we download from the passively-captured reel record
  // (real CDN URL). We map the on-screen item via its <time datetime> ==
  // taken_at. One floating stack (not per-tile) → cheap.
  // ============================================================
  function storyName(item, ext, idx) {
    const base = `ig-story-${sanit(item.owner_username || "unknown")}-${item.pk || Date.now()}`;
    return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
  }
  function dlStoryItem(item) {
    if (!item) return;
    if (item.media_type === "carousel" && Array.isArray(item.carousel)) {
      let i = 0;
      for (const ch of item.carousel) {
        i += 1;
        const vid = ch.media_type === "video" && ch.video;
        const url = vid ? ch.video : ch.image;
        if (!url) continue;
        chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: vid ? "video" : "image", url, filename: storyName(item, igExt(url, vid ? "video" : "image"), i) });
      }
    } else if (item.video) {
      chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: "video", url: item.video, filename: storyName(item, igExt(item.video, "video")) });
    } else if (item.image) {
      chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: "image", url: item.image, filename: storyName(item, igExt(item.image, "image")) });
    }
  }
  // Transcribe a story/highlight item: hand the background the captured direct
  // MP4 URL (same Whisper path as reels). Result → Library → Transcripts.
  function txStoryItem(item) {
    if (!item || !item.video) return false;
    chrome.runtime.sendMessage({
      type: "FBW_TRANSCRIBE",
      videoId: item.pk,
      mediaUrl: item.video,
      platform: "instagram",
      caption: item.caption || null,
      author: { name: item.owner_username || "unknown", url: item.owner_username ? `/${item.owner_username}/` : null },
      thumb: item.thumb || item.image || null,
    }).catch(() => {});
    return true;
  }
  // Most-centered large media in the viewer.
  function activeStoryMedia() {
    let media = null, best = -1;
    for (const el of document.querySelectorAll("video, img")) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 300) continue;
      const s = -Math.abs(r.left + r.width / 2 - innerWidth / 2) - Math.abs(r.top + r.height / 2 - innerHeight / 2) + (r.width * r.height) / 5000;
      if (s > best) { best = s; media = el; }
    }
    return media;
  }
  // Resolve the currently-shown reel + item from the URL (highlight id) and the
  // visible timestamp. Returns { reel, item } (item may be null → still allows
  // "download all").
  // Current item's timestamp: prefer a <time> inside the active media's own
  // viewer container (IG can preload a neighbor's <time> elsewhere in the DOM).
  function currentStoryTime() {
    let scope = activeStoryMedia();
    for (let i = 0; i < 6 && scope; i++) {
      const el = scope.querySelector && scope.querySelector("time[datetime]");
      if (el) { const s = Math.round(Date.parse(el.getAttribute("datetime")) / 1000); if (s) return s; }
      scope = scope.parentElement;
    }
    for (const el of document.querySelectorAll("time[datetime]")) {
      const s = Math.round(Date.parse(el.getAttribute("datetime")) / 1000);
      if (s) return s;
    }
    return null;
  }
  function currentStory() {
    const m = location.pathname.match(/\/stories\/highlights\/(\d+)/);
    const urlReel = m ? reels.get("highlight:" + m[1]) : null;
    const t = currentStoryTime();
    if (urlReel && t != null)
      for (const it of urlReel.items.values()) if (Math.abs((it.taken_at || 0) - t) <= 2) return { reel: urlReel, item: it };
    if (t != null)
      for (const R of reels.values()) for (const it of R.items.values()) if (Math.abs((it.taken_at || 0) - t) <= 2) return { reel: R, item: it };
    if (urlReel) return { reel: urlReel, item: null };
    return null;
  }
  function flash(btn) { btn.classList.add("ok"); setTimeout(() => btn.classList.remove("ok"), 1200); }
  function buildStoryDl() {
    const wrap = document.createElement("div");
    wrap.className = "sw-stdl";
    wrap.id = "sw-stdl";
    const mk = (icon, title, fn) => {
      const b = document.createElement("button");
      b.className = "sw-stbtn";
      b.type = "button";
      b.title = title;
      b.innerHTML = ovlIcon(icon, 19);
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(b); });
      return b;
    };
    wrap.appendChild(mk("dl", "Download this story", (b) => {
      const cur = currentStory();
      if (cur && cur.item) { dlStoryItem(cur.item); flash(b); return; }
      const media = activeStoryMedia(); // fallback: photo story with a real src
      if (media && media.tagName === "IMG" && /^https/.test(media.src)) {
        chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: "image", url: media.src, filename: `ig-story-${Date.now()}.jpg` });
        flash(b);
      }
    }));
    wrap.appendChild(mk("layers", "Download all in this reel", (b) => {
      const cur = currentStory();
      if (!cur || !cur.reel) return;
      for (const it of cur.reel.items.values()) dlStoryItem(it);
      flash(b);
    }));
    const txBtn = mk("filetext", "Transcribe this story", (b) => {
      const cur = currentStory();
      if (cur && txStoryItem(cur.item)) flash(b);
    });
    txBtn.dataset.sw = "tx"; // toggled to video-only items in maintainStoryDl
    wrap.appendChild(txBtn);
    return wrap;
  }
  // Maintain the floating stack: present only while the story viewer is open,
  // pinned to the media's top-right (offset down to clear IG's header).
  function maintainStoryDl() {
    const open = location.pathname.startsWith("/stories/");
    let wrap = document.getElementById("sw-stdl");
    if (!open || document.visibilityState !== "visible") { if (wrap) wrap.remove(); return; }
    const media = activeStoryMedia();
    if (!media) { if (wrap) wrap.remove(); return; }
    ensureOvlStyle();
    if (!wrap) { wrap = buildStoryDl(); (document.body || document.documentElement).appendChild(wrap); }
    const r = media.getBoundingClientRect();
    wrap.style.top = Math.max(8, r.top + 56) + "px";
    wrap.style.left = Math.round(r.right - 46) + "px";
    // Transcribe only makes sense for a video item — hide it on photos.
    const txBtn = wrap.querySelector('[data-sw="tx"]');
    if (txBtn) {
      const cur = currentStory();
      const isVideo = cur && cur.item && (cur.item.media_type === "video" || !!cur.item.video);
      txBtn.style.display = isVideo ? "" : "none";
    }
  }
  setInterval(maintainStoryDl, 800);
  window.addEventListener("resize", maintainStoryDl, { passive: true });

}
