import { defineManifest } from "@crxjs/vite-plugin";

// @private
// PUBLIC=1 builds the open-source variant: no hub, no warm engine (docs/superpowers/plans/2026-10-26-public-build.md).
// The // @private lines below are only comments to Node; scripts/export-public.mjs drops them.
// @end-private
const PUBLIC = process.env.PUBLIC === "1";

const manifest = {
  manifest_version: 3,
  name: "socialMate",
  short_name: "socialMate",
  // @private
  description:
    "Pesquisa e aquecimento semiautomáticos de Facebook / Instagram / TikTok a partir de um painel lateral — ritmo humano, iniciado por você, com log ao vivo.",
  // @end-private
  version: "1.18.0",
  // @private
  version_name:
    "1.18.0 — Transcrição em espanhol",
  // @end-private
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  action: {
    default_title: "socialMate (abrir painel lateral)",
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
  // Every one of these is load-bearing, and each is an install warning, so the list
  // is worth re-auditing before any Web Store submission:
  //   storage/unlimitedStorage — the Library holds base64 thumbs (~10-20KB each) up
  //     to a 300-item cap, which is past the default quota. unlimitedStorage has no
  //     chrome.* call site by design; it only raises that ceiling.
  //   tabs + scripting — resolving the platform tab and the panel's one-click
  //     re-injection recovery. `activeTab` was ALSO listed and is redundant: the
  //     four host permissions below already authorise executeScript on every
  //     surface this extension touches.
  //   webRequest — read-only observer that builds the fbcdn DASH track registry.
  //   declarativeNetRequest — one session rule adding a Referer for TikTok's CDN,
  //     which fetch/downloads cannot set themselves (forbidden header).
  //   alarms — o tique da passada diária da área spy; um setTimeout não sobrevive à
  //     morte do worker.
  permissions: ["storage", "unlimitedStorage", "sidePanel", "tabs", "webRequest", "declarativeNetRequest", "offscreen", "downloads", "scripting", "alarms"],
  host_permissions: [
    "*://*.facebook.com/*",
    "*://*.instagram.com/*",
    "*://*.tiktok.com/*",
    "*://*.fbcdn.net/*",
    "*://*.cdninstagram.com/*",
    "*://*.pinterest.com/*",
    // Pin images are downloaded by fetching them in the SW (FBW_DL_MEDIA kind:"image").
    "*://*.pinimg.com/*",
    // @private
    // The socialMate hub (~/Code/apps/socialmate-hub): where the Arquivo is
    // pushed so it outlives the local caps. Any OTHER host the user points the
    // sync at is asked for at runtime — see optional_host_permissions.
    "https://socialmate.rheav.dev/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
    // @end-private
  ],
  // @private
  // Only requested when someone changes the hub URL in Opções to an arbitrary remote host.
  optional_host_permissions: ["https://*/*"],
  // @end-private
  content_scripts: [
    // @private
    {
      matches: [
        "*://*.facebook.com/*",
        "*://*.instagram.com/*",
        "*://*.tiktok.com/*",
      ],
      js: ["src/content.js"],
      run_at: "document_idle",
    },
    // @end-private
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/transcription/inject.js"],
      run_at: "document_idle",
    },
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/fb/video-capture.js"],
      run_at: "document_start",
      world: "MAIN",
    },
    // FB reels-tab grid capture (DOM tiles + embedded JSON) → panel Reels Sort.
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/fb/reels-capture.js"],
      run_at: "document_idle",
    },
    // FB research-feed engagement filter — hides the posts under the panel's
    // like/comment/share thresholds as the search or hashtag feed scrolls.
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/fb/feed-filter.js"],
      run_at: "document_idle",
    },
    // FB comment scraper — floating button on reel/post permalinks → JSON export.
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/fb/comments-scrape.js"],
      run_at: "document_idle",
    },
    // FB profile-photos capture: MAIN-world XHR tee (document_start) + isolated
    // harvester. The photos-grid GraphQL row carries `viewer_image.uri` — the
    // FULL, UNCROPPED photo — beside the square `image.uri` crop the tile paints,
    // so the whole frame is already on the wire while the grid scrolls. Only a
    // MAIN-world script can patch the page's XMLHttpRequest, which is the
    // transport the grid actually uses (17 XHR responses, 0 via fetch).
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/fb/photos-capture.js"],
      run_at: "document_start",
      world: "MAIN",
    },
    // The isolated half: relays the capture, scrolls the grid, answers the
    // panel's "Fotos" tool (bulk ZIP download). Message-driven only — it never
    // runs on a timer, so it costs nothing on a FB tab the user is only warming
    // or scraping comments on.
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/fb/photos-scrape.js"],
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
};

if (PUBLIC) {
  manifest.description =
    "Pesquisa de Facebook / Instagram / TikTok / Pinterest a partir de um painel lateral — tudo local, sem servidor.";
  // @private
  delete manifest.version_name;
  delete manifest.optional_host_permissions;
  manifest.host_permissions = manifest.host_permissions.filter(
    (h) => !/socialmate\.rheav\.dev|localhost|127\.0\.0\.1/.test(h),
  );
  // src/content.js is the warm engine.
  manifest.content_scripts = manifest.content_scripts.filter((c) => !c.js.includes("src/content.js"));
  // @end-private
}

export default defineManifest(manifest);
