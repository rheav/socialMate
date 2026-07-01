// Instagram bridge — isolated content-script world.
//
// Unlike Facebook (media hidden in a worker → webRequest + DASH mux), Instagram
// serves a direct progressive MP4 on the <video> element and parses metadata on the
// main thread. So we read the URL straight off the DOM and get rich metadata from
// the MAIN-world JSON.parse capture (relayed via window.postMessage). We publish the
// in-view video to the panel and, on request, hand the background the direct MP4 URL.

if (location.hostname.endsWith("instagram.com") && !window.__fbwIgInit) {
  window.__fbwIgInit = true;

  // code/pk -> record (lookups, e.g. publishCurrent) + canonical-id list (deduped)
  const igMedia = {};
  const byId = new Map(); // code||pk -> record; insertion order preserved for the list

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
      r.surface = surface;
      // The profile's own Reels-tab items omit the username → label them with the
      // profile owner (from the surface) so the panel shows @name, not @unknown.
      if (!r.username && surface.startsWith("profile:"))
        r.username = surface.slice("profile:".length);
      const id = r.code || r.pk;
      if (id) byId.set(id, { ...(byId.get(id) || {}), ...r });
      if (r.code) igMedia[r.code] = r;
      if (r.pk) igMedia[r.pk] = r;
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
  // Engagement rate by views: (likes + comments) / views × 100, or null.
  const erOf = (r) => {
    const v = r.play_count;
    if (!v || v <= 0) return null;
    return (((r.like_count || 0) + (r.comment_count || 0)) / v) * 100;
  };

  let overlayOn = true;
  let ovlStyleAdded = false;
  let ovlTimer = null;

  const OVL_SVG = {
    eye: '<circle cx="12" cy="12" r="3"/><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  };
  function ovlIcon(name, size) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${OVL_SVG[name]}</svg>`;
  }
  function ensureOvlStyle() {
    if (ovlStyleAdded) return;
    ovlStyleAdded = true;
    const s = document.createElement("style");
    s.textContent = `
      .sw-ovl{position:absolute;left:8px;bottom:8px;display:flex;flex-direction:column;gap:5px;
        padding:9px 12px;border-radius:14px;background:rgba(0,0,0,.4);
        -webkit-backdrop-filter:blur(7px) saturate(130%);backdrop-filter:blur(7px) saturate(130%);
        color:#fff;pointer-events:none;z-index:5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        text-shadow:0 1px 2px rgba(0,0,0,.45)}
      .sw-ovl-row{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:700;line-height:1;white-space:nowrap}
      .sw-ovl-row.primary{font-size:21px;font-weight:800}
      .sw-ovl svg{flex:none}`;
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
    // Vertical rail: views (reels) as the headline, then likes, comments, ER.
    // Grid JSON omits play_count → likes becomes the headline instead.
    if (hasViews)
      rows.push(`<div class="sw-ovl-row primary">${ovlIcon("eye", 21)}<span>${fmtCount(rec.play_count)}</span></div>`);
    rows.push(`<div class="sw-ovl-row${hasViews ? "" : " primary"}">${ovlIcon("heart", 16)}<span>${fmtCount(rec.like_count)}</span></div>`);
    rows.push(`<div class="sw-ovl-row">${ovlIcon("msg", 16)}<span>${fmtCount(rec.comment_count)}</span></div>`);
    const e = erOf(rec);
    if (e != null)
      rows.push(`<div class="sw-ovl-row">${ovlIcon("zap", 16)}<span>${e.toFixed(1)}%</span></div>`);
    el.innerHTML = rows.join("");
    return el;
  }
  function renderOverlays() {
    if (!overlayOn) {
      document.querySelectorAll(".sw-ovl").forEach((e) => e.remove());
      return;
    }
    ensureOvlStyle();
    for (const a of document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]')) {
      // Real thumbnails only. Grid tiles have <img>; Reels-tab tiles use a
      // background-image DIV (no <img>/<video>), so match by rendered size.
      const rect = a.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      const code = tileCode(a);
      if (!code) continue;
      const rec = byId.get(code);
      if (!rec) continue;
      const existing = a.querySelector(":scope > .sw-ovl");
      if (existing) {
        if (existing.dataset.code === code) continue;
        existing.remove();
      }
      if (getComputedStyle(a).position === "static") a.style.position = "relative";
      a.appendChild(buildOvl(rec, code));
    }
  }
  function scheduleRender() {
    clearTimeout(ovlTimer);
    ovlTimer = setTimeout(renderOverlays, 250);
  }

  chrome.storage?.local?.get("sw_ig_overlay").then((r) => {
    if (r?.sw_ig_overlay != null) overlayOn = !!r.sw_ig_overlay;
    scheduleRender();
  });
  chrome.storage?.onChanged?.addListener((ch, area) => {
    if (area === "local" && ch.sw_ig_overlay) {
      overlayOn = !!ch.sw_ig_overlay.newValue;
      renderOverlays();
    }
  });
  new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true });
  scheduleRender();
}
