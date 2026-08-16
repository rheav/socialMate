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
      // Who posted it, so the creator stats collected below can be joined on.
      userid: u.pk != null ? String(u.pk) : (u.id != null ? String(u.id) : null),
      // The sound it rides: audio_id deep-links to every other reel using it.
      ...(igAudioInfo(m) || {}),
    };
  }

  // ---- creator stats (item 2) ----
  // User dicts ride along in payloads we already parse — profile headers, search
  // results, suggested-user rails. Collecting them costs no request and turns a
  // list of posts into a list of CREATORS: views per follower, small accounts
  // punching above their size, a bio and a link to contact them by.
  const users = new Map(); // userid -> stats
  function* findUsers(o, seen, depth) {
    if (!o || typeof o !== "object" || seen.has(o) || depth > 20) return;
    if (seen.size > NODE_BUDGET) return;
    seen.add(o);
    if (o.username && (o.follower_count != null || o.media_count != null)) yield o;
    if (Array.isArray(o)) { for (const v of o) yield* findUsers(v, seen, depth + 1); }
    else { for (const k in o) yield* findUsers(o[k], seen, depth + 1); }
  }
  function scanUsers(root) {
    const out = [];
    try {
      const seen = new Set();
      for (const u of findUsers(root, seen, 0)) {
        const stats = igUserStats(u);
        if (!stats) continue;
        const prev = users.get(stats.userid);
        const next = mergeIgRecord(prev, stats);
        if (prev && JSON.stringify(prev) === JSON.stringify(next)) continue;
        users.set(stats.userid, next);
        out.push({ __kind: "user", ...next });
      }
      while (users.size > 400) users.delete(users.keys().next().value);
    } catch (_) {}
    send(out);
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
// <<< inline:src/lib/shared/igFilters.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/igFilters.js and run `npm run gen:inline`.
// Panel-side knobs for the Instagram tool that the page ALSO needs — the overlay
// draws the same ER the panel sorts by, and the auto-scroll runs in the page.
// Canonical source, inlined into the capture scripts (see ./README.md).

// ---- date range (item 4) ----
// A hashtag search is mostly old posts; "what worked this month" is the question
// worth asking, and sorting alone can't answer it.
const DATE_RANGES = [
  { value: "all", label: "Todo o período", days: null },
  { value: "7d", label: "Últimos 7 dias", days: 7 },
  { value: "14d", label: "Últimos 14 dias", days: 14 },
  { value: "30d", label: "Últimos 30 dias", days: 30 },
  { value: "90d", label: "Últimos 90 dias", days: 90 },
  { value: "180d", label: "Últimos 180 dias", days: 180 },
  { value: "1y", label: "Último ano", days: 365 },
  { value: "2y", label: "Últimos 2 anos", days: 730 },
];

/**
 * `takenAt` is IG's taken_at — UNIX SECONDS, like the payload gives it. A record
 * whose date never arrived is KEPT: the grid payloads often omit taken_at, and
 * hiding those posts would look like the filter had eaten real results.
 */
function withinDateRange(takenAt, range, nowSec = Math.floor(Date.now() / 1000)) {
  const r = DATE_RANGES.find((x) => x.value === range);
  if (!r || r.days == null) return true;
  if (typeof takenAt !== "number" || !Number.isFinite(takenAt)) return true;
  return takenAt >= nowSec - r.days * 86400;
}

// ---- ER weights (item 5) ----
// Defaults match IG Sorter's, which is what these numbers were copied from: a
// comment and a repost each cost far more intent than a like.
const ER_WEIGHTS = { like: 1, comment: 4, repost: 4 };
const ER_WEIGHTS_KEY = "fbw_ig_er_weights"; // storage.local — panel writes, page reads

/** Per-field fallback: one junk value must not throw away the other two. */
function normalizeErWeights(w) {
  const out = { ...ER_WEIGHTS };
  if (!w || typeof w !== "object") return out;
  for (const k of Object.keys(ER_WEIGHTS)) {
    const n = Number(w[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

// ---- paced auto-scroll (item 6) ----
// IG Sorter scrolls to the bottom on a timer: 3 s for the first five, 6 s for the
// next five, then 10 s. Same shape here — a harvester that keeps a constant fast
// cadence is the part that reads as automation.
function scrollGapMs(i) {
  if (i < 5) return 3000;
  if (i < 10) return 6000;
  return 10000;
}

// ---- React-props media resolution (item 8) ----
// The full-screen /reels/ player renders no <a> around the video, so an
// anchor-based overlay finds nothing there. Instagram's own props do carry an
// identifier — a shortcode on some surfaces, a media id or the video's FB id on
// others — so the overlay resolves whichever one is present and looks it up.
const CODE_RE = /\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/;

function readReactMediaRef(props) {
  if (!props || typeof props !== "object") return null;
  const code = props.post && props.post.code;
  if (code) return { kind: "code", value: String(code) };
  const mediaKeyId = props.media$key && props.media$key.id;
  if (mediaKeyId) return { kind: "id", value: String(mediaKeyId) };
  if (props.mediaId) return { kind: "id", value: String(props.mediaId) };
  const fbid = (props.coreVideoPlayerMetaData && props.coreVideoPlayerMetaData.videoFBID) || props.videoFBID;
  if (fbid) return { kind: "pk", value: String(fbid) };
  if (props.postId) return { kind: "pk", value: String(props.postId) };
  const postIdNested = props.post && props.post.id;
  if (postIdNested) return { kind: "id", value: String(postIdNested) };
  if (typeof props.href === "string") {
    const m = props.href.match(CODE_RE);
    if (m) return { kind: "code", value: m[1] };
  }
  return null;
}
// >>> inline:end
// <<< inline:src/lib/shared/igEnrich.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/igEnrich.js and run `npm run gen:inline`.
// Filling the holes Instagram leaves in a captured record. Canonical source —
// inlined verbatim into the import-free capture scripts (see ./README.md).
//
// WHY THIS EXISTS. Measured live on /explore/search/keyword/?q=%23auralytrend
// (2026-08-15): the keyword-search SERP query (xdt_fbsearch__top_serp_graphql)
// returns `view_count: null` for 24 of 24 videos and carries no `play_count` /
// `ig_play_count` key at all — while like_count and comment_count are present on
// every one and `like_and_view_counts_disabled` is false. So the views did not
// move to another field; that endpoint simply stopped shipping them, which is why
// the overlay's eye row and the panel's views column went blank.
//
// The same post read through /api/v1/media/<pk>/info/ answers play_count 52222.
// So a video with no views is a record with a HOLE, and the hole has a cheap fix:
// ask for that one media. This module decides when to ask and how to merge the
// answer; the capture script owns the request itself.
//
// This is a deliberate break from "passive only" — until now the IG capture read
// what Instagram parsed and never called anything. One request per video, paced,
// is the smallest possible break, and it only fires for media the user has
// actually scrolled into view.

// One request per second, at most. IG Sorter (the reference extension) fires all
// 24 of a SERP page's enrichments the moment the payload lands, with no queue and
// no viewport gate — on a logged-in account that reads as a script, not a reader.
const ENRICH_MIN_GAP_MS = 1000;

/**
 * Does this record still need a per-media fetch?
 *
 * Only videos: photos and carousels have no view count to recover, and asking for
 * them would double the request count for nothing. `pk` is what the endpoint is
 * keyed by, so a record without one can never be asked about.
 */
function needsEnrichment(rec) {
  if (!rec || !rec.pk) return false;
  if (rec.media_type !== "video") return false;
  return rec.play_count == null || rec.video == null || rec.taken_at == null;
}

/**
 * The "how big is this creator" numbers out of an Instagram user dict, or null if
 * the object isn't one. These ride along in payloads we already parse — no extra
 * request — and they are what turns a list of posts into a list of creators worth
 * modelling (views per follower, small-account outliers, contactable bios).
 */
function igUserStats(u) {
  if (!u || typeof u !== "object") return null;
  const id = u.pk != null ? String(u.pk) : u.id != null ? String(u.id) : null;
  if (!id) return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const follower_count = num(u.follower_count);
  const media_count = num(u.media_count);
  // A user dict without any of these is a mention/tag stub, not a profile payload.
  if (follower_count == null && media_count == null) return null;
  return {
    userid: id,
    username: u.username || null,
    follower_count,
    following_count: num(u.following_count),
    media_count,
    total_clips_count: num(u.total_clips_count),
    biography: u.biography || null,
    external_url: u.external_url || null,
    is_business: !!u.is_business,
  };
}

/**
 * The sound a reel rides, so a trend can be traced back to its audio: original
 * sounds first (the creator's own), then a licensed track. `audio_id` deep-links
 * to instagram.com/reels/audio/<id>/, which lists every reel using it.
 */
function igAudioInfo(m) {
  const meta = m && m.clips_metadata;
  if (!meta) return null;
  const orig = meta.original_sound_info;
  if (orig && orig.audio_asset_id != null)
    return {
      audio_id: String(orig.audio_asset_id),
      audio_author: (orig.ig_artist && orig.ig_artist.username) || null,
      audio_ms: typeof orig.duration_in_ms === "number" ? orig.duration_in_ms : null,
    };
  const track = meta.music_info && meta.music_info.music_asset_info;
  if (track && track.audio_cluster_id != null)
    return {
      audio_id: String(track.audio_cluster_id),
      audio_author: track.display_artist || null,
      audio_ms: typeof track.duration_in_ms === "number" ? track.duration_in_ms : null,
    };
  return null;
}

/**
 * Fold a fresh sighting into a stored one. A later payload is not necessarily a
 * richer payload — the SERP carries no views, the grid carries no video URL — so
 * a null in the incoming record means "this payload didn't say", never "it's gone".
 */
function mergeIgRecord(prev, next) {
  if (!prev) return { ...next };
  const out = { ...prev };
  for (const [k, v] of Object.entries(next || {})) if (v != null) out[k] = v;
  return out;
}
// >>> inline:end
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
        queueEnrichment(r);
      }
      // Cap replay buffers for long SPA sessions (all holds ~2 keys per record:
      // code and pk). Oldest entries evict first (Map keeps insertion order).
      while (all.size > 1200) all.delete(all.keys().next().value);
      while (sent.size > 700) sent.delete(sent.keys().next().value);
    } catch (_) {}
    send(out);
  }

  // ---- views enrichment (item 1) ----
  // The keyword-search SERP ships no play_count at all (measured: 24/24 videos
  // with view_count null, no play_count key), so a video captured there arrives
  // with a hole where its views should be. /api/v1/media/<pk>/info/ still answers
  // with them — it is the same call Instagram makes when you open a post.
  //
  // Two rules keep this from reading as a script: ONE request per second (the
  // reference extension fires all 24 at once, unthrottled), and only while the tab
  // is actually being looked at. The app's own x-ig-app-id is borrowed rather than
  // hardcoded — it rotates, and a wrong one 400s.
  const IG_APP_ID_HEADER = "x-ig-app-id";
  let igAppId = null;
  const enrichQueue = [];
  const enrichAsked = new Set();
  let enrichTimer = null;

  function captureAppId(name, value) {
    if (!igAppId && String(name).toLowerCase() === IG_APP_ID_HEADER && value) igAppId = String(value);
  }
  // Instagram sets the header on its own requests; both transports are hooked
  // because which one carries a given query changes between releases.
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (n, v) {
    try { captureAppId(n, v); } catch (_) {}
    return xhrSetHeader.apply(this, arguments);
  };
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const h = (init && init.headers) || (input && input.headers);
        if (h) {
          if (typeof h.get === "function") captureAppId(IG_APP_ID_HEADER, h.get(IG_APP_ID_HEADER));
          else for (const k in h) captureAppId(k, h[k]);
        }
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }

  function queueEnrichment(rec) {
    if (!needsEnrichment(rec) || enrichAsked.has(rec.pk)) return;
    enrichAsked.add(rec.pk);
    // The surface travels WITH the pk. The queue drains at 1 req/s and pauses
    // while the tab is hidden, so a page of 24 takes at least 24s — long enough
    // for the user to have walked from #tag into a profile. Stamping the LIVE
    // surface at drain time relabels those posts as the profile's, mergeIgRecord
    // lets the non-null value win, and the bridge then files them (and their
    // username) under a surface they were never on.
    enrichQueue.push({ pk: rec.pk, surface: rec.__surface || igSurfaceKey() });
    if (enrichAsked.size > 600) enrichAsked.clear(); // long SPA session; re-asking is fine
    startEnrichLoop();
  }
  function startEnrichLoop() {
    if (enrichTimer || !enrichQueue.length) return;
    enrichTimer = setTimeout(drainEnrichment, ENRICH_MIN_GAP_MS);
  }
  async function drainEnrichment() {
    enrichTimer = null;
    // Not the active tab → don't spend the user's rate budget on it. The queue
    // survives; the next capture restarts the loop.
    if (document.visibilityState !== "visible" || !igAppId) return startEnrichLoop();
    const job = enrichQueue.shift();
    if (!job) return;
    const { pk, surface } = job;
    try {
      const r = await origFetch(`/api/v1/media/${pk}/info/`, {
        credentials: "include",
        headers: { [IG_APP_ID_HEADER]: igAppId, "x-requested-with": "XMLHttpRequest" },
      });
      if (r.ok) {
        const j = await r.json();
        // Straight through the normal path: lite() reads it, the surface stamp and
        // the replay buffer treat it like any other sighting, and the bridge merges.
        const items = (j && j.items) || [];
        const out = [];
        for (const m of items) {
          if (!m || !m.code) continue;
          const rec = lite(m);
          rec.__surface = surface; // where the post was SEEN, not where we are now
          const prev = all.get(rec.code);
          const merged = mergeIgRecord(prev, rec);
          all.set(rec.code, merged);
          if (merged.pk) all.set(merged.pk, merged);
          out.push(merged);
        }
        send(out);
      }
    } catch (_) {
      /* offline, rate-limited, logged out — the record just keeps its hole */
    }
    startEnrichLoop();
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
      // Creator stats travel in payloads with no media in them at all (a profile
      // header, a suggested-users rail), so they get their own sniff.
      if (mediaish || (txt && txt.indexOf("follower_count") > -1)) scanUsers(out);
      if (txt && (txt.indexOf("expiring_at") > -1 || txt.indexOf("reel_type") > -1)) scanReels(out);
    }
    return out;
  };

  // ---- name the media for the isolated world ----
  // The reel player (/reels/<code>/, /reel/<code>/) wraps NO <a> around the video,
  // so the bridge's link scan finds nothing there and the stats rail never
  // appeared on the surface where it is most wanted.
  //
  // Instagram's React props DO name the media (coreVideoPlayerMetaData.videoFBID —
  // verified live on /reels/DaBFBcgxZIi/), but those props hang off the page's own
  // JS objects: an ISOLATED-world script sees the same DOM and none of those
  // properties. Only this script, which runs in the MAIN world, can read them.
  //
  // So the MAIN world resolves the reference and writes it back as a DOM
  // ATTRIBUTE, which both worlds can see. The bridge then treats a stamped
  // container exactly like a link.
  const SW_MEDIA_ATTR = "data-sw-media";
  // Which media each player box was stamped FOR. Identity of the <video> plus its
  // src is what tells a re-render (same reel, nothing to do) from a reel change
  // (stamp is stale). WeakMap so a box Instagram drops is collectible.
  const stampedBy = new WeakMap();
  function annotateReelPlayer() {
    if (!/^\/(reels?|p)\//.test(location.pathname)) return;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      // The rail is hung on the player box, not the <video>: IG replaces the video
      // element on every reel change, and an attribute on it dies with it.
      const host = v.closest('div[role="presentation"]') || v.parentElement;
      if (!host) continue;
      // …which is exactly why the stamp cannot be written once and left alone. The
      // box OUTLIVES the media it describes, so on the full-screen player scrolling
      // to the next reel used to leave the previous reel's id on it — the overlay
      // then showed the old stats and Download/Save/Transcribe fired on the old
      // video. Re-resolve whenever the media under this box changed, and drop the
      // stale stamp first: resolving nothing is recoverable, pointing at the wrong
      // reel is not.
      const src = v.currentSrc || v.src || "";
      const seen = stampedBy.get(host);
      if (seen && seen.video === v && seen.src === src && host.getAttribute(SW_MEDIA_ATTR))
        continue;
      if (seen) {
        host.removeAttribute(SW_MEDIA_ATTR);
        host.removeAttribute(SW_MEDIA_ATTR + "-kind");
      }
      stampedBy.set(host, { video: v, src });
      let el = v;
      for (let i = 0; i < 15 && el; i++) {
        let key = null;
        for (const k in el) if (k.startsWith("__reactProps$")) { key = k; break; }
        if (key) {
          const props = el[key];
          const inner = props && props.children && props.children.props;
          const ref = readReactMediaRef(inner) || readReactMediaRef(props);
          if (ref) {
            host.setAttribute(SW_MEDIA_ATTR, ref.value);
            host.setAttribute(SW_MEDIA_ATTR + "-kind", ref.kind);
            break;
          }
        }
        el = el.parentElement;
      }
    }
  }
  // Cheap and idempotent (a box whose media has not changed costs one WeakMap hit
  // and two identity comparisons), so a plain interval is enough — no second
  // MutationObserver on a page that mutates constantly.
  setInterval(annotateReelPlayer, 1000);
  document.addEventListener("visibilitychange", annotateReelPlayer);

  // The isolated bridge attaches its listener at document_idle — long after we start
  // capturing. It asks us to replay everything we've buffered (media + reels).
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__fbwIgReq)
      send([...new Set(all.values()), ...reelAll.values()]);
  });

})();
