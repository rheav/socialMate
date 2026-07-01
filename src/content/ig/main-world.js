// Instagram capture — runs in the PAGE's MAIN world at document_start.
//
// IG parses its feed/post JSON on the main thread, so hooking JSON.parse here
// catches every media object with clean fields (author, caption, like/comment/play
// counts, video_versions URL, thumb). We relay compact records to our isolated
// content script via window.postMessage (the two worlds share the DOM, not JS).

(function () {
  if (window.__fbwIgMainInit) return;
  window.__fbwIgMainInit = true;

  function* findMedia(o, seen) {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (o.video_versions || (o.code && o.image_versions2) || (o.media_type != null && (o.image_versions2 || o.carousel_media))) yield o;
    if (Array.isArray(o)) { for (const v of o) yield* findMedia(v, seen); }
    else { for (const k in o) yield* findMedia(o[k], seen); }
  }

  function mediaTypeName(m) {
    if (m.media_type === 8 || m.carousel_media) return "carousel";
    if (m.media_type === 2 || m.video_versions) return "video";
    return "photo";
  }
  function bestImage(m) {
    const c = m.image_versions2 && m.image_versions2.candidates;
    return (c && c[0] && c[0].url) || null;
  }
  function carouselOf(m) {
    if (!m.carousel_media) return null;
    return m.carousel_media.map((ch) => ({
      media_type: mediaTypeName(ch),
      image: bestImage(ch),
      video: (ch.video_versions && ch.video_versions[0] && ch.video_versions[0].url) || null,
    }));
  }

  function lite(m) {
    const u = m.user || m.owner || {};
    const img = m.image_versions2 && m.image_versions2.candidates && m.image_versions2.candidates[0];
    const vid = m.video_versions && m.video_versions[0];
    return {
      code: m.code || null,
      pk: String(m.pk || m.id || ""),
      username: u.username || null,
      full_name: u.full_name || null,
      verified: !!u.is_verified,
      caption: (m.caption && m.caption.text) || null,
      like_count: m.like_count != null ? m.like_count : null,
      comment_count: m.comment_count != null ? m.comment_count : null,
      play_count: m.play_count != null ? m.play_count : (m.ig_play_count != null ? m.ig_play_count : (m.view_count != null ? m.view_count : null)),
      thumb: img ? img.url : null,
      video: vid ? vid.url : null,
      duration: m.video_duration != null ? Math.round(m.video_duration) : null,
      media_type: mediaTypeName(m),
      image: bestImage(m),
      carousel: carouselOf(m),
      taken_at: m.taken_at != null ? m.taken_at : (m.taken_at_timestamp != null ? m.taken_at_timestamp : null),
      repost: m.media_repost_count != null ? m.media_repost_count : null,
    };
  }

  const sent = new Map(); // key -> signature (avoid resending unchanged)
  const all = new Map();  // key (code & pk) -> latest record, for replay
  function send(records) { if (records.length) window.postMessage({ __fbwIg: true, records }, location.origin); }
  function scan(root) {
    const out = [];
    try {
      const seen = new Set();
      for (const m of findMedia(root, seen)) {
        if (!m.code && !(m.pk || m.id)) continue;
        const r = lite(m);
        const key = r.code || r.pk;
        if (r.code) all.set(r.code, r);
        if (r.pk) all.set(r.pk, r);
        const sig = `${r.like_count}|${r.comment_count}|${r.play_count}|${r.repost}|${!!r.video}|${r.media_type}`;
        if (sent.get(key) !== sig) { sent.set(key, sig); out.push(r); }
      }
    } catch (_) {}
    send(out);
  }

  const orig = JSON.parse;
  JSON.parse = function (text, reviver) {
    const out = orig.apply(this, arguments);
    if (out && typeof out === "object") scan(out);
    return out;
  };

  // The isolated bridge attaches its listener at document_idle — long after we start
  // capturing. It asks us to replay everything we've buffered.
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__fbwIgReq) send([...new Set(all.values())]);
  });

  // ================== OPT-IN FULL-STATS FETCH ==================
  // IG splits stats across endpoints (posts grid → reposts, reels tab → views).
  // For exact IG-Sorter ER we fetch /api/v1/media/{pk}/info/ (the complete media
  // object) for listed posts — PACED, and only when the panel toggle is on.
  // Same-origin + credentialed; needs X-IG-App-ID + X-CSRFToken (from cookie).
  const DETAIL_GAP_MS = 600; // pace between detail fetches
  const DETAIL_CAP = 500; // safety cap per page session
  const IG_APP_ID = "936619743392459";
  const csrfToken = () => (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
  const detailQueue = [];
  const detailed = new Set();
  let detailOn = false, detailTimer = null, detailCount = 0;

  async function fetchDetail(pk) {
    try {
      const res = await fetch(`/api/v1/media/${pk}/info/`, {
        headers: {
          "X-IG-App-ID": IG_APP_ID,
          "X-CSRFToken": csrfToken(),
          "X-Requested-With": "XMLHttpRequest",
        },
        credentials: "include",
      });
      if (!res.ok) return;
      const j = await res.json();
      const item = j && j.items && j.items[0];
      if (!item) return;
      const r = lite(item); // full media object → complete record (views+repost+date)
      if (r.code) all.set(r.code, r);
      if (r.pk) all.set(r.pk, r);
      send([r]); // → bridge coalesce-merges into byId
    } catch (e) {
      /* ignore */
    }
  }
  function detailPump() {
    if (!detailOn || detailCount >= DETAIL_CAP) { detailTimer = null; return; }
    if (document.visibilityState !== "visible") { detailTimer = setTimeout(detailPump, 1500); return; }
    const pk = detailQueue.shift();
    if (pk == null) { detailTimer = setTimeout(detailPump, 1000); return; }
    if (detailed.has(pk)) { detailTimer = setTimeout(detailPump, 20); return; }
    detailed.add(pk);
    detailCount += 1;
    fetchDetail(pk).finally(() => { detailTimer = setTimeout(detailPump, DETAIL_GAP_MS); });
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__fbwIgFull) {
      detailOn = !!e.data.__fbwIgFull.on;
      if (detailOn) { if (!detailTimer) detailPump(); }
      else { clearTimeout(detailTimer); detailTimer = null; }
      return;
    }
    if (e.data.__fbwIgFetch && detailOn) {
      for (const pk of e.data.__fbwIgFetch) {
        const p = String(pk).split("_")[0];
        if (/^\d+$/.test(p) && !detailed.has(p) && !detailQueue.includes(p)) detailQueue.push(p);
      }
      if (!detailTimer) detailPump();
    }
  });
})();
