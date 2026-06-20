import { Film, Newspaper, Search } from "lucide-react";

// Brand marks (simple-icons paths). lucide lacks TikTok and uses a different
// visual language, so all three platform logos use brand SVGs for a consistent
// gradient-glow treatment. 24x24 viewBox, single path, currentColor fill.
export function FacebookGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" />
    </svg>
  );
}

export function InstagramGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0Zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227a3.81 3.81 0 0 1-.899 1.382 3.744 3.744 0 0 1-1.38.896c-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.219-.96-.474-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03Zm0 3.678a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm7.846-10.405a1.441 1.441 0 0 1-2.88 0 1.44 1.44 0 0 1 2.88 0Z" />
    </svg>
  );
}

export function TikTokGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
    </svg>
  );
}

// Mode catalog (shared ids; engine routes by platform+mode).
//   C = reels / for-you video    B = feed / explore    A = keyword / hashtag / search
const MODE = {
  C: { id: "C", label: "Reels", Icon: Film },
  B: { id: "B", label: "Feed", Icon: Newspaper },
  A: { id: "A", label: "Keyword", Icon: Search },
};

// Per-platform CSS-variable theme. Applied to <html> on switch so every
// gradient/primary/glow/wash retints at once (see index.css var consumers).
//   --sw-from / --sw-to : 2-stop accent (switch fill, logo glyph, glow base)
//   --sw-grad           : full background gradient (logo, Start, badge, scrollbar)
//   --sw-grad-hover     : hover variant
//   --sw-glow           : drop-shadow color for the active platform logo
//   --sw-wash           : side-panel body backdrop
//   --primary / --ring  : shadcn HSL tokens (cascade to focus rings, tabs, etc.)
// STANDARDIZED white/black UI for all platforms. The ONLY per-platform difference is
// the brand identity gradient (--sw-from/--sw-to/--sw-grad + --sw-glow) — used by the
// logo squircle, the "socialWarmer" wordmark, and the active switcher icon (+ glow).
// Everything else (Start/badge/toggles/tabs/rings/wash/radius) is neutral black-on-white.
const NEUTRAL = {
  "--sw-action": "linear-gradient(0deg, #18181b, #18181b)",
  "--sw-action-hover": "linear-gradient(0deg, #000000, #000000)",
  "--sw-switch": "linear-gradient(0deg, #18181b, #18181b)",
  "--sw-wash": "radial-gradient(130% 90% at 50% -20%, #f7f7f8 0%, #fcfcfd 55%, #ffffff 82%)",
  "--radius": "0.625rem",
  "--primary": "240 6% 10%",
  "--ring": "240 6% 10%",
};
const THEMES = {
  facebook: {
    ...NEUTRAL,
    "--sw-from": "#3c7cfc",
    "--sw-to": "#59c0e8",
    "--sw-grad": "linear-gradient(135deg, #3c7cfc 0%, #59c0e8 100%)",
    "--sw-glow": "rgba(60, 124, 252, 0.5)",
  },
  instagram: {
    ...NEUTRAL,
    "--sw-from": "#f58529",
    "--sw-to": "#bc2a8d",
    "--sw-grad": "linear-gradient(135deg, #f58529 0%, #dd2a7b 55%, #8134af 100%)",
    "--sw-glow": "rgba(221, 42, 123, 0.5)",
  },
  tiktok: {
    ...NEUTRAL,
    "--sw-from": "#25f4ee",
    "--sw-to": "#fe2c55",
    "--sw-grad": "linear-gradient(135deg, #25f4ee 0%, #fe2c55 100%)",
    "--sw-glow": "rgba(254, 44, 85, 0.5)",
  },
};

// Per-platform support. `modes` order = tab order. `defaultMode` selected on switch.
// `keywordPlaceholder` tunes the Mode A input copy per platform.
export const PLATFORMS = {
  facebook: {
    id: "facebook",
    name: "Facebook",
    Glyph: FacebookGlyph,
    // FB warmer is hashtag-only for now: scroll the tag feed and like posts.
    // (Reels / Feed tabs removed — see platforms catalog history.)
    defaultMode: "A",
    modes: [{ ...MODE.A, label: "Hashtag" }],
    keywordPlaceholder: "e.g. tarotreading",
    theme: THEMES.facebook,
  },
  instagram: {
    id: "instagram",
    name: "Instagram",
    Glyph: InstagramGlyph,
    defaultMode: "C",
    modes: [
      MODE.C,
      { ...MODE.B, label: "Explore" },
      { ...MODE.A, label: "Hashtag" },
    ],
    keywordPlaceholder: "e.g. tarot  or  #tarotreading",
    theme: THEMES.instagram,
  },
  tiktok: {
    id: "tiktok",
    name: "TikTok",
    Glyph: TikTokGlyph,
    defaultMode: "C",
    modes: [
      { ...MODE.C, label: "For You" },
      { ...MODE.A, label: "Search" },
    ],
    keywordPlaceholder: "e.g. tarot  or  #tarottok",
    theme: THEMES.tiktok,
  },
};

export const PLATFORM_ORDER = ["facebook", "instagram", "tiktok"];
