# socialWarmer — Landing Page Design System

Design language for the socialWarmer marketing site. Ported from the Mail
Warmer Astro landing (soft analog atmosphere, pure-CSS "html gif" feature
loops), re-skinned to socialWarmer's **blue→cyan** identity gradient with
**ember-orange** warmth accents pulled from the extension UI.

> **Core idea inherited:** nothing on this page is a video. Every product
> demo is a *real CSS state machine* looping live — feeds scroll, videos
> watch, likes pop. Cheap to ship, never buffers, scales crisp.

## 1. Brand foundations

| Token | Hex | Use |
|-------|-----|-----|
| `--color-canvas` | `#f6f8fc` | Page background |
| `--color-blue` | `#3c7cfc` | **Primary accent** (extension `--sw-from`) |
| `--color-cyan` | `#59c0e8` | Gradient partner (extension `--sw-to`) |
| `--color-warm-2` | `#f59e3c` | Ember warmth accent (extension `--sw-ember`) |

**Rule:** blue/cyan carries action and trust (matches the in-product side
panel's `--sw-grad`). Ember orange is reserved for *warmth moments* — the
accent word, the running pulse, ambient sparks. Never let ember compete with
blue for the CTA.

- **Sans:** Outfit Variable. Headings 500 weight, -0.025em tracking.
- **Accent word:** one highlighted word per heading, ember orange→amber
  animated gradient clipped to text (`.accent-word`).
- **Logo:** the extension's flame droplet at `/logo.png` (copied from
  `public/icons/icon-256.png` — single source of truth).
- **Atmosphere:** grain overlay, breathing blobs, `FloatingEmbers` (rising
  flame sparks, the steam analog), reveal-on-scroll. All collapse under
  `prefers-reduced-motion`.

## 2. Page structure

```
Layout (grain + embers + reveal script)
 └ Navbar          floating pill, blue→cyan "Add to browser" CTA
 └ Hero            headline w/ ember "warm", dual CTA, trust line
 └ Scenarios       timeline of "the account goes invisible" story
 └ AppPreview      ★ BIG html-gif: FB feed + side panel warming run (12s loop)
 └ FeatureDemos    ★ 3 html-gif cards: persona dice · thresholds · bulk thumbs
 └ ClosingCTA      final warm nudge, single CTA
 └ FAQ             accordion, smooth height animation
 └ Footer          logo + links
Pages: /docs (sticky-sidebar reference) · /privacy · /terms
```

## 3. The html-gifs

- **AppPreview (`.ap-*`, 12s):** Chrome window, FB hashtag feed left, panel
  right. Start presses → feed scrolls per post → progress bar "watches" each
  video → ❤ pops on post 1, dice skip post 2, 🔖 pops on post 3 → log lines
  + counters tick → hold resolved ~25% → reset.
- **FeatureDemos (`.fd-*`, 10s, staggered 0/0.6/1.2s):**
  A. persona dice (watch marks vs one engage), B. thresholds (skip stamps +
  green checks driven by like-counts), C. thumbnail grid wave + saved counter.

## 4. Tech

Astro 5 + Tailwind v4 (`@theme` tokens) + `@lucide/astro` +
`@fontsource-variable/outfit`. One global stylesheet; demo machines live in
per-component `<style is:global>` blocks, class-prefixed so they can't leak.
