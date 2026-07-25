import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "socialMate",
  short_name: "socialMate",
  description:
    "Semi-automated Facebook / Instagram / TikTok research + warming from a side panel — paced, human-started, with live log.",
  version: "0.65.0",
  version_name: "0.65.0 — dead-code sweep (-39.5MB assets), offscreen idle release (~300MB), leak + hot-path fixes",
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  action: {
    default_title: "socialMate (open side panel)",
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
  permissions: ["storage", "unlimitedStorage", "activeTab", "sidePanel", "tabs", "webRequest", "declarativeNetRequest", "offscreen", "downloads", "scripting"],
  host_permissions: [
    "*://*.facebook.com/*",
    "*://*.instagram.com/*",
    "*://*.tiktok.com/*",
    "*://*.fbcdn.net/*",
    "*://*.cdninstagram.com/*",
    "*://*.pinterest.com/*",
    // Pin images are downloaded by fetching them in the SW (FBW_DL_MEDIA kind:"image").
    "*://*.pinimg.com/*",
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
    // FB reels-tab grid capture (DOM tiles + embedded JSON) → panel Reels Sort.
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/fb/reels-capture.js"],
      run_at: "document_idle",
    },
    // FB comment scraper — floating button on reel/post permalinks → JSON export.
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/fb/comments-scrape.js"],
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
    // TikTok capture: MAIN-world fetch/XHR response tee (document_start) + isolated
    // bridge. TikTok parses API responses with fetch().json() (native), so — unlike
    // IG — a JSON.parse hook sees nothing; we tee the fetch responses instead.
    {
      matches: ["*://*.tiktok.com/*"],
      js: ["src/content/tt/tt-capture.js"],
      run_at: "document_start",
      world: "MAIN",
    },
    {
      matches: ["*://*.tiktok.com/*"],
      js: ["src/content/tt/tt-relay.js"],
      run_at: "document_idle",
    },
    // Pinterest: single ISOLATED script, no MAIN-world hook. Pinterest's /resource/*
    // API is unsigned + cookie-auth, so we call it directly and paginate whole boards
    // instead of scraping whatever the user happened to scroll past.
    {
      matches: ["*://*.pinterest.com/*"],
      js: ["src/content/pin/pin-api.js"],
      run_at: "document_idle",
    },
  ],
});
