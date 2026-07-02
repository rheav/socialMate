// Instagram capture — runs in the PAGE's MAIN world at document_start.
//
// IG parses its feed/post JSON on the main thread, so hooking JSON.parse here
// catches every media object with clean fields (author, caption, like/comment/play
// counts, video_versions URL, thumb). We relay compact records to our isolated
// content script via window.postMessage (the two worlds share the DOM, not JS).

(function () {
  if (window.__fbwIgMainInit) return;
  window.__fbwIgMainInit = true;

  // Depth-capped: media objects sit well within 20 levels; the cap keeps a
  // pathological payload from hanging the main thread mid-JSON.parse.
  function* findMedia(o, seen, depth) {
    if (!o || typeof o !== "object" || seen.has(o) || depth > 20) return;
    seen.add(o);
    if (o.video_versions || (o.code && o.image_versions2) || (o.media_type != null && (o.image_versions2 || o.carousel_media))) yield o;
    if (Array.isArray(o)) { for (const v of o) yield* findMedia(v, seen, depth + 1); }
    else { for (const k in o) yield* findMedia(o[k], seen, depth + 1); }
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
      caption: (m.caption && m.caption.text && m.caption.text.slice(0, 500)) || null,
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

  // ---- stories & highlights (passive) ----
  // A "reel" is one highlight or one live-story tray. When you open one, IG
  // fetches the whole reel via /graphql/query (JS-parsed → this hook sees it).
  // We emit the reel container (title/cover/owner) + each story item, tagged
  // with __kind so the bridge routes them to a separate store.
  function* findReels(o, seen, depth) {
    if (!o || typeof o !== "object" || seen.has(o) || depth > 22) return;
    seen.add(o);
    if (o.id && Array.isArray(o.items) && o.items.length &&
        (o.reel_type || String(o.id).indexOf("highlight:") > -1)) yield o;
    if (Array.isArray(o)) { for (const v of o) yield* findReels(v, seen, depth + 1); }
    else { for (const k in o) yield* findReels(o[k], seen, depth + 1); }
  }
  function pickCover(reel) {
    const cm = reel.cover_media;
    if (cm) {
      const c = cm.cropped_image_version || cm.full_image_version;
      if (c && c.url) return c.url;
      const cand = cm.image_versions2 && cm.image_versions2.candidates && cm.image_versions2.candidates[0];
      if (cand) return cand.url;
    }
    const it = reel.items && reel.items[0];
    return it ? bestImage(it) : null; // live stories have no cover → first frame
  }
  function liteStory(item, reelId, ownerUsername) {
    const img = item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates[0];
    const vid = item.video_versions && item.video_versions[0];
    return {
      __kind: "story",
      pk: String(item.pk || item.id || ""),
      reel_id: reelId,
      owner_username: ownerUsername || null,
      media_type: mediaTypeName(item),
      image: bestImage(item),
      video: vid ? vid.url : null,
      thumb: img ? img.url : null,
      carousel: carouselOf(item),
      taken_at: item.taken_at != null ? item.taken_at : null,
      expiring_at: item.expiring_at != null ? item.expiring_at : null,
      duration: item.video_duration != null ? Math.round(item.video_duration) : null,
      code: item.code || null,
    };
  }
  const reelSent = new Map(); // reel_id / "s:"+pk -> signature
  const reelAll = new Map();  // same keys -> record, for replay
  function scanReels(root) {
    const out = [];
    try {
      const seen = new Set();
      for (const reel of findReels(root, seen, 0)) {
        const reelId = String(reel.id);
        const owner = reel.user ? reel.user.username || null : null;
        const meta = {
          __kind: "reel",
          reel_id: reelId,
          reel_type: reel.reel_type || (reelId.indexOf("highlight:") > -1 ? "highlight" : "user_reel"),
          title: reel.title || null,
          owner: reel.user ? { pk: String(reel.user.pk || ""), username: owner } : null,
          cover: pickCover(reel),
          item_count: reel.items.length,
        };
        const sig = `${meta.title}|${reel.items.length}`;
        if (reelSent.get(reelId) !== sig) {
          reelSent.set(reelId, sig);
          reelAll.set(reelId, meta);
          out.push(meta);
        }
        for (const item of reel.items) {
          const s = liteStory(item, reelId, owner);
          if (!s.pk) continue;
          const k = "s:" + s.pk;
          if (reelSent.get(k) === "1") continue;
          reelSent.set(k, "1");
          reelAll.set(k, s);
          out.push(s);
        }
      }
      while (reelAll.size > 600) reelAll.delete(reelAll.keys().next().value);
      while (reelSent.size > 600) reelSent.delete(reelSent.keys().next().value);
    } catch (_) {}
    send(out);
  }

  const sent = new Map(); // key -> signature (avoid resending unchanged)
  const all = new Map();  // key (code & pk) -> latest record, for replay
  function send(records) { if (records.length) window.postMessage({ __fbwIg: true, records }, location.origin); }
  function scan(root) {
    const out = [];
    try {
      const seen = new Set();
      for (const m of findMedia(root, seen, 0)) {
        // Require a shortcode: skips carousel children (image objects with a pk
        // but no code) that would otherwise flood the list as empty-stat cards.
        if (!m.code) continue;
        const r = lite(m);
        const key = r.code || r.pk;
        if (r.code) all.set(r.code, r);
        if (r.pk) all.set(r.pk, r);
        const sig = `${r.like_count}|${r.comment_count}|${r.play_count}|${r.repost}|${!!r.video}|${r.media_type}`;
        if (sent.get(key) !== sig) { sent.set(key, sig); out.push(r); }
      }
      // Cap replay buffers for long SPA sessions (all holds ~2 keys per record:
      // code and pk). Oldest entries evict first (Map keeps insertion order).
      while (all.size > 1200) all.delete(all.keys().next().value);
      while (sent.size > 700) sent.delete(sent.keys().next().value);
    } catch (_) {}
    send(out);
  }

  const orig = JSON.parse;
  JSON.parse = function () {
    const out = orig.apply(this, arguments);
    if (out && typeof out === "object") {
      scan(out);
      // Only walk for reels when the payload smells like one — keeps the common
      // case (feed/grid JSON) a single traversal.
      const txt = arguments[0];
      if (typeof txt === "string" && (txt.indexOf("expiring_at") > -1 || txt.indexOf("reel_type") > -1)) scanReels(out);
    }
    return out;
  };

  // The isolated bridge attaches its listener at document_idle — long after we start
  // capturing. It asks us to replay everything we've buffered (media + reels).
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__fbwIgReq)
      send([...new Set(all.values()), ...reelAll.values()]);
  });

})();
