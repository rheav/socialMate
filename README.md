# socialWarmer

Manifest V3 Chrome extension that semi-automates **research + warming on Facebook**
from a side panel. Built with **CRXJS + React + Tailwind + shadcn-style components**
(JSX, no TypeScript). The verified vanilla **content-script engine** (`src/content.js`)
drives facebook.com via ARIA roles + accessible names. No backend, no auth — local only.

Feeds the top of the **UGC Factory** funnel: find/collect reference reels & posts.

## Build & load

```bash
npm install
npm run build      # outputs dist/
# or: npm run dev  (Vite + HMR; still load dist/)
```

Then in Chrome:
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the **`dist/`** folder (not the project root).
3. Click the toolbar icon → the **side panel** opens.
4. Open a Facebook tab (logged into the fan-page account), pick a mode + N, **Start**.

> Remove any previously-loaded copy of this extension first. After code changes,
> re-run `npm run build` and hit the reload button on the extension card.

## Modes

| Mode | What it does |
|------|--------------|
| **Reels** (C) | Open reels → dwell each → act → advance via `Next Card`, up to N. |
| **Feed** (B) | Home feed → human scroll → process N posts. |
| **Keyword** (A) | A keyword or `#hashtag` → opens the exact search/hashtag results → process N posts. |

## Actions (per item, toggleable; Like/Follow probabilistic by personality)

- **Save** — ✅ works on **reels** (`Menu → Video options → Save reel`) **and posts**
  (`Actions for this post → Save post →` confirm the **Done** modal). Verified live
  (items appear in `facebook.com/saved`).
- **Like** — ✅ reels + posts (`Like → Remove Like`).
- **Follow** — `Follow <author>` button.
- **English-only posts** — optional filter; skips posts whose text isn't English
  (rejects Arabic / Burmese / CJK / Cyrillic, requires Latin + English stopwords).

## Control surface (side panel, shadcn)

- Mode tabs (Reels / Feed / Keyword) + keyword input for Mode A.
- Target **N**, personality, action switches (Save / Like / Follow), English-only switch.
- Pacing (collapsible): action delay min/max, reel dwell min/max, session time cap.
- **Start / Pause / Stop**.
- Live counters (done / saved / liked / followed) + timestamped **log** + status badge.
- **Auto-halt banner** on login wall / checkpoint / captcha / rate-limit / selector-loss.

## Pacing & safety

- Human-started; randomized delays (default 4–9s action, 6–15s reel dwell, tunable).
- Auto-halts + banner on stop conditions; items processed once per run; N is a ceiling;
  optional session time cap.

## Project layout

```
manifest.config.js     CRXJS manifest (source of truth)
vite.config.js         Vite + @crxjs/vite-plugin + React
tailwind.config.js     Tailwind + shadcn theme tokens
index.html             side-panel React entry
src/
  main.jsx, App.jsx    side-panel cockpit (React + shadcn)
  index.css            Tailwind + shadcn CSS variables
  components/ui/*.jsx   shadcn components (button, card, input, label, badge, switch, tabs)
  lib/utils.js         cn() helper
  content.js           the FB engine (modes, actions, pacing, log, safety, selectors)
  background.js        opens the side panel on toolbar click
dist/                  built extension (load this)
```

## Notes / limits

- **No commenting** (out of scope).
- Mode A covers search **posts** (reels-search not included).
- Selectors target ARIA roles + accessible names (FB's obfuscated classes rotate and are
  never used). If FB changes its DOM, fix selectors in `src/content.js`.
- Automating engagement is against Meta's ToS and carries account-action risk. Operate on
  fan-page accounts you own; pacing + stop controls keep it cautious.
```
