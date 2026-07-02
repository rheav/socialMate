# IG Stories & Highlights Download — Design

Date: 2026-07-01
Status: Draft (ready to build)
Depends on: swiss-knife shell + IG passive capture (main-world.js / bridge.js), FBW_DL_MEDIA.

## Goal

Let the user download a creator's **story highlights** and **live stories**
(image + video, including carousels) from the socialWarmer side panel — media
the normal DOM never exposes as a saveable file.

Inspired by InSaverify's stories/highlights capability, but rebuilt on our
**passive-only** philosophy: no synthetic Instagram API calls, no header
harvesting, no account-flagging risk. We piggy-back on the JSON Instagram
already parses on the main thread.

## Live research (verified on instagram.com/solomonaldric/, 2026-07-01)

Method: injected a `JSON.parse` + XHR + `fetch` probe as a page `initScript`
(mirrors our MAIN-world hook) and interacted with the live profile.

Findings — all confirmed, not assumed:

1. **Highlights are passively capturable.** Clicking a highlight fires ONE
   `POST /graphql/query` (~128 KB) with `responseType:""` (text). Instagram
   calls `JSON.parse` on it in JS → **our existing MAIN-world hook already sees
   the whole reel**. `viaFetch` was empty; `viaXhr` = `/graphql/query`.

2. **Live stories are passively capturable too.** Opening the story ring fires
   `POST /graphql/query` (text, JS-parsed). `viaFetch` empty. Same channel.

3. **One open = all items.** A single response contains the entire reel
   (all 3–5 items) — not one fetch per item.

4. **Reel container shape** (the grouping object):
   - Highlight: `{ id:"highlight:18123247438654659", reel_type:"highlight",
     title:"Reviews", items:[…5], cover_media:{cropped_image_version,
     full_image_version}, user:{pk,username}, latest_reel_media }`
   - Live story: `{ id:"20955652202" (= owner pk), reel_type:"user_reel",
     title:null, items:[…3], user:{pk,username} }`
   - Label rule: `title` for highlights; `"Stories"` for live (title null).

5. **Story item shape** (one media inside `items[]`):
   ```
   {
     pk: "3924250723026019313",
     id: "3924250723026019313_20955652202",   // pk_ownerpk
     media_type: 2,                            // 1=photo, 2=video
     taken_at: 1782027155,                     // unix s
     expiring_at: 1782113555,                  // STORY expiry (24h), not URL expiry
     original_width: 720, original_height: 1280,
     image_versions2: { candidates:[{url,width}, …] },   // always (poster/photo)
     video_versions: [{url,width,height}, …],  // present when media_type 2
     video_dash_manifest, is_dash_eligible, number_of_qualities, video_duration,
     carousel_media_count, carousel_media,      // stories CAN be carousels
     code, caption, has_audio,
     story_link_stickers                        // swipe-up link target (bonus data)
   }
   ```

6. **Direct progressive MP4.** `video_versions[0].url` is
   `…/o1/v/t2/…` — a progressive MP4 with audio, downloadable directly (same as
   reels). **No DASH muxing needed** (unlike Facebook). Photo = direct CDN jpg.

7. **Freshness.** URLs are signed with their own expiry (`oe` param). Because
   capture happens at open-time, the URL is fresh — download promptly. Do NOT
   rely on `expiring_at` for URL validity (that's the 24 h story lifetime).

## Design decisions

- **Passive, capture-on-open.** To grab a highlight/story we rely on the user
  opening it in Instagram (normal behavior). No background reels_media fetch.
  This is the deliberate, safe lane we chose when we removed the active
  `/media/info` fetch. (An active bulk fetch is a documented non-goal below.)
- **Downloads from the panel only.** Consistent with the just-made decision to
  keep the DOM script light (transcription is panel-only). No in-viewer buttons.
- **New global-ish tool: "Stories".** IG-only tool in the hub:
  `{ id:"ig-stories", label:"Stories", platforms:["instagram"] }`. Lists
  captured reels grouped by owner → album, each item downloadable, plus
  "Download all" per album.
- **Reuse everything.** FBW_DL_MEDIA (video direct / image dataURL / carousel
  per-child) already does the download. Capture rides the existing
  postMessage → bridge `byId` channel, but into a separate `reels` store so
  stories never pollute the Sort grid.

## Data model

Main-world emits a new record kind alongside normal media:

```js
// reel container (one per highlight / story tray)
{ __kind:"reel", reel_id, reel_type, title, owner:{pk,username}, cover, item_pks:[...] }
// story item (one per media)
{ __kind:"story", pk, id, reel_id, owner_username,
  media_type:"photo"|"video"|"carousel",
  image, video, carousel:[{media_type,image,video}], thumb,
  taken_at, expiring_at, duration, code }
```

Bridge keeps `reels: Map<reel_id, {meta, items:Map<pk,item>}>`, surface-scoped
like `byId`. Panel reads it via a new `FBW_IG_REELS` message.

## Architecture / changes

1. **src/content/ig/main-world.js**
   - `findMedia`: also yield reel containers (`o.id && Array.isArray(o.items) &&
     (o.reel_type || String(o.id).startsWith("highlight:"))`).
   - `scan`: when a container is found, emit a `reel` record (meta + child pks)
     and emit each `items[]` element as a `story` record. **Do not drop
     story items lacking `code`** (key by pk). Keep the existing `!m.code`
     skip only for the normal-media path.
   - `liteStory(item, reel)`: map the story-item shape above (image best
     candidate, video_versions[0].url, carousel children, media_type name,
     taken_at, expiring_at, duration).
   - Depth cap / buffer caps already added — reuse.

2. **src/content/ig/bridge.js**
   - Handle `__kind:"reel"|"story"` in the message listener → populate `reels`
     Map (coalesce, never null-clobber; cap size like byId).
   - Respond to `FBW_IG_REELS` with surface-scoped reels + items.
   - No overlay/DOM UI (keep the in-page script lean). Import-free rule holds.

3. **src/components/tools/IgStoriesTool.jsx** (new)
   - Poll `FBW_IG_REELS` (2.5 s, like IgSortTool).
   - Group: owner → album (title || "Stories"). Album card shows cover +
     item count + "Download all". Each item = a 9:16 thumb with a Download
     button (video → mp4, photo → jpg, carousel → per-child) via FBW_DL_MEDIA
     and `filenameFor` (extend to `ig-story-{owner}-{pk}`).
   - Empty state: "Open a story or highlight on Instagram to capture it here."

4. **src/lib/igReels.js** (new, pure, unit-tested)
   - `reelLabel(reel)`, `storyToCard(item)`, `groupReels(reels)`,
     `storyFilename(item, ext, idx)`. Mirrors igMedia helpers; keeps logic
     testable and out of the DOM scripts.

5. **src/lib/tools.jsx** — register the `ig-stories` tool.

6. **src/background.js** — no change expected (FBW_DL_MEDIA covers video/image/
   carousel). Verify carousel story children map to its per-child branch.

## UX flow

1. User opens a highlight or story on Instagram (normal tap).
2. Passive capture grabs the whole reel silently.
3. Panel → Instagram → **Stories** lists it under the owner, grouped by album.
4. User taps Download on an item, or "Download all" on the album.

## Edge cases

- **Photo story**: media_type 1, no video_versions → download image candidate[0].
- **Carousel story**: iterate carousel_media children (mixed photo/video).
- **No `code`**: key by pk; permalink omitted (stories aren't `/p/` shareable).
- **Expired story tray**: nothing to capture until the user opens something.
- **URL staleness**: capture-on-open keeps it fresh; if a download 403s, prompt
  "re-open the story and retry."
- **Surface scoping**: a reel belongs to the profile/owner surface; don't leak
  across creators (reuse the surface tag already stamped in bridge).
- **Memory**: cap `reels` Map (e.g. 60 reels) evicting oldest.

## Testing

- Unit (vitest): igReels helpers — label rule (title vs "Stories"),
  storyToCard mapping (photo/video/carousel), filename builder, groupReels.
- Live (chrome-devtools MCP): open the Reviews highlight + the story ring on
  solomonaldric, assert `FBW_IG_REELS` returns the reel with N items and valid
  media URLs; download one video + one photo and confirm the file lands.
- Regression: bridge stays a **direct** content script (no `-loader-`,
  `import(` count 0); Sort grid unaffected (stories excluded from byId).

## Non-goals (explicit)

- **No active `reels_media` bulk fetch.** Downloading a highlight the user has
  NOT opened would require calling `/api/v1/feed/reels_media/?reel_ids=…` with
  harvested headers (the InSaverify path). Powerful but re-introduces exactly
  the flagging/rate-limit risk we removed. Left as a future opt-in only if the
  user explicitly asks; would need a clear consent gate.
- No story stickers/link extraction UI (we capture `story_link_stickers` in the
  record for later, but no dedicated view yet).
- No DOM/in-viewer download buttons.

## Phased build

1. **Pure lib + tests** — `igReels.js` + `igReels.test.js` (red→green).
2. **Capture** — main-world reel/story emit + bridge `reels` store +
   `FBW_IG_REELS`. Verify live via MCP (no UI yet).
3. **Panel tool** — `IgStoriesTool.jsx` + registry entry; grouped list +
   per-item / per-album download.
4. **Verify + polish** — live download of video/photo/carousel; memory caps;
   build + tests + bridge-direct check; commit.
