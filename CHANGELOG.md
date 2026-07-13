# Changelog

All notable changes to socialMate.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — breaking engine reworks / storage-session schema breaks.
- **MINOR** — new features (platforms, modes, UI surfaces, adapters).
- **PATCH** — bug fixes, selector tweaks, copy/pacing-default updates.

Bump `version` in BOTH `manifest.config.js` and `package.json` on every code change
(keep them in sync — enforced by `.cursor/rules/bump-version.mdc`), set `version_name`,
then `npm run build` so `dist/manifest.json` reflects it.

> History before `0.5.1` is reconstructed from `README.md` / `HANDOFF.md`; dates are
> approximate. Entries from `0.5.1` on are taken from the handoff log.

---

## [0.51.0] — 2026-07-13

### Added — run telemetry
- **Every run is now recorded as structured events** and written to disk on
  finish: `~/Downloads/socialmate-runs/run-<timestamp>-<outcome>.json`. One file
  holds the run config (personality, mood, caps, pacing), the final counters, the
  human log, and the full event stream: `item`, `dwell` (planned vs actual ms,
  video length, watch fraction, watchedFull), `react` (**want vs got** — so a
  picker miss is visible), `no_react`, `feint`, `comment`, `comment_skip` (with
  the gate that declined), `skip`, `idle`, `break`, `pause`/`resume`, `halt`.
- The in-flight run is mirrored to `chrome.storage.local`, so a tab closed
  mid-run isn't lost — the next run flushes it as an `abandoned` file.

### Fixed
- **Comments were silently failing.** `fbCommentReel` had four distinct failure
  exits that all returned a bare `false`, so the log only ever said "did not
  post" — you couldn't tell whether the composer never opened, the send button
  wasn't found, or it actually posted and we misread it. It now reports *which*
  step failed, and the run log records it.
- Comment submit falls back to **Enter** (how a person actually sends a reel
  comment) when the send button can't be matched — its accessible name is
  localised, so a fixed aria-label list was always going to be partial. Also
  raised the composer wait 3.5s → 6s (the rail loads the drawer lazily).
- Breaks now show the **live seconds counter** like dwell and idle, instead of a
  static `☕ break ~166s`.

## [0.50.0] — 2026-07-13

### Added — human realism pass
- **Per-session mood.** Each run rolls its own engagement intensity (0.60–1.35×)
  and ~1 in 6 runs is **browse-only** (0.15–0.25×) — a session that mostly just
  scrolls. Stops every session having the same like-rate. Logged at start
  (`mood 0.87` / `👀browse-only`).
- **Engagement ramp / taper curve.** Reaction & engage probabilities follow a
  half-sine over the session — low at the start, peak mid-run, taper toward the
  end (people warm up then wind down) — instead of a flat rate.
- **Idle gaps.** ~4.5% of the time between items, a `💤 idle` pause of 18–85s
  ("got distracted / phone rang"), shown as a live countdown. Skipped if the
  session would end during it.
- **Hover-and-bail feints.** When the dice say *don't* react, ~9% of the time it
  travels to the like control, hovers a beat, then drifts away without clicking
  (`· hovered, didn't react`) — a person who looked but didn't engage.
- **Curved cursor travel.** Hovers now move the synthetic cursor along an eased
  bezier arc (jitter + occasional overshoot-correct) from its last position,
  instead of teleporting straight to the target. Movement events go to
  `document` so the in-flight path can't trip intermediate hover handlers.

> Note: our synthetic events are still `isTrusted: false`. This pass hardens
> against *behavioral* heuristics (rate/regularity/precision), not the trust
> flag — the biggest real risks remain account-level (IP, fingerprint, age, rate).

## [0.49.0] — 2026-07-13

### Fixed
- **Reactions actually go through now (was only ever Liking).** The engine
  opened the picker but then ran the *slow* `humanClick` on the reaction chip —
  a 0.5–1.1s hover before the click — which let FB's picker close/deselect, so
  the click committed a plain Like (and the degrade-to-Like fallback hid it).
  `humanHover` now also fires `pointerenter`/`mouseenter` (highlights the chip),
  and reactions use a **fast** chip click (brief hover, immediate press) that
  keeps the picker alive. [VERIFIED live: Haha → "Alterar reação Haha" applied.]

### Added
- **Live dwell counter in the log.** The watch line now counts up in place
  (`👀 dwell (full) 3s / 7s`) while the reel/post plays — the panel polls the
  log every second, so a single entry animates — and flips to `✅ dwell 7s` when
  done, so you can see how long each item takes and how long is left.

## [0.48.0] — 2026-07-12

### Changed (performance / memory)
- Added the `unlimitedStorage` permission and shrank the stored thumbnail
  (90px / q0.45) — the thumb was ~78% of each transcript record, which could hit
  the 10 MB quota and silently drop new transcripts.
- `trackRegistry` (background fbcdn track capture) is now pruned to the 300
  most-recent entries; it grew unbounded for the whole warm session.
- `fbPickPost` gates on cheap checks first and only hashes the one in-view
  candidate, instead of enumerating + hashing every accumulated feed child.

## [0.47.0] — 2026-07-12

### Added
- **Comment on fully-watched reels (first version).** A new "💬 Comment on reels"
  card (FB · Reels) lets the warmer rarely post one of your phrases — but only on
  a reel it watched to the end, and heavily capped. The composer flow is
  [VERIFIED live]: click the reel's "Comentar" button → inline Lexical editor →
  type the phrase char-by-char (`execCommand('insertText')`, emoji included, e.g.
  "So true 💫") → click "Postar comentário" → success = the editor clears →
  collapse the composer and continue the reel flow.
  - **Editable phrase pool** (mirrors the ugc-factory headlines UX): seed set of
    mystic/astro one-liners with emoji, each row editable, a trash button, and an
    "Add" input (Enter or +) that appends a new line. Persists in `swOptions`.
    The whole list is the random pool (never repeats back-to-back).
  - **How-often** slider (2–30% of full watches; default 8%) + "only fully-watched"
    is on by design for this version.
  - **Safety**: ≤10 comments/hour (hard), ≤1 per creator/session, never
    back-to-back, warm-up skip, once-per-reel dedup, and a soft-block halt if a
    post doesn't clear the editor. Counter shows 💬 in the running view.

## [0.46.0] — 2026-07-12

### Added
- **Pick any of Facebook's 7 reactions, not just Like.** The warmer can now send
  Like · Love · Care · Haha · Wow · Sad · Angry, chosen as a weighted mix (Like
  dominant, the rest sprinkled in) from the ones you enable in a new "Reactions"
  chip row (FB, when Like is on). It hovers the like control to open FB's
  reaction picker and clicks the chip — [VERIFIED live] that a content-script
  (synthetic) hover+click actually applies the reaction on a reel
  (Like→"Alterar reação Uau"/"…Força"). Wired into both the reels loop and the
  hashtag-posts loop; a per-reaction breakdown shows in the running counters.
  If the picker ever misses, it degrades to a plain Like (never a false
  soft-block). Localized picker names (pt-br verified: Curtir/Amei/Força/Haha/
  Uau/Triste/Grr).

### Fixed
- **Per-item dwell capped at 30s.** The reels rail mixes long-form video (60s+),
  and watch-full sat through the whole thing — 60–100s on one item. Watch-full
  now only applies to genuinely short reels (≤40s) and every dwell (reels and
  posts) is hard-capped at 30s, so the warmer keeps moving.

## [0.45.0] — 2026-07-12

### Changed
- **Tabs now flow the accent gradient like liquid.** Both the Warmer/Library
  segmented control and the Library sub-tabs (Transcripts/Saved) use a single
  accent-gradient indicator that is JS-positioned over the active tab and
  transitions its `left`/`width` (`cubic-bezier(0.25,0.8,0.25,1)`, 300ms), so
  switching tabs slides the brand color smoothly left/right instead of snapping.
  The gradient is themed (Smart blue in light, Brute red→yellow in dark) with
  black/white text per the contrast rule. Modeled on the unFunnelizer website's
  `.nav-highlight`. Repositions on resize; no animation flash on mount.

### Fixed
- **Toggle switches no longer show a white edge.** The `border-2 border-transparent`
  seamed against the accent gradient and the thumb was `bg-background` (a dark
  blob in dark mode). Now the gradient fills the whole pill (no border), the
  thumb is a clean white circle (design-doc §10.7), and the stray UA focus
  outline is removed (accessible `focus-visible` ring kept).

## [0.44.0] — 2026-07-12

### Added
- **Transcripts store the source reel URL.** Each capture now records a clean
  permalink (`/reel/<id>` or `/watch/?v=<id>`) for the video, and the Library
  card's thumbnail links back to it (plus a small ↗ button) so you can reopen
  the reel to re-transcribe or re-download. Old records fall back to a URL
  reconstructed from the id.

## [0.43.0] — 2026-07-12

### Changed
- **Dark theme now uses the Brute red→yellow accent** (`#ff4d4d`→`#f9cb28`),
  matching the unFunnelizer model (light = Smart blue, dark = Brute). Wordmark,
  primary button, tab underline, and transcript links all follow the accent;
  text on the Brute gradient is black per the contrast rule. Tokenized the last
  hardcoded blues (TabNav divider, transcript export links, Start button text)
  so they theme correctly.

### Added
- **Transcript card appears instantly on click.** The content script now writes
  a "running" record (thumbnail + author + caption already in hand) the moment
  you hit Transcribe, so the reel shows up in the Library → Transcripts list
  immediately instead of only after the job resolves. Transcription prefers the
  embedded audio-only stream (deterministic id, so the eager card matches the
  final one) and no longer waits on video priming.

## [0.42.0] — 2026-07-12

### Added
- **Embedded progressive_url fallback — Download/Transcribe now work on cached
  videos.** FB embeds each delivered video's direct progressive MP4 URL
  (audio+video, single file) under `videoDeliveryLegacyFields` in
  `<script type="application/json">` blocks. The content script reads it on
  demand (`fbProgressiveUrlFor`) by walking that JSON and matching the target
  video's id via its nearest ancestor id, so a Download/Transcribe no longer
  depends on having seen the video's fbcdn tracks on the wire (the old failure
  mode when a reel was served from cache). Runs only on click/capture, and only
  JSON.parses the few scripts that mention both an id and a url — no per-frame
  cost. Verified live: a reel downloads as `fb-<id>.mp4` and transcribes with no
  fresh network capture.
  - **Download** uses the progressive URL (single file, no offscreen mux).
  - **Transcribe** prefers a captured audio-only DASH track; when none exists it
    uses the **audio-only representation `base_url`** from the same embedded JSON
    (small, ~13s) — never the full progressive video, which decoded too slowly
    and timed out. Verified: a reel that was never played transcribes in ~13s.

## [0.41.0] — 2026-07-12

### Changed
- **Unified azure design + light/dark themes.** Dropped per-social-network
  retinting — one brand (Smart azure → seaFoam) across the whole panel, matching
  the unFunnelizer design system. shadcn tokens remapped, so every component
  re-skins at once; primary actions are now the Smart-blue gradient. A header
  sun/moon toggle switches light/dark (defaults to the OS preference, persisted).
- **On-page buttons only on reel + video-post pages.** Removed the per-post
  Download/Transcribe rail from the home/profile **feed** — there you open the
  reel to grab it. Reel and video-permalink pages keep the rail; the reels-tab
  thumbnail button is unaffected.
- **Library opens on Transcripts** (was Saved) and the **History tab was
  removed** — Library is now Transcripts + Saved.

### Performance (code review pass)
- **Removed the per-second canvas readback.** The transcription content script
  was scraping + JPEG-encoding the in-view `<video>` (`grabThumb` → canvas
  `toDataURL`) every second and on every scroll frame to publish `fbw_current` —
  which no longer has any consumer since the panel's Current-video card was
  removed. Deleted the interval, its scroll/resize/visibility listeners, and the
  publish path. Metadata/thumbnail is now scraped only on demand (button click /
  auto-capture). Big CPU/GC saving on every FB tab with a video.
- **Blob URLs from transcript exports (.txt/.srt) are now revoked** after the
  download hands off, instead of leaking for the panel's lifetime.
- **No theme flash** — the OS light/dark preference is applied before first
  paint (in `main.jsx`), and the reel rail-cleanup now runs after the
  MutationObserver is disconnected to avoid extra decorate passes.

## [0.40.0] — 2026-07-12

### Changed
- **Two-tab shell — Warmer · Library.** The panel is now two top-level tabs.
  **Warmer** → pick a platform → that platform's workspace; a platform's tools
  show as a segmented sub-nav inside the workspace, which is where the Instagram
  **Sort + Download** and **Stories** tools now live (alongside Warm). **Library**
  → Saved / Transcripts / History. Opens on the active tab's platform.
- **Library is a 2-column grid** of big thumbnail cards — portrait preview,
  counts strip over the image, author, caption, inline transcript toggle, and
  copy/.txt/.srt export. Replaces the old cramped horizontal rows. The panel-side
  "Current video" card was removed (on-page buttons do capture now).
- **Reel action buttons moved to the right side** of the reel (they were over
  FB's mute control at top-left); feed videos keep the top-left rail.

### Fixed
- **Author no longer "unknown" on followed reels.** The name is read off the
  follow control, which reads "Seguindo/Following <name>" once you follow the
  page (not just "Seguir/Follow <name>"); a generic "View owner's profile" link
  now falls back to its visible text ("Laura Shift") instead of being skipped.
  (Existing transcripts keep their stored author; the fix applies to new ones.)
- **Feed Download/Transcribe reliability.** Buttons now *prime* the target video
  — centre it, play it, and wait until it is actually streaming — before sending
  the job, so a feed video FB had paused/unloaded gets its fbcdn tracks fetched
  (and captured) instead of resolving nothing. Failures show ✗ with a retry hint.

## [0.39.1] — 2026-07-12

### Fixed
- **Reel buttons no longer pause the video** — the click handler used to pause
  every other `<video>` and play the rail's bound node; on a reel (several video
  elements, FB swaps them) that paused the reel you were watching. Now it never
  pauses neighbours, only plays a paused target, and swallows the whole pointer
  sequence (pointerdown/mouseup too) so FB's tap-to-pause never fires.
- **Reel jobs target the active reel** — Download/Transcribe on a reel now
  resolve the currently-visible reel at click time instead of the (possibly
  stale/preloaded) node captured when the rail was built, so the transcript/
  download matches what's on screen. Reel pages now get exactly one rail.
- Longer per-video wait (2.2s) before the job so the media has a beat to
  (re)fetch its fbcdn tracks. (Known limit: a fully-cached video exposes no new
  fbcdn request to capture — let it stream once, then retry; the button shows ✗.)

### Added
- **Reel-thumbnail download restored** — the old profile-thumbnails feature is
  back as a single floating “Download reel thumbnails” button that appears only
  on a profile’s Reels tab (auto-scrolls the lazy grid, saves to
  Downloads/socialMate-thumbs/&lt;page&gt;/). Keeps the side panel clean
  (Warm + Library) — all download/transcribe actions are now on-page and
  contextual.

## [0.39.0] — 2026-07-12

### Added
- **On-page Download / Transcribe buttons** — a small action rail is injected
  directly onto each Facebook video (feed, reel page, video-post page): Download
  + Transcribe; standalone photo posts get Download. Buttons act on the SPECIFIC
  media they belong to (play-in-place → capture tracks → job), and flip to ✓/✗
  when the background reports the result. Built the IG-overlay way for memory
  safety: one injected `<style>`, one debounced MutationObserver disconnected
  while appending (never self-triggers), dataset dedup, size + near-viewport
  gating so decoration stays bounded on long feeds. No React-internals hooking.
- **Facebook photo download** — largest fbcdn/scontent image in a post →
  `FBW_DL_MEDIA` (background fetch → data URL → downloads).

### Fixed
- **Reel-surface metadata scrape** — `grabVideoId` now reads the `/reel/<id>` ·
  `/videos/<id>` · `/watch?v=` id straight off the URL (reel pages hang no
  permalink near the player, so the id was null and jobs relied entirely on the
  fbcdn-track fallback). `grabAuthor` reads the creator off the “Seguir/Follow
  <name>” button and skips the generic “Ver perfil do dono / View owner’s
  profile” link that was mislabelling the card. Reel metadata now anchors to the
  “Change Position” slider card instead of the generic ancestor climb (which the
  multi-`<video>` guard broke early on reel pages).

### Changed
- **Facebook side panel simplified** — Facebook is now a single-tool surface
  (Warm); the panel opens straight into the Warmer, and per-video
  Download/Transcribe live as on-page buttons with results in the global Library
  (Transcripts / Saved). The old profile-thumbnail “Download” tool was removed
  from the FB hub. Single-tool platforms skip the hub grid and back-navigates
  Home.

## [0.38.0] — 2026-07-11

### Removed
- **Deep relevance (Whisper-for-relevance) removed end-to-end** — the engine
  flag/state, the quick-transcript request path (`FBW_QUICK_TRANSCRIBE`), the
  offscreen `quickTranscribe` action + cache, and the post-side helpers
  (`fbVideoIdCandidates`, `whisperLangFor`, `WHISPER_LANG`). Full transcription
  (Transcripts tab / auto-capture) is untouched.

### Fixed
- **Pagination-aware empty-scroll counter** — hashtag/feed children only ever
  grow (~8/batch) and hydrate lazily near the viewport; a growing child count
  during an empty stretch now resets the empty-scroll counter (progress, not
  selector loss), so slow pagination can't accrue misses toward a false
  "selectors not found" halt.
- **Fresh-node re-queries in the posts loop** — `fbPostStats` and the
  already-reacted check re-query the like control from the post root instead
  of trusting the enumerated node; FB's windowed hydration swaps a post's
  inner nodes when it leaves/re-enters the viewport window.

## [0.37.1] — 2026-07-11

### Fixed
- **Start silently doing nothing after an extension reload** — reloading the
  extension orphans the content script in every open FB/IG/TT tab
  ("Receiving end does not exist"), and the panel swallowed the send failure.
  Two-sided fix: the background now re-injects all manifest content scripts
  into matching open tabs on `onInstalled` (new `scripting` permission; every
  content script already carries an init guard, so double-injection is a
  no-op), and the panel shows a "tab isn't responding — Reload tab" banner
  (with button) after 3 failed status polls, disabling Start meanwhile.

## [0.37.0] — 2026-07-11

### Fixed
- **Sponsored detection localized** — `fbIsSponsored` matched only the literal
  "Sponsored", so on non-English accounts the hashtag warmer would engage with
  ads. Now a case-insensitive set (en/pt-br/es/fr/it/de: "Patrocinado" …).

### Changed
- **Hashtag UI simplified to match Reels** — the AI card (niche-relevance
  slider, spam-guard switch, deep-relevance/Whisper toggle) is gone. Spam/scam
  guard stays ON via the engine default (no UI); the relevance gate is off (a
  hashtag feed is already on-niche); deep relevance dropped. English-only now
  shows only in Hashtag mode (the filter never ran in the reels loop).
- **Hashtag postKey stays author+caption hash** — hashtag-surface posts expose
  no permalink; the 15–19-digit ids in post HTML include per-render tracking
  tokens, so promoting them to the dedup key would break cross-session dedup.

## [0.36.0] — 2026-07-11

### Added
- **⚡ Quick mode** — panel switch (persisted in `swOptions`): 3–10s dwell per
  item and 1–2.5s action gaps, overriding watch-full/fraction dwell and the
  circadian pacing multiplier. Applies to the video loop (`reelDwell`) and the
  FB posts loop (`fbWatchPost`) on every platform. For fast test iterations —
  not for real warming sessions. Run-start log line gets an `⚡quick` marker;
  the flag survives navigation resume.

## [0.35.0] — 2026-07-11

### Added
- **Facebook Reels mode (C) restored** — panel shows Reels + Hashtag tabs for FB
  (Reels is the default). Simple flow: watch the reel to the end, advance via the
  next-card button, Like randomly by personality. Like-only (Save/Follow forced
  off for FB runs even though the engine adapter supports them).
- **Watch-full dwell** — `FB_VIDEO.watchFull`: dwell = the video's remaining
  runtime (+0.4–1.2s), for items ≤ 5 min; longer long-form items mixed into the
  reels rail fall back to the personality fraction dwell.

### Fixed
- **FB reels selectors localized** — the reels adapter was hardcoded to English
  aria-labels ("Like"/"Remove Like"/"Next Card"/"Save reel"/`/^follow/`) and dead
  on non-English accounts. Now uses the same localized exact-membership sets as
  the posts adapter (en/pt-br/es/fr/it), plus `FB_NEXT_CARD` ("Próximo cartão" …)
  and `descurtir`/`unlike` in the unlike set. Verified live on a pt-br account:
  active-card anchor (`Change Position` slider — unlocalized), advance soft-nav,
  menu → "Salvar reel".
- **Stale-card video reads** — `reelDwell` now reads the active container's
  `<video>` (FB keeps previous reel cards in the DOM above the viewport, so
  document-order queries hit the old card); generic video-loop Like now uses the
  synthetic pointer trail (`humanClick`) instead of a bare `.click()`.

## [0.34.0] — 2026-07-02

### Added
- **Time-based sessions** — Duration (min) is now the primary target (default 15,
  min 3); item count demoted to an optional "Max items" ceiling in Pacing.
- **Personality-driven breaks** — the engine idles between items on a randomized
  cadence per personality (Binge 12–20m/20–60s, Casual 5–9m/1–3m, Engaged
  8–14m/45–120s); panel shows an "on break" chip.
- **Watch-commitment** — dwell is a personality-driven fraction of each video's
  length (Binge 70–100%, Casual 15–50%, Engaged 40–80%), clamped to
  [reelDwellMin, 4×reelDwellMax]; falls back to the old dwell range when no
  duration is readable.
- **Session lifecycle + summary** — new `abandoned` outcome reconciled on panel
  mount from stale `fbw_session`; every end path writes `fbw_last_summary`;
  WarmTool shows a dismissible last-session recap card; history rows show
  outcome badge + runtime.
- `src/lib/sessionMath.js` — pure, vitest-covered session helpers.

### Changed
- **Renamed** the extension `socialWarmer` → **socialMate** (display name, wordmark,
  and the `socialMate-thumbs/` download folder). Internal storage keys unchanged.
- `FBW_START` settings: `durationMinutes` + `maxItems` replace `targetN` +
  `sessionCapMinutes`.

---

## [0.8.2] — 2026-06-07

### Fixed
- Side panel no longer leaves a **white gap on the right** when the panel is wider than
  360px. `body` was locked to `width: 360px`, so the themed background wash (`--sw-wash`)
  only painted 360px and the rest of a resized panel showed bare white. Body now fills the
  panel (`width: 100%`, `min-width: 320px` — Chrome's side-panel floor) and content reflows
  to the available width.

---

## [0.8.1] — 2026-06-04

Mature multi-platform baseline (feature set as of this version; precise per-patch
boundaries for `0.6.x`–`0.8.x` not separately logged).

### Added
- **Detach to own window** — pop the bound platform tab into its own (unfocused) window so
  it keeps `visibilityState === "visible"` and Chrome won't throttle its timers; the run
  keeps scrolling while you work in other tabs.
- **Pacing controls** (collapsible) — action delay min/max, reel dwell min/max, and an
  optional session time cap (minutes, 0 = none).
- **Personality** select (Random / Binge / Casual / Engaged) driving Like/Follow
  probability and dwell.
- **English-only posts** filter for Facebook Feed/Keyword modes.
- Live counters (done / saved / liked / followed), timestamped log, ETA, and a status
  badge (idle / running / paused / halted) with an auto-halt banner on login wall /
  checkpoint / captcha / rate-limit / selector-loss.

### Changed
- Tab stays **locked to the bound tab by id** — switching browser tabs no longer drops the
  target; only a closed tab or a platform switch re-resolves it.

---

## [0.5.6] — 2026-06-04

### Changed
- **Standardized UI** — one white/black control surface for all three platforms. Only the
  brand identity changes per platform (logo gradient, wordmark color, glow, body wash);
  the rest of the chrome is neutral black/white.

---

## [0.5.5] — 2026-06-04

### Added
- **TikTok verified (logged in).** Favorite verified — count increments on click (TikTok
  keeps the "Adicionar aos favoritos" label and only bumps the count, so a click is treated
  as success). Follow verified via a synthetic content-script click (icon morphs `+` ↔ `✓`).
  Feed hooks `like-icon` / `favorite-icon` / `feed-follow`; detail view `browse-*`. TikTok
  selectors are language-independent (`data-e2e`).

---

## [0.5.4] — 2026-06-04

### Added
- **Instagram verified (logged in, pt-br).** Save verified live (`Salvar` → `Remover`,
  persists in `/saved`); Follow selector mapped (`Seguir` `div[role=button]`); Like / advance
  / resume made locale-aware.

### Fixed
- **Locale-dependent selectors.** Added a multi-locale `L` dictionary (en + pt + es/fr/it
  seeds) plus `nameOf` / `inSet` / `findByName` helpers in `content.js`; the IG adapter now
  matches via `L`. (FB adapters remain English-only — extend with `L` for non-EN FB
  accounts.)

---

## [0.5.2] — 2026-06-03

### Added
- Native **per-platform UI** — platform-specific theming applied via the `--sw-*` CSS-var
  bundle on `<html>` (later standardized in `0.5.6`).

---

## [0.5.1] — 2026-06-03

### Added
- **Multi-platform support** — Facebook, Instagram, and TikTok behind a **platform
  switcher** (`PlatformSwitcher.jsx`): three brand-logo buttons; the active logo fills the
  platform gradient and glows; disabled while a run is active.
- **Per-platform config** (`src/lib/platforms.jsx`) — brand SVG glyphs, supported `modes`
  (+ tab labels), `defaultMode`, `keywordPlaceholder`, and a `theme` CSS-var bundle.
- **Per-platform theming** — one swap retints logo / title / Start / badge / scrollbars /
  glow / body wash + shadcn `--primary` / `--ring`.

### Changed
- **Engine refactored to adapters** (`src/content.js`) — shared core (state / pacing /
  safety / counters / persistence / resume) + per-platform adapters. `platformForHost()`
  is the selector source of truth; one generic `videoLoop(adapter)` drives FB reels /
  IG reels+explore / TikTok For-You+search; FB keeps `postsLoop` for Feed/Keyword.
- Added safety patterns: consecutive like/follow caps + cooldown, resume-if-paused,
  end-of-results reload (TikTok search). Session key `fbw_session` gains a `platform`
  field; resume guards by host ↔ platform. Panel message names kept `FBW_*`.
- Manifest `host_permissions` + `content_scripts` extended to `*.facebook.com`,
  `*.instagram.com`, `*.tiktok.com` (one content script on all three).

---

## [0.1.0] — 2026-06-03

Initial **Facebook-only** build (MV3, CRXJS + React + Tailwind + shadcn-style components).

### Added
- Side-panel cockpit; vanilla content-script engine driving facebook.com via ARIA roles +
  accessible names (obfuscated FB classes never used).
- **Modes** — Reels (C), Feed (B), Keyword/#hashtag (A).
- **Actions** — Save (reels + posts), Like, Follow; English-only post filter.
- Human-started runs with randomized pacing (4–9s action, 6–15s reel dwell), per-run
  de-dup, N as a ceiling, and auto-halt on stop conditions.
- `background.js` opens the side panel on toolbar click. No backend, no auth — local only.
