# TikTok scraping — Sort + Download + Comments — Design

- **Date:** 2026-07-24
- **Status:** Approved (user: "Sort+Download + Comments", all surfaces). Autonomous build.
- **Version target:** 0.59.0 (MINOR — new platform tool surface)
- **Mirrors:** the Instagram Sort tool (`ig-sort`) and FB Comments tool, adapted to TikTok's data model.

## 1. Context

socialMate already WARMS TikTok (`content.js` `data-e2e` adapters, logged-in
verified) but has **zero TikTok scraping/download tools**. This adds them,
completing the platform to parity with Instagram (sort grid + comments).

## 2. Live recon (verified 2026-07-24, chrome-devtools MCP, logged-out @zachking/@khaby.lame)

- **Capture = fetch/XHR response tee, NOT a `JSON.parse` hook.** TikTok parses API
  responses with `fetch().json()` (native — does not call `window.JSON.parse`); a
  JSON.parse monkey-patch caught 0/167 calls. VERIFIED: wrapping `window.fetch` at
  `document_start` in the MAIN world and `res.clone().text()`-ing the body catches
  `/api/post/item_list/` with full data (`via:fetch`, `hasPlayAddr:true`). XHR path
  was empty but we wrap it too for safety.
- **Passive** — reads responses the page already fetched → **no request signing**
  (`msToken`/`X-Bogus`/`X-Gnarly`/`X-Dynosaur` are only needed to *forge* requests;
  we never do — that is the ban-risk lane we avoid, same philosophy as IG).
- Profile video grid: `GET /api/post/item_list/?secUid=…&cursor=0` →
  `{ itemList:[…], hasMore, cursor }`. `cursor` (ms timestamp) paginates. Logged-out
  pagination is walled (~17 tiles); real capture uses the user's logged-in session.
- Item fields (**richer than IG/FB grids — likes/comments/shares/saves on the list**):
  - `stats`/`statsV2`: `playCount`, `diggCount` (likes), `commentCount`, `shareCount`,
    `collectCount` (saves), `repostCount`.
  - `video`: `id`, `duration`, `cover`/`dynamicCover`/`originCover`, `playAddr` +
    `downloadAddr` (direct signed MP4, no DASH mux), `bitrateInfo[]` (quality gears),
    `width`/`height`, `ratio`.
  - `author` (`uniqueId`,`id`,`nickname`), `music`, `desc`, `createTime` (unix s),
    `challenges[]` (hashtags), `id` (aweme id), `isPinnedItem`.
- **Download referer gotcha:** TikTok video CDN (`v16-webapp-prime.tiktok.com`,
  `*.tiktokcdn*.com`) 403s on hotlink without `Referer: https://www.tiktok.com/`.
  `fetch` can't set Referer (forbidden header) → inject it via a
  `chrome.declarativeNetRequest` session rule on the video-CDN hosts. New permission
  `declarativeNetRequest`.

## 3. Surfaces captured (fetch-hook catches all; bridge tags each with a surface key)

| Surface | API endpoint | surfaceKey |
|---|---|---|
| Profile videos | `/api/post/item_list/` | `profile:<uniqueId>` (from URL `/@user`) |
| Search / hashtag | `/api/search/item/…`, `/api/challenge/item_list/` | `tag:<name>` / `search:<q>` |
| For You feed | `/api/recommend/item_list/` | `feed` |
| Comments (any video open) | `/api/comment/list/` | keyed by `aweme_id` (own store) |

All video endpoints yield the same `itemList[]` shape → one `liteItem()` compactor.
Comments route to a separate store (never pollute the Sort grid), like IG stories.

## 4. Architecture (mirrors IG exactly)

```
src/
  content/tt/
    main-world.js   # NEW — MAIN world, document_start. Wrap fetch + XHR; tee
                    #   response bodies of the video/comment endpoints; compact
                    #   via liteItem()/liteComment(); postMessage → bridge.
    bridge.js       # NEW — isolated, document_idle. Import-free (CRXJS-loader
                    #   safe, like ig/bridge.js). byId Map (surface-scoped, cap
                    #   500) + comments Map<aweme_id,{items,meta}> (cap 60).
                    #   Answers FBW_TT_LIST / FBW_TT_COMMENTS.
  lib/
    ttMedia.js      # NEW — pure: parseCount, sortComparator (views/likes/comments/
                    #   shares/saves/er/date), recordToCard, surfaceKey, filenameFor,
                    #   extFromUrl, engagementRate. + ttMedia.test.js
    ttComments.js   # NEW — pure: flattenComments, sortComments (by diggCount/time),
                    #   commentToRow. + ttComments.test.js
  components/tools/
    TtSortTool.jsx  # NEW — mirror IgSortTool: poll FBW_TT_LIST, sort grid, per-card
                    #   download MP4 / thumb / save-to-Library / transcribe.
    TtCommentsTool.jsx # NEW — mirror FbCommentsTool viewer: pick a captured video,
                    #   search/sort comments, copy/export.
  lib/tools.jsx     # register tt-sort + tt-comments (platforms:['tiktok'])
  background.js     # ensureTiktokReferer() DNR session rule; FBW_DL_MEDIA already
                    #   downloads video by direct URL (works once referer is set).
  manifest.config.js# register content/tt/{main-world,bridge}.js on tiktok;
                    #   add declarativeNetRequest permission.
```

### Data model (compact records the bridge stores)

```js
// video record (byId)
{ id, aweme_id, username, nickname, surface,
  play_count, digg_count, comment_count, share_count, collect_count, repost_count,
  video, download_url, cover, dynamic_cover, duration, width, height,
  desc, create_time, music, hashtags:[...], pinned }
// comment record (comments store, per aweme_id)
{ cid, aweme_id, text, digg_count, reply_count, username, nickname, create_time, is_reply, parent }
```

### Message API additions

| Message | Direction | Payload | Response |
|---|---|---|---|
| `FBW_TT_LIST` | panel → tt bridge | — | `{ records[], surface }` |
| `FBW_TT_COMMENTS` | panel → tt bridge | — | `{ videos:[{aweme_id, meta, comments[]}] }` |
| `FBW_DL_MEDIA` | panel → bg | (existing) video/image | `{ ok, error? }` |
| `FBW_TRANSCRIBE` | panel → bg | (existing) `{mediaUrl, platform:'tiktok'}` | via store |

Transcription reuses the Whisper path: `mediaUrl = video.playAddr`,
`platform:'tiktok'`. NOTE: the offscreen audio fetch hits the same CDN → the
Referer DNR rule must also cover the offscreen fetch (rule is host-scoped, not
initiator-scoped, so it does).

## 5. Sorting & ER

Panel-side, in `ttMedia.js`. Keys: `default` (capture order), `views`, `likes`,
`comments`, `shares`, `saves`, `er`, `date`. ER = (like·1 + comment·4 + share·4 +
save·2) / plays × 100 — TikTok exposes saves & shares (IG didn't), so the weight
set is richer; tunable constant. Missing metric sorts last (like IG).

## 6. Download

- Video: `FBW_DL_MEDIA {kind:'video', url: downloadAddr||playAddr, filename}` →
  `chrome.downloads.download` (direct, no mux). Referer DNR rule makes the CDN serve it.
- Thumbnail: `{kind:'image', url: cover}` → SW fetch → base64 (existing path;
  cover URLs are on `*.tiktokcdn*.com`, host-permitted).
- Bulk "⬇ All" over the sorted/filtered list, paced ~400ms (like IG).
- Filename: `tt-<uniqueId>-<awemeId>.<ext>`.

## 7. Comments (capture-on-open)

Comments only load when a video is opened (comment panel). The fetch hook catches
`/api/comment/list/` passively; the bridge stores them per `aweme_id`. Panel lists
captured videos, shows each thread (text, likes, author, time, reply nesting via
`reply_id`), with search + sort-by-likes + copy + JSON export (reuse `FBW_DL_JSON`).
Shape confirmed structurally from the API; exact field names verified against the
logged-in session during live-verify (defensive optional-chaining throughout).

## 8. Risks / mitigations

- **API shape drift** — defensive optional chaining; a field rename degrades a card,
  doesn't crash. Same fragility class as IG's hook (accepted).
- **Referer requirement uncertain until tested** — build the DNR rule defensively
  (harmless if unneeded); confirm a real download lands during live-verify.
- **Logged-out walls** — capture/pagination need the user's logged-in TikTok tab;
  documented, matches TikTok warming.
- **Import-free bridge** — like `ig/bridge.js`, inline the few helpers it needs so
  CRXJS doesn't wrap it in a dynamic-import loader TikTok's CSP would kill.

## 9. Testing

- vitest: `ttMedia` (parseCount, comparators across all keys/dirs, recordToCard,
  surfaceKey, filename, ER) + `ttComments` (flatten, sort, row mapping).
- Live (chrome-devtools MCP, logged-in): drive a creator profile, confirm
  `FBW_TT_LIST` returns records with stats + playAddr; download one MP4 + one thumb
  and confirm files land; open a video, confirm `FBW_TT_COMMENTS` populates.

## 9a. Verification results (live, 2026-07-24, extension v0.59.0)

- **Video list capture — VERIFIED end-to-end** via the real panel→bridge path
  (SW-driven `FBW_TT_LIST` to the live tab): 33 videos on `@zachking`, surface
  `profile:zachking`, full stats (play 52M, likes 11.2M, comments 87.8K, shares
  485K, saves 828K), `video`/`download_url`/`cover` all present.
- **Download referer — VERIFIED.** DNR session rule installs; a Range probe on the
  video CDN (`v16-webapp-prime.tiktok.com`) returned **206 video/mp4**, the cover
  returned **200 image/jpeg** — the CDN serves both with the injected Referer.
- **`related` endpoint — added after live trace.** `/api/related/item_list/` fires
  on video-detail pages; the initial regex missed it. Added `related` to the video
  regex → verified 12 related videos captured on a detail page.
- **Comments — VERIFIED live** (user drove the tab, network monitor + bridge poll).
  Both endpoints fire and are captured: `/api/comment/list` (top-level, paginates via
  `cursor`) and `/api/comment/list/reply` (replies, `count`). Bridge grew 19 → 86
  comments / 3 → 18 replies as the user scrolled and loaded replies; `is_reply`
  threading correct. Sample: "Farky · 1.25M likes · Bro was ai before ai".

## 10. Out of scope (later)

FB Ad Library spy, TikTok on-page overlays, trending-sound aggregation, CSV export,
outlier detector — separate specs (see session brainstorm).
