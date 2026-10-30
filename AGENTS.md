# socialMate extension — agent guide

Chrome MV3 side-panel extension for researching and warming social accounts on
Facebook, Instagram, TikTok and Pinterest. Plain JavaScript, CRXJS + Vite 8 +
React 19 + Tailwind 4. The panel UI is pt-BR; code, comments and docs are English.

The repo directory name (`social-warmer/fb-warmer`) is historical. The backend it
pushes to lives in another repository: `~/Code/apps/socialmate-hub`.

## Read first

- `README.md` — what it is, build and load, the `gen:inline` rule.
- `docs/ARCHITECTURE.md` — processes, message catalog, storage registry, and the
  invariants you will break if you don't know them (section 6). Required reading
  before touching a content script or `background.js`.
- `src/lib/shared/README.md` — why content scripts cannot `import`.
- `CHANGELOG.md` — one entry per version.

## The spy area

Saved Instagram and Facebook profiles, measured once a day by this extension and
shown in the hub. Shipped: `src/background/spy.js`, `src/background/spyStories.js`
and `src/components/tools/SpyTool.jsx` here, the rest in the hub. The documents that
explain why live in the hub repository, because the feature spans both:

- `~/Code/apps/socialmate-hub/docs/superpowers/specs/2026-10-02-spy-area-design.md`
  — the design.
- `~/Code/apps/socialmate-hub/docs/research/2026-10-02-spy-area.md` — the map of
  both repositories, the two live probes, and the owner's working rules
  (section 8).

## Commands

```bash
npm run dev          # Vite dev server with HMR
npm test             # Vitest
npm run gen:inline   # after editing src/lib/shared/
npm run build        # → dist/ (runs gen-inline --check first)
```

`dist/` is what Chrome loads unpacked, so a build replaces the running extension's
files.

## Rules

- Tests and build green before every commit. Push only when asked.
- Bump the version in **both** `package.json` and `manifest.config.js`
  (`.cursor/rules/bump-version.mdc`), only after the change was checked live.
- One version per commit, annotated tag `v<version>`.
- No AI attribution in commits, PRs, comments or docs.
