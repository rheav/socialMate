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

// Classify a Pinterest URL into the surface the resource API needs to be told about.
export function surfaceOf(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return OTHER;
  }
  const segs = u.pathname.split("/").filter(Boolean);
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

  const username = segs[0];
  if (segs.length === 1 || USER_TABS.has(segs[1]))
    return {
      kind: "user", username, slug: null, sectionSlug: null, query: null,
      handler: PWS_HANDLERS.user, sourceUrl, key: "user:" + username,
    };

  const slug = segs[1];
  if (segs.length >= 3)
    return {
      kind: "section", username, slug, sectionSlug: segs[2], query: null,
      handler: PWS_HANDLERS.section, sourceUrl,
      key: `section:${username}/${slug}/${segs[2]}`,
    };

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
  if (!rr) return { ok: false, error: "empty response", data: null, results: [], bookmark: null, isEnd: true };
  if (rr.error) return { ok: false, error: rr.error.message || "api error", data: null, results: [], bookmark: null, isEnd: true };
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
