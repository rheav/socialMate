# socialMate

A Chrome MV3 side-panel extension for researching and warming social accounts across
**Facebook, Instagram, TikTok and Pinterest**. No backend, no auth, no account of
ours — everything runs locally in your browser and writes to your own disk.

The panel's UI is in Brazilian Portuguese. The code, comments and docs are English.

Two halves share the codebase:

1. **The warm engine** (`src/content.js`) — an autonomous, human-paced browse-and-engage
   session runner for Facebook, Instagram and TikTok. You start it; it watches reels or
   feed posts and probabilistically likes / reacts / saves / follows / comments, with
   randomised dwell times, breaks, cursor paths and hard safety caps.
2. **The research suite** — per-platform capture that reads what the page *already*
   fetched and turns it into sortable lists, bulk downloads, local Whisper transcripts
   and a cross-platform saved Library.

## Build and load

```bash
npm install
npm run build      # → dist/
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** →
select `dist/`. Click the toolbar icon to open the side panel.

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR (port 5173) |
| `npm run build` | Production build into `dist/` |
| `npm test` | Vitest suite |
| `npm run gen:inline` | Regenerate the inlined helpers (see below) |

### `npm run gen:inline` — run this after editing `src/lib/shared/`

An ES `import` inside a content script makes CRXJS emit a `*-loader.js` shim that
does `await import(chrome.runtime.getURL(...))` instead of a self-contained bundle.
In a MAIN-world script that dynamic import is subject to the **page's** CSP, which on
Facebook and Instagram can kill it and silently disable capture. So the capture
scripts must not import.

Shared pure helpers therefore live in `src/lib/shared/` and are copied into a marked
region of each content script at build time. `npm run build` and the test suite both
run the generator in `--check` mode and **fail** on a stale copy, so the page can
never quietly diverge from the unit-tested source. Details in
[`src/lib/shared/README.md`](src/lib/shared/README.md).

## The warm engine

Three modes, offered per platform:

- **A — Keyword / hashtag.** Navigates to the tag surface and works that feed.
- **B — Feed.** The normal home feed.
- **C — Reels.** The immersive reels/short-video viewer.

Four personalities set the engagement odds and break cadence: **Maratona** (binge),
**Casual**, **Engajada** (engaged), or random. Actions are opt-in per run (save,
like, follow), and commenting is off by default, phrase-pool driven and separately
capped.

Safety caps are hard-coded in `src/content.js` and enforced by the engine, not the UI:

| Cap | Value |
| --- | --- |
| Likes per hour (rolling) | 60 |
| Likes per author per session | 2 |
| Comments per hour | 10 |
| Comments per author per session | 1 |
| Consecutive likes before a cooldown | 8 |
| Consecutive follows | 5 |
| Consecutive selector misses before halting | 6 |
| Reactions that click but don't register before halting | 3 |

That last one is the soft-block detector: a click that lands but doesn't register is
Facebook's classic tell, so the run stops rather than keeps clicking into the void.
The engine also halts on a login wall, checkpoint, captcha or rate-limit interstitial.

A run survives navigation: the engine persists its state (including the rate-limit
ledger) and resumes after the page reloads. Live counters, a timestamped log and the
halt reason all surface in the panel.

## The research suite

Capture is **passive** on three of four platforms — the extension reads responses the
page fetched for itself and never forges a signed request. The practical consequence:
data only exists for content you actually opened.

| Platform | Tools | How it captures |
| --- | --- | --- |
| Facebook | Reels grid, comment scraper, photo bulk export | DOM reads, plus a MAIN-world XHR tee for full-resolution photos and a `webRequest` registry for video tracks |
| Instagram | Sort & download, stories/highlights | MAIN-world `JSON.parse` hook |
| TikTok | Sort & download, comments, stories, collections | MAIN-world fetch/XHR response tee |
| Pinterest | Board / search harvester | The only active one: calls Pinterest's own cookie-authenticated resource API |

Plus a cross-platform **Library** holding saved posts and local transcripts.
Transcription runs entirely on-device (Whisper via Transformers.js in an offscreen
document), preferring a platform's own caption track when one exists.

Every download lands under one tree:

```
~/Downloads/social-mate/
  facebook/   videos · fotos · miniaturas · comentarios · transcricoes
  instagram/  videos · imagens · miniaturas · transcricoes
  tiktok/     videos · imagens · miniaturas · comentarios · transcricoes
  pinterest/  videos · imagens
```

## Project layout

```
src/
  content.js              warm engine (FB + IG + TikTok), one injected script
  background.js           service worker: message router, downloads, track registry,
                          offscreen owner, sole writer of the saved Library
  content/
    fb/                   comment scraper, photo capture + scrape, reels grid
    ig/                   MAIN-world parse hook + isolated bridge/overlay
    tt/                   MAIN-world fetch tee + isolated relay/overlay
    pin/                  Pinterest resource-API client + overlay
    transcription/        on-page video rails, id resolution, auto-capture
  offscreen/              Whisper ASR + MiniLM embeddings + ffmpeg mux (WASM)
  components/
    Shell.jsx             panel shell: platform workspaces, live tab following
    tools/                one pane per tool
    ui/                   shared primitives (shadcn-style)
  lib/
    shared/               inlined into content scripts — see its README
    ...                   download paths, session math, zip writer, tab resolution
docs/
  ARCHITECTURE.md         how it all fits together
  IMPROVEMENT-BACKLOG.md  known defects and cleanups, prioritised
```

Stack: CRXJS + Vite 8, React 19, Tailwind 4, plain JavaScript (no TypeScript),
Vitest.

## Notes and limits

- Selectors target **ARIA roles and accessible names**, never Facebook's obfuscated
  class names (those rotate). Accessible names are localized, so the label
  dictionaries in `src/content.js` are per-locale — they match the *site's* language,
  not the panel's, and translating them breaks the engine.
- Passive capture means an empty tool is usually a precondition, not a bug: open the
  story, the playlist or the profile tab first.
- **Automating engagement is against Meta's ToS and carries account-action risk.**
  Operate on fan-page accounts you own. The pacing, caps and stop controls keep it
  cautious, but they do not make it safe.
