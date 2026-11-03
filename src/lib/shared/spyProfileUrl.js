// Which Spy profile a URL names: the platform and its key. INLINED into the
// TikTok and Facebook content scripts for the Hub button (socialMate 1.32) — see
// src/lib/shared/README.md before editing (no imports allowed in this file).
// src/lib/spyProfile.js re-exports it for the panel, the background and the tests.

export const SPY_PLATFORMS = ["instagram", "facebook", "tiktok"];

export function isSpyPlatform(value) {
  return typeof value === "string" && SPY_PLATFORMS.includes(value);
}

export const IG_RESERVED = new Set([
  "explore", "reels", "reel", "p", "direct", "stories", "accounts", "tv", "guides", "challenges",
  "about", "legal", "privacy", "terms", "api", "graphql", "web", "emails", "developer", "press",
]);

export const FB_RESERVED = new Set([
  "watch", "reel", "reels", "groups", "marketplace", "gaming", "events", "pages", "stories",
  "search", "hashtag", "photo", "photo.php", "photos", "video.php", "videos", "story.php",
  "permalink.php", "login", "login.php", "help", "settings", "notifications", "messages",
  "friends", "bookmarks", "saved", "ads", "business", "share", "sharer", "sharer.php", "people",
  "public", "policies", "privacy", "l.php", "plugins", "dialog", "home.php", "live", "fundraisers",
  "memories", "profile.php",
]);

export const IG_KEY_RE = /^[a-z0-9._]{1,30}$/;
export const FB_VANITY_RE = /^[a-z0-9.-]{1,80}$/;
export const FB_NUMERIC_RE = /^\d+$/;
/** TikTok usernames: 2–24 letters, digits, "_" or "." (lowercased here). */
export const TT_KEY_RE = /^[a-z0-9._]{2,24}$/;

export function parseProfileUrl(input, platformHint) {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  // Handle bare handle or @handle when platformHint is provided
  if (platformHint && isSpyPlatform(platformHint)) {
    const cleanHandle = raw.replace(/^@+/, "").trim().toLowerCase();
    if (cleanHandle) {
      if (platformHint === "instagram") {
        if (IG_KEY_RE.test(cleanHandle) && !IG_RESERVED.has(cleanHandle)) {
          return { platform: "instagram", key: cleanHandle };
        }
      } else if (platformHint === "facebook") {
        if ((FB_NUMERIC_RE.test(cleanHandle) || FB_VANITY_RE.test(cleanHandle)) && !FB_RESERVED.has(cleanHandle)) {
          return { platform: "facebook", key: cleanHandle };
        }
      } else if (platformHint === "tiktok" && TT_KEY_RE.test(cleanHandle)) {
        return { platform: "tiktok", key: cleanHandle };
      }
    }
    if (raw.startsWith("@")) return null;
  }

  if (raw.startsWith("@")) return null;

  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const isIg = hostname === "instagram.com" || hostname.endsWith(".instagram.com");
  const isFb = hostname === "facebook.com" || hostname.endsWith(".facebook.com");
  const isTt = hostname === "tiktok.com" || hostname.endsWith(".tiktok.com");

  if (!isIg && !isFb && !isTt) return null;

  const pathname = parsed.pathname;
  const segments = pathname.split("/").filter(Boolean);

  if (isIg) {
    if (!segments.length) return null;
    // Exception: /stories/<username>/...
    if (segments[0].toLowerCase() === "stories" && segments.length >= 2) {
      const candidate = segments[1].toLowerCase();
      if (IG_KEY_RE.test(candidate) && !IG_RESERVED.has(candidate)) {
        return { platform: "instagram", key: candidate };
      }
      return null;
    }

    const candidate = segments[0].toLowerCase();
    if (IG_KEY_RE.test(candidate) && !IG_RESERVED.has(candidate)) {
      return { platform: "instagram", key: candidate };
    }
    return null;
  }

  if (isTt) {
    // tiktok.com/@user, also /@user/video/<id> and /@user/photo/<id>.
    const at = segments[0] || "";
    if (!at.startsWith("@")) return null;
    let candidate = at.slice(1);
    try { candidate = decodeURIComponent(candidate); } catch { /* keep it raw */ }
    candidate = candidate.toLowerCase();
    return TT_KEY_RE.test(candidate) ? { platform: "tiktok", key: candidate } : null;
  }

  if (isFb) {
    const candidatePath = segments.length ? segments[0].toLowerCase() : "";
    if (candidatePath === "profile.php") {
      const id = parsed.searchParams.get("id");
      if (id && FB_NUMERIC_RE.test(id)) {
        return { platform: "facebook", key: id };
      }
      return null;
    }

    if (!segments.length) return null;
    const candidate = segments[0].toLowerCase();
    if (
      (FB_NUMERIC_RE.test(candidate) || FB_VANITY_RE.test(candidate)) &&
      !FB_RESERVED.has(candidate)
    ) {
      return { platform: "facebook", key: candidate };
    }
    return null;
  }

  return null;
}
