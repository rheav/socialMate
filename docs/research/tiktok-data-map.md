# TikTok data map — what the page gives us, and what we currently take

Measured live on 2026-08-16 in the shared `:9222` Chrome (logged-in BR account),
using CDP network capture. Reference surfaces:

- grid: `https://www.tiktok.com/search?q=%23cardreading` (the "Melhores" tab)
- grid: `https://www.tiktok.com/search/video?q=%23cardreading` ("Vídeos" tab)
- grid: `https://www.tiktok.com/search/user?q=cardreading` ("Usuários" tab)
- video: `https://www.tiktok.com/@veloria691/video/7650586406246436127`
- profile: `https://www.tiktok.com/@veloria691`

## How to observe TikTok at all

Two traps cost an hour each; write them down.

1. **A page-level `fetch` patch installed after load catches nothing.** TikTok's
   bundle captures the original `fetch` reference at load time, so a probe
   injected later sees only late telemetry (`/api/inbox/notice_list/`,
   `/api/notice/multi/`, `mcs-sg.tiktokv.com/v1/list`). This is exactly why
   `src/content/tt/tt-capture.js` hooks at `document_start` — and why a
   diagnostic must use CDP (`list_network_requests`), which is below the page.
2. **`performance.getEntriesByType('resource')` truncates at 250 entries.**
   TikTok ships ~220 static chunks from `sf16-website-login.neutral.ttwstatic.com`
   on a cold load, so the buffer is full before the first API call. Every "no API
   calls happened" reading in this session was that. Fix:
   `performance.clearResourceTimings(); performance.setResourceTimingBufferSize(2000)`
   before acting.

Also: the search grid only paginates while the tab is *visible* (activate via
CDP `/json/activate/<id>` or `select_page bringToFront`), and its scroll
container is `<main>`, not the document — `document.scrollingElement.scrollHeight`
stayed equal to `clientHeight` while `main.scrollHeight` grew 2250 → 7287. A
harvester that scrolls the window here paginates nothing.

3. **The SSR blob is not guaranteed.** `__UNIVERSAL_DATA_FOR_REHYDRATION__` is in
   the initial HTML, but TikTok registers a service worker, and on a warm load the
   same `/video/` URL that had served the blob minutes earlier came back without
   it (`document.getElementById(...)` → null). Anything reading it must read
   *early* — `document_start`, before hydration can strip it — and must still have
   a fallback. Ours is the DOM: `[data-e2e="like-count"]`, `comment-count`,
   `share-count`, `favorite-count`. Views are not printed on a video page, so ER
   is genuinely unavailable on that path.

## Endpoint inventory

| Surface | Endpoint | Response root | Paging |
|---|---|---|---|
| Search · Melhores (default) | `/api/search/general/full/` | `data[] → {type, item, common}` | `offset`/`cursor` +12, `count=12`, `search_id` from page 2 on |
| Search · Vídeos | `/api/search/item/full/` | `item_list[]` | same |
| Search · Usuários | `/api/search/user/full/` | `user_list[]` (+ `challenge_list`, `music_list`) | `cursor` +10 |
| Search typeahead | `/api/search/suggest/guide/`, `/api/search/general/preview/` | — | — |
| Video page (first item) | **none — SSR** | `#__UNIVERSAL_DATA_FOR_REHYDRATION__` → `__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct` | — |
| Video page (next in feed) | `/api/related/item_list/` | `itemList[]` | scroll |
| Video page SEO | `/api/customtdk/item/` | — | — |
| Comments | `/api/comment/list/` | `comments[]` | `cursor` +20, `count=20`, `aweme_id` |
| Comment replies | `/api/comment/list/reply/` | `comments[]` | per `comment_id` |
| Profile | `/api/user/detail/`, `/api/post/item_list/`, `/api/user/playlist/`, `/api/story/user_list/`, `/api/story/item_list/`, `/api/story/batch/item_list/` | mixed | — |

All are plain GETs the page already signs (`X-Bogus`/`X-Gnarly`/`msToken`).
Signatures are **single-use**: replaying a captured URL from the page returns an
empty body. So the passive tee is the only workable approach — same conclusion
`tt-capture.js` already reached, and it means we can never "fetch page 2
ourselves"; we can only drive the UI and read what it asks for.

## What the grid gives us (per video)

`/api/search/general/full/` → `data[i].item` and `/api/search/item/full/` →
`item_list[i]` are the **same webapp item struct**, and it is remarkably complete
— everything Instagram makes us enrich for is already here on the first page:

```
id, desc, createTime, textLanguage, CategoryType, diversificationId, isAd
stats      { playCount, diggCount, commentCount, shareCount, collectCount }
statsV2    { ...same as strings, + repostCount }
author     { id, uniqueId, nickname, signature, secUid, verified, privateAccount,
             avatarThumb/Medium/Larger, relation, commentSetting, duetSetting,
             stitchSetting, downloadSetting, openFavorite }
authorStats{ followerCount, followingCount, heartCount, videoCount, diggCount, friendCount }
video      { id, duration, width, height, ratio, definition, codecType, format,
             size, bitrate, videoQuality, VQScore, volumeInfo{Loudness,Peak},
             cover, originCover, dynamicCover, zoomCover,
             playAddr, downloadAddr (sometimes absent),
             bitrateInfo[ {GearName, Bitrate, QualityType, CodecType,
                           PlayAddr{UrlList,Width,Height,DataSize,FileHash}} ],
             claInfo{ hasOriginalAudio, enableAutoCaption, captionsType,
                      originalLanguageInfo, captionInfos[] | noCaptionReason },
             subtitleInfos[ {LanguageCodeName, Url, Format:"webvtt",
                             Source:"ASR", Size, UrlExpire} ] }
music      { id, title, authorName, original, duration, playUrl, isCopyrighted, album, cover* }
challenges[{id,title}]  textExtra[{hashtagName,hashtagId,start,end,type,subType,isCommerce}]
contents[] item_control{can_repost} collected digged AIGCDescription
```

Two things worth calling out because they change what features are cheap:

- **`authorStats.followerCount` ships with every grid item.** Instagram needs a
  separate enrichment round-trip for this (`igEnrich.js`, `ENRICH_MIN_GAP_MS`).
  On TikTok, views/follower and ER are computable the moment the grid paints.
- **Captions are a direct WebVTT URL.** ~5 of 12 items in the sampled page carry
  `subtitleInfos[0].Url` (`Format: "webvtt"`, `Source: "ASR"`, `Version:
  "1:whisper_lid"` or `"1:big_caption"`). That is a free transcript — no Whisper,
  no download, one GET. The rest report `claInfo.noCaptionReason` and would need
  the audio path. `claInfo.captionInfos[]` carries the same URLs plus
  `isAutoGen`, `isOriginalCaption`, `subID`, `expire`, `variant`.

Sampled availability (`/api/search/item/full/`, 12 items): captions 8/12,
`downloadAddr` 6/12, `bitrateInfo` 4–5 gears on every item. `playAddr` is always
present, so downloads never depend on `downloadAddr`.

Difference between the two grid endpoints: `item/full` items add
`videoSuggestWordsList` and `effectStickers` but **drop `downloadAddr` more
often**; `general/full` items add `IsHDBitrate` and wrap each item as
`{type: 1, item, common:{doc_id_str}}` (type 1 = video; user/live cards use other
types and appear mostly at `offset=0`).

## What the video page adds

The detail item is **server-rendered, not fetched** —
`#__UNIVERSAL_DATA_FOR_REHYDRATION__` → `webapp.video-detail.itemInfo.itemStruct`,
same struct as the grid, plus:

```
locationCreated ("BR")          suggestedWords ["tarot","cartas de tarot"]
diversificationLabels ["Random Shoot","Others"]   channelTags[]
IsAigc / ShowAIGC               warnInfo, takeDown, indexEnabled, scheduleTime
effectStickers, comments        video.shareCover, video.reflowCover, video.PlayAddrStruct
shareMeta { title, desc }       (sibling of itemInfo)
```

Everything else — stats, statsV2, authorStats, bitrateInfo, subtitleInfos,
playAddr/downloadAddr — is **identical to what the grid already gave us**. So the
video page is worth visiting for `locationCreated`, `suggestedWords`,
`diversificationLabels`, AIGC flags and comments; it is *not* needed for stats,
downloads or captions.

**This is the single biggest gap in our capture layer**: `tt-capture.js` only
tees `fetch`/XHR, and the detail item never travels over either. On a single
video page we currently capture nothing until the user scrolls into the next
item (which does fire `/api/related/item_list/`). Reading it needs an SSR/DOM
reader, re-run on SPA navigation.

## Comments

`/api/comment/list/?aweme_id=<id>&count=20&cursor=N` — lazy, fires only when the
"Comentários" tab is opened, then again per scroll page. Response:
`{ comments[], cursor, has_more, total, has_filtered_comments, reply_style, top_gifts }`.

Per comment:

```
cid, aweme_id, text, create_time, digg_count, reply_comment_total,
comment_language ("pt"), is_comment_translatable, author_pin, user_digged,
is_author_digged, status, stick_position, sort_tags {"top_list":1},
sort_extra_score, label_list, image_list[]  (comment images/GIFs, crop_url+uri),
reply_id / reply_to_reply_id / thread_id / thread_has_more,
reply_comment[]  (inline preview of replies, when present),
user { uid, unique_id, nickname, sec_uid, avatar_thumb, custom_verify,
       enterprise_verify_reason, account_labels, user_tags, predicted_age_group }
```

`total` is the true comment count (1032 on the sample), so a full harvest is
`ceil(total/20)` scroll pages plus one `/api/comment/list/reply/` per thread.
Note the comment `user` object has **no follower count** — enriching a commenter
means a profile visit.

## Grid vs video page — the short version

| Data | Grid | Video page |
|---|---|---|
| views / likes / comments / shares / saves / reposts | ✅ | ✅ (same) |
| author follower/heart/video counts | ✅ | ✅ (same) |
| ER, views-per-follower | computable immediately | same |
| direct video URLs + quality ladder | ✅ | ✅ |
| WebVTT captions | ✅ when the video has them | ✅ same |
| music (title, author, direct `playUrl`) | ✅ | ✅ |
| hashtags + offsets | ✅ | ✅ |
| location, suggested words, topic labels, AIGC | ❌ | ✅ |
| comments | ❌ | ✅ (`/api/comment/list/`) |
| how it arrives | fetch (tee-able) | **SSR script tag (not tee-able)** |

## Status

Everything below was fixed in 0.81.0 — the section is kept because it is the
diagnosis, and because each item names a trap worth not re-entering.

## Gaps in `src/content/tt/tt-capture.js` today

1. **`VIDEO_RE` misses both search endpoints that matter.** The regex is
   `/api/(post|recommend|related|challenge|search|user)/(item_list|item)\b` —
   `/api/search/general/full/` and `/api/search/user/full/` don't match at all,
   and `/api/user/detail/` (profile creator stats) doesn't either.
2. **`ingest()` reads `obj.itemList || obj.items` only.** `/api/search/item/full/`
   *does* match the regex but returns `item_list` (snake_case), and
   `/api/search/general/full/` returns `data[].item`. Both are silently dropped.
   Net effect: **the entire search surface currently yields zero records.**
3. **No SSR reader** for `webapp.video-detail` / `webapp.user-detail`, so single
   video pages and profiles contribute nothing.
4. **`liteItem()` drops fields we already have in hand**: `authorStats.*`
   (follower/heart/video counts — the ER denominator), `author.signature`,
   `avatar*`, `verified`, `secUid`, `privateAccount`; `music.playUrl` (audio
   download) and `music.duration`; `video.size`/`bitrate`/`ratio`/`volumeInfo`;
   `textExtra` (hashtag offsets and mentions); `locationCreated`,
   `suggestedWords`, `diversificationLabels`; `isAd`, `collected`, `digged`,
   `AIGCDescription`.
5. `pinned` reads `it.isPinnedItem`, a key only `/api/post/item_list/` sets —
   harmless, but it will always be false on search results.

## What IG/FB parity would need

| Feature we have on IG/FB | TikTok status |
|---|---|
| grid overlay: views, likes, ER, saves | data is already in the grid payload; needs the capture fixes above + a bridge overlay |
| stats rail on the single-video player | needs the SSR reader; TikTok already paints its own progress bar, so `videoBar.js` is not needed here |
| transcribe | **cheaper than IG** — direct WebVTT for ~2/3 of videos; Whisper only for the rest |
| download video | direct: `bitrateInfo[].PlayAddr.UrlList[0]` (pick max resolution then bitrate — `bestBitrate()` already does this), fallback `downloadAddr` → `playAddr` |
| download thumbnail | `cover` / `originCover` / `dynamicCover` (animated webp) |
| download audio | `music.playUrl` — no IG equivalent |
| creator stats | `authorStats` inline on every item; `/api/user/detail/` on profiles |
| xlsx export | all columns available, plus follower count and music without a second round-trip |
| comments harvest | `/api/comment/list/` + `/api/comment/list/reply/`, `total` known upfront |
| date-range / ER-weight filters (`igFilters.js`) | `createTime` is a unix second stamp on every item — reusable as-is |

## Raw captures

Kept under the session scratchpad (not committed):
`tt-search-general-offset12.json`, `tt-search-item.json`, `tt-search-user.json`,
`tt-comments.json`.
