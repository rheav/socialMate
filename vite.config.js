import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import path from "path";
import fs from "fs";
import manifest from "./manifest.config.js";
import { dropBundledOrtWasm } from "./src/build/dropBundledOrtWasm.js";
import { stripRegionsPlugin } from "./src/build/stripRegions.js";

const PUBLIC = process.env.PUBLIC === "1";

// public/ is copied whole; the warm engine's relevance model (23 MB) is its only user.
const dropWarmModel = {
  name: "drop-warm-model",
  apply: "build",
  closeBundle() {
    fs.rmSync(path.resolve(__dirname, "dist-public/models/Xenova/all-MiniLM-L6-v2"), { recursive: true, force: true });
  },
};

export default defineConfig({
  define: { __PUBLIC__: JSON.stringify(PUBLIC) },
  plugins: [stripRegionsPlugin(PUBLIC), react(), tailwindcss(), crx({ manifest }), dropBundledOrtWasm(), ...(PUBLIC ? [dropWarmModel] : [])],
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
