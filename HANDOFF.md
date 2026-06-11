# socialWarmer — Handoff & Multi-Platform Build Brief

Handoff for the next AI/engineer. The extension now warms **Facebook, Instagram, and
TikTok** behind a **platform switcher**. Read §0 first (current status + immediate next
task), then the rest for verified selectors, patterns, and methodology.

> Project root: `~/Code/extensions/social-warmer/fb-warmer/`
> Original reverse-engineered reference: sibling `~/Code/extensions/social-warmer/social-flow/`
> (bundled/minified; beautify with `npx js-beautify content.min.js -o /tmp/sf.js`).

---

## 0. Current status (v0.5.1) & immediate next task

### Done since the original brief
- **Version discipline:** bump `version` in BOTH `manifest.config.js` + `package.json`
  on every code change, then `npm run build` (enforced by `.cursor/rules/bump-version.mdc`).
  Currently **0.5.1**.
- **Manifest:** `host_permissions` + `content_scripts` now cover `*.facebook.com`,
  `*.instagram.com`, `*.tiktok.com`. One content script injected on all three.
- **Platform switcher** (`src/components/ui/PlatformSwitcher.jsx`): three brand-logo
  buttons top-right of the header; active logo fills the active platform's gradient
  (`#sw-grad`) + glows. Inactive = muted gray. Disabled while a run is active.
- **Per-platform config** (`src/lib/platforms.jsx`): brand SVG glyphs (FB/IG/TikTok),
  per-platform supported `modes` (+ tab labels), `defaultMode`, `keywordPlaceholder`,
  and a `theme` (CSS-var bundle). Switching platform resets `mode` to that platform's
  default and re-resolves the target tab.
- **Per-platform theming:** each platform carries a `--sw-*` CSS-var bundle applied to
  `<html>` on switch (`App.jsx` effect). One swap retints logo/title/Start/badge/
  scrollbars/glow/body-wash + shadcn `--primary`/`--ring`. Toggle fill uses a dedicated
  `--sw-switch` (tuned for contrast vs the white thumb: FB blue, IG pink→purple,
  TikTok red — NOT the pale gradient ends).
- **Engine refactor** (`src/content.js`): shared core (state/pacing/safety/counters/
  persistence/resume) + per-platform **ADAPTERS**. `platformForHost()` is the selector
  source of truth. One generic `videoLoop(adapter)` drives FB reels / IG reels+explore /
  TikTok For-You+search; FB keeps its `postsLoop` for A/B. Added social-flow safety
  patterns: consecutive like/follow caps + cooldown, resume-if-paused, end-of-results
  reload (TikTok search). Session key still `fbw_session` (+`platform` field); resume
  guards by host↔platform. Panel message names kept `FBW_*`.
- **Panel** (`App.jsx`): `resolvePlatformTab(platform)`, per-platform tab list, keyword
  placeholder, noTab copy, and a per-mode hint line.

### 🌐 CRITICAL: selectors are LOCALE-dependent
The test account is **pt-br**. IG/FB use **localized aria-labels** (Like=`Curtir`,
Save=`Salvar`→`Remover`, Follow=`Seguir`→`Seguindo`, next=`Navegar para o próximo reel`,
play=`Pressionar para reproduzir`). English-only selectors silently no-op. Fix added: a
multi-locale **`L` dictionary** in `content.js` (en+pt+es/fr/it seeds) + `nameOf/inSet/
findByName` helpers; IG adapter now matches via `L`. **TikTok is language-independent**
(uses `data-e2e`). ⚠️ **FB adapters are still English-only** — extend with `L` if you hit
a non-EN FB account.

### ✅ Verified this pass (v0.5.4)
- **Instagram (logged in, pt-br):** Save **VERIFIED** live (`Salvar`→`Remover`, persists in
  /saved); Follow selector mapped (`Seguir` `div[role=button]`, click mechanism proven by
  Save — not clicked to avoid a junk follow); Like/advance/resume now locale-aware.
- **TikTok (logged in, v0.5.5):** Favorite **VERIFIED** — count increments on click (TikTok
  keeps the "Adicionar aos favoritos" label and only bumps the count, so there's no clean
  label flip; treat click as success). Follow **VERIFIED** — the icon morphs `+`↔`✓` and it
  works via a **synthetic content-script click** (toggled on then off in testing). Feed
  hooks `like-icon`/`favorite-icon`/`feed-follow`; detail `browse-*`; liked-state via icon
  color (red).

### ⚠️ Still to do
- **Instagram modes A/B:** explore/hashtag enumeration still best-effort ("like the
  centered reel while scrolling") — map the grid like FB posts.
- **FB:** make selectors locale-robust via `L` if non-EN accounts are in scope.
- **UI (v0.5.6):** STANDARDIZED — one white/black UI for all three platforms. Only the
  **logo squircle**, the **"socialWarmer" wordmark**, and the **active switcher icon (+glow)**
  carry the platform brand gradient (`--sw-from/--sw-to/--sw-grad/--sw-glow`). Everything
  else is neutral black-on-white via a shared `NEUTRAL` bundle in `platforms.jsx`
  (`--sw-action/--sw-switch/--sw-wash/--primary/--ring/--radius`). English-only defaults ON.

### ✅ DONE (v0.5.2) — native per-platform UI
Captured real tokens live via Playwright (IG action `#0095F6`/brand pink `#E1306C`,
system font, white bg, radius ~8px; TikTok `#FE2C55`, `TikTokFont`, radius 4px, bold,
white bg). Restyled with restraint: **brand gradient reserved for the logo only**
(`--sw-from/--sw-to` + glow); every action (Start/badge/title/counters/tabs/switch/
scrollbar) uses **one solid accent** via new `--sw-action`/`--sw-action-hover` — FB keeps
its blue gradient, **IG = solid pink `#E1306C`**, **TikTok = solid red `#FE2C55`**.
Per-platform `--radius` (FB .75 / IG .6 / TT .4rem) + cleaner near-white `--sw-wash`.
All in `lib/platforms.jsx` THEMES + `index.css`. Kept Outfit-300 lightness. Verified by
screenshotting all three panels.

### 🎯 IMMEDIATE NEXT TASK — verify IG/TikTok Save/Follow LIVE (Playwright, logged in)
The engine adapters for IG/TikTok Save/Follow (+ IG explore/hashtag, TikTok search
enumeration) are still `[BEST-EFFORT]` guesses (see "Still UNVERIFIED" above). Map them
live with the §5 methodology and replace the guesses, verifying each persisting action
authoritatively (bookmarks/saved page or label flip). THEN the older native-UI polish
notes below are obsolete — kept for reference:
1. With the **logged-in** Chrome, use Playwright to open instagram.com and tiktok.com.
   Screenshot key surfaces (reels/for-you, buttons, headers) and extract real design
   tokens via `getComputedStyle` — font stacks, primary button color + radius, surface
   bg, border colors, spacing. (IG primary action blue is ~`#0095F6`; TikTok primary red
   is `#FE2C55` — confirm live.)
2. Restyle per platform with restraint (real apps lead with ONE accent + neutral
   surfaces, not a rainbow): reserve the brand gradient for the logo/identity only; use
   the platform's real primary for the Start button + actionable accents; match the
   native font feel and button radius. Drive it all through the existing `--sw-*` vars in
   `platforms.jsx` (add vars if needed) so it stays a single per-platform bundle.
3. Keep the "Unfunnelizer" lightness (weight 300, airy) but make IG read clean-white/
   pink-accent and TikTok read crisp-white/red-accent. Bump version + rebuild.

> Note: a Playwright MCP browser-profile lock blocked live capture in the Cursor session
> (`Browser is already in use … mcp-chrome-…`). Continue in Claude Code where Playwright
> is attached to the logged-in browser.

---

## 1. What exists today

A Manifest V3 Chrome extension, **CRXJS + React + Tailwind + shadcn (JSX, no TypeScript)**.
A vanilla content-script engine drives facebook.com; a React side panel is the cockpit.

**Build / load:**
```bash
npm install
npm run build          # → dist/   (npm run dev for HMR)
node scripts/gen-icons.mjs   # regenerate PNG icons from public/icon.svg
```
`chrome://extensions` → Developer mode → **Load unpacked → `dist/`** (not the project root).

**File layout:**
```
manifest.config.js     CRXJS manifest (source of truth; icons, perms, content_scripts)
vite.config.js         Vite + @crxjs/vite-plugin + React
(Tailwind v4 — CSS-first; NO tailwind.config.js / postcss.config.js. Theme lives in
                       src/index.css via @import "tailwindcss" + @theme inline; plugin = @tailwindcss/vite)
index.html             side-panel React entry
public/icon.svg        master icon (flame on blue squircle); icons/*.png generated
scripts/gen-icons.mjs  resvg rasterizer (ImageMagick mangles gradients — use resvg)
src/
  main.jsx, App.jsx    side-panel cockpit (platform state, theme apply, tab resolve)
  index.css            Tailwind + shadcn vars + `--sw-*` themed gradient/glow/switch helpers
  components/ui/*.jsx   button, card, input, label, badge, switch, TabNav, PlatformSwitcher
  lib/utils.js         cn()
  lib/platforms.jsx    per-platform config: brand glyphs, modes, themes (`--sw-*` bundles)
  content.js           THE ENGINE — shared core + per-platform ADAPTERS (FB/IG/TikTok)
  background.js        opens side panel + action badge (watches chrome.storage)
.cursor/rules/bump-version.mdc   always bump version on changes (alwaysApply)
```

**Engine architecture (`src/content.js`) — keep this shape, generalize per platform:**
- Single global state `S` (run config + counters + log + safety). Persisted to
  `chrome.storage.local["fbw_session"]`; resumes across reloads/navigations.
- **Message API** (panel → content): `FBW_START {settings}`, `FBW_TOGGLE_PAUSE`,
  `FBW_STOP`, `FBW_STATUS` (returns a snapshot the panel polls every 1s).
- **Modes:** `A` keyword/#hashtag (navigates to search), `B` feed (scroll N posts),
  `C` reels (dwell each, advance N).
- **Actions** (per item, toggleable; Like/Follow probabilistic by personality):
  `save`, `like`, `follow`, plus an `englishOnly` post filter (heuristic).
- **Personalities** BINGE/CASUAL/ENGAGED → likeChance/followChance.
- **Pacing:** randomized delays (default 4–9s action, 6–15s reel dwell), tunable.
- **Safety:** `detectStop()` halts on login wall / `/checkpoint` / captcha / rate-limit
  text / `MISS_LIMIT` (6) consecutive selector misses → sets `haltReason`, shows banner.
- **Counters:** processed/saved/liked/followed/skipped + live log ring buffer (120).
- **Badge** (`background.js` via `chrome.storage.onChanged`): running→azure count,
  paused→amber "II", halted→red "!", idle→clear.

**Side panel (React/shadcn):** mode `TabNav`, keyword input (Mode A), target N,
personality select, action switches, English-only switch, collapsible pacing,
Start/Pause/Stop, counter cards, dark mono live log, status badge, halt banner.

---

## 2. Verified Facebook DOM facts (live-tested via Playwright, logged in)

Target **ARIA roles + accessible names** — never FB's obfuscated `x1i10hfl …` classes
(they rotate). All confirmed working with programmatic `.click()` unless noted.

| Thing | Selector / method |
|---|---|
| Post enumeration | anchor on unique `[role="button"][aria-label="Leave a comment"]` per post |
| Post action bar | nearest ancestor of comment btn containing `[aria-label="Like"]` + `[aria-label^="Send this to friends"]` |
| Post root | ancestor containing `[role="button"][aria-label^="Actions for this post"]` (the `…` menu) |
| Post Like | `[role="button"][aria-label="Like"]` in action bar → flips to `aria-label="Remove Like"` |
| Reel scrubber | `div[role="slider"][aria-label="Change Position"]` — progress = `aria-valuenow / aria-valuemax` (NOT the inner width-div, which is always 100%) |
| Reel active container | walk up from scrubber to node with `[aria-label="Like"\|"Remove Like"]` |
| Reel Like | same Like/Remove Like button inside active container |
| Reel advance | `div[role="button"][aria-label="Next Card"]` |
| **Reel Save** | kebab `[role="button"][aria-label="Menu"][aria-haspopup="menu"]` → `[role="menu"]` "Video options" → **`role="menuitem"` "Save reel"** → reopens as "Unsave reel" |
| **Post Save** | `…` menu → `[role="button"]` row "Save post/video" → **opens a modal; click `[role="button"][aria-label="Done"]`** (DO NOT press Escape — that cancels). Post menus do NOT relabel; verify via `facebook.com/saved` |
| Follow | `[role="button"]` with accessible name `Follow <author>` (matches `/^follow\b/i`) |
| Sponsored skip | best-effort: element with exact text `"Sponsored"` (FB obfuscates it, so some ads slip through) |

**Critical learned nuances:**
- Programmatic `.click()` works on **action-bar buttons** and **`role=menuitem`** rows
  (reels), but FB **post `…` menu rows are `role="button"`** and only "complete" the save
  after the **Done modal** is clicked. Always verify a destructive/persisting action with
  an authoritative check (the label flip, or the Saved page), not assumptions.
- Liked-state self-correct: read label → click → re-read; count only if it changed from
  `Like`. Skip items already reacted.
- **English heuristic** (`isEnglish`): reject if non-Latin chars (Arabic/Burmese/CJK/
  Cyrillic ranges) exceed ~25% of Latin chars; require ≥12 Latin chars + an English
  stopword. Post text via `[data-ad-comet-preview="message"]` or longest `[dir="auto"]`.

---

## 3. What social-flow does for Instagram & TikTok (study, then improve)

Source: beautified `social-flow/content.min.js`. social-flow only **watched + liked**
reels/videos on IG/TikTok — **no Save, no Follow, no keyword/feed modes**. Use its
selectors + orchestration as a starting point; everything else must be mapped live.

### Instagram (`B` module) — reels only
- **Gate:** runs on `/reels` or `/reel/`; else generic scroll.
- **Active reel:** among `<video>`, the playing one (`!paused && currentTime>0`), else
  nearest viewport center.
- **Progress:** `video.currentTime / duration`; finished if `ended`,
  `duration-currentTime ≤ 0.75`, or ≥75%.
- **Like:** walk ≤15 ancestors from video to node with
  `svg[aria-label="Like"\|"Unlike"][role="img"]`; click enclosing `button`/`role=button`.
  Liked = `svg[aria-label="Unlike"]` present.
- **Advance:** `div[role="button"][aria-label="Navigate to next Reel"]`; fallback
  `[aria-label="Reels navigation controls"]` → 2nd button.
- **Resume if paused:** `div[role="button"][aria-label="Press to play"]`.
- Watch modes full/partial/early; 60s cap; 12s stall.

### TikTok (`C` module) — multi-surface, most sophisticated
- **Page-type dispatch:** For You (`/`,`/foryou`), search (`/search`), explore grid
  (`/explore`,`/tag`), video detail (`/@user/video/<id>`), default.
- **Progress (3 fallbacks, take max):** seek text `"0:05 / 0:12"`
  (`[class*="DivSeekBarTimeContainer"]`) + slider `aria-valuenow`/`aria-valuetext` +
  `video.currentTime`.
- **Like:** `button[data-e2e="browse-like"]` / `[aria-pressed][aria-label*="Like"]`.
- **Advance:** `button[data-e2e="arrow-right"]` / "Next For You" / scroll.
- **Search smarts:** cooldown 6.5–12s between watches + **consecutive-watch limit**;
  detect `"No more results"` / bottom-with-no-new-tiles ×3 → **reload page** for fresh
  results.
- **Explore grid:** click a tile → run video-detail orchestrator → return.
- Skips **LIVE**; counts a watch only at ≥90% progress.

### Patterns worth adopting for ALL platforms (not in current FB engine)
1. **Cooldowns + consecutive-action limits** (cap N likes/follows in a row, then wait) —
   biggest safety win, low effort.
2. **End-of-results reload** (no new content after K scrolls → reload to refresh).
3. **Page-type dispatch** per surface (clean way to grow surfaces).
4. **Resume-if-paused** nudge for reels.
5. **Multi-fallback progress read** (slider + text + `<video>`).
6. **Skip non-standard content** (LIVE / "Suggested").

---

## 4. Multi-platform build spec — ✅ IMPLEMENTED (kept for reference)

> This section was the original next task. It is now built (see §0). The notes below
> remain accurate as the design/spec of what shipped; the OPEN items are the
> `[BEST-EFFORT]` selectors + native-UI polish called out in §0.

### 4a. Platform switcher UI (side panel, top-right)
- Three brand-logo buttons **top-right of the header**: **Facebook, Instagram, TikTok**.
- The **active platform's logo glows in the blue gradient** (`#3C7CFC → #59C0E8`):
  fill the logo with the gradient (SVG `fill` via gradient/mask or `grad-blue-text`-style
  clip) + `filter: drop-shadow(0 0 6px rgba(60,124,252,.55))`. Inactive logos are muted
  gray (`text-muted-foreground`), no glow, slight opacity; hover lifts opacity.
- **Icons:** lucide-react is the default for UI icons, BUT lucide has `Facebook` and
  `Instagram` only — **no TikTok**. Use brand SVGs for the platform logos (e.g.
  `simple-icons` paths or hand-inlined SVGs); this is an accepted exception for brand
  marks. Keep all other UI icons on lucide-react.
- Switching platform sets `state.platform` ('facebook'|'instagram'|'tiktok'), resets the
  mode/config to that platform's supported set, and the panel reflects which
  modes/actions each platform supports.

### 4b. Engine: route by `platform` + `mode`
- Add `platform` to settings + persisted state + snapshot.
- Refactor `content.js` into per-platform selector/orchestrator modules behind a common
  interface (mirror social-flow's platform dispatch object), e.g.
  `findItems()`, `like(item)`, `save(item)`, `follow(item)`, `advance()`,
  `progress()`, `resume()`, `isEnd()`. Keep the shared run loop, pacing, counters,
  safety, persistence.
- **Manifest:** add `host_permissions` + `content_scripts` matches for
  `*://*.instagram.com/*` and `*://*.tiktok.com/*`. The side panel works on any of the
  three; `resolveFbTab()` → generalize to `resolvePlatformTab(platform)`.
- Mode support differs per platform — propose:
  - **Facebook:** A keyword, B feed, C reels (done).
  - **Instagram:** C reels (known), B feed/explore (map), A hashtag `/explore/tags/<tag>` (map).
  - **TikTok:** C For-You/reels, A search/hashtag (`/search`, `/tag/<tag>`), B = n/a or "following" feed.

### 4c. MUST map live (unknown — social-flow never did these)
Use the **same methodology that worked for Facebook** (see §5):
- **Instagram:** Save (bookmark) flow + its confirm/collection modal; Follow button;
  feed/explore post Like (svg-based); hashtag page structure.
- **TikTok:** Save/Favorite (bookmark) flow; Follow button; search-result enumeration;
  language filter feasibility.
- Verify each persisting action authoritatively (saved/bookmarks page, or label flip),
  never assume a click "took".

### 4d. State/UX wiring
- Per-platform persisted session keys (`sw_session__<platform>`), or include `platform`
  in the single key and guard resume by hostname↔platform.
- Badge logic unchanged (reads the running session regardless of platform).
- English-only filter applies to post text where available (FB/IG); for TikTok captions
  map the caption node first.

---

## 5. Methodology for mapping new DOM (use this, it works)
1. Drive the **already-logged-in** Chrome via Playwright MCP (you cannot click the
   extension side panel from the harness — operate the page directly to map, or drive the
   panel by opening `chrome-extension://<id>/sidepanel.html` as a tab).
2. Inspect by **role + accessible name**; walk up from a unique anchor to the item root.
3. For any persisting action (save/follow/like): read state → click → **re-read / check
   the authoritative page**. If it didn't persist, look for a **confirm modal** (FB posts
   needed a `Done` button) or a different activation (menu rows vs action buttons differ).
4. Bake selectors into ONE per-platform module so DOM churn = one file to fix.

---

## 6. Design system (match exactly — "Unfunnelizer" feel)
- **Gradient:** `linear-gradient(135deg, #3C7CFC 0%, #59C0E8 100%)` (azure→seafoam).
  Helpers in `index.css`: `.grad-blue`, `.grad-blue-text`. Used on logo, Start button,
  running badge, **switch checked fill**, scrollbars, gradient title/counters.
- **Font:** Outfit (bundled `@fontsource/outfit`), **light weight 300**. Keep everything
  light — buttons/headings/tabs inherit; lean on color/size/gradient for hierarchy, NOT
  bold weights. (Earlier feedback: text was too bold — fixed by inheriting 300/400.)
- **Background:** airy `radial-gradient(130% 90% at 50% -20%, #e9f2ff, #f6f9ff, #fff)`.
- **TabNav pattern** (`components/ui/TabNav.jsx`): collapsed icons; active (and hovered)
  tab expands its label (`max-w` + opacity transition), bottom-border, `bg-primary/10`
  active. Reuse for platform tabs if desired, but platform switcher is icon-only glow.
- Tokens: `--primary: 220 97% 61%` (= #3C7CFC), `--radius: 0.75rem`. Dark-mode tokens
  exist; dark mode not yet wired.

---

## 7. Backlog (after IG/TikTok) — from earlier discussion
- **Metadata export** (author/permalink/text/counts/media URL → JSON/CSV or UGC Factory
  DB) — the real "research" payload; brief-deferred v2.
- Save-to-named-collection; persist settings + niche presets; daily budget + scheduling;
  cross-session dedup; run history/stats + export log; completion notification; dark mode;
  selector health-check.

---

## 8. Constraints / notes
- No commenting (out of scope).
- Meta/IG/TikTok automation violates ToS — user runs on **fan-page / owned accounts** and
  accepts the risk. **Do not lecture**; just keep pacing + stop controls.
- Niche being warmed: **tarot / astrology / card reading**.
- Keep it simple — user explicitly rejected over-engineering (no separate SW orchestrator;
  engine stays content-script-driven).

---

## 9. Next tasks (prioritized checklist)

Do these in Claude Code with Playwright attached to the **logged-in** Chrome. Bump the
version + `npm run build` after each chunk (see §0).

### A. Native per-platform UI polish (IG + TikTok) — FB is fine, leave it
The panel looks "cheap" because every platform gets the same rainbow-gradient treatment.
Real apps lead with ONE accent over neutral surfaces. Reserve the brand gradient for the
logo/identity only; everything actionable uses the platform's real primary.
- [ ] Open instagram.com + tiktok.com in Playwright; screenshot reels/for-you, headers,
      and primary buttons for reference.
- [ ] Extract real tokens via `getComputedStyle` on native buttons/surfaces: font stack,
      primary button bg + `border-radius`, surface bg, border color, text colors.
      Starting guesses to CONFIRM: IG primary `#0095F6`, TikTok primary `#FE2C55`.
- [ ] Add/adjust the per-platform `--sw-*` bundle in `src/lib/platforms.jsx` (e.g. a
      `--sw-primary-solid` + `--sw-radius` if needed) so Start button + accents use the
      native primary, not the gradient. Keep Outfit 300 lightness.
- [ ] IG → clean white + pink/blue accent; TikTok → crisp white + red accent. Confirm the
      switch/badge/tabs still read well per platform.

### B. Verify the `[BEST-EFFORT]` selectors LIVE (replace guesses)
Use §5 methodology: read state → click → re-read / check the authoritative page. Bake
confirmed selectors into the relevant adapter in `src/content.js`. Update the in-file
`[VERIFIED]`/`[BEST-EFFORT]` tags + the §0 list as you confirm each.
- [ ] **Instagram Save** (reel bookmark): confirm `svg[aria-label="Save"]` → enclosing
      button; verify item lands in `instagram.com/<you>/saved/`. Find the collection
      modal (if any) + its confirm button.
- [ ] **Instagram Follow**: confirm the `Follow` button selector on a reel/profile.
- [ ] **Instagram explore/hashtag (modes A/B)**: map real enumeration (grid → open →
      act → back), replacing the current "like centered reel while scrolling" stopgap.
- [ ] **TikTok Favorite/Save**: confirm `button[data-e2e="browse-favorite"]` (or actual
      hook) toggles + persists; verify in Favorites.
- [ ] **TikTok Follow**: confirm `button[data-e2e="browse-follow"]`.
- [ ] **TikTok search enumeration**: confirm tile→detail→advance(arrow-right)→reload-on-end
      flow against live search results.
- [ ] Re-confirm the social-flow-lifted selectors too (IG like/advance/resume, TikTok
      like/advance/LIVE-skip) — DOM may have drifted.

### C. Selector health-check harness (nice-to-have)
- [ ] A small Playwright script per platform that asserts each adapter selector resolves
      on the right surface, so DOM churn is caught fast. Document how to run it here.

### D. Then resume the §7 backlog
- [ ] Metadata export (the real "research" payload), persisted settings/niche presets,
      daily budget + scheduling, cross-session dedup, run history/stats, dark mode.
