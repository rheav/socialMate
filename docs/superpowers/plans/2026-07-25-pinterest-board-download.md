# Pinterest Board Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pinterest as a fourth platform with a Board tool that harvests an entire board (or section, or search) through Pinterest's authenticated resource API and bulk-downloads every pin's full-resolution image or MP4 video.

**Architecture:** Pinterest is the **first active-fetch platform**. FB/IG/TikTok all capture passively (webRequest / JSON.parse hook / fetch tee) because their APIs are signed or worker-issued. Pinterest's `/resource/*` API is plain JSON, cookie-authenticated, same-origin, and cursor-paginated — so an isolated content script on `pinterest.com` calls it directly and paginates a whole board without the user scrolling. There is **no MAIN-world hook and no bridge**; `src/content/pin/pin-api.js` is a single isolated content script that owns the API client, and the panel drives it over `chrome.tabs.sendMessage`. All parsing/URL/selection logic is pure and unit-tested in `src/lib/pinMedia.js`.

**Tech Stack:** Vanilla JS content script (ES imports OK — CRXJS bundles them), React 19 + shadcn side panel, `chrome.downloads`, Vitest (node env).

**Recon source:** `../../../.recon/*.json` (repo root) and memory `pinterest-scrape-recon`. Every API fact in this plan was verified live against `br.pinterest.com` on 2026-07-25 while logged in. See Appendix A for the full verified contract.

## Global Constraints

- **`x-pinterest-pws-handler` is mandatory on every resource call** and must match the route, or Pinterest returns `403 Invalid Resource Request` even with perfect cookies and options. Values: board `www/[username]/[slug].js`, section `www/[username]/[slug]/[sectionSlug].js`, search `www/search/[scope].js`, home `www/index.js`.
- **GET must NOT send `x-csrftoken`; POST MUST.** A GET carrying it returns 403; a POST without it returns `Bad CSRF token`. `BoardFeedResource`/`BoardResource`/`BoardSectionsResource` are GET. `BaseSearchResource` is POST.
- **`filter_section_pins: false`** on `BoardFeedResource` — this is the bulk key. Pinterest's own site sends `true`, which returns only un-sectioned pins (a 6689-pin board returned **6**).
- Auth is cookies only, via `credentials: "include"`. `_auth` / `_pinterest_sess` are httpOnly — never attempt to read them from JS. Only `csrftoken` is readable from `document.cookie`.
- `x-app-version` comes from `JSON.parse(document.querySelector("#__PWS_DATA__").textContent).appVersion`. `meta[name="pinterest-app-version"]` does **not** exist on the current site. Hardcoded fallback `"d97c852"` (observed 2026-07-25); a stale value still works but refresh it if calls start failing.
- **Never rewrite `/236x/` → `/originals/`.** The extension can differ (thumb `.jpg`, original `.png`) and the rewrite 403s. Always use `images.orig.url`.
- **HLS is the majority case** (66 of 80 sampled video pins). MP4-path *guessing* fails (0/12). The only working rule: read the master `.m3u8`, take the highest-`BANDWIDTH` variant's filename **from the manifest**, then swap dir `/hls/` → `/expMp4/` and `.m3u8` → `.mp4` (fallback `/hevcMp4V3/`). Verified 3/3.
- `i.pinimg.com` / `v1.pinimg.com` are CORS-open, accept `Range`, need **no Referer** — no `declarativeNetRequest` rule (unlike TikTok).
- Pinterest exposes **no view counts**, so there is no engagement rate. Sort keys are saves / comments / date / default only.
- Bulk download pacing: **serial, 400 ms between items**, matching `IgSortTool.downloadAll` / `TtSortTool.downloadAll`. Page-to-page harvest delay **350 ms**.
- Harvest safety cap: **40 pages** (~1000 pins) per run, surfaced in the UI, never silent.
- Bump `version` in BOTH `manifest.config.js` and `package.json` (0.63.0 → **0.64.0**), set `version_name`, add a CHANGELOG entry (project rule).
- Commands: tests `npx vitest run`, build `npm run build`.
- Code style: match existing — 2-space indent, no TS, section banner comments explaining *why*, `catch {}` for intentional no-ops, `@/lib/...` alias in panel code and relative `./lib/...` in content scripts.

## Scope

**In:** board harvest + section harvest + search harvest, full-res image download, video download (MP4 direct and HLS-derived), multi-page Idea Pins, bulk download, save to Library, sorting.

**Out (deliberate, do not build):** a Warm engine adapter for Pinterest (no `src/content.js` changes, no `PLATFORM_HOST` engine wiring beyond tab resolution), ZIP bundling, transcription of Pinterest video, comments. Pinterest gets a download tool only; `TOOLS` will list exactly one Pinterest entry.

## File Structure

| File | Responsibility |
|---|---|
| Create `src/lib/pinMedia.js` | All pure logic: surface detection, resource URL/header/envelope, pin→record, media selection, HLS parsing, filenames, sorting. No DOM, no chrome APIs. |
| Create `src/lib/pinMedia.test.js` | Vitest coverage for the above. |
| Create `src/content/pin/pin-api.js` | Isolated content script on pinterest.com. Owns the authenticated fetch client, pagination loop, in-memory record store, and the `FBW_PIN_*` message handlers. |
| Create `src/components/tools/PinBoardTool.jsx` | The panel: context header, Harvest button + progress, pin grid, per-pin and bulk download, save-to-Library. |
| Modify `src/lib/platforms.jsx` | `PinterestGlyph`, `THEMES.pinterest`, `PLATFORMS.pinterest`, `PLATFORM_ORDER`. |
| Modify `src/lib/tabs.js:3-7` | `PLATFORM_HOST.pinterest`. |
| Modify `src/lib/tools.jsx:21-34` | One `pin-board` TOOLS entry. |
| Modify `manifest.config.js` | Host permissions (`pinterest.com`, `pinimg.com`), one content_scripts entry, version bump. |

`src/background.js` needs **zero code changes**: `FBW_DL_MEDIA` already handles `kind:"video"` (direct URL — works because pinimg needs no Referer) and `kind:"image"` (SW fetch → base64 data URL — works once `*://*.pinimg.com/*` is in `host_permissions`).

---

### Task 1: pinMedia.js — surface detection + resource API contract

**Files:**
- Create: `src/lib/pinMedia.js`
- Create: `src/lib/pinMedia.test.js`

**Interfaces:**
- Produces (Tasks 2–7 import these from `@/lib/pinMedia` in panel code, `../../lib/pinMedia.js` in `src/content/pin/pin-api.js`):
  - `PWS_HANDLERS` → `{ home, user, board, section, search }` string map.
  - `surfaceOf(href)` → `{ kind, username, slug, sectionSlug, query, handler, sourceUrl, key }`. `kind` ∈ `"home"|"user"|"board"|"section"|"search"|"pin"|"other"`. `sourceUrl` is the path+search Pinterest expects in `source_url`. `key` is a stable string for change-detection.
  - `resourceGetUrl(name, options, sourceUrl, now)` → full relative URL string.
  - `resourceHeaders({ appVersion, sourceUrl, handler, csrfToken })` → header object. Includes `x-csrftoken` **only** when `csrfToken` is passed (POST); omit the arg for GET.
  - `parseEnvelope(json)` → `{ ok, error, data, results, bookmark, isEnd }`.
  - `boardFeedOptions(board, bookmark)` → options object for `BoardFeedResource`.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/pinMedia.test.js
import { describe, it, expect } from "vitest";
import {
  PWS_HANDLERS,
  surfaceOf,
  resourceGetUrl,
  resourceHeaders,
  parseEnvelope,
  boardFeedOptions,
} from "./pinMedia.js";

describe("surfaceOf", () => {
  it("detects a board", () => {
    const s = surfaceOf("https://br.pinterest.com/marianam7536/tarot/");
    expect(s.kind).toBe("board");
    expect(s.username).toBe("marianam7536");
    expect(s.slug).toBe("tarot");
    expect(s.handler).toBe(PWS_HANDLERS.board);
    expect(s.sourceUrl).toBe("/marianam7536/tarot/");
  });

  it("detects a board section", () => {
    const s = surfaceOf("https://br.pinterest.com/marianam7536/tarot/lenormand/");
    expect(s.kind).toBe("section");
    expect(s.sectionSlug).toBe("lenormand");
    expect(s.handler).toBe(PWS_HANDLERS.section);
  });

  it("detects search and keeps the query", () => {
    const s = surfaceOf("https://br.pinterest.com/search/pins/?q=tarot%20cards");
    expect(s.kind).toBe("search");
    expect(s.query).toBe("tarot cards");
    expect(s.handler).toBe(PWS_HANDLERS.search);
    expect(s.sourceUrl).toBe("/search/pins/?q=tarot%20cards");
  });

  it("treats reserved first segments as non-boards", () => {
    expect(surfaceOf("https://br.pinterest.com/pin/12345/").kind).toBe("pin");
    expect(surfaceOf("https://br.pinterest.com/today/").kind).toBe("other");
    expect(surfaceOf("https://br.pinterest.com/").kind).toBe("home");
  });

  it("treats /_saved/ and /_created/ as user pages, not boards", () => {
    expect(surfaceOf("https://br.pinterest.com/rheav7/_saved/").kind).toBe("user");
    expect(surfaceOf("https://br.pinterest.com/rheav7/").kind).toBe("user");
  });

  it("returns a stable key that changes with the surface", () => {
    const a = surfaceOf("https://br.pinterest.com/u/b/");
    const b = surfaceOf("https://br.pinterest.com/u/b/");
    const c = surfaceOf("https://br.pinterest.com/u/other/");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it("never throws on garbage", () => {
    expect(surfaceOf("not a url").kind).toBe("other");
    expect(surfaceOf(null).kind).toBe("other");
  });
});

describe("resourceGetUrl", () => {
  it("encodes source_url and the data envelope", () => {
    const u = resourceGetUrl("BoardFeedResource", { board_id: "1" }, "/a/b/", 1700000000000);
    expect(u).toContain("/resource/BoardFeedResource/get/?");
    expect(u).toContain("source_url=%2Fa%2Fb%2F");
    expect(u).toContain(encodeURIComponent(JSON.stringify({ options: { board_id: "1" }, context: {} })));
    expect(u).toContain("&_=1700000000000");
  });
});

describe("resourceHeaders", () => {
  const base = { appVersion: "d97c852", sourceUrl: "/a/b/", handler: PWS_HANDLERS.board };

  it("always sends the pws-handler — omitting it 403s", () => {
    expect(resourceHeaders(base)["x-pinterest-pws-handler"]).toBe(PWS_HANDLERS.board);
  });

  it("omits x-csrftoken for GET", () => {
    expect(resourceHeaders(base)["x-csrftoken"]).toBeUndefined();
  });

  it("includes x-csrftoken when given (POST)", () => {
    expect(resourceHeaders({ ...base, csrfToken: "abc" })["x-csrftoken"]).toBe("abc");
  });

  it("sends the app version and XHR marker", () => {
    const h = resourceHeaders(base);
    expect(h["x-app-version"]).toBe("d97c852");
    expect(h["x-requested-with"]).toBe("XMLHttpRequest");
    expect(h["x-pinterest-appstate"]).toBe("active");
    expect(h["x-pinterest-source-url"]).toBe("/a/b/");
  });
});

describe("parseEnvelope", () => {
  it("reads array data and the cursor", () => {
    const r = parseEnvelope({ resource_response: { status: "success", data: [{ id: "1" }], bookmark: "BM" } });
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([{ id: "1" }]);
    expect(r.bookmark).toBe("BM");
    expect(r.isEnd).toBe(false);
  });

  it("reads search-shaped data.results", () => {
    const r = parseEnvelope({ resource_response: { status: "success", data: { results: [{ id: "2" }] }, bookmark: "-end-" } });
    expect(r.results).toEqual([{ id: "2" }]);
    expect(r.isEnd).toBe(true);
  });

  it("treats a missing bookmark as the end", () => {
    expect(parseEnvelope({ resource_response: { data: [] } }).isEnd).toBe(true);
  });

  it("surfaces an API error", () => {
    const r = parseEnvelope({ resource_response: { error: { message: "Invalid Resource Request" } } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid Resource Request");
  });

  it("does not throw on null", () => {
    expect(parseEnvelope(null).ok).toBe(false);
  });
});

describe("boardFeedOptions", () => {
  const board = { id: "590745744811011892", url: "/marianam7536/tarot/" };

  it("sets filter_section_pins false — true returns only un-sectioned pins", () => {
    expect(boardFeedOptions(board, null).filter_section_pins).toBe(false);
  });

  it("omits bookmarks on the first page and wraps it in an array after", () => {
    expect(boardFeedOptions(board, null).bookmarks).toBeUndefined();
    expect(boardFeedOptions(board, "BM").bookmarks).toEqual(["BM"]);
  });

  it("carries the verified option set", () => {
    const o = boardFeedOptions(board, null);
    expect(o.board_id).toBe(board.id);
    expect(o.board_url).toBe(board.url);
    expect(o.field_set_key).toBe("react_grid_pin");
    expect(o.redux_normalize_feed).toBe(true);
    expect(o.page_size).toBe(25);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/pinMedia.test.js`
Expected: FAIL — `Failed to resolve import "./pinMedia.js"`

- [ ] **Step 3: Write the implementation**

```js
// src/lib/pinMedia.js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/pinMedia.test.js`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pinMedia.js src/lib/pinMedia.test.js
git commit -m "feat(pinterest): pure resource-API contract (surface routing, headers, envelope)"
```

---

### Task 2: pinMedia.js — media resolution, HLS→MP4, records, filenames

**Files:**
- Modify: `src/lib/pinMedia.js` (append; do not alter Task 1 exports)
- Modify: `src/lib/pinMedia.test.js` (append)

**Interfaces:**
- Produces:
  - `mediaItems(pin)` → `Array<{ kind:"image"|"video", url, hls:boolean, width, height, duration, thumb }>`. One entry per downloadable asset — a plain pin yields 1, a multi-page Idea Pin yields one per page.
  - `parseHlsMaster(text)` → `Array<{ bandwidth, resolution, file }>` sorted by bandwidth descending.
  - `mp4CandidatesFromHls(hlsUrl, variantFile)` → `string[]` — ordered MP4 URLs to try.
  - `pinToRecord(pin, surfaceKey)` → record (shape in Step 3).
  - `recordToCard(rec)` → `{ id, title, thumb, username, saves, comments, date, mediaType, count, permalink }`.
  - `sanitizeFilenamePart(s)`, `filenameFor(rec, ext, idx)`, `extFromUrl(url, kind)`, `fmtCount(n)`, `fmtDate(unixSeconds)`.
  - `sortComparator(key, dir)`, `sortRecords(records, key, dir)` — keys `saves|comments|date|default`.

- [ ] **Step 1: Write the failing tests**

```js
// append to src/lib/pinMedia.test.js
import {
  mediaItems,
  parseHlsMaster,
  mp4CandidatesFromHls,
  pinToRecord,
  recordToCard,
  sanitizeFilenamePart,
  filenameFor,
  extFromUrl,
  fmtCount,
  fmtDate,
  sortRecords,
} from "./pinMedia.js";

const IMAGE_PIN = {
  id: "819655200979225688",
  type: "pin",
  grid_title: "The Illuminated Tarot",
  description: "deck",
  link: "https://example.com/x",
  repin_count: 120,
  comment_count: 3,
  created_at: "Thu, 04 Aug 2016 06:01:07 +0000",
  pinner: { username: "marianam7536", full_name: "Mariana M" },
  images: {
    "236x": { url: "https://i.pinimg.com/236x/86/30/a0/8630a02b653ff40f60be0853a587ebdc.jpg", width: 236, height: 277 },
    orig: { url: "https://i.pinimg.com/originals/86/30/a0/8630a02b653ff40f60be0853a587ebdc.png", width: 1535, height: 1802 },
  },
};

const MP4_IDEA_PIN = {
  id: "12455336471243517",
  type: "pin",
  story_pin_data: {
    page_count: 1,
    pages: [
      {
        blocks: [
          {
            type: "story_pin_video_block",
            video: {
              video_list: {
                V_EXP7: { width: 1080, height: 1920, duration: 10700, url: "https://v1.pinimg.com/videos/mc/720p/22/10/04/abc.mp4", thumbnail: "https://i.pinimg.com/videos/thumbnails/originals/22/10/04/abc.0000000.jpg" },
                V_HLSV3_MOBILE: { width: 1080, height: 1920, url: "https://v1.pinimg.com/videos/mc/hls/22/10/04/abc.m3u8", thumbnail: "https://i.pinimg.com/t.jpg" },
              },
            },
          },
        ],
      },
    ],
  },
};

const HLS_ONLY_PIN = {
  id: "596164069470205442",
  type: "pin",
  videos: {
    video_list: {
      V_HLSV4: { width: 720, height: 1280, url: "https://v1.pinimg.com/videos/iht/hls/be/0c/11/be0c11.m3u8", thumbnail: "https://i.pinimg.com/th.jpg" },
      V_HLSV3_MOBILE: { width: 480, height: 854, url: "https://v1.pinimg.com/videos/iht/hls/be/0c/11/be0c11_mob.m3u8" },
    },
  },
};

describe("mediaItems", () => {
  it("uses images.orig — never a rewritten thumbnail (extensions differ, rewrite 403s)", () => {
    const items = mediaItems(IMAGE_PIN);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("image");
    expect(items[0].url).toBe(IMAGE_PIN.images.orig.url);
    expect(items[0].url).toContain(".png");
  });

  it("prefers a direct MP4 over HLS on an idea pin", () => {
    const items = mediaItems(MP4_IDEA_PIN);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("video");
    expect(items[0].hls).toBe(false);
    expect(items[0].url).toContain(".mp4");
    expect(items[0].duration).toBe(10700);
  });

  it("falls back to the highest-res HLS and flags it for resolution", () => {
    const items = mediaItems(HLS_ONLY_PIN);
    expect(items[0].kind).toBe("video");
    expect(items[0].hls).toBe(true);
    expect(items[0].url).toBe(HLS_ONLY_PIN.videos.video_list.V_HLSV4.url);
  });

  it("returns one item per page of a multi-page idea pin", () => {
    const multi = {
      id: "m1",
      story_pin_data: {
        page_count: 2,
        pages: [
          { blocks: [{ video: { video_list: { V_EXP7: { url: "https://v1.pinimg.com/a.mp4", width: 1, height: 2 } } } }] },
          { blocks: [{ image: { images: { orig: { url: "https://i.pinimg.com/originals/b.jpg", width: 3, height: 4 } } } }] },
        ],
      },
    };
    const items = mediaItems(multi);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("video");
    expect(items[1].kind).toBe("image");
  });

  it("returns [] rather than throwing when a pin has no media", () => {
    expect(mediaItems({ id: "x" })).toEqual([]);
    expect(mediaItems(null)).toEqual([]);
  });
});

describe("parseHlsMaster", () => {
  const MASTER = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio1",URI="abc_audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=560544,RESOLUTION=234x416,AUDIO="audio1"',
    "abc_240w.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=937320,RESOLUTION=360x640,AUDIO="audio1"',
    "abc_360w.m3u8",
  ].join("\n");

  it("returns variants sorted by bandwidth descending", () => {
    const v = parseHlsMaster(MASTER);
    expect(v).toHaveLength(2);
    expect(v[0].file).toBe("abc_360w.m3u8");
    expect(v[0].bandwidth).toBe(937320);
    expect(v[0].resolution).toBe("360x640");
  });

  it("ignores the audio-only EXT-X-MEDIA line", () => {
    expect(parseHlsMaster(MASTER).some((v) => v.file.includes("audio"))).toBe(false);
  });

  it("returns [] on junk", () => {
    expect(parseHlsMaster("")).toEqual([]);
    expect(parseHlsMaster(null)).toEqual([]);
  });
});

describe("mp4CandidatesFromHls", () => {
  it("swaps /hls/ for /expMp4/ and keeps the manifest's variant filename", () => {
    const c = mp4CandidatesFromHls("https://v1.pinimg.com/videos/iht/hls/fb/03/c7/sig.m3u8", "sig_360w.m3u8");
    expect(c[0]).toBe("https://v1.pinimg.com/videos/iht/expMp4/fb/03/c7/sig_360w.mp4");
  });

  it("offers hevcMp4V3 as the second candidate", () => {
    const c = mp4CandidatesFromHls("https://v1.pinimg.com/videos/iht/hls/fb/03/c7/sig.m3u8", "sig_360w.m3u8");
    expect(c[1]).toContain("/hevcMp4V3/");
    expect(c[1]).toContain("sig_360w.mp4");
  });

  it("returns [] when the URL is not an hls path", () => {
    expect(mp4CandidatesFromHls("https://v1.pinimg.com/videos/mc/720p/a/b/c/sig.mp4", "x.m3u8")).toEqual([]);
  });
});

describe("pinToRecord", () => {
  it("flattens a pin into the panel record", () => {
    const r = pinToRecord(IMAGE_PIN, "board:marianam7536/tarot");
    expect(r.id).toBe(IMAGE_PIN.id);
    expect(r.title).toBe("The Illuminated Tarot");
    expect(r.username).toBe("marianam7536");
    expect(r.saves).toBe(120);
    expect(r.comments).toBe(3);
    expect(r.mediaType).toBe("image");
    expect(r.thumb).toContain("236x");
    expect(r.surface).toBe("board:marianam7536/tarot");
    expect(r.permalink).toBe("https://www.pinterest.com/pin/819655200979225688/");
  });

  it("parses Pinterest's HTTP-date created_at into unix seconds", () => {
    expect(pinToRecord(IMAGE_PIN, "s").created_at).toBe(Math.floor(Date.parse("Thu, 04 Aug 2016 06:01:07 +0000") / 1000));
  });

  it("labels idea pins and counts their pages", () => {
    const r = pinToRecord(MP4_IDEA_PIN, "s");
    expect(r.mediaType).toBe("idea");
    expect(r.count).toBe(1);
  });

  it("labels a plain video pin", () => {
    expect(pinToRecord(HLS_ONLY_PIN, "s").mediaType).toBe("video");
  });
});

describe("filenames", () => {
  it("strips path-hostile characters", () => {
    expect(sanitizeFilenamePart('a/b:c*d?"<>|')).toBe("a_b_c_d_");
  });

  it("builds pin-<user>-<id>.<ext> and suffixes multi-asset pins", () => {
    const rec = pinToRecord(IMAGE_PIN, "s");
    expect(filenameFor(rec, "png")).toBe("pin-marianam7536-819655200979225688.png");
    expect(filenameFor(rec, "mp4", 2)).toBe("pin-marianam7536-819655200979225688_2.mp4");
  });

  it("reads the real extension off the URL — orig can be png while the thumb is jpg", () => {
    expect(extFromUrl("https://i.pinimg.com/originals/a/b/c/d.png", "image")).toBe("png");
    expect(extFromUrl("https://i.pinimg.com/originals/a/b/c/d.jpeg", "image")).toBe("jpg");
    expect(extFromUrl("https://v1.pinimg.com/videos/x.m3u8", "video")).toBe("mp4");
    expect(extFromUrl("", "image")).toBe("jpg");
  });
});

describe("sortRecords", () => {
  const recs = [
    { id: "a", saves: 5, comments: 1, created_at: 300 },
    { id: "b", saves: 50, comments: 0, created_at: 100 },
    { id: "c", saves: null, comments: 9, created_at: 200 },
  ];

  it("sorts by saves descending with nulls last", () => {
    expect(sortRecords(recs, "saves", "desc").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps nulls last even ascending", () => {
    expect(sortRecords(recs, "saves", "asc").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("default preserves harvest order", () => {
    expect(sortRecords(recs, "default").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const copy = [...recs];
    sortRecords(recs, "saves", "desc");
    expect(recs).toEqual(copy);
  });
});

describe("formatters", () => {
  it("compacts counts", () => {
    expect(fmtCount(964490)).toBe("964.5K");
    expect(fmtCount(1200000)).toBe("1.2M");
    expect(fmtCount(null)).toBe("—");
  });

  it("formats dates and tolerates missing values", () => {
    expect(fmtDate(1470290467)).toBe("2016-08-04");
    expect(fmtDate(null)).toBe("");
  });
});

describe("recordToCard", () => {
  it("projects a record for the grid", () => {
    const c = recordToCard(pinToRecord(IMAGE_PIN, "s"));
    expect(c.id).toBe(IMAGE_PIN.id);
    expect(c.saves).toBe(120);
    expect(c.date).toBe("2016-08-04");
    expect(c.mediaType).toBe("image");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/pinMedia.test.js`
Expected: FAIL — `mediaItems is not a function` (Task 1 tests still pass).

- [ ] **Step 3: Write the implementation**

```js
// append to src/lib/pinMedia.js

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
  const o = images?.orig;
  // Only images.orig is trustworthy. Rewriting /236x/ -> /originals/ 403s whenever
  // the original's extension differs from the thumbnail's (png vs jpg) — verified.
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
export function sanitizeFilenamePart(s) {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function filenameFor(rec, ext, idx) {
  const base = `pin-${sanitizeFilenamePart(rec.username) || "pinterest"}-${rec.id || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

export function extFromUrl(url, kind) {
  const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
  return kind === "video" ? "mp4" : "jpg";
}

export function fmtCount(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — the whole suite, including the pre-existing fbcdn/fbReels/igMedia/ttMedia/sessionMath/tools tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pinMedia.js src/lib/pinMedia.test.js
git commit -m "feat(pinterest): media resolution, HLS->MP4 derivation, records, filenames"
```

---

### Task 3: pin-api.js content script + manifest registration

**Files:**
- Create: `src/content/pin/pin-api.js`
- Modify: `manifest.config.js:33-39` (host_permissions), `:40-93` (content_scripts)

**Interfaces:**
- Consumes: everything from Task 1 + Task 2 via `../../lib/pinMedia.js`.
- Produces (message contract the panel in Tasks 4–7 relies on):
  - `FBW_PIN_CONTEXT` → `{ ok, loggedIn, surface: {kind,username,slug,sectionSlug,query,key}, board: {id,name,url,pin_count,section_count}|null, sections: [{id,title,slug,pin_count}], error }`
  - `FBW_PIN_HARVEST` `{ maxPages }` → `{ started: true }` (async; poll state)
  - `FBW_PIN_STATE` → `{ records, harvesting, pages, done, error, surfaceKey }`
  - `FBW_PIN_CLEAR` → `{ ok: true }`
  - `FBW_PIN_RESOLVE` `{ id, itemIndex }` → `{ ok, url, error }` — turns an HLS item into a real MP4 URL
  - `FBW_PING` → `{ ok: true }`

- [ ] **Step 1: Write the content script**

```js
// src/content/pin/pin-api.js
import * as PIN from "../../lib/pinMedia.js"; // CRXJS bundles content-script imports

// Pinterest capture — the ONLY active-fetch platform in this extension.
//
// FB/IG/TikTok all capture passively (webRequest / JSON.parse hook / fetch tee)
// because their feed APIs are signed or issued off the main thread. Pinterest's
// /resource/* API is unsigned, cookie-authenticated and cursor-paginated, so we can
// simply call it ourselves from the page's own origin and walk the whole board —
// no scrolling, no MAIN-world hook, no bridge.
//
// Isolated world is fine: a same-origin fetch from a content script carries the
// page's cookies, including the httpOnly _auth/_pinterest_sess we can never read.
(() => {
  if (window.__fbwPinInit) return;
  window.__fbwPinInit = true;

  const APP_VERSION_FALLBACK = "d97c852"; // observed 2026-07-25; stale values still work

  let store = new Map();     // pin id -> record
  let surfaceKey = null;
  let harvesting = false;
  let pages = 0;
  let done = false;
  let lastError = null;
  let generation = 0;        // bumps on clear/surface change to abandon in-flight loops

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function appVersion() {
    try {
      return JSON.parse(document.querySelector("#__PWS_DATA__").textContent).appVersion || APP_VERSION_FALLBACK;
    } catch {
      return APP_VERSION_FALLBACK;
    }
  }

  const csrfToken = () => document.cookie.match(/csrftoken=([^;]+)/)?.[1] || null;
  // _auth is httpOnly so we can't read it; its absence here proves nothing. The
  // reliable signal is whether the API answers, so treat a 403 as "log in".
  const looksLoggedIn = () => !!csrfToken();

  async function resourceGet(name, options, surface) {
    const url = PIN.resourceGetUrl(name, options, surface.sourceUrl);
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: PIN.resourceHeaders({ appVersion: appVersion(), sourceUrl: surface.sourceUrl, handler: surface.handler }),
    });
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    return PIN.parseEnvelope(await res.json());
  }

  async function resourcePost(name, options, surface) {
    const res = await fetch(`/resource/${name}/get/`, {
      method: "POST",
      credentials: "include",
      headers: {
        ...PIN.resourceHeaders({ appVersion: appVersion(), sourceUrl: surface.sourceUrl, handler: surface.handler, csrfToken: csrfToken() }),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        source_url: surface.sourceUrl,
        data: JSON.stringify({ options, context: {} }),
      }).toString(),
    });
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    return PIN.parseEnvelope(await res.json());
  }

  // The board id is NOT in the DOM on the current site — no #initial-state script, no
  // "board_id" in __PWS_DATA__, no board_id regex hit (all verified dead 2026-07-25).
  // BoardResource by username+slug is the only reliable lookup.
  async function fetchBoard(surface) {
    const env = await resourceGet(
      "BoardResource",
      { field_set_key: "profile_grid_item", is_mobile_fork: true, username: surface.username, slug: surface.slug },
      surface,
    );
    const b = env.data;
    if (!env.ok || !b?.id) throw new Error(env.error || "board not found");
    return { id: b.id, name: b.name || surface.slug, url: b.url || `/${surface.username}/${surface.slug}/`, pin_count: b.pin_count ?? null, section_count: b.section_count ?? null };
  }

  async function fetchSections(board, surface) {
    try {
      const env = await resourceGet("BoardSectionsResource", { board_id: board.id, redux_normalize_feed: true }, surface);
      return (env.results || []).map((s) => ({ id: s.id, title: s.title, slug: s.slug, pin_count: s.pin_count ?? null }));
    } catch {
      return [];
    }
  }

  function ingest(pins, key) {
    for (const p of pins) {
      if (!p || p.type !== "pin" || !p.id) continue;   // feeds interleave "story" ad slots
      const rec = PIN.pinToRecord(p, key);
      if (!rec.items.length) continue;                  // nothing downloadable
      store.set(rec.id, rec);
    }
  }

  async function harvest(maxPages) {
    const gen = ++generation;
    const surface = PIN.surfaceOf(location.href);
    harvesting = true; done = false; lastError = null; pages = 0; surfaceKey = surface.key;
    try {
      if (surface.kind === "board" || surface.kind === "section") {
        const board = await fetchBoard(surface);
        let bookmark = null;
        for (let i = 0; i < maxPages; i++) {
          if (gen !== generation) return;
          const env = await resourceGet("BoardFeedResource", PIN.boardFeedOptions(board, bookmark), surface);
          if (!env.ok) throw new Error(env.error);
          ingest(env.results, surface.key);
          pages++;
          bookmark = env.bookmark;
          if (env.isEnd) break;
          await sleep(350);
        }
      } else if (surface.kind === "search") {
        let bookmark = null;
        for (let i = 0; i < maxPages; i++) {
          if (gen !== generation) return;
          const opts = { query: surface.query, scope: "pins", rs: "typed", appliedProductFilters: "---", bookmarks: bookmark ? [bookmark] : [] };
          const env = await resourcePost("BaseSearchResource", opts, surface);
          if (!env.ok) throw new Error(env.error);
          ingest(env.results, surface.key);
          pages++;
          bookmark = env.bookmark;
          if (env.isEnd) break;
          await sleep(350);
        }
      } else {
        throw new Error("Open a board, a board section, or a search page.");
      }
      done = true;
    } catch (e) {
      lastError = e.message || String(e);
    } finally {
      if (gen === generation) harvesting = false;
    }
  }

  // Turn an HLS pointer into a real progressive MP4. Guessing the path fails; the
  // variant filename has to come from the master manifest.
  async function resolveHls(hlsUrl) {
    const master = await (await fetch(hlsUrl)).text();
    const variants = PIN.parseHlsMaster(master);
    if (!variants.length) throw new Error("no HLS variants");
    for (const url of PIN.mp4CandidatesFromHls(hlsUrl, variants[0].file)) {
      try {
        const r = await fetch(url, { headers: { range: "bytes=0-1023" } });
        if (r.ok || r.status === 206) return url;
      } catch { /* try next */ }
    }
    throw new Error("no MP4 twin for this HLS stream");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FBW_PING") { sendResponse({ ok: true }); return; }

    if (msg?.type === "FBW_PIN_CONTEXT") {
      (async () => {
        const surface = PIN.surfaceOf(location.href);
        // Surface changed under us (SPA nav) — drop stale records so the panel
        // never shows another board's pins.
        if (surfaceKey && surfaceKey !== surface.key) { store = new Map(); generation++; harvesting = false; done = false; pages = 0; }
        surfaceKey = surface.key;
        const out = { ok: true, loggedIn: looksLoggedIn(), surface, board: null, sections: [], error: null };
        try {
          if (surface.kind === "board" || surface.kind === "section") {
            out.board = await fetchBoard(surface);
            out.sections = await fetchSections(out.board, surface);
          }
        } catch (e) {
          out.error = e.message || String(e);
        }
        sendResponse(out);
      })();
      return true; // async
    }

    if (msg?.type === "FBW_PIN_HARVEST") {
      harvest(Math.max(1, Math.min(40, msg.maxPages || 40)));
      sendResponse({ started: true });
      return;
    }

    if (msg?.type === "FBW_PIN_STATE") {
      sendResponse({ records: Array.from(store.values()), harvesting, pages, done, error: lastError, surfaceKey });
      return;
    }

    if (msg?.type === "FBW_PIN_CLEAR") {
      store = new Map(); generation++; harvesting = false; done = false; pages = 0; lastError = null;
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "FBW_PIN_RESOLVE") {
      (async () => {
        try {
          const rec = store.get(String(msg.id));
          const item = rec?.items?.[msg.itemIndex ?? 0];
          if (!item) throw new Error("unknown pin");
          sendResponse({ ok: true, url: item.hls ? await resolveHls(item.url) : item.url });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true; // async
    }
  });
})();
```

- [ ] **Step 2: Register in the manifest**

In `manifest.config.js`, add to `host_permissions` (after `"*://*.cdninstagram.com/*"`):

```js
    "*://*.pinterest.com/*",
    // Pin images are downloaded by fetching them in the SW (FBW_DL_MEDIA kind:"image").
    "*://*.pinimg.com/*",
```

And append this content_scripts entry after the TikTok pair:

```js
    // Pinterest: single ISOLATED script, no MAIN-world hook. Pinterest's /resource/*
    // API is unsigned + cookie-auth, so we call it directly and paginate whole boards
    // instead of scraping whatever the user happened to scroll past.
    {
      matches: ["*://*.pinterest.com/*"],
      js: ["src/content/pin/pin-api.js"],
      run_at: "document_idle",
    },
```

- [ ] **Step 3: Build to verify the bundle resolves**

Run: `npm run build`
Expected: build succeeds; `dist/manifest.json` contains a `pinterest.com` content-script entry whose `js` points at a hashed `assets/pin-api.js-*.js`, and `host_permissions` lists `*://*.pinimg.com/*`.

- [ ] **Step 4: Commit**

```bash
git add src/content/pin/pin-api.js manifest.config.js
git commit -m "feat(pinterest): active-fetch content script (board/section/search harvest, HLS resolve)"
```

---

### Task 4: Register Pinterest as a platform + prove the pipe

**Files:**
- Modify: `src/lib/platforms.jsx:1-124`
- Modify: `src/lib/tabs.js:3-7`
- Modify: `src/lib/tools.jsx:1-34`
- Create: `src/components/tools/PinBoardTool.jsx`

**Interfaces:**
- Consumes: `FBW_PIN_CONTEXT` from Task 3; `resolvePlatformTab` from `@/lib/tabs`.
- Produces: `PinBoardTool` default export, registered as tool id `"pin-board"`.

**Two crash risks make this one task rather than three** — both fire the instant `"pinterest"` joins `PLATFORM_ORDER`:
1. `Shell.jsx:295` indexes `tools[0].id` unguarded, so a platform with zero tools throws. Pinterest needs its tool registered in the same change.
2. `Shell.jsx:273` reads `theme["--sw-grad"]` inline for the Home picker tile. A `PLATFORMS` entry without a `theme` is a TypeError, not a styling nit. (`theme` is *not* applied to `<html>` — see the note at `Shell.jsx:25` — the picker tile is its only consumer.)

`modes` / `defaultMode` are read **only** by `WarmTool.jsx:62,267,400`, and Pinterest never registers the Warm tool, so leaving them empty/null is safe.

- [ ] **Step 1: Add the platform entry**

In `src/lib/platforms.jsx`, add the glyph beside the other brand marks:

```jsx
export function PinterestGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.367 18.592.001 11.985.001L12.017 0z" />
    </svg>
  );
}
```

Add to `THEMES` (after `tiktok`). This is **required**, not cosmetic — `Shell.jsx:273` reads `theme["--sw-grad"]` for the Home picker tile and would throw on a missing `theme`:

```js
  pinterest: {
    ...NEUTRAL,
    "--sw-from": "#e60023",
    "--sw-to": "#ff5a5f",
    "--sw-grad": "linear-gradient(135deg, #e60023 0%, #ff5a5f 100%)",
    "--sw-glow": "rgba(230, 0, 35, 0.5)",
  },
```

Add to `PLATFORMS` (after `tiktok`). Pinterest has no Warm engine adapter, so `modes` is empty and `defaultMode` is null — the Warm tool is not registered for it.

```js
  pinterest: {
    id: "pinterest",
    name: "Pinterest",
    Glyph: PinterestGlyph,
    // Download-only platform: no Warm engine adapter, so no modes.
    defaultMode: null,
    modes: [],
    keywordPlaceholder: "e.g. tarot spread",
    theme: THEMES.pinterest,
  },
```

And extend the order:

```js
export const PLATFORM_ORDER = ["facebook", "instagram", "tiktok", "pinterest"];
```

- [ ] **Step 2: Add host matching**

In `src/lib/tabs.js`, add to `PLATFORM_HOST`:

```js
  pinterest: { re: /(^|\.)pinterest\.[a-z.]+$/, glob: ["*://*.pinterest.com/*"] },
```

The regex is deliberately looser than the others: Pinterest runs country domains (`br.pinterest.com`, `pinterest.co.uk`). The `glob` stays `.com` only because that is what `host_permissions` grants — widen both together if a non-`.com` TLD is ever needed.

- [ ] **Step 3: Register the tool**

In `src/lib/tools.jsx`, add the import and the entry (label kept short — `Segmented` clips long labels):

```js
import PinBoardTool from "@/components/tools/PinBoardTool";
import { Image as ImageIcon } from "lucide-react";
```

```js
  { id: "pin-board", label: "Board", Icon: ImageIcon, platforms: ["pinterest"], Panel: PinBoardTool, requiresTab: true },
```

- [ ] **Step 4: Write the tool skeleton that proves the pipe**

```jsx
// src/components/tools/PinBoardTool.jsx
import { useCallback, useEffect, useRef, useState } from "react";
import { resolvePlatformTab } from "@/lib/tabs";

// Pinterest Board tool. Unlike the IG/TT tools this is not polling a passive
// capture — pin-api.js actively pages Pinterest's resource API, so the panel asks
// for context once per surface and then drives an explicit Harvest.
export default function PinBoardTool() {
  const [ctx, setCtx] = useState(null);
  const [noTab, setNoTab] = useState(false);
  const tabId = useRef(null);

  const send = useCallback(async (msg) => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("pinterest");
    if (tabId.current == null) { setNoTab(true); return null; }
    setNoTab(false);
    try {
      return await chrome.tabs.sendMessage(tabId.current, msg);
    } catch {
      tabId.current = null;
      return null;
    }
  }, []);

  const loadContext = useCallback(async () => {
    const res = await send({ type: "FBW_PIN_CONTEXT" });
    if (res) setCtx(res);
  }, [send]);

  useEffect(() => {
    loadContext();
    // Context is cheap but not free (2 API calls), so re-check on a slow interval
    // to catch SPA navigation between boards rather than the 2.5s data-tool cadence.
    const id = setInterval(loadContext, 5000);
    return () => clearInterval(id);
  }, [loadContext]);

  if (noTab)
    return <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">Open Pinterest in a tab (logged in), then reopen this panel.</div>;

  if (!ctx) return <p className="py-8 text-center text-sm text-muted-foreground">Reading the page…</p>;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="text-[13px] font-medium">{ctx.board?.name || ctx.surface?.kind}</div>
        <div className="text-[11px] text-muted-foreground">
          surface: {ctx.surface?.kind} · board: {ctx.board?.id || "—"} · pins: {ctx.board?.pin_count ?? "—"} · sections: {ctx.sections?.length ?? 0}
        </div>
        {ctx.error ? <div className="mt-1 text-[11px] text-red-600">{ctx.error}</div> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build, load, and confirm the pipe**

Run: `npm run build`, reload the extension, open a Pinterest board, open the panel.
Expected: the Pinterest glyph appears in the header switcher; selecting it shows one `Board` tool; the card reports `surface: board`, a numeric board id, and the real pin count (e.g. 6689). If it reports `403 Invalid Resource Request`, the `x-pinterest-pws-handler` header is wrong for the route.

- [ ] **Step 6: Commit**

```bash
git add src/lib/platforms.jsx src/lib/tabs.js src/lib/tools.jsx src/components/tools/PinBoardTool.jsx
git commit -m "feat(pinterest): register platform + Board tool, prove resource-API context"
```

---

### Task 5: Harvest + pin grid

**Files:**
- Modify: `src/components/tools/PinBoardTool.jsx`

**Interfaces:**
- Consumes: `FBW_PIN_HARVEST`, `FBW_PIN_STATE`, `FBW_PIN_CLEAR` (Task 3); `sortRecords`, `recordToCard`, `fmtCount` (Task 2).
- Produces: `records` state consumed by Task 6's download actions.

- [ ] **Step 1: Add harvest state and polling**

Replace the component body's state block and add these hooks (keep `send`, `loadContext`, `noTab` from Task 4):

```jsx
import { Download, RotateCw, Play, Image as ImageIcon, Film, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sortRecords, recordToCard, fmtCount } from "@/lib/pinMedia";

const MAX_PAGES = 40; // ~1000 pins per run — surfaced in the UI, never a silent cap.
```

```jsx
  const [records, setRecords] = useState([]);
  const [state, setState] = useState({ harvesting: false, pages: 0, done: false, error: null });
  const [sortKey, setSortKey] = useState("default");

  const pullState = useCallback(async () => {
    const res = await send({ type: "FBW_PIN_STATE" });
    if (!res) return;
    setRecords(res.records || []);
    setState({ harvesting: !!res.harvesting, pages: res.pages || 0, done: !!res.done, error: res.error || null });
  }, [send]);

  useEffect(() => {
    const id = setInterval(pullState, 1000);
    pullState();
    return () => clearInterval(id);
  }, [pullState]);

  const harvest = useCallback(async () => {
    setRecords([]);
    await send({ type: "FBW_PIN_HARVEST", maxPages: MAX_PAGES });
    pullState();
  }, [send, pullState]);

  const clear = useCallback(async () => {
    await send({ type: "FBW_PIN_CLEAR" });
    setRecords([]);
    pullState();
  }, [send, pullState]);

  const sorted = sortRecords(records, sortKey, "desc");
```

- [ ] **Step 2: Render the harvest bar and grid**

Replace the returned JSX below the context card with:

```jsx
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={harvest} disabled={state.harvesting}>
          <Play className="size-3.5" /> {state.harvesting ? `Harvesting… ${state.pages}p` : "Harvest"}
        </Button>
        <Button variant="outline" size="sm" onClick={clear} disabled={state.harvesting}>
          <RotateCw className="size-3.5" /> Clear
        </Button>
        <select
          className="ml-auto rounded-md border border-border bg-background px-1.5 py-1 text-[11px]"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
        >
          <option value="default">Board order</option>
          <option value="saves">Most saved</option>
          <option value="comments">Most commented</option>
          <option value="date">Newest</option>
        </select>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {records.length} pin(s) · {state.pages} page(s)
        {state.harvesting ? " · running" : state.done ? " · complete" : ""}
        {state.pages >= MAX_PAGES ? ` · stopped at the ${MAX_PAGES}-page cap — Harvest again for more` : ""}
      </div>
      {state.error ? <div className="rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-700">{state.error}</div> : null}

      <div className="grid grid-cols-3 gap-1.5">
        {sorted.map((rec) => {
          const card = recordToCard(rec);
          const Badge = card.mediaType === "video" ? Film : card.mediaType === "idea" ? Layers : ImageIcon;
          return (
            <div key={card.id} className="group relative aspect-[3/4] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5">
              {card.thumb ? (
                <img src={card.thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
              ) : null}
              <span className="absolute right-1 top-1 grid size-5 place-items-center rounded bg-black/65 text-white">
                <Badge className="size-3" />
              </span>
              {card.saves != null && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[9.5px] font-semibold text-white">
                  {fmtCount(card.saves)} saves
                </div>
              )}
            </div>
          );
        })}
      </div>
```

Note: Pinterest thumbnails do **not** need `referrerPolicy="no-referrer"` (that trick exists for TikTok/FB CDNs which 403 on a foreign referrer). `i.pinimg.com` serves them regardless.

- [ ] **Step 3: Build and verify live**

Run: `npm run build`, reload, open a large board, click Harvest.
Expected: page counter climbs, grid fills past 25, count exceeds the ~6 that `filter_section_pins:true` would have returned, and it stops on `complete` or the 40-page cap.

- [ ] **Step 4: Commit**

```bash
git add src/components/tools/PinBoardTool.jsx
git commit -m "feat(pinterest): board harvest with cursor pagination + pin grid"
```

---

### Task 6: Downloads — single, video resolution, and bulk

**Files:**
- Modify: `src/components/tools/PinBoardTool.jsx`

**Interfaces:**
- Consumes: `FBW_PIN_RESOLVE` (Task 3); `filenameFor`, `extFromUrl` (Task 2); background `FBW_DL_MEDIA` (existing, unmodified).
- Produces: `downloadRecord(rec)` used by both the per-pin button and `downloadAll`.

- [ ] **Step 1: Add the download helpers**

Extend the **existing** `@/lib/pinMedia` import from Task 5 rather than adding a second one:

```jsx
import { sortRecords, recordToCard, fmtCount, filenameFor, extFromUrl } from "@/lib/pinMedia";
```

```jsx
  const [busy, setBusy] = useState({});
  const setStatus = (id, s) => setBusy((b) => ({ ...b, [id]: s }));
  const bg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));

  async function downloadRecord(rec) {
    setStatus(rec.id, "downloading");
    try {
      const multi = rec.items.length > 1;
      for (let i = 0; i < rec.items.length; i++) {
        const item = rec.items[i];
        let url = item.url;
        // ~80% of Pinterest videos are HLS-only. The content script derives a real
        // MP4 from the master manifest; a plain .m3u8 would download as a useless
        // text playlist.
        if (item.kind === "video" && item.hls) {
          const r = await send({ type: "FBW_PIN_RESOLVE", id: rec.id, itemIndex: i });
          if (!r?.ok) throw new Error(r?.error || "could not resolve video");
          url = r.url;
        }
        const ext = extFromUrl(url, item.kind);
        await bg({
          type: "FBW_DL_MEDIA",
          kind: item.kind,
          url,
          filename: filenameFor(rec, ext, multi ? i + 1 : null),
        });
      }
      setStatus(rec.id, "done");
    } catch {
      setStatus(rec.id, "error");
    }
  }

  // Serial with a 400 ms gap, matching IgSortTool/TtSortTool. Chrome will happily
  // accept parallel downloads, but Pinterest's CDN starts refusing under a burst.
  async function downloadAll() {
    for (const rec of sorted) {
      await downloadRecord(rec);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
```

- [ ] **Step 2: Wire the buttons**

Add to the harvest bar, before the sort `<select>`:

```jsx
        <Button variant="secondary" size="sm" onClick={downloadAll} disabled={!records.length || state.harvesting}>
          <Download className="size-3.5" /> All ({records.length})
        </Button>
```

Add inside the grid tile, as the first child of the tile `<div>`:

```jsx
              <button
                onClick={() => downloadRecord(rec)}
                disabled={busy[rec.id] === "downloading"}
                className="absolute left-1 top-1 z-10 grid size-6 place-items-center rounded-md bg-black/65 text-white hover:bg-black/80 disabled:opacity-50"
                title={rec.items.length > 1 ? `Download ${rec.items.length} assets` : "Download"}
              >
                <Download className={"size-3.5 " + (busy[rec.id] === "done" ? "text-emerald-400" : busy[rec.id] === "error" ? "text-red-400" : "")} />
              </button>
```

- [ ] **Step 3: Build and verify each media path live**

Run: `npm run build`, reload.
Expected, checked one at a time:
- An image pin downloads as `pin-<user>-<id>.png` or `.jpg` at full original resolution (open it — it must be far larger than 236 px wide).
- A direct-MP4 pin downloads a playable `.mp4`.
- An HLS-only pin downloads a playable `.mp4` (not a 200-byte `.m3u8`).
- A multi-page Idea Pin produces `_1`, `_2`, … files.
- `All` walks the grid serially without the CDN starting to fail.

- [ ] **Step 4: Commit**

```bash
git add src/components/tools/PinBoardTool.jsx
git commit -m "feat(pinterest): image/video download incl. HLS-derived MP4, serial bulk"
```

---

### Task 7: Save to Library

**Files:**
- Modify: `src/components/tools/PinBoardTool.jsx`
- Modify: `src/components/TranscriptsPanel.jsx:258-262` (`PLATFORM_META`)

**Interfaces:**
- Consumes: `chrome.storage.local["fbw_saved"]` — the shared Library map keyed by id.
- Produces: saved records carrying `platform: "pinterest"` and an explicit `sourceUrl`.

**Note:** `VideoCard` in `TranscriptsPanel.jsx:89-99` reconstructs a permalink from `platform` when `sourceUrl` is absent, and only knows FB and IG. Pinterest records must therefore always set `sourceUrl` — which `pinToRecord` already provides as `permalink`.

- [ ] **Step 1: Add the save action**

Add `Bookmark` to the **existing** `lucide-react` import line. Do **not** add a second `@/lib/pinMedia` import — `fmtCount` is already imported by Task 5, and a duplicate binding is a `SyntaxError`:

```jsx
import { Download, RotateCw, Play, Image as ImageIcon, Film, Layers, Bookmark } from "lucide-react";
```

```jsx
  async function save(rec) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      if (map[rec.id]) delete map[rec.id];
      else
        map[rec.id] = {
          videoId: rec.id,
          platform: "pinterest",
          thumb: rec.thumb || null,
          caption: rec.title || rec.description || null,
          author: { name: rec.username || "unknown", url: rec.username ? `https://www.pinterest.com/${rec.username}/` : null },
          counts: { like: fmtCount(rec.saves), comment: fmtCount(rec.comments), views: "—" },
          code: rec.id,
          // TranscriptsPanel only knows how to rebuild FB/IG permalinks, so Pinterest
          // must always carry its own.
          sourceUrl: rec.permalink,
          updatedAt: Date.now(),
        };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch { /* ignore */ }
  }
```

- [ ] **Step 2: Add the button to the tile**

Directly after the download button inside the grid tile:

```jsx
              <button
                onClick={() => save(rec)}
                className="absolute left-1 top-8 z-10 grid size-6 place-items-center rounded-md bg-black/65 text-white hover:bg-black/80"
                title="Save to Library"
              >
                <Bookmark className="size-3.5" />
              </button>
```

- [ ] **Step 3: Teach the Library about Pinterest**

In `src/components/TranscriptsPanel.jsx`, add to `PLATFORM_META`:

```js
  pinterest: { label: "Pinterest", color: "#e60023" },
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`, reload.
Expected: saving a pin makes it appear under Library → Saved with a red `Pinterest` chip, and clicking through opens `pinterest.com/pin/<id>/`.

- [ ] **Step 5: Commit**

```bash
git add src/components/tools/PinBoardTool.jsx src/components/TranscriptsPanel.jsx
git commit -m "feat(pinterest): save pins to the shared Library"
```

---

### Task 8: Version bump + changelog

**Files:**
- Modify: `manifest.config.js:9-10`
- Modify: `package.json` (`version`)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump both version fields**

`manifest.config.js`:

```js
  version: "0.64.0",
  version_name: "0.64.0 — Pinterest: harvest a whole board through the resource API and bulk-download full-res images + MP4 video (HLS derived)",
```

`package.json`: set `"version": "0.64.0"`.

- [ ] **Step 2: Add the changelog entry**

Prepend to `CHANGELOG.md`, matching the existing entry style:

```markdown
## 0.64.0 — Pinterest board download

- **New platform: Pinterest.** Fourth platform in the switcher, with a single `Board` tool.
- **Active fetch, not passive capture.** Pinterest's `/resource/*` API is unsigned and cookie-authenticated, so `src/content/pin/pin-api.js` calls it directly and walks the cursor — a whole board is harvested without the user scrolling. This is the first platform in the extension that works this way.
- **`filter_section_pins: false`** is what makes bulk possible; Pinterest's own site sends `true`, which returns only un-sectioned pins (a 6689-pin board returns 6).
- **HLS→MP4.** ~80% of Pinterest videos expose only an HLS manifest. Guessing MP4 paths does not work; the variant filename is read from the master `.m3u8` and the directory swapped `/hls/` → `/expMp4/`.
- Full-resolution images come from `images.orig` — the common `/236x/` → `/originals/` rewrite 403s when the original's extension differs.
- No background or engine changes: `FBW_DL_MEDIA` already covered both media kinds; Pinterest has no Warm adapter.
```

- [ ] **Step 3: Commit**

```bash
git add manifest.config.js package.json CHANGELOG.md
git commit -m "chore: release 0.64.0 — Pinterest board download"
```

---

### Task 9: Live verification (manual — requires a logged-in browser)

Project practice: API behavior and selectors are verified live, not mocked. Run `npm run build` and reload the extension card first.

- [ ] **Regression:** full suite green — `npx vitest run`.
- [ ] **Platform switch:** Pinterest glyph appears fourth; selecting it shows exactly one `Board` tool; FB/IG/TT tools are unchanged.
- [ ] **Tab following:** with Pinterest, Instagram and TikTok tabs open, switching browser tabs moves the panel to the matching platform and returns to the Board tool on coming back (per-platform workspace, `sw_nav3`).
- [ ] **Board harvest:** open a board with >200 pins and sections. Confirm the context card shows the real pin count and section count, Harvest pages past 25, and the harvested total is far above what the site's own `filter_section_pins:true` call returns.
- [ ] **Cap honesty:** on a very large board, confirm the UI says it stopped at the 40-page cap rather than silently appearing complete.
- [ ] **Section page:** open a board *section* URL and confirm harvest still works (it resolves the parent board and pages the full feed).
- [ ] **Search page:** open `/search/pins/?q=tarot` and confirm harvest works — this exercises the POST + `x-csrftoken` path, which is the opposite of the GET rule.
- [ ] **Image fidelity:** download an image pin; confirm the file is the original (check it is much larger than 236 px wide) and that a pin whose original is `.png` saves as `.png`.
- [ ] **Direct MP4:** download a pin whose `video_list` has `V_EXP7`/`V_720P`; confirm it plays.
- [ ] **HLS-only video:** download a pin exposing only `V_HLSV4`/`V_HLSV3_MOBILE`; confirm a playable `.mp4` lands, not a tiny `.m3u8`.
- [ ] **Multi-page Idea Pin:** confirm `_1`, `_2`, … files.
- [ ] **Bulk:** `All` on a ~50-pin harvest completes without CDN failures.
- [ ] **Library:** saved pin shows a Pinterest chip and its permalink opens the right pin.
- [ ] **Logged-out behavior:** in a profile without Pinterest cookies, confirm the tool surfaces Pinterest's error rather than hanging or silently returning zero pins.
- [ ] **SPA navigation:** navigate board A → board B without a reload; confirm the grid does not show board A's pins.

---

## Appendix A — Verified API contract

Captured live 2026-07-25, `br.pinterest.com`, logged in. Raw probe output in `.recon/` at the repo root.

**Envelope** — every resource call returns:

```json
{ "resource_response": { "status": "success", "data": …, "bookmark": "…|-end-", "error": null },
  "client_context": { … }, "resource": { "name": "…", "options": { … } } }
```

`data` is an array for board/section feeds and `{ results: [...] }` for search. Feeds interleave `type: "story"` ad/recommendation slots among `type: "pin"` entries — filter on `type === "pin"`.

**Endpoints used**

| Resource | Method | Key options | Handler |
|---|---|---|---|
| `BoardResource` | GET | `{ field_set_key:"profile_grid_item", is_mobile_fork:true, username, slug }` | `www/[username]/[slug].js` |
| `BoardSectionsResource` | GET | `{ board_id, redux_normalize_feed:true }` | `www/[username]/[slug].js` |
| `BoardFeedResource` | GET | `{ board_id, board_url, currentFilter:-1, field_set_key:"react_grid_pin", filter_section_pins:false, sort:"default", layout:"default", page_size:25, redux_normalize_feed:true, bookmarks?:[cursor] }` | `www/[username]/[slug].js` |
| `BaseSearchResource` | **POST** | `{ query, scope:"pins", rs:"typed", appliedProductFilters:"---", bookmarks:[] }` | `www/search/[scope].js` |

**Headers** (GET example — note the absent csrf):

```
accept: application/json, text/javascript, */*, q=0.01
x-app-version: d97c852
x-requested-with: XMLHttpRequest
x-pinterest-appstate: active
x-pinterest-source-url: /marianam7536/tarot/
x-pinterest-pws-handler: www/[username]/[slug].js
```

POST adds `content-type: application/x-www-form-urlencoded` and `x-csrftoken: <csrftoken cookie>`, with the body as `source_url=…&data=…`.

**Measured behavior**

- Board `/marianam7536/tarot/` (6689 pins, 33 sections): `filter_section_pins:true` → 6 pins total; `false` → 25/page, 149 unique across 6 pages and still paginating.
- Video format mix over 91 search pins: 80 had video — 14 direct MP4, **66 HLS-only**. Quality keys seen: `V_EXP3..V_EXP7`, `V_HLSV3_MOBILE` (80), `V_HLSV4` (39).
- CDN: `i.pinimg.com` and `v1.pinimg.com` return `206` to a `Range` request with `type: "cors"` and no Referer. Both with and without a referrer policy.
- Dead ends confirmed, so nobody re-tries them: `meta[name="pinterest-app-version"]` absent; `script#initial-state` absent; `"board_id"` regex over `documentElement.innerHTML` no match; `__PWS_DATA__` contains no board object; naive `/236x/`→`/originals/` 403s; MP4 path guessing from the signature 0/12.

## Appendix B — Known limitations (deliberate, not defects)

- **40-page harvest cap** (~1000 pins). Boards larger than that need repeated Harvest runs. The UI states when the cap was hit.
- **Harvest state is in-memory in the content script.** A Pinterest page reload loses harvested records; re-run Harvest. (Records are cheap to re-fetch and persisting them would mean a fourth storage key with its own cap policy.)
- **No Warm adapter.** Pinterest cannot be warmed; it is a research/download surface only.
- **No transcription** for Pinterest video, though nothing blocks it — `FBW_TRANSCRIBE` is platform-agnostic and would need only a UI entry point.
- **Board sections are listed but not individually harvestable** from the panel; `filter_section_pins:false` already returns sectioned pins in the main feed, so per-section harvest would only be a filing convenience.

## Self-Review Notes

- **Constraint coverage:** pws-handler → Task 1 (`resourceHeaders`, tested) + Task 3 (per-surface handler); csrf GET/POST split → Task 1 test + Task 3 `resourceGet`/`resourcePost`; `filter_section_pins:false` → Task 1 `boardFeedOptions` + test; `images.orig` no-rewrite → Task 2 `pickImage` + test; HLS rule → Task 2 `parseHlsMaster`/`mp4CandidatesFromHls` + Task 3 `resolveHls` + Task 6 download path; no-Referer/no-DNR → Task 3 manifest host perms, no background change; no ER → Task 2 `METRIC` has no views key; 400 ms bulk / 350 ms paging → Tasks 6 and 3; 40-page cap surfaced → Task 5; version bump → Task 8.
- **Type consistency:** `surfaceOf().handler` feeds `resourceHeaders({handler})` in Task 3. `boardFeedOptions(board, bookmark)` takes the `{id,url}` shape `fetchBoard` returns. `mediaItems()` output is stored on `record.items` by `pinToRecord` and indexed by `FBW_PIN_RESOLVE`'s `itemIndex` in Task 6 — same array, same order. `recordToCard().mediaType` matches `pinToRecord().mediaType` values (`image|video|idea`).
- **Deliberate deviation from the reference extensions:** Pin-Kit's DOM board-id strategies and its MP4-guessing ladder are both **not** reproduced — verified dead against the current site. Pin-Kit's 6-way parallel downloader is also not copied; this plan keeps the repo's existing serial-with-delay convention.
- **Import hygiene:** `PinBoardTool.jsx` is built up across Tasks 4–7. Each task **extends** the existing `lucide-react` and `@/lib/pinMedia` import lines; it never adds a second import from the same module. A duplicate binding (e.g. importing `fmtCount` twice) is a `SyntaxError`, not a lint warning.
- **Verified against the real code, not assumed:** `tools[0].id` is `Shell.jsx:295`; `theme["--sw-grad"]` is `Shell.jsx:273` (required, or the Home picker throws); `modes`/`defaultMode` are read only by `WarmTool.jsx`; `PLATFORM_META` is `TranscriptsPanel.jsx:258-262` with the FB/IG-only permalink fallback at `:89-98`.
- **Risk to watch during execution:** Task 3 assumes an isolated-world content-script `fetch` to `pinterest.com` carries cookies. This is how the Pin-Kit MVP works and all recon ran same-origin, but it was verified from the page's main world. If Task 4 Step 5 shows a 403 despite correct headers, the fallback is to move the fetch into a `world: "MAIN"` script and relay over `window.postMessage`, mirroring `ig/main-world.js` + `ig/bridge.js`.
