# `src/lib/shared/` — the inlinable helpers

Every module in this directory is **copied verbatim into content scripts at build
time** by `scripts/gen-inline.mjs`. That exists because of a hard constraint:

> **An ES `import` in a content script turns it into a dynamic-import loader.**

CRXJS emits a `*-loader.js` shim (`await import(chrome.runtime.getURL(...))`) for
any content script whose source has an import, and a plain self-contained IIFE for
any that doesn't. You can see the split in `dist/manifest.json`: `content.js` and
`pin-api.js` get loaders, the other nine are bundles. For a MAIN-world script that
dynamic import is subject to the **page's** CSP — Facebook's and Instagram's can
kill it, which silently disables capture. So the capture scripts must stay
import-free.

The old answer was to hand-copy the helpers and write "mirror of `src/lib/x.js`"
in a comment. Nothing enforced it and six copies had already drifted — the live
one being `comments-scrape.js`'s `parseCount`, which carried 5 locale unit words
where the tested lib has 13, so an Indonesian/Nordic/Polish reaction count like
`"1,2 rb"` parsed to `null` on the page while the unit tests were green.

## The rules

1. **No `import` and no `export default`** in this directory. Each declaration is
   `export const` / `export function`; the generator strips the `export ` keyword
   when it inlines. A module here may only reference its own declarations.
2. This is the **canonical** source. `src/lib/*.js` re-export from here so the
   panel and the unit tests use the exact same code the pages run.
3. Content scripts carry a generated region:

   ```js
   // <<< inline:src/lib/shared/counts.js
   ...generated...
   // >>> inline:end
   ```

   Never edit inside it. Edit the module here and run `npm run gen:inline`.
4. `npm run build` and the test suite both run the generator in `--check` mode, so
   a stale region is a loud failure instead of a silent divergence.
