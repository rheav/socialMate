import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "socialWarmer",
  short_name: "socialWarmer",
  description:
    "Semi-automated Facebook / Instagram / TikTok research + warming from a side panel — paced, human-started, with live log.",
  version: "0.31.0",
  version_name: "0.31.0 — Whisper→relevance (deep), spam/scam guard, soft-block backoff, cross-session dedup, run history",
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  action: {
    default_title: "socialWarmer (open side panel)",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },
  background: { service_worker: "src/background.js", type: "module" },
  side_panel: { default_path: "index.html" },
  // Whisper/onnxruntime + ffmpeg compile WebAssembly → needs wasm-unsafe-eval.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
  },
  permissions: ["storage", "activeTab", "sidePanel", "tabs", "webRequest", "offscreen", "downloads"],
  host_permissions: [
    "*://*.facebook.com/*",
    "*://*.instagram.com/*",
    "*://*.tiktok.com/*",
    "*://*.fbcdn.net/*",
    "*://*.cdninstagram.com/*",
  ],
  content_scripts: [
    {
      matches: [
        "*://*.facebook.com/*",
        "*://*.instagram.com/*",
        "*://*.tiktok.com/*",
      ],
      js: ["src/content.js"],
      run_at: "document_idle",
    },
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/transcription/inject.js"],
      run_at: "document_idle",
    },
    // Instagram capture: MAIN-world JSON.parse hook (document_start) + isolated bridge.
    {
      matches: ["*://*.instagram.com/*"],
      js: ["src/content/ig/main-world.js"],
      run_at: "document_start",
      world: "MAIN",
    },
    {
      matches: ["*://*.instagram.com/*"],
      js: ["src/content/ig/bridge.js"],
      run_at: "document_idle",
    },
  ],
});
