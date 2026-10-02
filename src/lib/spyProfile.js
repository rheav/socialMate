// Spy area profile identities, key resolution, and URLs.
// Pure module, mirrored between Hub (server/spy.ts) and Extension (src/lib/spyProfile.js).

export const SPY_PLATFORMS = ["instagram", "facebook"];

export function isSpyPlatform(value) {
  return typeof value === "string" && SPY_PLATFORMS.includes(value);
}

const IG_RESERVED = new Set([
  "explore", "reels", "reel", "p", "direct", "stories", "accounts", "tv", "guides", "challenges",
  "about", "legal", "privacy", "terms", "api", "graphql", "web", "emails", "developer", "press",
]);

const FB_RESERVED = new Set([
  "watch", "reel", "reels", "groups", "marketplace", "gaming", "events", "pages", "stories",
  "search", "hashtag", "photo", "photo.php", "photos", "video.php", "videos", "story.php",
  "permalink.php", "login", "login.php", "help", "settings", "notifications", "messages",
  "friends", "bookmarks", "saved", "ads", "business", "share", "sharer", "sharer.php", "people",
  "public", "policies", "privacy", "l.php", "plugins", "dialog", "home.php", "live", "fundraisers",
  "memories", "profile.php",
]);

const IG_KEY_RE = /^[a-z0-9._]{1,30}$/;
const FB_VANITY_RE = /^[a-z0-9.-]{1,80}$/;
const FB_NUMERIC_RE = /^\d+$/;

export function spyId(platform, key) {
  return `${platform}:${String(key).toLowerCase()}`;
}

export function profileUrl(platform, key) {
  const k = String(key).toLowerCase();
  if (platform === "instagram") {
    return `https://www.instagram.com/${k}/`;
  }
  if (platform === "facebook") {
    if (FB_NUMERIC_RE.test(k)) {
      return `https://www.facebook.com/profile.php?id=${k}`;
    }
    return `https://www.facebook.com/${k}`;
  }
  return "";
}

export function storiesUrl(profile) {
  if (!profile || !profile.platform || !profile.key) return null;
  const k = String(profile.key).toLowerCase();
  if (profile.platform === "instagram") {
    return `https://www.instagram.com/stories/${k}/`;
  }
  if (profile.platform === "facebook") {
    const ref = profile.storyRef ?? profile.story_ref;
    if (ref && typeof ref === "string" && ref.trim()) {
      return `https://www.facebook.com/stories/${ref.trim()}/`;
    }
    return null;
  }
  return null;
}

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

  if (!isIg && !isFb) return null;

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
