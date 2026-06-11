// Instagram bridge — isolated content-script world. No on-page UI.
//
// Unlike Facebook (media hidden in a worker → webRequest + DASH mux), Instagram
// serves a direct progressive MP4 on the <video> element and parses metadata on the
// main thread. So we read the URL straight off the DOM and get rich metadata from
// the MAIN-world JSON.parse capture (relayed via window.postMessage). We publish the
// in-view video to the panel and, on request, hand the background the direct MP4 URL.

if (location.hostname.endsWith("instagram.com") && !window.__fbwIgInit) {
  window.__fbwIgInit = true;

  // code/pk -> record (from the MAIN-world JSON.parse capture)
  const igMedia = {};
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__fbwIg) return;
    for (const r of e.data.records || []) {
      if (r.code) igMedia[r.code] = r;
      if (r.pk) igMedia[r.pk] = r;
    }
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
    if (msg?.type === "FBW_RUN_TRANSCRIBE") run("transcribe");
    if (msg?.type === "FBW_RUN_DOWNLOAD") run("download");
    if (msg?.type === "FBW_PING") { lastKey = null; publishCurrent(); sendResponse?.({ ok: true }); }
  });
}
