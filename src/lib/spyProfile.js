// Spy area profile identities, key resolution, and URLs.
// Pure module, mirrored between Hub (server/spy.ts) and Extension (src/lib/spyProfile.js).

import { FB_NUMERIC_RE } from "./shared/spyProfileUrl.js";

export { SPY_PLATFORMS, isSpyPlatform, parseProfileUrl } from "./shared/spyProfileUrl.js";

export function spyId(platform, key) {
  return `${platform}:${String(key).toLowerCase()}`;
}

/** Facebook reels tab: the daily reading's single request (followers + newest reels). */
export function reelsUrl(key) {
  const k = String(key).toLowerCase();
  return FB_NUMERIC_RE.test(k)
    ? `https://www.facebook.com/profile.php?id=${k}&sk=reels_tab`
    : `https://www.facebook.com/${k}/reels/`;
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
  if (platform === "tiktok") return `https://www.tiktok.com/@${k}`;
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
  // TikTok stories open from the profile's avatar.
  if (profile.platform === "tiktok") return `https://www.tiktok.com/@${k}`;
  return null;
}

