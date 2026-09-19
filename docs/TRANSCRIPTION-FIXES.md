# Transcription fixes — handoff log (started 2026-09-19)

Resumable log for any agent (Claude, Codex). Read this first, then continue from
the first item not marked DONE. Update the status line of an item the moment it
lands; keep the notes short and factual.

Two repos are involved:

- **Extension**: `~/Code/extensions/social-warmer/fb-warmer` (git). Rules in
  `.cursor/rules/bump-version.mdc`: bump `version` in BOTH `manifest.config.js`
  and `package.json`, set `version_name`, add a pt-BR entry to `CHANGELOG.md`,
  `npm run build`. Shared helpers in `src/lib/shared/` are INLINED into content
  scripts: after editing one run `npm run gen:inline` (build fails otherwise).
  Tests: `npx vitest run`.
- **Hub**: `~/Code/apps/socialmate-hub` (git, autoDeploy on push to GitHub →
  socialmate.rheav.dev). Tests: `npm test`; build: `npm run build`. Do NOT push
  without the user's OK — a push deploys to production.

## Already shipped

- **0.97.1** — transcription default is English (`TX_LANG_DEFAULT = "en"` in
  `src/lib/shared/txLang.js`; `lib/transcriptionLanguage.js` re-exports it).
  One-time migration `applyTranscriptLanguageDefaultOnce()` runs from
  `chrome.runtime.onInstalled` and overwrites the stored pick with "en" once
  (flag key `fbw_transcript_language_default_applied`).

## The fix list (from the 2026-09-19 analysis)

Status: TODO / WIP / DONE. Target extension version for the batch: **0.98.0**.

### Extension — bugs
1. DONE — Orphaned `status:"running"` records (extension reload / browser close
   mid-job) show "transcrevendo…" forever. Fix: sweep on SW boot, mark running
   records older than the job timeout as error "interrompida".
2. DONE — No Whisper job queue: concurrent jobs interleave in one worker, share
   one global progress id, and one timeout's `abortTranscription` kills every
   pending job. Fix: serialize in offscreen, "na fila" state on the card.
3. DONE — Fixed 3-min timeout. Fix: scale by `durationS` when known.
4. DONE — Re-transcribing in another language relabels the OLD text at job
   start (and forever if the job fails); card with old text shows no progress.
5. DONE — Whisper worker has no `onerror`: a crash waits for the full timeout.

### Extension — text quality
6. DONE — Double spaces in every Whisper transcript (26/26 on the hub):
   Whisper chunk text starts with a space and `cleanChunks` joins with " ".
7. DONE — Hallucination filter only looks inside one chunk (>10 words); loops of
   the same sentence across consecutive chunks pass. Drop consecutive repeats.
8. DONE — "Auto" language option: franc-min (already a dependency) on the post
   caption picks EN/PT; falls back to the default.

### Extension — panel display
9. DONE — Timestamped lines always (not only while the video plays in the tab).
10. DONE — "copiar" gives no feedback.
11. DONE — Empty-state copy says "em um vídeo no Facebook" (IG/TT exist too).

### Hub
12. DONE — Transcript record with error/running and no text shows "foi salvo na
    Biblioteca". Show status/error instead.
13. DONE — Language shown raw "(br)/(en)" → PT/EN.
14. DONE — Search matches transcript text but the reader doesn't highlight or
    scroll to the matching line.

## Progress notes

(append below, newest last)
- New pure lib `src/lib/transcriptJobs.js` (+ test): `cleanChunks` (moved out of
  offscreen.js; trims chunks, drops 3rd+ consecutive repeat), `tidyTranscriptText`,
  `txDeadlineMs`/`TX_STALL_MS`, `orphanedTranscriptIds`, `savedTranscriptPatch`,
  `isActiveTxStatus` ("queued"/"running").
- offscreen.js: imports cleanChunks from the lib; worker `onerror`/`onmessageerror`
  settle pending jobs (guarded to the current worker); first progress message of
  a job carries `start: true` (panel resets its forward-only bar on it).
- New `src/lib/captionLanguage.js` (+ test, background-only, franc-min restricted
  to eng/por, near-tie → null → fallback "en"). `TX_LANG_OPTIONS` gained
  `{value:"auto", short:"AUTO"}`; `normTxLang`/`normalizeTranscriptLanguage`
  accept "auto"; `whisperTranscriptLanguage` maps br→pt, everything else→en.
  Menu height constant 126. `npm run gen:inline` done. 777 tests green.
- background.js: `sweepOrphanedTranscripts()` runs at top level (SW boot) over
  fbw_transcripts AND fbw_saved (records active with updatedAt < SW_BOOT_AT →
  error TX_INTERRUPTED_ERROR; saved copy takes the transcript's outcome when it
  finished). `refreshSavedTranscript(id, record)` after every done/error so a
  star pressed mid-job gets the result. Whisper jobs go through `queueWhisper`
  (serialQueue) with `whisperJobs` dedupe; status "queued" while waiting;
  `whisperWithWatchdog` = hard deadline `txDeadlineMs(durationS)` + stall
  timer `TX_STALL_MS` fed by `FBW_TX_PROGRESS` (new case in the SW switch,
  offscreen sender only). `language`/`source` no longer written on "running";
  Whisper done writes `language`, `languageAuto`, clears `text` (empty = no
  speech). Tests added in background.transcripts.test.js.
- Panel: `isTranscribing` (lib/transcriptCardState.js) — active status wins over
  text (re-run), "done" without text is not running; `heardNoSpeech` → "nenhuma
  fala detectada". TranscriptsPanel: progress block above the text ("na fila…" /
  "transcrevendo de novo…"), `TranscriptLines` always shows timestamped lines
  (clickable seek only while the tab plays that video), "copiado ✓", badge
  "EN · auto" for languageAuto, text tidied for view/copy/.txt, empty-state copy
  names IG/TT, useTxProgress resets on `start`. Grid tools (IgSort/TtSort/
  TtStories) map queued→"running" via `txButtonState`; IG/TT modals tidy text.
  FBW_TRANSCRIPT_PUT (FB instant card) drops the pick `language`.
- Extension shipped as **0.98.0** (CHANGELOG entry, version_name, `npm run build`
  ok, 782 tests green). Not committed.
- Hub (`~/Code/apps/socialmate-hub`, uncommitted, NOT pushed — push = deploy):
  server/social.ts stores `error` (≤500) and `languageAuto` (true|null); twin
  borrow prefers the transcript's `language` and carries `languageAuto`.
  dashboard/transcript.ts: `fmtLanguage` (EN/PT/"EN · auto"), `tidyText`,
  `highlightParts`, `noTextMessage`. RecordSheet: `query` prop (App passes the
  literal search, "" when semantic), <mark> highlights + scroll to first mark,
  tidied text for view/copy/.txt, status-aware empty message. 89 tests green.
  GOTCHA: run hub tests with `PATH=/opt/homebrew/bin:$PATH` (Node 26) —
  better-sqlite3 is built for ABI 147 and nvm's default Node 20 fails 63 tests.

## Remaining (not code)

- Reload the unpacked extension in Edge (`edge://extensions`) to get 0.98.0.
- Hub: commit + push to deploy (ask the user first).
- No live UI check was done (panel/overlay/hub); only unit tests + builds.
