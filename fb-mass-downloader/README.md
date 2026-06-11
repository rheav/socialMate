# fbMassDownloader

A clean, custom-UI Chrome (MV3) extension for **bulk downloading Facebook videos and reels**.
It reuses the *exact* detection core from the original extension but wraps it in a 100%-custom UI and downloader.

## Architecture

Two execution worlds share the page `window` for `postMessage`:

| World | Files | Role |
|-------|-------|------|
| **MAIN** | `engine/prehook.js` → `engine/proxy.js` → `engine/vendors.js` → `engine/bridge.js` | The reused core + our engine bridge |
| **ISOLATED** | `content/loader.js` | Our Shadow-DOM UI + message relay |

### How detection works (reused core)
- `engine/proxy.js` (reused verbatim) hooks Facebook's internal module system (`window.__d`, Relay store, `RelayPublishQueue`). It patches `createRelayFBNetwork` so that whenever Facebook prefetches DASH video representations it calls `window.__setVideoRepresentations(...)`.
- `engine/prehook.js` runs **before** `proxy.js` and defines `window.__setVideoRepresentations` first. Because `proxy.js` defines it with `|| function`, **our** version is kept — letting us capture the full video **and** audio representations per `video_id` into `window.__FBMD.videos`.

### How download works (our code)
- `engine/bridge.js` turns captured representations into a clean list, downloads tracks via HTTP **byte-range** requests (2 MB chunks), and merges video + audio with **ffmpeg.wasm** (`@ffmpeg/ffmpeg` reused from `engine/vendors.js`, core in `ffmpeg/`). Same approach/command (`-c copy`) as the original.
- `content/loader.js` renders the panel (launcher + list + select-all + quality mode + progress) and talks to the bridge over `window.postMessage`.

## Install (dev)
1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open Facebook, play/scroll past videos, click the blue button (bottom-right), select, **Download**.

## Status / limitations
- **Iteration 1.** Detects videos via Facebook's DASH **prefetch** path (covers feed/watch/reel videos you actually scroll past or play). It does not yet replicate the original's exhaustive per-page-type `storeFinder` mapping (collections/playlists/group grids), which can be added later.
- ffmpeg merge runs client-side and is the slowest step for HD clips.
- Audio-only saves as `.m4a`; merged output is `.mp4`.

## Notes
No login, no paywall, no telemetry. `engine/proxy.js`, `engine/vendors.js`, and `ffmpeg/` are reused from the original extension; everything in `content/`, `popup/`, `engine/prehook.js`, and `engine/bridge.js` is original to this project.
