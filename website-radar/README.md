# socialRadar website

Marketing site for socialRadar, the public build of the extension (Astro 5 + Tailwind 4,
static). Adapted from the unFunnelizer site; Cloudflare Pages-ready (`public/_headers`).

- `npm install`, then `npm run dev` / `npm run build` (output in `dist/`).
- pt-BR is served at the root; English lives under `/en`.
- Page copy: `src/i18n/translations/*.ts`; legal pages: Markdown in `src/content/legal/`.
- Product images: `public/images/shots/` are the store captures (`../docs/store/raw/`,
  synthetic data); `public/logo.svg` is `../public/icon-public.svg`.
- Served at https://socialradar.rheav.dev (`astro.config.mjs`, `src/i18n/ui.ts`).
- No analytics or tag manager: the only cookie is the theme.
