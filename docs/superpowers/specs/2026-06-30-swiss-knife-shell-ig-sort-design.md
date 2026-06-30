# Swiss-knife shell + Instagram Sort/Download tool — Design

- **Date:** 2026-06-30
- **Status:** Approved (brainstorm), pending implementation plan
- **Scope:** Spec 1 of a 4-spec program (see Appendix A). This spec covers the UI shell
  revamp **plus** the Instagram Sort/Download tool as the proof slice.

---

## 1. Context & problem

`socialWarmer` (v0.33.0) is a Manifest-V3 side-panel extension that semi-automates
Facebook / Instagram / TikTok research + warming, with a revived media pipeline
(webRequest fbcdn capture → offscreen Whisper transcription + ffmpeg DASH mux → download,
plus MiniLM niche-relevance gating). The warming **engine** (`src/content.js`, ~2030 lines)
and the **media pipeline** (`background.js`, `offscreen/`, `lib/fbcdn.js`, the IG/FB capture
content scripts) are solid and stay untouched.

The **UI** is the problem. `src/App.jsx` is one ~810-line monolith with a flat 5-tab
`BottomNav` (Warm · History · Transcripts · Saved · Download). "Platform" and "tool" live
on inconsistent axes: the platform switcher (FB/IG/TikTok) only appears inside the Warm
view, while Transcripts/Saved/Download are global and platform-agnostic. It reads as "a
warmer with download tools bolted on," not a coherent multi-platform toolkit.

The user wants `socialWarmer` reframed as a **"swiss-knife for social media"**: a clean
shell where you pick a platform and get that platform's tools. Three new capabilities are
planned (Instagram sort+download, Pinterest merge, improved Facebook mass-download); the
current IA can't absorb them cleanly — e.g. Pinterest is download-only and breaks the
warm-centric `A/B/C` mode model.

## 2. Goals

- Replace the flat tab IA with a **launcher shell**: Home (platform grid) → Platform hub
  (tool grid) → Tool. Extensible so new platforms/tools are pure additions.
- Land the **Instagram Sort + Download** tool inside the new shell as the proof slice.
- Reuse the existing IG capture + download + Saved pipeline; do not rebuild the engine.
- Decompose `App.jsx` into focused per-tool panels.

## 3. Non-goals (handled by later specs — Appendix A)

- Pinterest platform/merge (Spec 2).
- Facebook GraphQL mass-download (Spec 3).
- TikTok download, in-page IG feed re-sorting, image OCR, account management.

## 4. Locked decisions (from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Shell nav model | **Launcher** (home grid → drill into platform → tool) | Most app-like; scales as platforms grow. Friction offset by remember-last + quick platform-swap. |
| IA split | **Per-platform action tools (Warm/Sort/Download) + one global Library (Saved/Transcripts/History)** | Library content is cross-platform; actions are platform-bound. |
| IG "Sort" behavior | **Panel card list** (sort + download in the side panel) | Survives IG's virtualized infinite scroll; reuses existing capture + Saved/Download. NOT in-page DOM re-sort (brittle). |
| IG list fill | **Passive** (fills from the JSON.parse capture as the user scrolls IG) | Safest / least bot-like; no auto-scroll harvester. |
| IG surfaces (slice) | **Hashtag pages + Profile posts/reels** | Core niche-research surfaces. |
| IG sort keys | likes / views / comments / date | Standard engagement dimensions. |
| IG media types | **Video + images + carousels** | Ports pinkit image upscaling; carousels = multiple files per post. |
| Architecture | **Incremental refactor** (Shell + tool registry; engine/background/offscreen untouched) | Lowest risk; clean swiss-knife foundation. |

## 5. Architecture

Incremental refactor of the **UI layer only**. New pieces:

```
src/
  App.jsx                     # shrinks to: mount <Shell/>
  components/
    Shell.jsx                 # launcher state machine + theme retint + chrome
    ui/
      Launcher.jsx            # Home platform grid + Platform-hub tool grid
    tools/
      WarmTool.jsx            # extracted warm form + status + log (from App.jsx)
      IgSortTool.jsx          # NEW — IG sort + download panel (the slice)
      LibraryTool.jsx         # wraps existing Saved/Transcripts/History as inner tabs
  lib/
    tools.jsx                 # NEW — declarative tool registry
    igMedia.js                # NEW — pure helpers (sort comparator, record→card, image upscaler)
```

Unchanged: `content.js`, `offscreen/*`, `lib/fbcdn.js`. `lib/platforms.jsx` gets only a tiny
`tools` wiring (no structural change). `content/ig/{main-world,bridge}.js` and
`background.js` get **additive** changes (below).

### 5.1 Shell + routing

`Shell.jsx` owns nav state `{ screen, platform, tool }` where `screen ∈ {home, hub, tool}`.

- **Home** — renders `Launcher` in platform-grid mode: a card per platform in
  `PLATFORM_ORDER` plus a **Library** card. Tapping a platform → `{screen:hub, platform}`.
- **Hub** — renders `Launcher` in tool-grid mode for `platform`: a card per registered tool
  whose `platforms` includes it. Tapping a tool → `{screen:tool, platform, tool}`.
- **Tool** — renders the tool's `Panel`, wrapped in a `ToolFrame` (‹ back, tool title, and a
  compact platform-swap control that re-resolves the tool on another platform if supported).

Nav state persists to `chrome.storage.local` under `sw_nav`; on panel open the Shell
restores the last `{screen, platform, tool}` (**remember-last**). Theme retint stays as
today: on `platform` change, write `PLATFORMS[platform].theme` vars to `:root`.

### 5.2 Tool registry (`lib/tools.jsx`)

Declarative array; the single source of truth for what shows where:

```js
// shape
{ id, label, Icon, platforms: ["facebook","instagram",...] | "global",
  Panel,            // React component rendered in the Tool screen
  requiresTab }     // bool — needs a live platform tab (Warm, IgSort) vs not (Library)
```

Initial registry:

| id | label | platforms | Panel | requiresTab |
|---|---|---|---|---|
| `warm` | Warm | facebook, instagram, tiktok | `WarmTool` | yes |
| `ig-sort` | Sort + Download | instagram | `IgSortTool` | yes |
| `download` | Download | facebook | `DownloadPanel` (existing) | yes |
| `library` | Library | global | `LibraryTool` | no |

(IG downloads live in `ig-sort`; the standalone `download` tool stays FB-only for the
existing in-view capture flow. Adding it to other platforms later is a registry edit.)

Adding Pinterest (Spec 2) or FB mass-download (Spec 3) = append a registry entry + Panel;
**no Shell edits**. This is the extensibility that makes it a swiss-knife.

### 5.3 `App.jsx` decomposition

- Extract the warm form + status + counters + log + History inline component out of
  `App.jsx` into `WarmTool.jsx` (and fold History into `LibraryTool`). The warm
  message API (`FBW_START/STATUS/TOGGLE_PAUSE/STOP`, options persistence) moves with it.
- `App.jsx` becomes a thin mount of `<Shell/>`.
- `BottomNav` is removed (replaced by launcher nav); `PlatformSwitcher` becomes the
  Home grid + the in-tool platform-swap control.

## 6. Instagram Sort + Download tool (the proof slice)

### 6.1 Data source (passive)

The MAIN-world `content/ig/main-world.js` already hooks `JSON.parse` and relays media
records to the isolated `content/ig/bridge.js`, which keeps a full `igMedia` map
(currently only the in-view video is published to the panel). Changes:

1. **`bridge.js`** stamps each received record with a **surface key** computed from
   `location` at receive time:
   - hashtag → `tag:<tag>` (path `/explore/tags/<tag>`)
   - profile → `profile:<username>` (path `/<username>/` and its `/reels/`)
   - other → `feed` / `explore` (still captured, shown under "All")
2. **`bridge.js`** answers a new message `FBW_IG_LIST` →
   `{ records: [...all igMedia values...], surface: <currentSurfaceKey> }`.
3. **`IgSortTool`** sends `FBW_IG_LIST` to the active IG tab on mount + on a light interval,
   filters records to the current `surface` (with a "show all collected" toggle), and shows
   a live "N posts collected — scroll Instagram to collect more" counter (passive model).

### 6.2 Capture extension (`lite()` in `main-world.js`)

`lite(m)` today returns video + thumb only. Extend it (passive — no extra network) to add:

- `media_type`: derive `"photo" | "video" | "carousel"` from `m.media_type`
  (1=photo, 2=video, 8=carousel).
- `image`: best full-resolution image URL (`m.image_versions2.candidates[0].url`); keep the
  existing smaller `thumb` for the card.
- `carousel`: when `m.carousel_media` exists, an array of children
  `{ media_type, image, video }` (each child's best image + `video_versions[0].url` if a
  video). Lets carousel download save every slide.
- `taken_at`: `m.taken_at` (unix seconds) → enables date sort.
- Resend signature gains `media_type` so a post upgrading photo→carousel re-emits.

### 6.3 Sort + list UI

- Pure helpers in `lib/igMedia.js`: `sortComparator(key, dir)` over
  `key ∈ {likes, views, comments, date}`; `recordToCard(rec)`; `bestImageUrl(url)`
  (pinkit `/originals/` upscaling with a fallback).
- Card: thumb, `@username`, counts (❤/💬/▶), a media-type badge (photo/video/carousel),
  per-card `⬇`, and a per-card "save to Library."
- Controls: sort-key dropdown + direction toggle + `⬇ All` (bulk over the current sorted,
  filtered list).

### 6.4 Download paths

A single new background message handles panel-initiated downloads:

`FBW_DL_MEDIA { kind: "video" | "image", url, filename, fallbackUrl? }` →

- **video** → `chrome.downloads.download({ url, filename })` (IG `video_versions` URLs are
  directly downloadable; same as today's `runDownload` IG branch). `sendResponse({ok})`.
- **image** → background `fetch(url)` (host permission `*.cdninstagram.com` bypasses page
  CORS) → arrayBuffer → base64 data URL (mirror pinkit `blobToDataUrl` in the SW) →
  `chrome.downloads.download({ url: dataUrl, filename })`. On non-OK, retry `fallbackUrl`,
  then give up with an error in the response.
- **carousel** → the panel loops the post's `carousel[]`, emitting one `FBW_DL_MEDIA` per
  child with `_1 / _2 …` filename suffixes (kind per child).
- **bulk (`⬇ All`)** → the panel iterates the sorted/filtered list sequentially with a small
  paced delay, rendering per-item progress rows (reuse the existing `DownloadPanel`
  progress-row pattern).

Filename template: `ig-<username>-<code>[_<n>].<ext>`.

### 6.5 Saved/Library integration

Per-card "save" merges the record into the existing `fbw_saved` store (same shape
`content/transcription/inject.js#saveFavorite` writes), so saved IG posts appear in the
global Library alongside FB captures.

## 7. Data flow

```
IG tab (MAIN world)  JSON.parse hook → media records
        │ window.postMessage
        ▼
bridge.js (isolated) igMedia map + surface stamp
        │ FBW_IG_LIST (chrome.tabs.sendMessage from panel)
        ▼
IgSortTool (panel)   filter by surface → sort → render cards
        │ FBW_DL_MEDIA (chrome.runtime → background)
        ▼
background.js        video: downloads.download(url)
                     image: fetch → base64 dataURL → downloads.download
        ▼
chrome.downloads     file saved   (offscreen NOT used — IG has direct URLs, no DASH mux)
```

## 8. Error handling & edge cases

- **No IG tab** → hub/tool shows the existing `noTab` prompt ("Open Instagram, then reopen").
- **Empty list** (nothing scrolled yet) → empty state "Scroll the Instagram feed to collect
  posts." Always show the collected-count so the passive model is legible.
- **Image 403 / hotlink block** → background-fetch path (credentialed-omit) + `fallbackUrl`
  retry; final failure surfaces a per-card error, doesn't abort the bulk run.
- **Carousel partial** → download children independently; one failed slide doesn't fail the
  others.
- **SPA navigation** (IG is a single-page app) → records accumulate across surfaces; the
  surface filter keeps the list scoped to the current hashtag/profile, with "show all".
- **Record without a video URL** (photo posts) → card shows image download only; no video ⬇.

## 9. Testing

The project has no test harness today (Vite + React, manual `npm run build` → load `dist/`).
Scope minimal, focused on **pure** logic:

- Add Vitest for `lib/igMedia.js`: `sortComparator` ordering across keys/dirs, `bestImageUrl`
  upscaling + fallback, `recordToCard` mapping, and the `lite()` field-derivation helpers
  (extract the pure parts so they're testable without the DOM).
- Manual live verification on the logged-in Playwright Chrome (per the harness constraint we
  can't click the panel UI, but we can drive IG, confirm `FBW_IG_LIST` returns records on
  hashtag + profile surfaces, and confirm `FBW_DL_MEDIA` saves video/image/carousel files).

## 10. File plan

**New:** `components/Shell.jsx`, `components/ui/Launcher.jsx`,
`components/tools/{WarmTool,IgSortTool,LibraryTool}.jsx`, `lib/tools.jsx`, `lib/igMedia.js`,
plus a Vitest config + `lib/igMedia.test.js`.

**Changed:** `content/ig/main-world.js` (extend `lite()`), `content/ig/bridge.js`
(surface stamp + `FBW_IG_LIST`), `background.js` (add `FBW_DL_MEDIA`), `App.jsx`
(→ `<Shell/>`), `lib/platforms.jsx` (tool wiring if needed), `package.json` (vitest dev dep).

**Untouched:** `content.js`, `offscreen/*`, `lib/fbcdn.js`, FB/transcription capture.

## 11. Risks

- **IG JSON shape drift** — `lite()` depends on IG's internal field names
  (`image_versions2`, `carousel_media`, `video_versions`, `media_type`, `taken_at`). Mitigation:
  defensive optional-chaining + the existing fallback (DOM author/caption) already present in
  `bridge.js`; field changes degrade a card, don't crash the tool.
- **Passive-only thinness** — a freshly opened hashtag yields few records until the user
  scrolls. Accepted (the user chose passive for safety); mitigated by the visible
  collected-count and "scroll to collect more" affordance.
- **App.jsx extraction regressions** — moving the warm flow risks breaking the working
  warmer. Mitigation: extract verbatim into `WarmTool.jsx` (move, don't rewrite); verify the
  warm path still runs before adding IG-Sort.

---

## Appendix A — Program decomposition (roadmap)

This is Spec 1 of 4; each is its own spec → plan → build cycle, slotting into the shell:

1. **Spec 1 (this doc)** — Swiss-knife shell + IG Sort/Download tool.
2. **Spec 2** — Pinterest merge: new download-only "platform" (board scrape via the private
   `BoardFeedResource` API + grid hover button + ZIP), proving the shell handles a non-warming
   platform. Source: `inspirations/pinterest-download/pinkit-mvp`.
3. **Spec 3** — Facebook mass-download: bulk via FB GraphQL `doc_id` (skip the play-each-video
   webRequest+DASH path for bulk). Source already in-repo: `fb-mass-downloader/` (clean engine)
   + `bulk-download-videos-fb/` (packed reference).
4. **Spec 4 (optional/backlog)** — TikTok download, in-page IG re-sort, cross-platform Library
   enhancements.

## Appendix B — Message API additions

| Message | Direction | Payload | Response |
|---|---|---|---|
| `FBW_IG_LIST` | panel → IG content (bridge) | — | `{ records[], surface }` |
| `FBW_DL_MEDIA` | panel → background | `{ kind, url, filename, fallbackUrl? }` | `{ ok, error? }` |

Existing messages (`FBW_START/STATUS/TOGGLE_PAUSE/STOP`, `FBW_CURRENT`, `FBW_DOWNLOAD`,
`FBW_TRANSCRIBE`, `FBW_RELEVANCE`, `FBW_QUICK_TRANSCRIBE`) are unchanged.
