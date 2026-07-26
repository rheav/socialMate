// Pure, DOM-free helpers for the Pinterest Board tool. Unit-tested.
//
// Unlike FB/IG/TikTok, Pinterest data is ACTIVE: pin-api.js calls Pinterest's own
// /resource/* endpoints with the user's cookies and walks the cursor itself. That is
// possible because the API is unsigned and same-origin. Everything here is the pure
// half of that client — URL/header construction, envelope parsing, surface routing.
//
// Two rules cause silent 403s and are encoded here rather than at the call sites:
//   1. x-pinterest-pws-handler is MANDATORY and must match the route.
//   2. GET must NOT carry x-csrftoken; POST MUST.

import { downloadPath, kindFromExt, sanitizeFilenamePart } from "./downloadPath.js";
import { fmtCount } from "./shared/counts.js";
export { fmtCount };

export const PWS_HANDLERS = {
  home: "www/index.js",
  user: "www/[username].js",
  board: "www/[username]/[slug].js",
  section: "www/[username]/[slug]/[sectionSlug].js",
  search: "www/search/[scope].js",
};

// First path segments that are Pinterest features, never usernames.
const RESERVED = new Set([
  "pin", "search", "ideas", "today", "settings", "business", "news_hub",
  "categories", "topics", "discover", "login", "signup", "about", "_",
]);
// Second segments that are profile tabs, not board slugs.
const USER_TABS = new Set(["_saved", "_created", "_shop", "pins", "boards", "followers", "following"]);

const OTHER = { kind: "other", username: null, slug: null, sectionSlug: null, query: null, handler: PWS_HANDLERS.home, sourceUrl: "/", key: "other" };

// location.pathname is percent-encoded (accents, cedillas, emoji, spaces all get
// escaped). decodeURIComponent("%") throws URIError on a malformed escape — never
// let that propagate, since surfaceOf must never throw. Fall back to the raw segment.
function decodeSeg(seg) {
  if (seg == null) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

// Classify a Pinterest URL into the surface the resource API needs to be told about.
export function surfaceOf(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return OTHER;
  }
  const segs = u.pathname.split("/").filter(Boolean);
  // sourceUrl stays RAW/encoded: Pinterest's own requests send the encoded path as
  // source_url and x-pinterest-source-url, so decoding it would make our requests
  // diverge from what the site itself sends. username/slug/sectionSlug, by contrast,
  // are used as API OPTION VALUES (e.g. BoardResource's { username, slug }) — those
  // must be decoded, or any board name with non-ASCII characters (common for our
  // Brazilian users — accents, cedillas) 404s against the resource API.
  const sourceUrl = u.pathname + (u.search || "");

  if (!segs.length) return { ...OTHER, kind: "home", handler: PWS_HANDLERS.home, sourceUrl, key: "home" };

  if (segs[0] === "search")
    return {
      kind: "search", username: null, slug: null, sectionSlug: null,
      query: u.searchParams.get("q") || "",
      handler: PWS_HANDLERS.search, sourceUrl,
      key: "search:" + (u.searchParams.get("q") || ""),
    };

  if (segs[0] === "pin") return { ...OTHER, kind: "pin", sourceUrl, key: "pin:" + (segs[1] || "") };
  if (RESERVED.has(segs[0])) return { ...OTHER, sourceUrl };

  const username = decodeSeg(segs[0]);
  if (segs.length === 1 || USER_TABS.has(segs[1]))
    return {
      kind: "user", username, slug: null, sectionSlug: null, query: null,
      handler: PWS_HANDLERS.user, sourceUrl, key: "user:" + username,
    };

  const slug = decodeSeg(segs[1]);
  if (segs.length >= 3) {
    const sectionSlug = decodeSeg(segs[2]);
    return {
      kind: "section", username, slug, sectionSlug, query: null,
      handler: PWS_HANDLERS.section, sourceUrl,
      key: `section:${username}/${slug}/${sectionSlug}`,
    };
  }

  return {
    kind: "board", username, slug, sectionSlug: null, query: null,
    handler: PWS_HANDLERS.board, sourceUrl,
    key: `board:${username}/${slug}`,
  };
}

export function resourceGetUrl(name, options, sourceUrl, now = Date.now()) {
  const data = encodeURIComponent(JSON.stringify({ options, context: {} }));
  return `/resource/${name}/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${data}&_=${now}`;
}

// csrfToken is intentionally opt-in: sending it on a GET makes Pinterest 403.
export function resourceHeaders({ appVersion, sourceUrl, handler, csrfToken }) {
  const h = {
    accept: "application/json, text/javascript, */*, q=0.01",
    "x-app-version": appVersion,
    "x-requested-with": "XMLHttpRequest",
    "x-pinterest-appstate": "active",
    "x-pinterest-source-url": sourceUrl,
    "x-pinterest-pws-handler": handler,
  };
  if (csrfToken) h["x-csrftoken"] = csrfToken;
  return h;
}

export function parseEnvelope(json) {
  const rr = json?.resource_response;
  if (!rr) return { ok: false, error: "resposta vazia", data: null, results: [], bookmark: null, isEnd: true };
  if (rr.error) return { ok: false, error: rr.error.message || "erro da API", data: null, results: [], bookmark: null, isEnd: true };
  const data = rr.data ?? null;
  // Board/section feeds return an array; search returns { results: [...] }.
  const results = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
  const bookmark = typeof rr.bookmark === "string" ? rr.bookmark : null;
  return { ok: true, error: null, data, results, bookmark, isEnd: !bookmark || bookmark === "-end-" };
}

// filter_section_pins:false is the whole reason bulk works. Pinterest's own site
// sends true, which hides every pin that lives in a section — a 6689-pin board
// returned 6 pins with true and paginated fully with false.
export function boardFeedOptions(board, bookmark) {
  const o = {
    board_id: board.id,
    board_url: board.url,
    currentFilter: -1,
    field_set_key: "react_grid_pin",
    filter_section_pins: false,
    sort: "default",
    layout: "default",
    page_size: 25,
    redux_normalize_feed: true,
  };
  if (bookmark) o.bookmarks = [bookmark];
  return o;
}

// ---------------------------------------------------------------------------
// Media resolution
// ---------------------------------------------------------------------------
// Direct-MP4 qualities in preference order, then the HLS-only ones. ~80% of
// Pinterest video pins expose ONLY HLS, so the hls flag is the common path and
// pin-api.js resolves those to a real MP4 before download.
const MP4_QUALITIES = ["V_720P", "V_EXP7", "V_EXP6", "V_EXP5", "V_EXP4", "V_EXP3", "V_HEVC_MP4_T1"];
const HLS_QUALITIES = ["V_HLSV4", "V_HLSV3_MOBILE"];

function pickVideo(videoList) {
  if (!videoList) return null;
  for (const q of MP4_QUALITIES) {
    const v = videoList[q];
    if (v?.url && v.url.includes(".mp4"))
      return { kind: "video", url: v.url, hls: false, width: v.width ?? null, height: v.height ?? null, duration: v.duration ?? null, thumb: v.thumbnail || null };
  }
  // Highest-resolution HLS wins; it is only a pointer — the real MP4 is derived later.
  let best = null;
  for (const q of HLS_QUALITIES) {
    const v = videoList[q];
    if (!v?.url) continue;
    const area = (v.width || 0) * (v.height || 0);
    if (!best || area > best.area) best = { area, v };
  }
  if (!best) return null;
  const v = best.v;
  return { kind: "video", url: v.url, hls: true, width: v.width ?? null, height: v.height ?? null, duration: v.duration ?? null, thumb: v.thumbnail || null };
}

function pickImage(images) {
  // Full-res lives under two different keys depending on pin type — verified live:
  // ordinary pins key it images.orig, but Idea-Pin story blocks (image.images inside
  // story_pin_data.pages[].blocks[]) key it images.originals instead and omit orig
  // entirely. Both have the same { url, width, height } shape, so accept either.
  // Only these two keys are trustworthy. Rewriting /236x/ -> /originals/ 403s whenever
  // the original's extension differs from the thumbnail's (png vs jpg) — verified.
  const o = images?.orig || images?.originals;
  if (o?.url) return { kind: "image", url: o.url, hls: false, width: o.width ?? null, height: o.height ?? null, duration: null, thumb: null };
  const f = images?.["736x"] || images?.["474x"] || images?.["236x"];
  return f?.url ? { kind: "image", url: f.url, hls: false, width: f.width ?? null, height: f.height ?? null, duration: null, thumb: null } : null;
}

// Every downloadable asset on a pin, in page order. Idea Pins can hold several.
export function mediaItems(pin) {
  if (!pin || typeof pin !== "object") return [];
  const out = [];
  const pages = pin.story_pin_data?.pages;
  if (Array.isArray(pages) && pages.length) {
    for (const page of pages) {
      let got = null;
      for (const b of page?.blocks || []) {
        if (b?.video?.video_list) got = pickVideo(b.video.video_list);
        else if (b?.image?.images) got = pickImage(b.image.images);
        if (got) break;
      }
      if (!got && page?.image?.images) got = pickImage(page.image.images);
      if (got) out.push(got);
    }
    if (out.length) return out;
  }
  const v = pickVideo(pin.videos?.video_list);
  if (v) return [v];
  const i = pickImage(pin.images);
  return i ? [i] : [];
}

// ---------------------------------------------------------------------------
// HLS -> MP4
// ---------------------------------------------------------------------------
// Guessing MP4 paths from the signature (what Pin-Kit does) fails — 0/12 candidates
// hit. The variant FILENAME must come from the master manifest, because the suffix
// varies per pin (_360w, _720w, ...). With the real filename, swapping the directory
// /hls/ -> /expMp4/ works: verified 3/3 on live pins.
export function parseHlsMaster(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const file = (lines[i + 1] || "").trim();
    if (!file || file.startsWith("#")) continue;
    out.push({
      bandwidth: Number(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] || 0),
      resolution: lines[i].match(/RESOLUTION=([\dx]+)/)?.[1] || null,
      file,
    });
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth);
}

export function mp4CandidatesFromHls(hlsUrl, variantFile) {
  const url = String(hlsUrl || "");
  if (!url.includes("/hls/") || !variantFile) return [];
  const baseDir = url.replace(/[^/]+$/, "");
  const mp4Name = variantFile.replace(/\.m3u8$/, ".mp4");
  return ["expMp4", "hevcMp4V3"].map((dir) => baseDir.replace("/hls/", `/${dir}/`) + mp4Name);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
function mediaTypeOf(pin) {
  if (pin?.story_pin_data) return "idea";
  if (pin?.videos?.video_list) return "video";
  return "image";
}

// Pinterest sends created_at as an HTTP date string, not a unix stamp.
function createdAtUnix(pin) {
  const t = Date.parse(pin?.created_at || "");
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export function pinToRecord(pin, surfaceKey) {
  const items = mediaItems(pin);
  const thumb =
    pin?.images?.["236x"]?.url ||
    pin?.images?.["474x"]?.url ||
    items.find((i) => i.thumb)?.thumb ||
    items.find((i) => i.kind === "image")?.url ||
    null;
  return {
    id: String(pin?.id ?? ""),
    title: pin?.grid_title || pin?.title || "",
    description: (pin?.description || "").slice(0, 500),
    link: pin?.link || null,
    username: pin?.pinner?.username || pin?.native_creator?.username || "",
    fullName: pin?.pinner?.full_name || "",
    thumb,
    items,
    mediaType: mediaTypeOf(pin),
    count: items.length,
    saves: pin?.repin_count ?? null,
    comments: pin?.comment_count ?? null,
    created_at: createdAtUnix(pin),
    dominantColor: pin?.dominant_color || null,
    permalink: pin?.id ? `https://www.pinterest.com/pin/${pin.id}/` : null,
    surface: surfaceKey || null,
  };
}

export function recordToCard(rec) {
  return {
    id: rec.id,
    title: rec.title,
    thumb: rec.thumb,
    username: rec.username || "unknown",
    saves: rec.saves ?? null,
    comments: rec.comments ?? null,
    date: fmtDate(rec.created_at),
    mediaType: rec.mediaType,
    count: rec.count,
    permalink: rec.permalink,
  };
}

// ---------------------------------------------------------------------------
// Filenames + formatting
// ---------------------------------------------------------------------------
// One definition, in downloadPath.js — this used to be a byte-identical copy.
export { sanitizeFilenamePart };

export function baseNameFor(rec, ext, idx) {
  const base = `pin-${sanitizeFilenamePart(rec.username) || "pinterest"}-${rec.id || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

// A pin is an image OR a video (and a carousel can mix them), so the sub-folder
// comes from the resolved extension of THIS item, not from the record.
export function filenameFor(rec, ext, idx) {
  return downloadPath("pinterest", kindFromExt(ext), baseNameFor(rec, ext, idx));
}

export function extFromUrl(url, kind) {
  const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
  return kind === "video" ? "mp4" : "jpg";
}



export function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Sorting — Pinterest exposes no view count, so there is no engagement rate.
// ---------------------------------------------------------------------------
const METRIC = {
  saves: (r) => r.saves,
  comments: (r) => r.comments,
  date: (r) => r.created_at,
};

export function sortComparator(key, dir = "desc") {
  const get = METRIC[key] || METRIC.saves;
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // missing metrics sort last in BOTH directions
    if (bv == null) return -1;
    return (av - bv) * sign;
  };
}

export function sortRecords(records, key, dir) {
  if (key === "default") return [...records];
  return [...records].sort(sortComparator(key, dir));
}
