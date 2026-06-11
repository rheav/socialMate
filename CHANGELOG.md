# Changelog

All notable changes to socialWarmer.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — breaking engine reworks / storage-session schema breaks.
- **MINOR** — new features (platforms, modes, UI surfaces, adapters).
- **PATCH** — bug fixes, selector tweaks, copy/pacing-default updates.

Bump `version` in BOTH `manifest.config.js` and `package.json` on every code change
(keep them in sync — enforced by `.cursor/rules/bump-version.mdc`), set `version_name`,
then `npm run build` so `dist/manifest.json` reflects it.

> History before `0.5.1` is reconstructed from `README.md` / `HANDOFF.md`; dates are
> approximate. Entries from `0.5.1` on are taken from the handoff log.

---

## [0.8.2] — 2026-06-07

### Fixed
- Side panel no longer leaves a **white gap on the right** when the panel is wider than
  360px. `body` was locked to `width: 360px`, so the themed background wash (`--sw-wash`)
  only painted 360px and the rest of a resized panel showed bare white. Body now fills the
  panel (`width: 100%`, `min-width: 320px` — Chrome's side-panel floor) and content reflows
  to the available width.

---

## [0.8.1] — 2026-06-04

Mature multi-platform baseline (feature set as of this version; precise per-patch
boundaries for `0.6.x`–`0.8.x` not separately logged).

### Added
- **Detach to own window** — pop the bound platform tab into its own (unfocused) window so
  it keeps `visibilityState === "visible"` and Chrome won't throttle its timers; the run
  keeps scrolling while you work in other tabs.
- **Pacing controls** (collapsible) — action delay min/max, reel dwell min/max, and an
  optional session time cap (minutes, 0 = none).
- **Personality** select (Random / Binge / Casual / Engaged) driving Like/Follow
  probability and dwell.
- **English-only posts** filter for Facebook Feed/Keyword modes.
- Live counters (done / saved / liked / followed), timestamped log, ETA, and a status
  badge (idle / running / paused / halted) with an auto-halt banner on login wall /
  checkpoint / captcha / rate-limit / selector-loss.

### Changed
- Tab stays **locked to the bound tab by id** — switching browser tabs no longer drops the
  target; only a closed tab or a platform switch re-resolves it.

---

## [0.5.6] — 2026-06-04

### Changed
- **Standardized UI** — one white/black control surface for all three platforms. Only the
  brand identity changes per platform (logo gradient, wordmark color, glow, body wash);
  the rest of the chrome is neutral black/white.

---

## [0.5.5] — 2026-06-04

### Added
- **TikTok verified (logged in).** Favorite verified — count increments on click (TikTok
  keeps the "Adicionar aos favoritos" label and only bumps the count, so a click is treated
  as success). Follow verified via a synthetic content-script click (icon morphs `+` ↔ `✓`).
  Feed hooks `like-icon` / `favorite-icon` / `feed-follow`; detail view `browse-*`. TikTok
  selectors are language-independent (`data-e2e`).

---

## [0.5.4] — 2026-06-04

### Added
- **Instagram verified (logged in, pt-br).** Save verified live (`Salvar` → `Remover`,
  persists in `/saved`); Follow selector mapped (`Seguir` `div[role=button]`); Like / advance
  / resume made locale-aware.

### Fixed
- **Locale-dependent selectors.** Added a multi-locale `L` dictionary (en + pt + es/fr/it
  seeds) plus `nameOf` / `inSet` / `findByName` helpers in `content.js`; the IG adapter now
  matches via `L`. (FB adapters remain English-only — extend with `L` for non-EN FB
  accounts.)

---

## [0.5.2] — 2026-06-03

### Added
- Native **per-platform UI** — platform-specific theming applied via the `--sw-*` CSS-var
  bundle on `<html>` (later standardized in `0.5.6`).

---

## [0.5.1] — 2026-06-03

### Added
- **Multi-platform support** — Facebook, Instagram, and TikTok behind a **platform
  switcher** (`PlatformSwitcher.jsx`): three brand-logo buttons; the active logo fills the
  platform gradient and glows; disabled while a run is active.
- **Per-platform config** (`src/lib/platforms.jsx`) — brand SVG glyphs, supported `modes`
  (+ tab labels), `defaultMode`, `keywordPlaceholder`, and a `theme` CSS-var bundle.
- **Per-platform theming** — one swap retints logo / title / Start / badge / scrollbars /
  glow / body wash + shadcn `--primary` / `--ring`.

### Changed
- **Engine refactored to adapters** (`src/content.js`) — shared core (state / pacing /
  safety / counters / persistence / resume) + per-platform adapters. `platformForHost()`
  is the selector source of truth; one generic `videoLoop(adapter)` drives FB reels /
  IG reels+explore / TikTok For-You+search; FB keeps `postsLoop` for Feed/Keyword.
- Added safety patterns: consecutive like/follow caps + cooldown, resume-if-paused,
  end-of-results reload (TikTok search). Session key `fbw_session` gains a `platform`
  field; resume guards by host ↔ platform. Panel message names kept `FBW_*`.
- Manifest `host_permissions` + `content_scripts` extended to `*.facebook.com`,
  `*.instagram.com`, `*.tiktok.com` (one content script on all three).

---

## [0.1.0] — 2026-06-03

Initial **Facebook-only** build (MV3, CRXJS + React + Tailwind + shadcn-style components).

### Added
- Side-panel cockpit; vanilla content-script engine driving facebook.com via ARIA roles +
  accessible names (obfuscated FB classes never used).
- **Modes** — Reels (C), Feed (B), Keyword/#hashtag (A).
- **Actions** — Save (reels + posts), Like, Follow; English-only post filter.
- Human-started runs with randomized pacing (4–9s action, 6–15s reel dwell), per-run
  de-dup, N as a ceiling, and auto-halt on stop conditions.
- `background.js` opens the side panel on toolbar click. No backend, no auth — local only.
