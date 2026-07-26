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
  // Node budget alongside the depth cap: depth alone doesn't bound a wide payload
  // (a 50k-element array is depth 2), and this runs inside the page's JSON.parse.
  const NODE_BUDGET = 50000;
  function* findMedia(o, seen, depth) {
    if (!o || typeof o !== "object" || seen.has(o) || depth > 20) return;
    if (seen.size > NODE_BUDGET) return;
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
    if (seen.size > NODE_BUDGET) return;
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
  // Swipe-up / link-sticker destinations on a story — competitors' actual funnel
  // URLs. Defensive: IG's shape is story_link_stickers[].story_link.url, but we
  // walk for any url-ish field so a rename degrades instead of dropping the link.
  function storyLinks(item) {
    const out = [];
    const seen = new Set();
    const push = (u) => { if (u && /^https?:/.test(u) && !seen.has(u)) { seen.add(u); out.push(u); } };
    const stickers = item.story_link_stickers || item.link_stickers || [];
    for (const s of Array.isArray(stickers) ? stickers : []) {
      const link = s.story_link || s.link || s;
      push(link && (link.url || link.web_uri || link.link_url || link.deeplink_url));
    }
    // Also catch CTA/bio link shapes some story payloads use.
    if (item.story_cta_url) push(item.story_cta_url);
    return out;
  }
  function liteStory(item, reelId, ownerUsername) {
    const img = item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates[0];
    const vid = item.video_versions && item.video_versions[0];
    const links = storyLinks(item);
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
      caption: (item.caption && item.caption.text && item.caption.text.slice(0, 500)) || null,
      taken_at: item.taken_at != null ? item.taken_at : null,
      expiring_at: item.expiring_at != null ? item.expiring_at : null,
      duration: item.video_duration != null ? Math.round(item.video_duration) : null,
      code: item.code || null,
      links: links.length ? links : null,
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
// <<< inline:src/lib/shared/igSurface.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/igSurface.js and run `npm run gen:inline`.
// Which Instagram surface a record belongs to. INLINED into content scripts —
// see src/lib/shared/README.md before editing (no imports allowed in this file).
//
// This is shared between the MAIN-world capture and the isolated bridge because
// the surface has to be decided WHERE AND WHEN the record is captured, not when it
// is relayed. The bridge used to stamp `surfaceKey()` at relay time, which is
// wrong for replays: after "Atualizar" the MAIN world resends everything it ever
// captured, so records from profile A arrived while the user was on profile B and
// got labelled `profile:B` — and the username backfill then attributed A's posts
// to B, defeating the Sort tool's ownership filter.

// Top-level IG routes that are features, not usernames. A path like /explore/ or
// /direct/ must never be read as a profile.
const IG_RESERVED_SEGMENTS = [
  "explore",
  "reels",
  "reel",
  "p",
  "direct",
  "stories",
  "accounts",
  "tv",
  "guides",
  "challenges",
  "about",
  "legal",
  "privacy",
  "terms",
];

/**
 * `path` is a pathname (defaults to the live location). Returns one of:
 *   "tag:<name>" | "explore" | "profile:<username>" | "feed"
 */
function igSurfaceKey(path) {
  const p = path == null ? location.pathname : String(path);
  let m;
  if ((m = p.match(/\/explore\/tags\/([^/]+)/))) {
    try {
      return "tag:" + decodeURIComponent(m[1]);
    } catch {
      return "tag:" + m[1]; // a malformed escape must not throw here
    }
  }
  if (p.startsWith("/explore")) return "explore";
  if ((m = p.match(/^\/([^/]+)\/?(?:reels\/?)?$/))) {
    const u = m[1];
    if (!IG_RESERVED_SEGMENTS.includes(u)) return "profile:" + u;
  }
  return "feed";
}
// >>> inline:end

  function scan(root) {
    const out = [];
    try {
      const seen = new Set();
      for (const m of findMedia(root, seen, 0)) {
        // Require a shortcode: skips carousel children (image objects with a pk
        // but no code) that would otherwise flood the list as empty-stat cards.
        if (!m.code) continue;
        const r = lite(m);
        // Stamp the surface HERE, where the record is actually seen. The bridge
        // used to decide it at relay time, which mislabels every replayed record
        // (see src/lib/shared/igSurface.js).
        r.__surface = igSurfaceKey();
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
      // This hook sits in front of EVERY JSON.parse on instagram.com — Relay/Bloks
      // payloads, config, logging, third-party libs. `scan` used to run
      // unconditionally, so every one of those paid for a recursive walk of the whole
      // object graph plus a Set holding every visited node. An indexOf over the raw
      // text is ~1µs even on a megabyte; the walk is milliseconds. Sniff first and
      // only walk payloads that can actually contain media. (The reels path below
      // already did this — the expensive, far more frequent path was the unguarded one.)
      const txt = typeof arguments[0] === "string" ? arguments[0] : null;
      const mediaish =
        !txt || // non-string input (rare): can't sniff, fall back to walking
        txt.indexOf("image_versions2") > -1 ||
        txt.indexOf("video_versions") > -1 ||
        txt.indexOf("carousel_media") > -1;
      if (mediaish) scan(out);
      if (txt && (txt.indexOf("expiring_at") > -1 || txt.indexOf("reel_type") > -1)) scanReels(out);
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
