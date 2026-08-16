# Karaoke transcript sync for socialMate

**What this is:** feasibility research for highlighting a stored transcript line-by-line, in the side
panel, in time with the reel playing in the Facebook tab — the effect unFunnelizer already ships for
Ads Library videos.

**Date:** 2026-08-15 · **Status:** draft · **Repo:** `~/Code/extensions/social-warmer/fb-warmer` @ 0.74.1

**Verdict:** feasible, and cheaper than the unFunnelizer version. Every hard part (a video to sync
against, timestamps, a channel to the page) already exists or measured clean. No new permissions, no
new dependency, no re-transcription.

**Chosen shape (confirmed with the user):** the transcript stays in the panel and follows the video
playing in the tab; highlight granularity is **phrase-level**, using the chunks already stored.

---

## 1. What unFunnelizer does, and why it was easy there

`unfunnelizer-extension/extension/src/content/fb-ads-spy/components/transcription.js:392-431`

A modal is injected into the Ads Library page carrying **its own** `<video src={job.videoUrl}>`. Then:

```js
video.addEventListener("timeupdate", () => {
  // linear scan of .transcript-chunk, compare currentTime against data-start/data-end
  // → toggle .active, and scrollIntoView({behavior:"smooth", block:"center"}) when the index changes
});
// clicking .transcript-timestamp → video.currentTime = t; video.play()
```

Chunk-level, not word-level. ~40 lines of DOM work.

**It is easy there for exactly one reason:** an Ads Library video is a single progressive MP4, and the
job stores that URL (`background/index.js:741-765`), so the player and the transcript live in one
document. That assumption does not survive the move to facebook.com — see §3.

## 2. What socialMate already has

| Piece | State | Evidence |
|---|---|---|
| Chunks with `timestamp:[start,end]` | ✅ present on **7/7** stored records | read from `fbw_transcripts` in the live profile |
| Granularity | **1.31 s avg**, min 0.20 s, max 3.02 s, **4.8 words/chunk**, contiguous, zero null ends | 40 chunks over a 52.48 s reel |
| Chunk producer | `return_timestamps: true` (segment level) | `src/offscreen/transcribe.worker.js:72` |
| Caption-sourced chunks (TikTok) | same shape, from WebVTT | `parseWebVtt` in `src/background.js` |
| Consumer that already reads chunks | `.srt` export | `src/components/TranscriptsPanel.jsx` |
| Word-level *capability* | bundled `whisper-base` ships `alignment_heads` (8 pairs) → `return_timestamps:"word"` is theoretically reachable | `public/models/Xenova/whisper-base/generation_config.json` |
| A stored media URL | ❌ none — no record carries one | `putTranscript` writes only thumb/counts/author/caption/platform/sourceUrl/language |
| A `<video>` in the panel | ❌ none anywhere | `grep -rn "<video" src/components src/lib` → 0 hits |
| Panel↔page channel | ⚠️ no long-lived ports exist; today it's one-shot `sendMessage` + `storage.onChanged` | `grep runtime.connect\|onConnect` → 0 hits |

## 3. Why we are NOT mounting our own player (the discarded option)

Measured, so it doesn't have to be re-litigated later:

- **Playback in the panel works.** A raw `progressive_url` in `<video src>` on the `chrome-extension://`
  origin loaded fine: duration 118.1 s, 360×640. `fetch()` → blob → `<video>` works too (2.7 MB in ~1 s,
  HTTP 200; a ranged request returns 206 `video/mp4`). The extension CSP sets no `media-src`, and
  `*.fbcdn.net` is already in `host_permissions`.
  *Gotcha that cost an hour: Chrome defers media element loading while the page is hidden. The first
  probes returned `readyState 0` with no error event. Activate the tab before measuring anything media.*
- **But the URL often isn't there.** `progressive_url` lives in the page's embedded JSON, which only
  ships for the reel you land on with a full page load. Sampled 3 reels: **2 had it, 1 (reached by SPA
  pagination) had neither progressive nor audio** — matching the existing comments in `inject.js`.
- **And it rots.** The `oe` param is an expiry: progressive ≈ **5 days**, audio-only ≈ **1.5 days**.
  A stored URL stops playing; unFunnelizer has the same rot, it just bites less on Ads Library.
- The rot-free variant (mux DASH → MP4 in the offscreen ffmpeg, stash in IndexedDB — `idb-keyval` is
  already a dependency and `unlimitedStorage` is already granted) costs ~3 MB/reel plus an ffmpeg pass
  per transcript. Real, but a much bigger feature than the one being asked for.

Syncing to the page's own video sidesteps all three.

## 4. The chosen design

```
facebook.com tab                          side panel (extension page)
┌───────────────────────────┐            ┌────────────────────────────────┐
│ inject.js (isolated world)│            │ TranscriptsPanel / VideoCard   │
│  pickActiveVideo()        │  port      │                                │
│  video.timeupdate  ───────┼──────────► │ {videoId, t, paused, duration} │
│                           │            │   → active chunk = last chunk  │
│  seek handler       ◄─────┼────────────┤     with start <= t < end      │
│  video.currentTime = t    │  seek msg  │   → highlight + scroll inside  │
└───────────────────────────┘            │     the transcript box         │
                                         └────────────────────────────────┘
```

**Measured, all of it green:**

| Question | Answer |
|---|---|
| How often does a reel's `<video>` report time? | **11 `timeupdate`s in 3 s, median gap 0.265 s** (~3.8 Hz). Against a 1.31 s chunk that is ~5 updates per chunk — no rAF, no polling loop needed. |
| Does FB fight a JS seek? | **No.** `currentTime` 11.71 → 23.71 landed at 24.00 after 400 ms and kept playing (25.50 two seconds later). Click-a-line-to-seek is real. |
| Can the panel even reach the content script? | **Yes, today.** `chrome.tabs.sendMessage(tabId, {type:"FBW_PING"})` from the panel answered `{ok:true}` in **0.4–0.9 ms** (3 runs). `chrome.tabs.query` from the panel found 3 candidate tabs. |
| Which record to light up? | Match on `videoId`. `inject.js` already derives it (`urlPathVideoId`/`grabVideoId`) and the panel already keys cards by it. |

**Pieces to build (rough shape, not a plan):**

1. `inject.js`: a reporter that attaches to the active video, and on `timeupdate`/`play`/`pause`/`seeked`
   posts `{videoId, t}` down a port. Must re-attach when FB swaps the `<video>` node (the machinery for
   that already exists: `pickActiveVideo`, `liveVideoFor`, `settleCapture`).
2. A port: `chrome.tabs.connect(tabId, {name:"fbw-playhead"})` from the panel, `onConnect` in `inject.js`.
   Panel binds to the active tab and re-binds on `chrome.tabs.onActivated` / `onUpdated`.
3. `src/lib/shared/chunkAt.js` (or similar): pure `chunkIndexAt(chunks, t)` — binary search, returns the
   index or -1. Unit-testable without a DOM, which is where the actual logic bugs live (boundaries,
   gaps, t past the end).
4. `TranscriptsPanel.jsx`: render chunks as rows instead of one `{it.text}` blob when a playhead is
   live; `.active` styling; click-to-seek; auto-scroll.

## 5. Edge cases and risks

**Scroll containment.** The transcript box is `max-h-44 overflow-y-auto` inside a scrolling Library
list. unFunnelizer's `scrollIntoView({block:"center"})` would yank the whole panel. Must scroll the
*container* (`el.offsetTop` math against `container.scrollTop`), and only when the active index changes.

**Whisper timestamp drift.** Chunks come from the same asset the user is watching, so the timelines
share an origin, but Whisper segment boundaries are typically ±0.2–0.5 s and can drift on long audio
(30 s windows + stride). Mitigation if it reads badly: a fixed lead bias (highlight ~150 ms early —
reads as "on time" to a viewer) and/or a small nudge control. Worth an eyeball test before tuning.

**Which video is "the" video.** Reel pages mount 2–3 `<video>` nodes (current + preloads) and swap them
on navigation. The reporter must re-resolve, and must publish the videoId alongside the time so the
panel can refuse a mismatched pair — this is the same crossing hazard the counts fix hit (URL updates
~150–175 ms before the card swaps, measured 2026-08-01).

**Feed videos with no confident id.** A feed post whose id never resolved has no card to light up.
Fall back to "no playhead", not to a guess.

**Panel lifecycle.** The panel closes and reopens; ports die with the tab. Reconnect on panel mount,
tolerate `chrome.runtime.lastError` on a dead tab (existing `sendBg` already models this).

**Multiple FB tabs.** Bind to the *active* tab only; a second tab playing in the background must not
drive the highlight.

**Records with no chunks.** None today (7/7 have them), but old/imported records could lack them —
degrade to the current plain-text view.

**Other platforms.** IG (`content/ig/bridge.js`) and TikTok (`content/tt/tt-relay.js`) have video
elements and the same record shape, so the same port protocol extends there. Out of scope for v1
unless you say otherwise.

## 6. What this is not

- Not a player in the panel (§3) — no media storage, no ffmpeg, no expiry handling.
- Not word-level highlighting. `alignment_heads` says it's reachable, but it needs
  `return_timestamps:"word"` verified against the **q8 merged decoder** we bundle, is slower, and would
  re-transcribe every existing record. Deferred; the renderer should take a chunk list so a
  finer-grained list can drop in later without a rewrite.
- Not an on-video overlay on facebook.com (considered, not chosen).

## 7. Still open

- Does the highlight need to work while the panel shows the **Salvos** tab too, or Transcrições only?
- Should a reel that has no transcript yet show anything while playing (e.g. "transcrever" affordance),
  or stay inert?
- Lead-bias value — needs one eyeball pass on a real reel before picking a number.

## Appendix — how to re-run the measurements

Shared Chrome on `:9222` (`~/.claude/scripts/open-chrome.sh`, sandbox off). socialMate id in that
profile: `cmaidhikebdolakdmipclahbokbokflg`. Panel page at `.../index.html` gives `chrome.*`; the reel
tab gives the DOM. **Activate a tab via `curl :9222/json/activate/<targetId>` before any media or
`<video>` measurement** — a hidden tab reports `readyState 0` forever and reads as a false negative.
