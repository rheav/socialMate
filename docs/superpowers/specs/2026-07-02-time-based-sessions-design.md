# Time-Based Warm Sessions — Design

**Date:** 2026-07-02
**Status:** awaiting user review
**Scope:** Warm tool only (all three platforms). Inspired by social-flow's session model.

## Goal

Make warm runs time-boxed and behaviorally human: sessions run for a target
duration (not an item count), take personality-driven breaks, watch a
personality-driven percentage of each video, and end with a summary card plus a
reconciled run history that includes runs killed mid-flight.

## Decisions (and what was rejected)

| Decision | Choice | Rejected |
|---|---|---|
| Target model | **Duration primary** (minutes); item count demoted to optional ceiling in Pacing | Count-primary; per-run toggle |
| Breaks | **Personality-driven**, randomized cadence + length, zero new UI | User-configured "break every N min" (fixed cadence = fingerprint) |
| Watch time | **% of video** by personality, clamped; fallback to current dwell range when duration unknown | Absolute-seconds dwell only |
| Like-only passes | **Dropped (YAGNI)** — likes are already probabilistic per item; no like budget exists to spend | social-flow's end-of-session like pass |
| Architecture | **Additive hooks** into existing loops via pure helpers | Phase-machine rewrite (regression risk); background-alarm clock (SW ephemerality) |

## 1. Target model

- `WarmTool`: replace the prominent **Target (N)** input with **Duration (min)**
  (default 15, min 3). Move item count into the Pacing collapsible as
  **Max items (0 = no cap)**, default 0.
- `start()`: `S.willEndAt = now + durationMinutes * 60_000` — now always set
  (the old optional `sessionCapMinutes` becomes this required duration).
- Both run loops switch their condition to a shared
  `shouldContinue(S, now)`: running, `now < willEndAt`, and
  `maxItems ? processed < maxItems : true`.
- ETA display already reads `willEndAt` — no change.
- Outcome when the clock runs out: `complete` (same as N-reached today).

## 2. Personality-driven breaks

Per-personality break profile (tunable constants next to `PERSONALITIES`):

| Personality | Break every | Break length |
|---|---|---|
| Binge Watcher | 12–20 min | 20–60 s |
| Casual Scroller | 5–9 min | 60–180 s |
| Engaged User | 8–14 min | 45–120 s |

- State: `nextBreakAt`, `breakUntil` (both persisted for reload/resume).
- At the top of each loop iteration (between items, never mid-item):
  if `now >= nextBreakAt` → set `breakUntil`, log `☕ break ~90s`, idle-loop
  until `breakUntil` (respecting stop/pause), then schedule the next break.
- Wall-clock semantics: breaks count toward the session duration (humans'
  "30 minutes on Facebook" includes idle moments). If a break would overshoot
  `willEndAt`, skip it and let the session end instead.
- Panel: status badge shows **on break** while `breakUntil > now`.

## 3. Watch-commitment

Per-personality watch fraction:

| Personality | Watches |
|---|---|
| Binge Watcher | 70–100 % of the video |
| Casual Scroller | 15–50 % |
| Engaged User | 40–80 % |

- Where video duration is readable (`fbWatchPost`, reels/video loops on all
  platforms): `dwellMs = clamp(pct × duration × 1000, reelDwellMin, 4 × reelDwellMax)`.
  The upper clamp keeps a 30-minute FB video from eating the session.
- Duration unknown → current behavior (`rand(reelDwellMin, reelDwellMax)`).
- Log line gains the fraction: `▶ watching ~42s (63%)`.
- Existing "remaining time" cap (don't dwell past video end) stays.

## 4. Session lifecycle, summary, history

- **Outcomes:** `complete` | `stopped` | `halt: <reason>` (all existing) +
  **`abandoned`** (new — run died without an end path: browser/tab killed).
- **`fbw_last_summary`** (new storage key): written by every end path
  (`finishRun`, `stop`, `halt`, reconciliation) — `{ outcome, platform, mode,
  keyword, startedAt, endedAt, durationMs, processed, saved, liked, loved,
  followed, skipped, personality }`.
- **Summary card** in `WarmTool`: when idle and `fbw_last_summary` exists,
  render a recap card (outcome badge, runtime, counters) above the controls;
  **Dismiss** clears the key.
- **Abandoned reconciliation** — single reconciler in `WarmTool` on mount
  (works even when the platform tab is gone): if `fbw_session.isRunning` and
  `savedAt` older than 2 min and no live content script confirms a run →
  append `outcome: "abandoned"` to `fbw_history`, write `fbw_last_summary`,
  clear `fbw_session`. The content script's existing resume path already
  handles the fresh-reload case; a `reconciledAt` guard prevents double
  entries.
- **History entries** gain `durationMs`; `LibraryTool` HistoryPanel shows an
  outcome badge + runtime per row (minor UI touch).

## 5. Files touched

| File | Change |
|---|---|
| `src/lib/sessionMath.js` (new) | Pure helpers: `shouldContinue`, `pickBreakSchedule`, `commitmentDwellMs`, `isStaleSession` |
| `src/lib/sessionMath.test.js` (new) | Vitest coverage for the four helpers |
| `src/content.js` | Import helpers; `start()` duration; loop conditions; break hook at iteration top; commitment dwell in watch fns; `fbw_last_summary` writes; personality break/commitment constants |
| `src/components/tools/WarmTool.jsx` | Duration input; Max items → Pacing; summary card; on-break badge; mount-time reconciliation |
| `src/components/tools/LibraryTool.jsx` | Outcome badge + runtime in HistoryPanel |
| `manifest.config.js` + `package.json` | Version bump (minor) + `version_name`; CHANGELOG entry |

## 6. Error handling

- Break/dwell idle loops poll `S.isRunning` / `S.isPaused` every ~400 ms —
  stop/pause stay instantly responsive (same pattern as today's dwell loop).
- Persisted `nextBreakAt` / `breakUntil` in the past on resume → recompute
  forward, never "catch up" on missed breaks.
- Reconciliation is storage-only and wrapped in try/catch — a missing content
  script or closed tab can't throw into the panel.

## 7. Testing

- Unit: `sessionMath.test.js` — boundary cases (clock expiry, cap-0 semantics,
  clamps, stale detection).
- Build: `npm run build` clean.
- Live verification (project practice — selectors are verified live): one FB
  hashtag run and one IG reels run at short duration (3 min) with a
  fast-forwarded break profile; confirm break log lines, %-dwell log lines,
  summary card, and an abandoned entry after killing the tab mid-run.

## Out of scope (noted for later)

- Like-only passes; per-page settings; cloud sync (social-flow features not
  adopted now).
- YouTube adapter (separate feature, item 2 of build order).
