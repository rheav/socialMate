import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import path from "path";
import manifest from "./manifest.config.js";
import { dropBundledOrtWasm } from "./src/build/dropBundledOrtWasm.js";

const PUBLIC = process.env.PUBLIC === "1";

export default defineConfig({
  define: { __PUBLIC__: JSON.stringify(PUBLIC) },
  plugins: [react(), tailwindcss(), crx({ manifest }), dropBundledOrtWasm()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    // Separate folder so a public build never overwrites the dist/ loaded unpacked.
    outDir: PUBLIC ? "dist-public" : "dist",
    rollupOptions: {
      // Extra HTML entry for the offscreen document (loaded via chrome.offscreen).
      input: { offscreen: path.resolve(__dirname, "src/offscreen/offscreen.html") },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
