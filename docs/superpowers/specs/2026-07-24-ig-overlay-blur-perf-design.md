# IG overlay scroll-jank fix — remove backdrop-filter blur

- **Date:** 2026-07-24
- **Status:** Approved (user picked "darker solid" restyle; IG-only scope; no commits — user handles git)
- **Version:** 0.58.3 (PATCH)

## Problem

The Instagram on-page stat overlays (`src/content/ig/bridge.js`) make the page feel
very slow — scrolling a profile/reels grid janks hard.

## Root cause (measured live, 2026-07-24)

Profiled `instagram.com/solomonaldric/reels/` in the shared debug Chrome
(extension v0.58.2 dist build of 2026-07-20), chrome-devtools MCP.

Load itself is NOT the problem:
- extension main-thread cost during page load: **32 ms** (ThirdParties insight);
  forced reflows (94 ms) are Instagram's own code
- MAIN-world `JSON.parse` hook total overhead during scroll pagination: **3.6 ms**
  (vs 0.8 ms clean parse of the same payloads, 8 calls, 0.9 MB)
- overlay pass-1 selector scan: 0.05 ms; DOM stays ~28 tiles (IG virtualizes)

The problem is **`backdrop-filter: blur()`** — with 28 tiles annotated the DOM holds
112 blur surfaces (28 rails + 84 action buttons). Each one re-rasters the moving
grid behind it on every scrolled frame.

rAF frame-time A/B while auto-scrolling the grid:

| Condition | avg frame | p95 | frames >25 ms |
|---|---|---|---|
| A — overlays as-is (blur on) | **68.3 ms (~15 fps)** | 96.2 ms | 49/52 |
| B — same overlays, backdrop-filter disabled | 8.3 ms (120 fps) | 9.3 ms | 0 |
| C — overlays hidden entirely | 8.3 ms | 9.3 ms | 0 |

B == C ⇒ the blur is 100 % of the cost; the rails/buttons themselves are free.

## Decision

Remove every `backdrop-filter`/`-webkit-backdrop-filter` from the IG overlay styles
and compensate with a darker solid background. Keep the blue border, outer glow,
and text-shadow — the identity styling — unchanged.

- `.sw-ovl` rail: `rgba(0,0,0,.42)` + blur(4px) → solid `rgba(0,0,0,.62)`
- `.sw-actbtn` tile buttons: same solid `.62`; hover `.66` → `.78` (still darkens)
- `.sw-stbtn` story-viewer buttons: `.55` + blur(6px) → solid `.68`; hover `.84`
- `OVL.blurPx` config key deleted (nothing consumes it anymore)

Out of scope (deliberate): Facebook's on-page buttons (`transcription/inject.js`,
blur(9px)) have the same defect — user chose IG-only tonight. Panel-side
`IgSortTool` cards are unaffected (side panel doesn't scroll-jank the page).

## Files

- `src/content/ig/bridge.js` — OVL config + `ensureOvlStyle()` CSS only
- `manifest.config.js`, `package.json` — 0.58.3 + version_name
- `CHANGELOG.md` — entry

## Verification

Rebuild (`npm run build`), reload the unpacked extension, reload the IG grid, then
re-run the same rAF scroll benchmark with overlays visible: expect avg frame
≤ ~10 ms and 0 frames > 25 ms, overlays still rendering (count > 0).

### Result (verified live 2026-07-24, v0.58.3 running)

Same page, same benchmark, 28 rails + 84 buttons visible, 0 blur surfaces left,
rail bg `rgba(0,0,0,.62)`:

| | before (0.58.2) | after (0.58.3) |
|---|---|---|
| avg frame | 68.3 ms | **8.3 ms** |
| p95 frame | 96.2 ms | **9.3 ms** |
| frames >25 ms | 49/52 | **0/421** |

Identical to the overlays-hidden baseline — the overlays are now free.
`npm run build` clean; 93/93 vitest pass; built bridge contains zero
`backdrop-filter` occurrences.
