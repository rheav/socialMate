// @ts-nocheck
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://socialradar.pages.dev", // shortcut: placeholder until a domain is chosen; also siteUrl in src/i18n/ui.ts

  // One served URL per page, no trailing slash: /privacy -> privacy.html.
  // Cloudflare Pages serves *.html without the extension, so canonical,
  // hreflang and sitemap URLs never hit a redirect.
  trailingSlash: "never",
  build: { format: "file" },

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [
    react(),
    sitemap({
      // Localized 404 pages are not content.
      filter: (page) => !/\/404$/.test(page),
      i18n: {
        defaultLocale: "pt-br",
        locales: {
          "pt-br": "pt-BR",
          en: "en",
        },
      },
    }),
  ],
});
