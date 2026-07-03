# Time-Based Warm Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warm runs become time-boxed (duration primary, item count optional ceiling) with personality-driven breaks, %-of-video watch commitment, an `abandoned` lifecycle outcome, and an end-of-run summary card.

**Architecture:** Additive hooks into the existing verified run loops in `src/content.js`. Pure session math lives in a new `src/lib/sessionMath.js` (imported by both the content script and the panel — CRXJS bundles content-script imports). UI changes confined to `WarmTool.jsx` (duration input, summary card, reconciliation) and `LibraryTool.jsx` (history row polish).

**Tech Stack:** Vanilla JS content script (IIFE, ES imports OK), React + shadcn side panel, chrome.storage.local, Vitest (node env).

**Spec:** `docs/superpowers/specs/2026-07-02-time-based-sessions-design.md`

## Global Constraints

- Duration input: default **15 min**, minimum **3 min**.
- Break profiles: Binge 12–20 min every / 20–60 s long; Casual 5–9 min / 60–180 s; Engaged 8–14 min / 45–120 s.
- Watch fractions: Binge 0.7–1.0; Casual 0.15–0.5; Engaged 0.4–0.8.
- Commitment dwell clamp: `[pacing.reelDwellMin, 4 × pacing.reelDwellMax]`.
- Stale session threshold: **2 min** (120 000 ms) since `savedAt`; a persisted future `breakUntil` (+60 s grace) counts as live.
- Storage keys: existing `fbw_session`, `fbw_history` (cap 50); new `fbw_last_summary`.
- Outcomes: `complete` | `stopped` | `halt: <reason>` | `abandoned`.
- Breaks count toward wall-clock duration; a break that would overshoot `willEndAt` is skipped.
- Bump `version` in BOTH `manifest.config.js` and `package.json` (0.33.0 → 0.34.0), set `version_name`, add CHANGELOG entry (project rule).
- Commands: tests `npx vitest run`, build `npm run build`. Repo branch: `swiss-knife-shell`.
- Code style: match existing — 2-space indent, no TS, section banner comments, `/* noop */` empty catches.

---

### Task 1: sessionMath.js — pure helpers + tests

**Files:**
- Create: `src/lib/sessionMath.js`
- Create: `src/lib/sessionMath.test.js`

**Interfaces:**
- Produces (later tasks import these exact names from `@/lib/sessionMath` in panel code and `./lib/sessionMath.js` in `src/content.js`):
  - `shouldContinue(s, now = Date.now())` → boolean. `s` needs `{ isRunning, willEndAt, maxItems, processed }`.
  - `scheduleNextBreak(profile, now, rnd = Math.random)` → epoch ms of next break. `profile` = `{ everyMin, everyMax, lenMin, lenMax }` (all ms).
  - `breakLengthMs(profile, rnd = Math.random)` → break length ms.
  - `commitmentDwellMs(fraction, videoDurationSec, dwellMinMs, dwellMaxMs)` → dwell ms, or `null` when duration unusable.
  - `isStaleSession(saved, now = Date.now(), staleMs = 120000)` → boolean.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/sessionMath.test.js
import { describe, it, expect } from "vitest";
import {
  shouldContinue,
  scheduleNextBreak,
  breakLengthMs,
  commitmentDwellMs,
  isStaleSession,
} from "./sessionMath.js";

const NOW = 1_000_000_000;

describe("shouldContinue", () => {
  const base = { isRunning: true, willEndAt: NOW + 60_000, maxItems: 0, processed: 5 };
  it("continues while running, before clock, no cap", () => {
    expect(shouldContinue(base, NOW)).toBe(true);
  });
  it("stops when not running", () => {
    expect(shouldContinue({ ...base, isRunning: false }, NOW)).toBe(false);
  });
  it("stops at clock expiry (inclusive)", () => {
    expect(shouldContinue(base, NOW + 60_000)).toBe(false);
  });
  it("maxItems 0 = no cap", () => {
    expect(shouldContinue({ ...base, processed: 9999 }, NOW)).toBe(true);
  });
  it("stops when cap reached", () => {
    expect(shouldContinue({ ...base, maxItems: 10, processed: 10 }, NOW)).toBe(false);
    expect(shouldContinue({ ...base, maxItems: 10, processed: 9 }, NOW)).toBe(true);
  });
});

describe("scheduleNextBreak / breakLengthMs", () => {
  const prof = { everyMin: 300_000, everyMax: 540_000, lenMin: 60_000, lenMax: 180_000 };
  it("schedules within [everyMin, everyMax] of now", () => {
    expect(scheduleNextBreak(prof, NOW, () => 0)).toBe(NOW + 300_000);
    expect(scheduleNextBreak(prof, NOW, () => 0.999999)).toBeLessThanOrEqual(NOW + 540_000);
    expect(scheduleNextBreak(prof, NOW, () => 0.5)).toBe(NOW + 420_000);
  });
  it("length within [lenMin, lenMax]", () => {
    expect(breakLengthMs(prof, () => 0)).toBe(60_000);
    expect(breakLengthMs(prof, () => 0.5)).toBe(120_000);
    expect(breakLengthMs(prof, () => 0.999999)).toBeLessThanOrEqual(180_000);
  });
});

describe("commitmentDwellMs", () => {
  it("returns fraction of duration inside clamps", () => {
    // 0.5 × 60s = 30s, clamps [6s, 60s]
    expect(commitmentDwellMs(0.5, 60, 6000, 15000)).toBe(30_000);
  });
  it("clamps up to dwellMin for tiny targets", () => {
    // 0.15 × 10s = 1.5s → 6s floor
    expect(commitmentDwellMs(0.15, 10, 6000, 15000)).toBe(6000);
  });
  it("clamps down to 4×dwellMax for long videos", () => {
    // 0.9 × 1800s = 1620s → 60s ceiling (4 × 15s)
    expect(commitmentDwellMs(0.9, 1800, 6000, 15000)).toBe(60_000);
  });
  it("null when duration unusable", () => {
    expect(commitmentDwellMs(0.5, 0, 6000, 15000)).toBe(null);
    expect(commitmentDwellMs(0.5, NaN, 6000, 15000)).toBe(null);
    expect(commitmentDwellMs(0.5, Infinity, 6000, 15000)).toBe(null);
  });
});

describe("isStaleSession", () => {
  it("stale: running + savedAt older than threshold", () => {
    expect(isStaleSession({ isRunning: true, savedAt: NOW - 121_000 }, NOW)).toBe(true);
  });
  it("fresh: savedAt within threshold", () => {
    expect(isStaleSession({ isRunning: true, savedAt: NOW - 60_000 }, NOW)).toBe(false);
  });
  it("not running / missing → not stale", () => {
    expect(isStaleSession({ isRunning: false, savedAt: NOW - 999_999 }, NOW)).toBe(false);
    expect(isStaleSession(null, NOW)).toBe(false);
    expect(isStaleSession({ isRunning: true }, NOW)).toBe(false);
  });
  it("future breakUntil (+grace) counts as live", () => {
    expect(
      isStaleSession({ isRunning: true, savedAt: NOW - 150_000, breakUntil: NOW + 30_000 }, NOW),
    ).toBe(false);
    expect(
      isStaleSession({ isRunning: true, savedAt: NOW - 300_000, breakUntil: NOW - 61_000 }, NOW),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/sessionMath.test.js`
Expected: FAIL — `Cannot find module './sessionMath.js'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

```js
// src/lib/sessionMath.js
// Pure session math for the warm engine — no chrome.*, no DOM. Imported by
// src/content.js (engine) and WarmTool.jsx (reconciliation). Times are epoch ms
// unless noted.

// Run-loop gate: running, before the session clock, under the optional item cap
// (maxItems 0 = no cap).
export function shouldContinue(s, now = Date.now()) {
  if (!s?.isRunning) return false;
  if (s.willEndAt && now >= s.willEndAt) return false;
  if (s.maxItems > 0 && s.processed >= s.maxItems) return false;
  return true;
}

// profile: { everyMin, everyMax, lenMin, lenMax } — all ms.
export function scheduleNextBreak(profile, now, rnd = Math.random) {
  return now + profile.everyMin + Math.floor(rnd() * (profile.everyMax - profile.everyMin));
}

export function breakLengthMs(profile, rnd = Math.random) {
  return profile.lenMin + Math.floor(rnd() * (profile.lenMax - profile.lenMin));
}

// Watch-commitment dwell: fraction × video length, clamped to
// [dwellMinMs, 4 × dwellMaxMs]. Returns null when the duration is unusable so
// the caller can fall back to the plain random dwell range.
export function commitmentDwellMs(fraction, videoDurationSec, dwellMinMs, dwellMaxMs) {
  if (!isFinite(videoDurationSec) || videoDurationSec <= 0) return null;
  const target = fraction * videoDurationSec * 1000;
  return Math.round(Math.min(Math.max(target, dwellMinMs), 4 * dwellMaxMs));
}

// A persisted fbw_session that claims to be running but hasn't been persisted
// for staleMs is an abandoned run (browser/tab killed). A future breakUntil
// (+60s grace) means the engine is intentionally idle — not stale.
export function isStaleSession(saved, now = Date.now(), staleMs = 120000) {
  if (!saved?.isRunning || !saved.savedAt) return false;
  if (saved.breakUntil && saved.breakUntil + 60000 > now) return false;
  return now - saved.savedAt > staleMs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/sessionMath.test.js`
Expected: PASS — 5 describe blocks, all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessionMath.js src/lib/sessionMath.test.js
git commit -m "feat: session math helpers for time-based warm sessions"
```

---

### Task 2: Engine — duration primary, maxItems ceiling, shouldContinue

**Files:**
- Modify: `src/content.js` (import block ~line 1; `freshState()` ~66–128; `persist()` ~152–190; `snapshot()` ~192–215; `postsLoop` ~1157–1214; `videoLoop` ~1592–1664; `start()` ~1845–1912; resume IIFE ~1974–2033)

**Interfaces:**
- Consumes: `shouldContinue` from Task 1.
- Produces: engine accepts `settings.durationMinutes` (number, min 3, default 15) and `settings.maxItems` (number, 0 = no cap) in `FBW_START`; `S.targetN` is renamed to `S.maxItems` everywhere; `snapshot()` emits `maxItems` **and** a legacy `targetN` alias (removed in Task 6).

- [ ] **Step 1: Add the import**

At the top of `src/content.js`, after `import { franc } from "franc-min";`:

```js
import {
  shouldContinue,
  scheduleNextBreak,
  breakLengthMs,
  commitmentDwellMs,
} from "./lib/sessionMath.js";
```

(`scheduleNextBreak`/`breakLengthMs` used in Task 3, `commitmentDwellMs` in Task 4 — import once now.)

- [ ] **Step 2: Rename targetN → maxItems in state, persist, snapshot**

In `freshState()` replace `targetN: 10,` with `maxItems: 0,`.
In `persist()` replace `targetN: S.targetN,` with `maxItems: S.maxItems,`.
In `snapshot()` replace `targetN: S.targetN,` with:

```js
      maxItems: S.maxItems,
      targetN: S.maxItems, // legacy alias — WarmTool switches to maxItems in the UI task
```

- [ ] **Step 3: start() — duration required, maxItems optional**

In `start()`, replace `S.targetN = Math.max(1, settings.targetN || 10);` with:

```js
    S.maxItems = Math.max(0, Number(settings.maxItems) || 0);
```

Replace the `S.willEndAt = settings.sessionCapMinutes ? ... : 0;` assignment with:

```js
    const durationMin = Math.max(3, Number(settings.durationMinutes) || 15);
    S.willEndAt = now + 60000 * durationMin;
```

Update the start log line (`▶️ ${S.platform} · mode ...`): replace `· N=${S.targetN}` with:

```js
· ${durationMin}m${S.maxItems ? ` · cap ${S.maxItems}` : ""}
```

- [ ] **Step 4: Loop conditions**

`postsLoop`: replace `while (S.isRunning && S.processed < S.targetN) {` with:

```js
      while (shouldContinue(S)) {
```

Replace its start log `(target ${S.targetN}, warm-up ${S.warmupPosts})` with `` (until ${new Date(S.willEndAt).toTimeString().slice(0, 5)}, warm-up ${S.warmupPosts}) `` and the per-item log ``logLine(`✓ post ${S.processed}/${S.targetN}`)`` with:

```js
        logLine(`✓ post ${S.processed}${S.maxItems ? `/${S.maxItems}` : ""}`);
```

`videoLoop`: same treatment — `while (shouldContinue(S)) {`, start log `(target ${S.targetN})` → `` (until ${new Date(S.willEndAt).toTimeString().slice(0, 5)}) ``, per-item log → `` `✓ ${A.noun} ${S.processed}${S.maxItems ? `/${S.maxItems}` : ""}` ``, and replace `if (S.processed >= S.targetN) break;` with:

```js
        if (!shouldContinue(S)) break;
```

- [ ] **Step 5: Resume path**

In the resume IIFE, replace `targetN: saved.targetN || 10,` with `maxItems: saved.maxItems || 0,`.

- [ ] **Step 6: Build + tests**

Run: `npx vitest run && npm run build`
Expected: tests PASS, build clean. `grep -n "targetN" src/content.js` shows only the snapshot alias line.

- [ ] **Step 7: Commit**

```bash
git add src/content.js
git commit -m "feat: duration-primary sessions — maxItems ceiling, shouldContinue gate"
```

---

### Task 3: Engine — personality-driven breaks + persist heartbeat

**Files:**
- Modify: `src/content.js` (constants near `PERSONALITIES` ~28–49; `freshState()`; `persist()`; `snapshot()`; new `maybeBreak()` near `waitWhilePaused` ~373; both loops; `start()`; `tick()` ~1833; resume IIFE)

**Interfaces:**
- Consumes: `scheduleNextBreak`, `breakLengthMs` (imported in Task 2).
- Produces: `S.nextBreakAt` / `S.breakUntil` (epoch ms, persisted); `snapshot().isAutoBreak` (boolean — `WarmTool` line 166 already reads this name); `maybeBreak()` awaited at the top of both loops.

- [ ] **Step 1: Break profiles constant**

Directly below the `PERSONALITIES` object:

```js
  // Break cadence per personality (ms). Breaks land BETWEEN items, count toward
  // the wall-clock session duration, and are skipped when the session would end
  // first. Tunable.
  const BREAKS = {
    BINGE: { everyMin: 12 * 60e3, everyMax: 20 * 60e3, lenMin: 20e3, lenMax: 60e3 },
    CASUAL: { everyMin: 5 * 60e3, everyMax: 9 * 60e3, lenMin: 60e3, lenMax: 180e3 },
    ENGAGED: { everyMin: 8 * 60e3, everyMax: 14 * 60e3, lenMin: 45e3, lenMax: 120e3 },
  };
```

- [ ] **Step 2: State + persistence**

`freshState()` — after `willEndAt: 0,` add:

```js
      nextBreakAt: 0,
      breakUntil: 0,
      lastPersistAt: 0,
```

`persist()` — after `willEndAt: S.willEndAt,` add `nextBreakAt: S.nextBreakAt,` and `breakUntil: S.breakUntil,`; at the top of the function body add `S.lastPersistAt = Date.now();`.

`snapshot()` — after `isPaused: S.isPaused,` add:

```js
      isAutoBreak: S.breakUntil > now,
```

- [ ] **Step 3: maybeBreak() + heartbeat in tick()**

Below `waitWhilePaused()`:

```js
  // Personality-driven break: fires between items when nextBreakAt is due.
  // Ignores pause (a break IS an idle pause); stop exits immediately.
  async function maybeBreak() {
    const prof = BREAKS[S.personalityMode];
    if (!prof || !S.nextBreakAt) return;
    const now = Date.now();
    if (now < S.nextBreakAt) return;
    const len = breakLengthMs(prof);
    if (S.willEndAt && now + len >= S.willEndAt) {
      S.nextBreakAt = S.willEndAt; // session ends first — skip the break
      return;
    }
    S.breakUntil = now + len;
    logLine(`☕ break ~${Math.round(len / 1000)}s`);
    persist();
    while (Date.now() < S.breakUntil && S.isRunning) await sleep(400);
    S.breakUntil = 0;
    S.nextBreakAt = scheduleNextBreak(prof, Date.now());
    if (S.isRunning) logLine("▶ back from break");
    persist();
  }
```

In `tick()`, before the `detectStop()` check, add the heartbeat (keeps `savedAt` fresh through long dwells so the panel's stale-session reconciler never false-fires):

```js
    if (Date.now() - S.lastPersistAt > 30000) persist();
```

- [ ] **Step 4: Hook into both loops + start() + resume**

In `postsLoop` and `videoLoop`, directly after `await waitWhilePaused();` add:

```js
        await maybeBreak();
```

In `start()`, after the personality is picked (after the `else pickPersonality();` line):

```js
    S.nextBreakAt = scheduleNextBreak(BREAKS[S.personalityMode], now);
```

In the resume IIFE's `Object.assign(S, freshState(), { ... })`, after `willEndAt: saved.willEndAt || 0,` add:

```js
        breakUntil: saved.breakUntil > Date.now() ? saved.breakUntil : 0,
        nextBreakAt: saved.nextBreakAt || 0,
```

and after the `if (!S.personalityMode) pickPersonality();` line (never "catch up" on missed breaks):

```js
      if (!S.nextBreakAt || S.nextBreakAt < Date.now())
        S.nextBreakAt = scheduleNextBreak(BREAKS[S.personalityMode], Date.now());
```

- [ ] **Step 5: Build + tests**

Run: `npx vitest run && npm run build`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/content.js
git commit -m "feat: personality-driven session breaks + persist heartbeat"
```

---

### Task 4: Engine — watch-commitment dwell

**Files:**
- Modify: `src/content.js` (`PERSONALITIES` ~28–49; `reelDwell` ~371–372; `fbWatchPost` ~918–950)

**Interfaces:**
- Consumes: `commitmentDwellMs` (imported in Task 2); `igActiveVideo()` (existing, ~line 1249 — generic nearest-playing `<video>` finder, hoisted function declaration).
- Produces: personalities gain `watchMin` / `watchMax`; `watchFraction()` helper.

- [ ] **Step 1: Watch fractions on personalities**

Add to each personality in `PERSONALITIES`:

```js
    BINGE:   { ..., watchMin: 0.7,  watchMax: 1.0 },
    CASUAL:  { ..., watchMin: 0.15, watchMax: 0.5 },
    ENGAGED: { ..., watchMin: 0.4,  watchMax: 0.8 },
```

(Keep existing fields; append the two new ones to each object literal.)

- [ ] **Step 2: watchFraction + commitment-aware reelDwell**

Replace the `const reelDwell = () => sleep(rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax));` line with:

```js
  const watchFraction = () => {
    const p = persona();
    return p.watchMin + Math.random() * (p.watchMax - p.watchMin);
  };
  // Dwell on the active video for a personality-driven fraction of its length;
  // fall back to the plain random dwell range when no duration is readable.
  async function reelDwell() {
    const vid = igActiveVideo(); // generic: nearest playing/centered <video>
    let dwell = null;
    let frac = null;
    if (vid && isFinite(vid.duration) && vid.duration > 0) {
      frac = watchFraction();
      dwell = commitmentDwellMs(frac, vid.duration, S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    }
    if (dwell == null) dwell = rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    logLine(
      `👀 dwell ~${Math.round(dwell / 1000)}s${frac != null ? ` (${Math.round(frac * 100)}%)` : ""}`,
    );
    const t0 = Date.now();
    while (Date.now() - t0 < dwell && S.isRunning && !S.isPaused) await sleep(400);
  }
```

- [ ] **Step 3: fbWatchPost commitment dwell**

In `fbWatchPost`, replace:

```js
    let dwell = rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    if (isFinite(vid.duration) && vid.duration > 0) {
      const remaining = Math.max(2000, (vid.duration - vid.currentTime) * 1000);
      dwell = Math.min(dwell, remaining);
    }
    logLine(`▶ watching video ~${Math.round(dwell / 1000)}s`);
```

with:

```js
    let dwell = null;
    let frac = null;
    if (isFinite(vid.duration) && vid.duration > 0) {
      frac = watchFraction();
      dwell = commitmentDwellMs(frac, vid.duration, S.pacing.reelDwellMin, S.pacing.reelDwellMax);
      const remaining = Math.max(2000, (vid.duration - vid.currentTime) * 1000);
      dwell = Math.min(dwell, remaining);
    }
    if (dwell == null) dwell = rand(S.pacing.reelDwellMin, S.pacing.reelDwellMax);
    logLine(
      `▶ watching video ~${Math.round(dwell / 1000)}s${frac != null ? ` (${Math.round(frac * 100)}%)` : ""}`,
    );
```

- [ ] **Step 4: Build + tests**

Run: `npx vitest run && npm run build`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/content.js
git commit -m "feat: personality watch-commitment — dwell a fraction of each video"
```

---

### Task 5: Engine — lifecycle summary writes

**Files:**
- Modify: `src/content.js` (constants ~51–64; `logHistory` ~893–914; `finishRun` ~1666; `stop` ~1914; `halt` ~304; resume-expiry branch ~1985)

**Interfaces:**
- Produces: storage key `fbw_last_summary` — `{ outcome, platform, mode, keyword, startedAt, endedAt, durationMs, processed, saved, liked, loved, followed, skipped, personality }`. `fbw_history` entries gain `durationMs`. Task 6's summary card reads `fbw_last_summary`; Task 7 renders `durationMs`.

- [ ] **Step 1: Constant + writeSummary()**

Next to `const HISTORY_KEY = "fbw_history";` add:

```js
  const SUMMARY_KEY = "fbw_last_summary"; // last run recap for the WarmTool summary card
```

Below `logHistory()` add:

```js
  function writeSummary(outcome) {
    try {
      chrome.storage.local.set({
        [SUMMARY_KEY]: {
          outcome,
          platform: S.platform,
          mode: S.mode,
          keyword: S.keyword,
          startedAt: S.startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - (S.startedAt || Date.now()),
          processed: S.processed,
          saved: S.saved,
          liked: S.liked,
          loved: S.loved,
          followed: S.followed,
          skipped: S.skipped,
          personality: S.personalityMode ? PERSONALITIES[S.personalityMode].name : null,
        },
      });
    } catch {
      /* noop */
    }
  }
```

- [ ] **Step 2: durationMs in history + summary calls on every end path**

In `logHistory()`'s pushed object, after `startedAt: S.startedAt,` add:

```js
          durationMs: Date.now() - (S.startedAt || Date.now()),
```

Add `writeSummary(...)` beside each existing `logHistory(...)` call:
- `finishRun()`: `writeSummary("complete");` after `logHistory("complete");`
- `stop()`: `writeSummary("stopped");` after `logHistory("stopped");`
- `halt(reason)`: `writeSummary("halt: " + reason);` after `logHistory("halt: " + reason);`

- [ ] **Step 3: Resume-expiry path records the finished run**

In the resume IIFE, the clock-expired branch currently discards the run silently. Replace:

```js
      if (saved.willEndAt && Date.now() >= saved.willEndAt) {
        chrome.storage.local.set({ [STORAGE_KEY]: { isRunning: false } });
        return;
      }
```

with:

```js
      if (saved.willEndAt && Date.now() >= saved.willEndAt) {
        // Clock ran out while the page was navigating — record it as complete
        // from the persisted counters instead of dropping it.
        Object.assign(S, freshState(), {
          platform: saved.platform || here,
          mode: saved.mode || "C",
          keyword: saved.keyword || "",
          startedAt: saved.startedAt || 0,
          processed: saved.processed || 0,
          saved: saved.saved || 0,
          liked: saved.liked || 0,
          loved: saved.loved || 0,
          followed: saved.followed || 0,
          skipped: saved.skipped || 0,
          personalityMode: saved.personalityMode || null,
        });
        logHistory("complete");
        writeSummary("complete");
        chrome.storage.local.set({ [STORAGE_KEY]: { isRunning: false } });
        return;
      }
```

- [ ] **Step 4: Build + tests**

Run: `npx vitest run && npm run build`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/content.js
git commit -m "feat: fbw_last_summary on every run end path + durationMs in history"
```

---

### Task 6: WarmTool — duration UI, summary card, on-break chip, reconciliation

**Files:**
- Modify: `src/components/tools/WarmTool.jsx`
- Modify: `src/components/ui/OptionsDropdown.jsx` (swap sessionCap slot for maxItems)
- Modify: `src/content.js` (remove the `targetN` legacy alias from `snapshot()`)

**Interfaces:**
- Consumes: `isStaleSession` from `@/lib/sessionMath`; `snapshot().maxItems` / `.isAutoBreak` (Tasks 2–3); `fbw_last_summary` (Task 5).
- Produces: `FBW_START` settings carry `durationMinutes` + `maxItems` (no more `targetN` / `sessionCapMinutes`).

- [ ] **Step 1: State swap — duration + maxItems**

In `WarmTool.jsx` replace `const [targetN, setTargetN] = useState(10);` with:

```js
  const [duration, setDuration] = useState(15); // session length, minutes
```

Replace `const [sessionCap, setSessionCap] = useState(0);` with:

```js
  const [maxItems, setMaxItems] = useState(0); // 0 = no item cap
```

Options persistence: in the load effect replace `if (o?.sessionCap != null) setSessionCap(o.sessionCap);` with:

```js
      if (o?.duration != null) setDuration(o.duration);
      if (o?.maxItems != null) setMaxItems(o.maxItems);
```

In the save effect's object replace `sessionCap,` with `duration,` and `maxItems,`; update the dependency array the same way (`sessionCap` → `duration, maxItems`).

- [ ] **Step 2: Settings payload**

In `start()`, replace `targetN: Number(targetN) || 10,` and `sessionCapMinutes: Number(sessionCap) || 0,` with:

```js
      durationMinutes: Math.max(3, Number(duration) || 15),
      maxItems: Math.max(0, Number(maxItems) || 0),
```

- [ ] **Step 3: Duration input replaces Target (N)**

Replace the Target (N) grid cell:

```jsx
            <div className="space-y-1.5">
              <Label htmlFor="duration">Duration (min)</Label>
              <Input
                id="duration"
                type="number"
                min={3}
                max={180}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
```

- [ ] **Step 4: Max items into OptionsDropdown**

In `OptionsDropdown.jsx`, rename the `sessionCap`/`setSessionCap` props to `maxItems`/`setMaxItems`, and change its input row (the one at the old `sessionCap` slot, ~line 181): label text → `Max items (0 = no cap)`, `value={maxItems}`, `onChange` → `setMaxItems`. In `WarmTool.jsx` pass `maxItems={maxItems} setMaxItems={setMaxItems}` instead of the sessionCap pair.

- [ ] **Step 5: Done counter + on-break chip**

Replace the done Counter value `` `${status.processed}/${status.targetN}` `` with:

```jsx
              value={
                status.maxItems > 0
                  ? `${status.processed}/${status.maxItems}`
                  : `${status.processed}`
              }
```

`StatusChip`: pass `onBreak={!!status?.isAutoBreak}` from the parent (keep `paused` as-is — line 166 already ORs `isAutoBreak`; change it to `const paused = !!status?.isPaused;` so the two states are distinct) and add before the paused branch:

```jsx
  if (onBreak)
    return (
      <span className="rounded-full bg-sky-400/15 px-2.5 py-1 text-[11px] font-medium text-sky-600">
        on break
      </span>
    );
```

(Signature becomes `function StatusChip({ running, paused, halted, onBreak })`.)

- [ ] **Step 6: Summary card + reconciliation**

Add imports at the top of `WarmTool.jsx`:

```js
import { isStaleSession } from "@/lib/sessionMath";
```

Add state + effects inside the component (after the `status` state declarations):

```js
  const [summary, setSummary] = useState(null);

  // Load last-run summary when idle; reconcile abandoned runs on mount.
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    (async () => {
      const r = await chrome.storage.local.get(["fbw_session", "fbw_history", "fbw_last_summary"]);
      const s = r?.fbw_session;
      if (isStaleSession(s)) {
        // Run died without an end path (browser/tab killed) → abandoned.
        const entry = {
          at: Date.now(),
          startedAt: s.startedAt || 0,
          durationMs: (s.savedAt || Date.now()) - (s.startedAt || s.savedAt || Date.now()),
          platform: s.platform,
          mode: s.mode,
          keyword: s.keyword || "",
          processed: s.processed || 0,
          liked: s.liked || 0,
          loved: s.loved || 0,
          skipped: s.skipped || 0,
          outcome: "abandoned",
        };
        const hist = Array.isArray(r.fbw_history) ? r.fbw_history : [];
        const sum = {
          outcome: "abandoned",
          platform: s.platform,
          mode: s.mode,
          keyword: s.keyword || "",
          startedAt: s.startedAt || 0,
          endedAt: s.savedAt || Date.now(),
          durationMs: entry.durationMs,
          processed: entry.processed,
          saved: s.saved || 0,
          liked: entry.liked,
          loved: entry.loved,
          followed: s.followed || 0,
          skipped: entry.skipped,
          personality: null,
        };
        await chrome.storage.local.set({
          fbw_history: [...hist, entry].slice(-50),
          fbw_last_summary: sum,
          fbw_session: { isRunning: false },
        });
        setSummary(sum);
      } else if (r?.fbw_last_summary) {
        setSummary(r.fbw_last_summary);
      }
    })().catch(() => {});
  }, []);

  // Refresh the card when a run ends while the panel is open.
  useEffect(() => {
    if (running || typeof chrome === "undefined" || !chrome?.storage?.local) return;
    chrome.storage.local
      .get("fbw_last_summary")
      .then((r) => r?.fbw_last_summary && setSummary(r.fbw_last_summary))
      .catch(() => {});
  }, [running]);

  const dismissSummary = () => {
    chrome?.storage?.local?.remove("fbw_last_summary");
    setSummary(null);
  };
```

Render the card in the idle branch — directly above `{!running && !halted && (` insert:

```jsx
      {!running && summary && (
        <SummaryCard summary={summary} onDismiss={dismissSummary} />
      )}
```

Add the component next to `StatusChip`:

```jsx
function SummaryCard({ summary, onDismiss }) {
  const ok = summary.outcome === "complete";
  const badge = ok
    ? "bg-emerald-500/10 text-emerald-600"
    : summary.outcome === "abandoned"
      ? "bg-amber-400/15 text-amber-600"
      : (summary.outcome || "").startsWith("halt")
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="p-3.5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Last session</span>
          <span className={`text-[10px] rounded-full px-2 py-0.5 ${badge}`}>
            {summary.outcome}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {summary.platform} · {summary.keyword || summary.mode}
          {summary.personality ? ` · ${summary.personality}` : ""} ·{" "}
          {fmtMs(summary.durationMs)}
        </div>
        <div className="flex gap-3 text-[11px] text-muted-foreground">
          <span>seen {summary.processed}</span>
          <span>👍 {summary.liked}</span>
          <span>❤️ {summary.loved ?? 0}</span>
          <span>➕ {summary.followed ?? 0}</span>
          <span>skip {summary.skipped}</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs w-full" onClick={onDismiss}>
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 7: Drop the snapshot alias**

In `src/content.js` `snapshot()`, delete the `targetN: S.maxItems, // legacy alias ...` line.

- [ ] **Step 8: Build + tests**

Run: `npx vitest run && npm run build`
Expected: PASS / clean. `grep -rn "targetN\|sessionCap" src/` returns nothing.

- [ ] **Step 9: Commit**

```bash
git add src/components/tools/WarmTool.jsx src/components/ui/OptionsDropdown.jsx src/content.js
git commit -m "feat: duration UI, last-session summary card, on-break chip, abandoned reconciliation"
```

---

### Task 7: LibraryTool history rows — abandoned badge + runtime

**Files:**
- Modify: `src/components/tools/LibraryTool.jsx` (`HistoryPanel`, ~33–100)

**Interfaces:**
- Consumes: history entries with optional `durationMs` and `outcome: "abandoned"` (Tasks 5–6).

- [ ] **Step 1: Badge + runtime**

In `HistoryPanel`'s map callback, replace the badge logic:

```jsx
        const ok = h.outcome === "complete";
        const halted = (h.outcome || "").startsWith("halt");
        const abandoned = h.outcome === "abandoned";
```

and the badge span's class/content:

```jsx
                <span
                  className={`text-[10px] rounded-full px-2 py-0.5 ${
                    ok
                      ? "bg-emerald-500/10 text-emerald-600"
                      : halted
                        ? "bg-destructive/10 text-destructive"
                        : abandoned
                          ? "bg-amber-400/15 text-amber-600"
                          : "bg-muted text-muted-foreground"
                  }`}
                >
                  {ok ? "complete" : halted ? "halted" : abandoned ? "abandoned" : "stopped"}
                </span>
```

In the timestamp line, append runtime when present:

```jsx
              <div className="text-[10px] text-muted-foreground">
                {new Date(h.at).toLocaleString()}
                {h.durationMs
                  ? ` · ${Math.round(h.durationMs / 60000)}m`
                  : ""}
              </div>
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/tools/LibraryTool.jsx
git commit -m "feat: abandoned badge + runtime in run history"
```

---

### Task 8: Version bump, CHANGELOG, full verification

**Files:**
- Modify: `manifest.config.js` (version 0.33.0 → 0.34.0 + version_name)
- Modify: `package.json` (version 0.34.0)
- Modify: `CHANGELOG.md` (new entry at top, below the header block)

- [ ] **Step 1: Bump versions**

`manifest.config.js`: `version: "0.34.0"`, `version_name: "0.34.0 — time-based sessions: duration target, personality breaks, watch-commitment, run summary"`.
`package.json`: `"version": "0.34.0"`.

- [ ] **Step 2: CHANGELOG entry**

Insert above the `## [0.8.2]` entry (keep-a-changelog format used in the file):

```markdown
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
- `FBW_START` settings: `durationMinutes` + `maxItems` replace `targetN` +
  `sessionCapMinutes`.
```

- [ ] **Step 3: Full verification**

Run: `npx vitest run && npm run build`
Expected: all tests PASS, build clean.

- [ ] **Step 4: Commit**

```bash
git add manifest.config.js package.json CHANGELOG.md
git commit -m "chore: v0.34.0 — time-based warm sessions"
```

---

### Task 9: Live verification (manual — requires logged-in browser)

Project practice: selectors and behavior are verified live. Not automatable here.

- [ ] Load `dist/` in Chrome (reload extension card after `npm run build`).
- [ ] **FB hashtag run, 3 min duration:** confirm start log shows `· 3m`, `✓ post N` (no `/N` when Max items = 0), `▶ watching video ~Xs (Y%)` lines, ETA countdown, session ends at clock with `✅ run complete`, summary card appears with runtime ~3m.
- [ ] **Break smoke test:** temporarily edit `BREAKS.CASUAL` to `{ everyMin: 60e3, everyMax: 90e3, lenMin: 15e3, lenMax: 20e3 }`, rebuild, run Casual 5 min: confirm `☕ break ~Xs` + "on break" chip + `▶ back from break`, then **revert the edit and rebuild**.
- [ ] **IG reels run, 3 min:** confirm `👀 dwell ~Xs (Y%)` lines and summary card.
- [ ] **Abandoned test:** start a run, close the platform tab AND the side panel, wait >2 min, reopen panel: confirm History shows an `abandoned` entry and the summary card shows outcome `abandoned`.
- [ ] **Stop mid-run:** summary card shows `stopped` with correct counters.

---

## Self-Review Notes

- **Spec coverage:** §1 duration → Tasks 2+6; §2 breaks → Task 3; §3 commitment → Task 4; §4 lifecycle/summary/history → Tasks 5+6+7; §5 files → Tasks 1–8; §6 error handling → poll-loops in Tasks 3–4, recompute-forward in Task 3 Step 4, try/catch reconciler in Task 6; §7 testing → Tasks 1, 8, 9.
- **Beyond spec (justified):** persist heartbeat in `tick()` (Task 3) — without it, breaks longer than the 2-min stale threshold would false-trigger abandoned reconciliation; `breakUntil` guard added to `isStaleSession` for the same reason.
- **Type consistency check:** `shouldContinue(S)` — `S` carries `isRunning/willEndAt/maxItems/processed` after Task 2. `isAutoBreak` matches the pre-existing reference at `WarmTool.jsx:166`. `fbw_last_summary` shape identical in Tasks 5 and 6.
