# socialMate — architecture map

Derived from a full read of every file in `src/`, kept current through v0.68.0. This is the missing
top-level doc: the de-facto architecture record was smeared across CHANGELOG
entries and seven design docs under `docs/superpowers/specs/`.

Companion: `docs/IMPROVEMENT-BACKLOG.md` (prioritised defects and cleanups).

---

## 1. Shape of the thing

MV3 side-panel extension, plain JS (no TypeScript), CRXJS + Vite 8 + React 19 +
Tailwind 4 + shadcn-style primitives. UI is pt-BR. No backend, no auth. Four
platforms: Facebook, Instagram, TikTok, Pinterest.

Two distinct products share one codebase:

1. **The warmer** — `src/content.js` (~2730 lines): an autonomous
   browse-and-engage session engine for FB/IG/TT. Human-realism simulation
   (bezier cursor paths, dwell curves, breaks, feints, circadian pacing) plus
   safety caps. Driven from `WarmTool.jsx`.
2. **The research suite** — per-platform capture content scripts + sortable
   panel tools + downloads + Whisper transcription + a saved Library.

Five processes:

| Process | Files | Notes |
|---|---|---|
| Side panel (React) | `src/App.jsx`, `Shell.jsx`, `components/tools/*` | normal extension page: has `URL.createObjectURL`, can fetch fbcdn via host perms |
| Service worker | `src/background.js` | message router, badge, `chrome.downloads` (sole caller), fbcdn track registry, offscreen owner |
| Offscreen document | `src/offscreen/*` | Whisper ASR + MiniLM embeddings + ffmpeg mux; released 45 s after last job |
| Content scripts (isolated) | `content.js`, `content/**` | warm engine, bridges, overlays, scrapers |
| Content scripts (MAIN world) | `fb/photos-capture.js`, `ig/main-world.js`, `tt/tt-capture.js` | network/parse tees — impossible from an isolated world |

---

## 2. Capture strategy per platform

The governing rule: **tee what the page already fetched, or read rendered DOM —
never forge a signed request.** Each platform needed a different hook, verified
live:

| Platform | Hook | Why not the others |
|---|---|---|
| Facebook photos | MAIN-world **XHR tee** on `*graphql*` + sweep of `script[type="application/json"]` hydration blobs | grid pages over XHR (17 XHR / 0 fetch measured); first grid page is server-rendered and never requested |
| Facebook video | `chrome.webRequest` on `*.fbcdn.net/*` → DASH track registry | tracks are byte-ranged split streams; `efg` param decodes to `{video_id, xpv_asset_id, duration_s}` |
| Facebook reels/comments | DOM only | FB paginates reels off the main thread — no parse hook can see it |
| Instagram | MAIN-world **`JSON.parse` hook** | IG parses feed/post JSON on the main thread |
| TikTok | MAIN-world **fetch/XHR response-body tee** | TikTok uses native `fetch().json()` — a parse hook caught 0/167 |
| Pinterest | **Active fetch** of `/resource/*` (cookie-auth, unsigned) | the only non-passive platform; board id is not in the DOM |

Passive capture means the panel's data only exists for content the user actually
opened. That precondition is invisible until the empty states (IG reels need a
story opened; TT collections need the playlist opened; etc.).

---

## 3. Message catalog

### Panel → warm engine (`content.js`)
`FBW_START {settings}`, `FBW_TOGGLE_PAUSE`, `FBW_STOP`, `FBW_STATUS` (polled
1 s), `FBW_PAGE_INFO`, `FBW_COLLECT_REEL_THUMBS`.

### Panel → capture content scripts
| Platform | Types |
|---|---|
| FB photos | `FBW_FBPHOTOS_CONTEXT` (5 s), `_STATE` (1 s), `_SCRAPE`, `_STOP`, `_CLEAR` |
| FB reels | `FBW_FB_REELS_LIST` (3 s), `FBW_FB_REELS_HARVEST` |
| IG | `FBW_IG_LIST` (2.5 s), `FBW_IG_REELS`, `FBW_IG_CLEAR` |
| TT | `FBW_TT_LIST` (2.5 s), `FBW_TT_COMMENTS`, `FBW_TT_STORIES`, `FBW_TT_LISTS`, `FBW_TT_CLEAR` |
| Pin | `FBW_PIN_CONTEXT` (5 s), `FBW_PIN_STATE` (1 s), `FBW_PIN_HARVEST`, `FBW_PIN_CLEAR`, `FBW_PIN_RESOLVE` |
| any | `FBW_PING` (liveness) |

`FBW_IG_CLEAR` / `FBW_TT_CLEAR` are **platform-global** — "Atualizar" in any TT
pane wipes the captures of all four TT panes.

### → background (service worker)
`FBW_TRANSCRIBE`, `FBW_DOWNLOAD`, `FBW_DL_MEDIA`, `FBW_DL_JSON`,
`FBW_MATCH_TRACKS`, `FBW_RELEVANCE`, `FBW_REVIVE_TAB`, `FBW_RELOAD_TAB`,
`FBW_OFFSCREEN_IDLE`, and the Library writers `FBW_SAVED_TOGGLE` (→ `{ok, saved}`),
`FBW_SAVED_UPSERT` (insert-or-refresh, never removes — the auto-capture path) and
`FBW_SAVED_REMOVE` (`{id}` or `{ids}`).

Panel code talks to the worker through `src/lib/bg.js` (`sendBg` / `requireOk`),
which reads `chrome.runtime.lastError` and surfaces `.ok` — the per-pane `bg()`
helpers it replaced did neither, so a failed download reported success.

### background → tab
`FBW_PING`, `FBW_TRANSCRIBE_RESULT`, `FBW_DOWNLOAD_RESULT`.

### background → offscreen (all carry `target:"offscreen"`)
`transcribeFromAudioUrl`, `relevanceScore`, `muxDownload`.

### Same-page window events / postMessage
- Relay: `__fbwFbPh` / `__fbwFbPhReq` (FB photos), `__fbwIg` / `__fbwIgReq`,
  `__fbwTt` / `__fbwTtReq`.
- Generation takeover: `__fbwEngineTakeover`, `__fbwTakeover`, `__fbwCmTakeover`,
  `__fbwPhTakeover`, `__fbwIgTakeover`, `__fbwTtTakeover`.
- Cross-script: `__fbw_auto_capture` (warmer → transcription inject),
  `__fbwScrapeComments` / `__fbwScrapeProgress`.

### Removed in 0.65.0 — do not resurrect
`FBW_GET_ACTIVE_VIDEO`, `FBW_CURRENT`, `FBW_DO_TRANSCRIBE`, `FBW_DO_DOWNLOAD`,
`FBW_LIST_TRANSCRIPTS`, `FBW_DEBUG_REGISTRY`, `FBW_TRANSCRIBE_PROGRESS`,
`FBW_DOWNLOAD_PROGRESS`. (`FBW_PAGE_INFO` and `FBW_COLLECT_REEL_THUMBS` are
still handled in `content.js` despite being listed as removed.)

`FBW_RUN_TRANSCRIBE` / `FBW_RUN_DOWNLOAD` are still *listened for* in
`transcription/inject.js` and `ig/bridge.js` but **nothing sends them**.

---

## 4. Storage registry (`chrome.storage.local`)

| Key | Owner (writer) | Shape / cap |
|---|---|---|
| `fbw_session` | warm engine `persist()` | full resumable run state + `savedAt` heartbeat (30 s) |
| `fbw_history` | engine + WarmTool reconciler | last 50 run summaries |
| `fbw_last_summary` | engine + WarmTool | last run recap card |
| `fbw_seen` | engine, 1.5 s debounce | cross-session post-id dedup, 5000 ids |
| `fbw_transcripts` | `background.putTranscript` + inject eager records | cap 20 (thumbs are 10–20 KB) |
| `fbw_saved` | **background only**, via `FBW_SAVED_TOGGLE` / `_UPSERT` / `_REMOVE` | cap 300; writes serialized in one promise chain; shape built by `lib/shared/savedEntry.js` (counts are raw numbers, `schema: 2`) |
| `fbw_comments` / `fbw_comments_live` | `comments-scrape.js` | archive ≤8 posts / single streaming post |
| `fbw_need_reload` | background `tabs.onActivated` | panel stale-tab hint; FB/IG only |
| `swOptions` | WarmTool | persisted subset of warm settings |
| `sw_nav3` / `sw_nav2` | Shell (300 ms debounce) | nav state; v2 is legacy, still read forever |
| `sw_theme` | Shell | light/dark |
| `sw_ig_overlay` / `sw_pin_overlay` | IgSortTool / pin-api | on-page overlay toggles (note the `sw_` vs `fbw_` prefix split) |
| IndexedDB `emb:<djb2>:<len>` | offscreen, idb-keyval | MiniLM embedding cache |

Downloads: one authority, `src/lib/downloadPath.js` →
`~/Downloads/social-mate/{facebook|instagram|tiktok|pinterest}/{videos|fotos|imagens|miniaturas|comentarios|transcricoes}`.
`background.js` is the only `chrome.downloads.download` caller and applies
`underDownloadRoot()` as a last line of defence.

---

## 5. The warm engine

Shared core (state singleton `S`, pacing, safety caps, persistence)
drives per-platform **adapter objects** holding selectors + navigation:
`FB_VIDEO`, `IG_REELS`, `IG_FEED`, `TT_FORYOU`, `TT_SEARCH`. Two loops:
`postsLoop` (FB feed/hashtag) and `videoLoop` (all reel/video adapters).

Modes: **A** keyword/hashtag, **B** feed, **C** reels. Personalities:
`BINGE` / `CASUAL` / `ENGAGED`, each with its own like/follow/engage chances,
watch window, and break cadence.

Safety caps: `MISS_LIMIT 6`, `EMPTY_SCROLL_LIMIT 14`, `MAX_CONSEC_LIKES 8`,
`MAX_CONSEC_FOLLOWS 5`, `MAX_LIKES_PER_AUTHOR 2`, `MAX_LIKES_PER_HOUR 60`,
`MAX_COMMENTS_PER_HOUR 10`, `MAX_COMMENTS_PER_AUTHOR 1`, `SOFT_FAIL_LIMIT 3`,
`SPAM_MIN 0.34`.

A run reports itself through storage only — `fbw_session` (live), `fbw_history`
(last 50), `fbw_last_summary` (recap card), all read by the panel. **Nothing is
written to disk.** The structured per-event telemetry that used to download a JSON
into `social-mate/sessoes/` after every run was removed in 0.68.0; don't
reintroduce a download there.

**The load-bearing invariant:** a run navigates to its target surface
(`start()` → `location.assign`), which *kills the content script*. Everything
that must remain "the same run" has to survive in `persist()` and be restored by
the resume IIFE at the bottom of `content.js`. Add run state without persisting
it and the run silently forks. The safety caps are exactly this failure: they were
restored empty on every navigation until `serializeLedger`/`restoreLedger`
(`lib/sessionMath.js`) made persist and resume one tested contract.

---

## 6. Invariants you will break if you don't know them

**Cross-cutting**
- **Content scripts must stay import-free**, and this is measurable: any ES import
  makes CRXJS emit a `*-loader.js` shim doing
  `await import(chrome.runtime.getURL(...))` instead of a self-contained IIFE.
  Check `dist/manifest.json` — `content.js` and `pin-api.js` get loaders, the
  other nine get bundles. In a MAIN-world script that dynamic import is subject to
  the **page's** CSP, which on FB/IG can kill it and silently disable capture.
- **Shared helpers are inlined at build time, not imported.** The canonical,
  unit-tested source lives in `src/lib/shared/` (import-free by rule; a module
  there may import only a sibling, which the generator strips). Content scripts
  carry a generated region:

  ```js
  // <<< inline:src/lib/shared/counts.js
  ...generated — do not edit...
  // >>> inline:end
  ```

  `npm run gen:inline` writes them; `npm run build` and the test suite run
  `--check` and fail loudly on a stale copy. The panel libs (`fbReels`,
  `fbComments`, `fbPhotos`, `igMedia`, `ttMedia`, `pinMedia`) re-export from
  `shared/` so the panel, the tests, and the pages run the same code. This
  replaced hand-copied "mirror of src/lib/x.js" blocks that had already drifted —
  see `src/lib/shared/README.md`.
- **Generation takeover, not just an init guard.** Extension reload re-injects
  into a fresh isolated world while the old world's timers/observers keep
  running (only its `chrome.*` dies). Every timer-owning content script posts a
  generation announcement and older generations tear themselves down.
- **MAIN world survives extension reloads; isolated worlds don't.** Hence the
  replay protocol (`__fbw*Req`) — the MAIN half buffers everything and re-sends
  when a fresh bridge asks.
- **MV3 SW has no `URL.createObjectURL`.** ZIPs are built in the panel; JSON
  exports go through `jsonDataUrl()` (TextEncoder → chunked base64; bare `btoa`
  corrupts emoji).
- **`<a download="a/b/c.json">` flattens the path** to `a_b_c.json` in the
  Downloads root — every export must use `chrome.downloads`.

**Facebook**
- `stp` is covered by the fbcdn `oh=` HMAC → a URL **cannot** be rewritten up to
  full resolution (403). `GET /photo/?fbid=` returns ~1 MB of HTML with zero
  `scontent` URLs. Full photos only exist in GraphQL `viewer_image.uri`.
- The only non-localized anchor for the active reel card is
  `div[role="slider"][aria-label="Change Position"]`; document-order `<video>`
  queries hit stale cards FB keeps above the viewport.
- **All FB/IG accessible names are localized** — the `L` / `FB_*_WORDS` exact-
  membership dictionaries match the *site* language, not the panel language.
  Never translate them (called out explicitly in CHANGELOG 0.67.0).
- `efg`'s `duration_s` **lies** (preview-cut durations); only the embedded JSON's
  `playable_duration_in_ms` is honest. Duration is only ever a tie-breaker.
- **Feed candidate ids are poison** — a feed post's markup embeds neighbouring
  videos' ids; both ends defend against it (a post already inherited a
  neighbour's transcript once).
- FB remounts feed subtrees every second while a video plays → overlay rails are
  parented on `<html>` and re-bound geometrically mid-job.
- Reaction picker: a slow hover closes it, so chips use `pressRelease` with no
  dwell; a picker miss degrades to plain Like.
- FB decoy text (`Facebook Facebook Facebook…`) must be filtered before feeding
  the relevance embedder.

**Instagram**
- `video.src` is usually `blob:` (MSE) and always in the story viewer —
  downloads must use the captured `video_versions` CDN URL.
- No backdrop blur on the overlay: measured 68 ms → 8 ms per frame after removal.
- Profile Reels-tab payloads omit `username`; it is backfilled from the surface.
- Story item identity is a DOM heuristic: visible `<time datetime>` matched to
  `taken_at` within ±2 s, scoped to the active media's container.

**TikTok**
- `bitrateInfo[0]` is **not** best quality (it's the ~720p default) — score by
  resolution area then bitrate.
- `reply_id === "0"` means top-level, not a real parent.
- Downloads need a Referer — a `declarativeNetRequest` session rule (id `9101`)
  supplies it; `<img referrerPolicy="no-referrer">` is required on thumbs.
- Detail pages never hit `item_list` for the open video → the
  `#__UNIVERSAL_DATA_FOR_REHYDRATION__` SSR fallback is load-bearing.

**Pinterest**
- Two silent-403 rules: `x-pinterest-pws-handler` is mandatory and must match
  the route; GET must **not** carry `x-csrftoken`, POST must.
- `filter_section_pins: false` is the bulk key — Pinterest's own site sends
  `true`, which returned 6 pins from a 6689-pin board.
- ~80 % of video pins are HLS-only; MP4 comes from swapping `/hls/` → `/expMp4/`
  or `/hevcMp4V3/` **keeping the master manifest's real variant filename**
  (signature path-guessing verified 0/12, this approach 3/3).
- `images.orig` vs `images.originals` (Idea-Pin story blocks use the latter);
  rewriting `/236x/` → `/originals/` 403s on extension mismatch.

**Panel layout**
- Tailwind `sm:`/`md:` can never fire — the panel is always <640 px. All
  responsiveness is container queries (`@max-[308px]/toolbar`,
  `@max-[390px]/toolbardense`) and the query strings must stay **literal**.
- `container-type` implies `contain: layout`, which would re-anchor the tools'
  `fixed inset-0` modals — so the container is scoped to rows, never panel-wide.
- 308 / 390 / 338 are *measured* pt-BR label widths at `html{font-size:15px}` in
  Outfit. Changing labels, font or padding silently invalidates them.
- Tooltip carriers must be **siblings** of their control (the button's
  `active:scale` would re-anchor a child).
- `basis-0 grow`, never `flex-1`, on a full-row ActionButton (tailwind-merge
  group collision with the button's built-in `shrink-0`).
- `ResizeObserver`, never `window.resize` — panel-internal layout changes don't
  fire `resize`.
- `min-w-0` is load-bearing around `<input>` (intrinsic ~20-char min width) and
  on Segmented's buttons.

**Build**
- The offscreen document is a **hand-wired extra rollup input** in
  `vite.config.js` — CRXJS can't discover `chrome.offscreen` documents. Deleting
  it breaks transcription and muxing with no build error.
- CSP needs `wasm-unsafe-eval` (onnxruntime + ffmpeg-wasm) and `worker-src 'self'`.
- Workers can't see `chrome.*` — extension URLs travel in a one-time `config`
  postMessage; `useBrowserCache:false` (Cache API rejects `chrome-extension://`),
  `numThreads:1`, `proxy:false` (MV3 CSP forbids nested blob workers).
- Version lives in **two** places (`package.json` + `manifest.config.js`) and
  must be bumped in both.
- A new platform must be registered in **four** places: `NAV_PLATFORMS`
  (`lib/navState.js`), `PLATFORMS`/`PLATFORM_ORDER` (`lib/platforms.jsx`),
  `PLATFORM_HOST` (`lib/tabs.js`), `TOOLS` (`lib/tools.jsx`). Missing
  `NAV_PLATFORMS` makes the platform silently unreachable.
- `PLATFORM_HOST[*].re` must stay in lockstep with the manifest globs — a wider
  regex makes the panel adopt a tab with no content script, and `sendMessage`
  fails silently ("Lendo a página…" forever).

---

## 7. Panel navigation

`Shell` holds one `nav` object `{tab, platform, perPlatform:{platform:{toolId}}}`
under `sw_nav3`. Top-level `tab` picks Library vs Warmer. Inside Warmer,
`platform` is set at load by `detectActivePlatform()` (active tab beats restored
value) and kept live by `useFollowActiveTab` — panel-side, debounced 150 ms,
own-window-filtered, ticket-guarded. `toolIdFor(nav, platform)` recalls that
platform's last tool, validated against `toolsForPlatform(platform)`.

Every `withPlatform`/`withToolId`/`withTab` returns the **same reference** on a
no-op so React bails out — that's what makes tab-event bursts free.

`useContentLink(platform)` is the panel↔content-script link layer: binds a tab,
counts misses (a user-action miss reports immediately, a background-poll miss
needs 3), and renders `ContentLinkBanner` with a one-click repair that calls
`FBW_REVIVE_TAB` (re-inject first, preserving page state; reload as fallback).

---

## 8. Test posture

19 test files, 345 tests, all passing. Coverage is still **libs only** — every
pure module under `src/lib/` except `poll.js` and `utils.js`, plus `background.js`'s
`reviveWith` ladder.

Two of those suites are contract guards rather than unit tests, and they are the
ones that catch the failures this codebase actually had:

- `src/lib/inline.test.js` runs `gen-inline --check`, so a content script carrying
  a stale copy of a `src/lib/shared/` helper fails the suite. That is exactly the
  bug that hid before: the page copy of `parseCount` had 5 locale unit words
  against the lib's 13, and the unit tests stayed green.
- `sessionMath.test.js`'s safety-ledger block asserts persist and resume cover the
  same key set, so the caps can't silently stop surviving navigation again.

Still untested: every content script (the code that actually touches the
platforms), and the near-pure background functions `resolveTracks` (the 5-rung
trust ladder that has already produced cross-video bugs), `parseWebVtt`,
`capSavedStore`, `jsonDataUrl`.
