# socialMate — improvement backlog

From a full read of `src/` at v0.67.0. Companion to `docs/ARCHITECTURE.md`.

Tiers: **P0** = wrong behaviour a user will hit or an account-safety hole.
**P1** = silent failure / duplication that will cause the next bug.
**P2** = perf, UX, hygiene.

Items marked ✅ were verified directly against the source in this pass; the rest
come from the subsystem read and are high-confidence but unverified line-by-line.

---

---

## Done in 0.70.0 — the P0/P1 sweep and most of P2

**P0, all closed.** IG records now carry the surface they were CAPTURED on (items
7-8: a replay after Clear relabelled other profiles' posts as the current one, and
`igMedia` stored the raw record where `byId` stored the coalesced one). The Facebook
photos and Pinterest stores both had a null-key guard that skipped the reset, so two
profiles could merge into one ZIP (item 9); the join tables are cleared now too. A
second Pinterest Harvest press silently restarted from page 1 (item 10). Pausing with
no run poisoned the next one (item 11). Items 12-13 dissolved: those handlers had zero
senders, so they were deleted rather than guarded, along with `fbPageInfo`,
`collectReelThumbs`, `run`, `forcePlayOnly` and `ensurePlaying`.

**P1, all closed.** `ensureOffscreen` no longer treats a real failure as "already
exists" (16). The transcription timeout now actually aborts the worker (17) — and
must NOT touch `inFlight`, which would drive it negative and block the idle release
forever. `muxDownload` checks `r.ok`, so an expired signed URL says so instead of
feeding an HTML error page to ffmpeg (18). Worker config failures are no longer
dropped (19). `FBW_DL_JSON` is awaited (20). `storeComments` rethrows (21).
`reels-capture.js` gained the generation takeover it never had, plus a concurrency
guard, a rejection handler and a stop message (22). The video loop feeds the
soft-block detector (23) — a soft-blocked reels session used to keep clicking into
the void for its whole duration. `logHistory` reports every counter (24). `poll.js`
was rewritten and is finally testable and tested (27).

**P2, most of it.** Perf: `detectStop` cached, `persist` debounced, per-store poll
versions (and the panes now actually USE the `{unchanged}` protocol — they never sent
`since`, so it was dead code), `buildDoc`'s O(n²) orphan pass, a node budget on the
reels JSON walk, the FB photos sweep gated on surface, the Pinterest store capped,
the IG story ticker made navigation-driven. Duplication: one `IconBtn` (five copies,
already drifted), one base64 encoder, one TikTok-CDN test, and — the big one — one
`parseCount` where there had been SEVEN, with its separator rule generalised and
pinned by tests. UX: destructive confirms, bulk-download progress and cancel, an
error boundary, dark mode and validation in OptionsDropdown, cross-window theme sync,
a fail-closed window filter, stable virtualizer keys, platform-correct export names.
Locale: the FB counts scraper read nothing on a pt-BR UI. Pinterest: retry with
backoff, and a 403 now says "log in" instead of "HTTP 403". Hygiene: dropped the
redundant `activeTab` permission, marked both stale specs, rewrote the README.

Tests went 324 → 362 across 19 → 21 files.

### Still open

- **Item 43 (partial)** — `ttMedia.parseCount`'s pt-BR bug is fixed, but
  `isCommentArticle` still matches only `/coment|comment/i` while `COMMENT_PREFIX`
  claims de/fr/it support, and recovery errors are pt-BR where transcription errors
  are English.
- **Items 33, 36, 50** — layout thrash from per-tile `getBoundingClientRect`, the
  SW's base64 image buffering (~3× the file in memory), and `FbPhotosTool`'s
  hand-rolled tab binding with no revive banner.
- **Item 41** — the four page overlays still reimplement the same button machinery;
  `ig/bridge.js` keeps its own `erOf`/`dateFromPkOvl`/`sanit`/`igName`, so the IG
  snowflake epoch is still written twice. Each is now one `gen-inline` target entry.
- **Items 44, 47, 49** — `busy` statuses are still permanent, the platform-global
  Clear is still unexplained in the UI, and `FBW_FBPHOTOS_STOP` still lags.
- **Item 59** — still zero coverage on the content scripts themselves. A jsdom
  Vitest project over captured HTML fixtures is the unlock.
- **Item 62** — NOT DONE ON PURPOSE. `social-warmer-v0.33.0.zip` (96 MB),
  `social-slim.zip` and `dist-slim/` are **untracked**, so deleting them is not
  recoverable through git. `fb-mass-downloader/` and `bulk-download-videos-fb/` ARE
  tracked (and the latter is third-party compiled code). Needs a human decision.
- **Items 63, 64** — the four-way name split (socialMate / socialWarmer /
  social-mate / social-warmer) and the 25-version CHANGELOG hole.

## Done in 0.69.0

- **Item 14 — the mirroring problem is structurally solved.** `src/lib/shared/`
  holds the canonical, unit-tested helpers; `scripts/gen-inline.mjs` copies them
  into a marked region of each import-free content script; `npm run build` and the
  test suite run `--check` and fail on a stale copy. Verified empirically that this
  preserves the invariant: any `import` in a content script makes CRXJS emit a
  `*-loader.js` (confirmed in `dist/manifest.json`), and the affected scripts are
  still emitted as plain bundles after the change.
  The three drifted behaviours are fixed in the shipped bundle: the full 13-entry
  locale unit map, the wider `parseReactions` regex, and `cleanAuthorUrl`'s
  slug-deriving catch. `fmtCount` and the photo harvest caps also collapsed to one
  home each.
- **Item 15 — one schema, one writer.** `lib/shared/savedEntry.js` builds every
  `fbw_saved` record (raw numeric counts, `schema: 2`, permalink and profile URL
  derived per platform so no caller can omit them); the background is now the only
  writer, serialized in a promise chain, via `FBW_SAVED_TOGGLE` / `_UPSERT` /
  `_REMOVE`. All ten former writers converted. `TranscriptsPanel` formats counts at
  render time and still tolerates the legacy strings.
- **Both 0.68.0 follow-ups.** `lib/useItemStatus.js` keeps the failure *reason*
  (surfaced in each button's tooltip via `statusTitle`) and namespaces status per
  action, so a failed thumbnail no longer reddens the media-download icon. Adopted
  by all seven panes, which also retires the duplicated `busy`/`setStatus` pair
  from item 40.
- **Item 19 — bookmarks that never filled.** `TtCollectionsTool` and
  `PinBoardTool` had no `fbw_saved` mirror, so the toggle looked like a no-op and a
  second tap silently un-saved. Both now mirror it read-only (the background is
  still the only writer), fill amber when saved, go red with a reason on failure,
  and are disabled in flight.
- Three agent-introduced regressions were caught by the adversarial verify passes
  and fixed before landing: `TtCollectionsTool` and `PinBoardTool` had silently
  started preferring the display name over the @handle (diverging from the page
  overlays writing the same records), and `PinBoardTool`'s save was left
  unconverted with its failure swallowed into `console.warn`. Worth noting for
  future delegation: both verify passes earned their cost — every one of these
  would have shipped silently.

Still open from this cluster: `IgStoriesTool` has neither save-to-library nor
transcribe while its TikTok sibling has both (item 23), and several panes still
report a failed *save* only to the console where they have no affordance for it.

Remaining from item 14: `tt-relay.js`'s `mapItem` vs `tt-capture.js`'s `liteItem`
are still separate (they live in different worlds and only overlap partially), and
`ig/bridge.js` still has its own `erOf`/`fmtDateOvl`/`dateFromPkOvl`/`sanit`/
`igExt`/`igName` — the IG snowflake epoch is still written twice. Those are now
one `gen-inline` target entry each.

## Done in 0.68.0

- **Run-log download removed entirely** (the headline ask). No more
  `Downloads/social-mate/sessoes/run-*.json` after every run: `FBW_WRITE_RUN_LOG`,
  `writeRunLogFile`, the `fbw_run_events` buffer, the whole `emit()`/`runMeta()`/
  `runCounters()`/`flushEvents()`/`flushOrphanRun()`/`loadEventBuffer()` chain, and
  the now-dead `SESSIONS`/`sessoes` path constant. ~300 lines out of `content.js`.
  This also dissolved item 2 below (no log, nothing to lose) and item 26's
  telemetry entries.
- **Item 1 — the safety ledger now survives navigation.** `serializeLedger()` /
  `restoreLedger()` in `lib/sessionMath.js` are the single contract shared by
  `persist()` and the resume path, with 6 round-trip tests including a
  both-directions-cover-the-same-keys drift guard.
- **Item 6 — failed downloads stop reporting success.** New `src/lib/bg.js`
  (`sendBg`/`requireOk`) reads `chrome.runtime.lastError` and surfaces `.ok`;
  all 8 panel panes now route through it, and the three import-free page overlays
  (IG/TT/Pin) check the reply and flash a real error state.
- **Item 3** — `stable = 0` before the comment scraper's phase-3 sweep.
- **Item 4** — the scraper bails when the comment panel never opened.
- **Item 5** — caption-fallback gap: `durationHint`/`primedAt` now count as a
  resolvable audio source, so normal FB feed jobs reach Whisper.
- **Item 13 / parts of 26** — deleted `fbSavePost`, `S.seen`, `requiresTab`, the
  duplicate `commented` key, `FbReelsTool`'s unused `Download` import; `postsLoop`
  now honours `EMPTY_SCROLL_LIMIT` instead of a hardcoded `10`.
- **Item 21 (partial)** — the injected buttons' `err` state existed in CSS but was
  never reachable; a failed comment scrape now goes red instead of spinning forever.

Two follow-ups this work surfaced (both minor, both new to this list):
- The `catch {}` blocks in the panes discard `requireOk`'s message, so the user
  sees a red icon but never the reason.
- In `IgSortTool`/`TtSortTool` the `busy` map is keyed per record, so a failed
  *thumbnail* download paints the adjacent media-download icon red rather than the
  thumbnail button.

---

## P0 — correctness and account safety

1. ✅ **Rate-limit caps reset on every navigation.** `content.js:2932` restores
   counters but `freshState()` wipes `likeTimes`, `authorLikes`, `commentTimes`,
   `authorComments`, `commentedIds`, `consecLikes`, `consecFollows`,
   `softFailStreak`, `capturedIds` — and nothing in the resume block puts them
   back. Mode A starts with a `location.assign`, and `TT_SEARCH.onEnd` does a
   full `location.reload()`, so `MAX_LIKES_PER_HOUR = 60` and
   `MAX_LIKES_PER_AUTHOR = 2` are routinely zeroed mid-run. This is the one
   defect that undermines the extension's whole purpose. (`seenIds` is fine — it
   round-trips through `fbw_seen` at `content.js:1426`.)

2. ✅ **A run log can be lost.** `content.js:387` fires
   `FBW_WRITE_RUN_LOG` fire-and-forget and then removes `fbw_run_events`
   *synchronously*, before the background acknowledges the disk write. Move the
   `remove` into the sendMessage callback, on success only.

3. ✅ **Comment scraper's phase 3 is unreachable.** `comments-scrape.js:377`
   loops on `stable < 3`, but phase 1 (`:352`) exits at `stable === 4` and never
   resets it. The "one more load-more sweep after expanding replies" never runs
   in the normal case. Reset `stable = 0` before the loop.

4. **Comment scraper runs a full ~7-minute harvest on a closed panel.**
   `comments-scrape.js:445` discards `ensureCommentsOpen()`'s boolean, then
   downloads an empty `{count: 0}` JSON. Bail early.

5. ✅ **Transcription's caption fallback has a hole.** `background.js:481`:
   after a caption fetch fails, Whisper is only attempted when
   `meta.mediaUrl || meta.candidates`. A normal FB feed job carries neither
   (candidates are deliberately stripped for feed surfaces) — only
   `durationHint`/`primedAt`, which `resolveTracks` could still resolve. Those
   jobs report the caption error instead of transcribing.

6. **Every download button shows success on failure.** `bg()` resolves
   `r || {ok:false}` and no caller checks `.ok`; only a thrown exception reaches
   the `catch`. Affects `IgSortTool:158,180`, `IgStoriesTool:72,94`,
   `TtSortTool:137,143`, `TtStoriesTool:73`, `TtCollectionsTool:45`,
   `PinBoardTool:127`, `FbReelsTool:108`, plus the page overlays
   (`pin-api.js:389`, `ig/bridge.js:448`, `tt-relay.js:367`). `bg()` also never
   reads `chrome.runtime.lastError`, so Chrome logs "Unchecked runtime.lastError"
   and a dead SW resolves as `{ok:false}` → green icon.

7. **`igMedia` bypasses the coalescing that `byId` gets.** `ig/bridge.js:121`
   stores the merged `prev` in `byId` but the raw `r` in `igMedia[code]/[pk]`. A
   later stats-less payload overwrites a rich record, so `grabMeta` (which reads
   `igMedia`) can lose `video`/`caption`/counts that `byId` still holds.

8. **IG replay after Clear mislabels surfaces.** The MAIN world resends
   *everything ever captured*; `onIgRelay` stamps the *current* `surfaceKey()`
   and backfills missing usernames with the *current* profile
   (`bridge.js:104-112`). After Clear on profile B, profile A's records resurface
   tagged `profile:B` and get attributed to B — defeating `filterBySurface`.

9. **Two profiles' photos can merge into one ZIP.** `photos-scrape.js:296`
   only clears the store when both owner keys resolve; `ownerKeyFromUrl`
   returning `null` on either side skips the reset. `capById`/`capByStem` are
   never cleared at all — not on profile switch, not on `FBW_FBPHOTOS_CLEAR`.

10. **Pinterest "collect again for more" may re-fetch the same 40 pages.**
    A double-press of `FBW_PIN_HARVEST` reads `hitCap`, which the in-flight run
    already reset to `false` (`pin-api.js:134-140`), so the resume cursor is
    dropped and the walk restarts from page 1. Guard the message while
    `harvesting`, or make resume state per-surface.

11. **`FBW_TOGGLE_PAUSE` has no `isRunning` guard.** `content.js:2847`: pausing
    with no run persists `isPaused: true`, which the resume path honours — a
    later run can come back pre-paused.

12. **`FBW_COLLECT_REEL_THUMBS` fights a live run.** `content.js:2885` scrolls
    to page bottom for up to ~60 s with no `S.isRunning` guard.

13. **`fbSavePost` is dead *and* broken.** ✅ `content.js:1342` has no callers,
    and its menu-row regex `/^save (post|video|reel)/i` is English-only —
    contradicting the localized dictionaries used everywhere else. Either wire it
    up with proper locale sets or delete it.

---

## P1 — silent failures and drift

14. **The mirroring problem.** Five content scripts hand-copy helpers from their
    unit-tested lib twins, and the copies have **already drifted**:
    - `comments-scrape.js:31` carries a reduced `UNIT` map (`k, mil, m, mi, b`)
      vs the canonical 13-entry map in `fbReels.js:19`. On an Indonesian/Nordic/
      Polish UI `"1,2 rb"` parses to `null` in the page but works in the lib.
    - `comments-scrape.js:72` `cleanAuthorUrl` returns `{id:null}` where
      `fbComments.js:58` derives a slug id.
    - `comments-scrape.js:296` `buildDoc` and `fbComments.js:84` `buildExport`
      emit **different envelopes** for the same file format — the tested one
      isn't the one that ships.
    - `photos-scrape.js:48-52` re-declares `MAX_PHOTOS 300` / `MAX_SCROLLS 60`
      alongside `HARVEST_CAPS` in `fbPhotos.js:257`.
    - `tt-relay.js:287` `mapItem` vs `tt-capture.js:57` `liteItem` (relay omits
      `music`, `width`/`height`, `author_id`).
    - `bridge.js:287-340` duplicates seven `igMedia.js` helpers, incl. the IG
      snowflake epoch `1314220021721` in two places.

    The CSP constraint forbids *runtime* imports, not build-time inlining. A tiny
    Vite plugin (or codegen step emitting `*-inline.js`) that injects the shared
    pure helpers would delete this whole class of bug. **Highest-leverage
    structural fix in the codebase.**

15. **Seven independent `fbw_saved` read-modify-write toggles**, racy against
    each other, writing **five different record shapes**: `IgSortTool:210`,
    `TtSortTool:170`, `TtStoriesTool:90`, `TtCollectionsTool:49`,
    `PinBoardTool:140`, `FbReelsTool:127`, `TranscriptsPanel:53`, plus
    `ig/bridge.js:463`, `tt-relay.js:346`, `pin-api.js:408`. Divergences: guarded
    vs unguarded `fmtCount(null)`, `counts.views: "—"` (string) vs `null`,
    `sourceUrl` present or absent (absent → VideoCard renders a dead
    `facebook.com/reel/<id>` link), TikTok storing an expiring CDN URL as `thumb`
    where others store base64. Extract one `savedStore.toggle(entry)` with one
    schema — ideally owned by the background, which already enforces the 300 cap.

16. **`ensureOffscreen` treats every failure as "already exists".**
    `background.js:416` sets `offscreenReady = true` in the catch, so a genuine
    create failure leaves every later `callOffscreen` failing with no receiver
    until the SW restarts. Match the "single offscreen document" message or
    re-check `hasDocument()`.

17. **The 3-minute transcription timeout doesn't cancel anything.**
    `background.js:537`: Whisper keeps burning CPU, the late reply is dropped,
    `inFlight` stays > 0 so the idle release is blocked for minutes. Add an abort
    message that terminates and respawns the tx worker.

18. **`muxDownload` never checks `r.ok`.** `offscreen.js:233`: an expired fbcdn
    URL writes an HTML error page into ffmpeg → garbage MP4 or a cryptic ffmpeg
    error instead of "track URL expired". Same class: `resolveHls`
    (`pin-api.js:207`) reports "sem variantes HLS" for a 403.

19. **Worker `config` failures vanish.** `offscreen.js:26,138` post `config`
    with an id that has no pending resolver, so an `{ok:false}` reply is dropped
    and the first real job fails with a confusing pipeline error.

20. **`FBW_DL_JSON`'s try/catch can't catch anything.** `background.js:829`
    doesn't await `chrome.downloads.download`, so a bad filename rejects
    unobserved and the sender still gets `{ok:true}`.

21. **`storeComments` swallows everything.** `comments-scrape.js:435`: a quota
    error during a 2000-comment scrape is indistinguishable from success. The
    failure path then reports `progress("busy", …)` — the button keeps spinning
    on error, and there is no error state in the wire protocol at all.

22. **`reels-capture.js` has no takeover guard, no generation counter, no stop
    message.** Two `FBW_FB_REELS_HARVEST` messages drive two concurrent 112 s
    scroll loops over the same grid; `harvest().then(sendResponse)` has no
    `.catch`, so a throw hangs the port and sticks the panel's `harvesting` flag.

23. **Feature asymmetries with no code reason:**
    - `englishOnly`, `relevanceMin`/`spamGuard`, and `thresholds` only apply in
      `postsLoop` — `videoLoop` (FB reels / IG / TikTok) ignores all of them
      (`content.js:1726,1758,1934`). Either wire them in or hide them for video
      modes. `WarmTool.jsx:298` sends `englishOnly: true` for every platform
      even though the toggle only renders for FB mode A.
    - `TtStoriesTool` can't view a finished transcript — `txMap==="done"` still
      re-runs the whole pipeline (`:167`); its `FBW_TRANSCRIBE` also omits
      `counts` and `sourceUrl` that `TtSortTool` sends.
    - `IgStoriesTool` has no save-to-library and no transcribe while
      `TtStoriesTool` has both.
    - `TtCollectionsTool` and `PinBoardTool` never subscribe to `fbw_saved`, so
      the bookmark never fills and a second tap silently *removes* the item.
    - `videoLoop` never increments `softFailStreak` on a failed reaction, so the
      soft-block detector only exists on the posts path (`content.js:2340`).

24. **`logHistory` under-reports.** `content.js:1438` records
    processed/liked/loved/skipped but not `saved`, `followed`, `commented`,
    `reactionCounts`, so the History tab disagrees with `writeSummary`. The
    abandoned-run entry WarmTool synthesizes (`WarmTool.jsx:185`) has yet another
    shape (omits `saved`/`followed`). Read-modify-write is also non-atomic across
    tabs.

25. ✅ **Duplicate object key.** `commented:` appears twice in the same
    `persist()` literal (`content.js:477` and `:494`). Harmless, but it means
    nothing is linting this file.

26. ✅ **Dead code inventory** (all verified by grep unless noted):
    `content.js:1342` `fbSavePost`; `content.js:197` `S.seen` WeakSet (zero
    references); `tools.jsx:38` `requiresTab` (declared, consumed nowhere);
    `inject.js` `ensurePlaying` + `run`/`forcePlayOnly` +
    `FBW_RUN_TRANSCRIBE`/`FBW_RUN_DOWNLOAD` listeners (no sender exists);
    `inject.js:42` `PLATFORM` ternary (the file-level guard makes it always
    `"facebook"`); `fbPhotos.js` `mergeCaptured`, `dedupeByFbid`, `filenameFor`;
    `fbComments.js` `filenameFor`, `buildExport`; `fbReels.js` `METRIC.date` +
    `fmtDate` (`taken_at` is always `null`); `photos-capture.js:182` fetch tee
    (self-described unused); `platforms.jsx:108` Pinterest
    `keywordPlaceholder`/`defaultMode`/`modes`; `PlatformSwitcher` `disabled`
    prop; `FbReelsTool.jsx:3` unused `Download` import; `offscreen.js:53`
    `fetchAudioPCM`'s `maxSeconds`/`maxBytes` + the worker's `language` branch
    (quick-relevance path was removed); `background.js:818` orphaned comment
    describing a handler that no longer exists.
    ✅ `content.js:91` `EMPTY_SCROLL_LIMIT = 14` is bypassed by a hardcoded
    `> 10` at `:1922` while `:2481` uses the constant — two different empty-feed
    semantics behind one misleadingly-named constant.

27. **`poll.js` hazards** ✅ (read in full):
    - No in-flight guard: an async `fn` slower than `ms` overlaps ticks and races
      responses. WarmTool polls at 1 s into a busy content script.
    - Never fires immediately on start — first data arrives one full interval
      later, which every tool works around with a manual initial call.
    - Line 20's `document?.addEventListener` does **not** guard an undeclared
      identifier; under the `node` Vitest environment this throws
      `ReferenceError`. That's why `poll.js` is the one lib with no test file.

---

## P2 — perf, UX, hygiene

**Perf**
28. `detectStop()` serializes `document.body.innerText` and runs 12 regexes
    **every second** via `tick()` *and* once per loop iteration; `halt(detectStop())`
    evaluates it twice back to back (`content.js:1910, 2474, 2726`). Cache per tick.
29. `persist()` writes the entire session object on **every** `logLine`
    (`content.js:210`), sometimes several times per item, on top of the 30 s
    heartbeat. Debounce like `persistSeen` already does.
30. Every panel poll re-serializes a whole store even when idle: `FBW_IG_LIST`
    (500 records / 2.5 s), `FBW_TT_LIST` (500 / 2.5 s), `FBW_PIN_STATE`
    (thousands / 1 s), `FBW_FBPHOTOS_STATE` (300 / 1 s). `tt-relay.js` already
    has the `{unchanged, version}` short-circuit — but **one** `storeVersion`
    covers four stores, so any video ingest invalidates the comments/stories/
    lists polls too. Per-store counters + a `since` cursor everywhere.
31. Every passive pane `setState`s on every poll even when nothing changed, so a
    fresh array identity re-renders the whole grid. `PinBoardTool.jsx:52` already
    has the snapshot-compare pattern to copy. `sortRecords` also runs on every
    render, unmemoized.
32. `photos-capture.js` sweeps hydration blobs on **every** facebook.com page
    load, photos tab or not; `fbEmbeddedResolve`/`fbEmbeddedMediaFor` re-parse
    every `<script type="application/json">` per job (multi-hundred-KB blobs,
    dozens per click) — memoize per node in a `WeakMap`.
33. Layout thrash: `getBoundingClientRect()` on every `a[href*="fbid="]` per
    1400 ms ingest (`photos-scrape.js:218`); `a.innerText` per reel tile on every
    3 s poll (`reels-capture.js:80`); `renderOverlays` pass 1 scans the whole
    document for `a[href*="/p/"]` on every mutation burst (`bridge.js:517`).
34. `buildDoc` is O(n²) (`ordered.includes` inside a loop,
    `comments-scrape.js:310`) and runs on **every** 1.4 s flush; each flush also
    re-serializes the entire multi-MB envelope.
35. `reels-capture.js:109` walks embedded JSON with a depth cap but **no node
    budget** (unlike `photos-capture.js:56`) — one pathological blob blocks the
    main thread.
36. `FBW_DL_MEDIA`'s image path buffers whole files as base64 strings in the SW
    (`background.js:883`): bytes → binary string → base64 → data URL, ~3× the
    memory. Fetch in the offscreen doc and hand back a blob URL like the mux path.
37. `pin-api.js` `store` is the one uncapped store in the codebase; a 6689-pin
    board plus a long-lived tab holds every record forever.
38. `maintainStoryDl`'s 800 ms interval ticks forever on every IG tab, even
    outside `/stories/` (`bridge.js:720`).
39. `WarmTool.jsx:138` writes `swOptions` on **every keystroke** (duration
    typing, every character of every comment phrase). Debounce ~300 ms.
    `FBW_STATUS` polls at 1 s even when idle and even when the link is down.

**Duplication → shared abstractions**
40. `IconBtn` is defined **four** times and inlined twice more, already diverging
    (`bg-black/55` vs `/65`). `bg()` + `setStatus()` + `busy` map duplicated in
    six panes. The `fbw_transcripts`/`fbw_saved` mirror effect copy-pasted three
    times. The transcript modal (~35 lines of JSX) duplicated twice, already
    diverging. `downloadAll`'s serial-400 ms loop five times. Three different
    blob-revoke strategies for the same export (event-driven + 5-min backstop /
    bare 8 s / bare 10 s).
    `IgSortTool` and `TtSortTool` are ~85 % identical — a parameterized
    `SortGrid` with a platform adapter collapses ~700 lines.
41. Overlay button machinery (SVG set, busy/ok/err state machine, 2.5 s reset,
    two-pass render, dataset sig markers, `position:relative` forcing) is
    reimplemented in `ig/bridge.js`, `tt-relay.js`, `pin-api.js`, and
    `inject.js` — `pin-api.js:279` even says it "mirrors bridge.js's conventions".
    One `overlayButtons` module serves all four.
42. Smaller repeats: chunked base64 encoder twice in `background.js` (`:698`,
    `:884`); the TikTok CDN regex three times (`:471`, `:505`, `:871`) plus a
    diverging DNR domain list at `:38`; `placeRail` vs `repositionOverlayRails`
    write phase; `pickByDuration` vs `pickByWindow` selection loops; the
    board/search pagination loops in `pin-api.js:155` vs `:176` (which carry the
    subtle generation re-check logic that must not drift).

**Localization**
43. Locale bugs in a codebase built for pt-BR users: `fbPageInfo` matches only
    `/\bfollowers\b/` and `/\bfollowing\b/` (`content.js:2693`) so
    followers/following come back `null`; `grabCounts` splits on the literal
    English "Share" and English `comments?`/`shares?` (`inject.js:249,259`);
    `ttMedia.parseCount` mis-parses `"1.234"` (=1234 in pt-BR) as `1.234`;
    `isCommentArticle` matches only `/coment|comment/i` despite
    `COMMENT_PREFIX` claiming de/fr/it support. Recovery errors are pt-BR while
    transcription errors are English, and the panel prints both.

**UX**
44. `busy` statuses are permanent — after done/error the icon stays green/red
    forever with no reset short of a whole-pane refresh (all panes).
45. Bulk "Tudo" buttons are never disabled during a run, show no progress and no
    cancel; double-clicking starts a second interleaved serial loop.
46. Both "limpar tudo" buttons wipe the whole transcripts / saved store in one
    tap with no confirmation and no undo (`TranscriptsPanel.jsx:252,302`).
47. `FBW_TT_CLEAR` / `FBW_IG_CLEAR` being platform-global is not surfaced
    anywhere in the UI.
48. `reels-capture.js:173` hijacks the user's scroll to top when it finishes
    (the photos harvester correctly restores `startY`).
49. `FBW_FBPHOTOS_STOP` leaves `scraping: true` for up to 1.4 s, and a cancelled
    run reports `phase: "idle"` — indistinguishable from "never ran".
50. `FbPhotosTool` hand-rolls its tab binding instead of using
    `useContentLink`, so it has no revive/openTab banner: if the FB tab exists
    but the script isn't injected it shows "Lendo a página…" forever.
51. No error boundary anywhere (`main.jsx:11`) — any throw in a tool Panel
    whitescreens the entire side panel. `Shell.jsx:302` `tools[0].id` also throws
    if a platform ever has zero registry entries.
52. `OptionsDropdown` breaks dark mode (hardcoded `bg-white/95`,
    `text-slate-800`, `border-t-white`), duplicates the shared tooltip system
    with a private portal implementation, has no `aria-expanded`/Escape-to-close,
    attaches its document `mousedown` listener even while closed, and pipes raw
    `e.target.value` strings into pacing/threshold state with no clamping.
53. Theme isn't synced across windows (`sw_theme` read once, no
    `storage.onChanged`); the debounced `sw_nav3` write is lost if the panel
    closes within 300 ms; `sw_nav2` is re-read on every panel open forever
    instead of being removed after migration.
54. `Shell.jsx:232` `ours()` fails **open** — a failed `windows.getCurrent()`
    makes every window's tab events retarget this panel, exactly the bug the
    filter exists to prevent.
55. `FbCommentsTool.jsx:153` `getItemKey` falls back to the array index, so with
    search/filter active keys collide across different comments and poison the
    virtualizer's measurement cache. `h-[calc(100dvh-190px)]` hardcodes the
    shell's chrome height.
56. `TranscriptsPanel.jsx:208` exports every transcript as `fb-<id>.txt/.srt`
    even for IG/TT/Pinterest items, despite `dl()` being platform-aware for the
    folder.
57. No 429/backoff anywhere. Pinterest aborts a 40-page harvest on the first
    non-OK at a fixed 350 ms cadence; the reels-thumbnail harvester fires one
    `FBW_DL_MEDIA` per thumb unthrottled and reports `✓ N miniaturas` regardless.
58. `looksLoggedIn` is just "a `csrftoken` cookie exists", which survives logout
    (`pin-api.js:50`) — map the first 403 to "faça login no Pinterest".

**Testing**
59. Zero coverage on content scripts — the code that actually touches the
    platforms. Cheapest high-value additions, all pure or near-pure:
    `resolveTracks` (5-rung trust ladder, already caused cross-video bugs),
    `parseWebVtt`/`vttTime`, `capSavedStore`, `jsonDataUrl`, `poll.js` (needs the
    `typeof document` fix first). A jsdom Vitest project would let the DOM
    parsers (`extractComment`, `commentRefs`, `scanTiles`, `surfaceKey`) be
    tested against captured HTML fixtures.

**Repo hygiene**
60. `README.md` documents a single-platform, English-UI FB warmer with "no
    commenting (out of scope)" — reality is a four-platform pt-BR research suite
    with transcription, bulk downloads, a Library and a comment scraper. Its
    project-layout tree omits `src/content/`, `src/lib/`,
    `src/components/tools/`, and the offscreen doc. Line 85 is a stray ``` fence.
61. `COMMENT_SCRAPER_SPEC.md` still says "approved, building" — it shipped, and
    its `commentIdFromHref` was superseded by `commentRefs()` and deleted.
    `POCKETBASE_MIGRATION.md` has been "planned, not built" through 30+ releases;
    its §4-5 storage audit is the real asset and is now stale (predates the
    0.65.0 cap rework and the TikTok/Pinterest write paths). Decide: refresh or
    archive. Both live at the repo root while seven siblings live in
    `docs/superpowers/specs/`.
62. `social-warmer-v0.33.0.zip` is **100 MB** of stale June artifact;
    `social-slim.zip` and `dist-slim/` likewise. `fb-mass-downloader/` and
    `bulk-download-videos-fb/` are reference extensions (the latter is someone
    else's compiled code) living inside the main extension's repo, next to a
    README that says "load unpacked → dist/". Move to `../inspirations/`.
63. Naming is split four ways: README says "socialMate", the website design doc
    says "socialWarmer", downloads go to `social-mate/`, the repo dir is
    `social-warmer/fb-warmer`. Pick one before any public release.
64. CHANGELOG has a 25-version hole (nothing between 0.8.2 on 2026-06-07 and
    0.34.0 on 2026-07-02) covering the entire multi-platform + transcription
    build-out, and switches from English to pt-BR at 0.67.0.
65. `manifest.config.js` carries both `webRequest` **and**
    `declarativeNetRequest`, plus `activeTab` alongside full `tabs` and broad
    host permissions. Audit before any Web Store submission — each one is an
    install warning. Also: version duplicated in `package.json`
    (`manifest.config.js` could just import it), and four isolated FB content
    scripts each get their own CRXJS loader injection on every facebook.com
    navigation.
