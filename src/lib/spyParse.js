// Pure HTML and JSON parser for profile measurement in the spy area.
import { parseCount } from "./shared/counts.js";

const FB_FOLLOWERS_RE =
  /([\d.,]+\s?\p{L}{0,5})\s+(?:followers|seguidores|seguidoras|abonnés|follower|seguaci)/iu;
const FB_FOLLOWING_RE =
  /([\d.,]+\s?\p{L}{0,5})\s+(?:following|seguindo|abonnements|seguiti)/iu;

export function parseFbProfileHtml(html, responseUrl = "") {
  if (typeof html !== "string") {
    return { ok: false, error: "parse_failed" };
  }

  // 1. Login or checkpoint checks
  if (
    responseUrl.includes("/login") ||
    responseUrl.includes("/checkpoint") ||
    html.includes('id="loginbutton"') ||
    html.includes('id="login_form"') ||
    html.includes('name="login"')
  ) {
    return { ok: false, error: "login_required" };
  }

  // 2. Not found / unavailable checks
  if (
    html.includes("Este conteúdo não está disponível no momento") ||
    html.includes("This content isn't available right now") ||
    html.includes("This page isn't available") ||
    html.includes('id="content_unavailable"')
  ) {
    return { ok: false, error: "not_found" };
  }

  // 3. Followers count from profile_social_context
  let followers = null;
  let following = null;
  let followersApprox = false;

  const socialContextIdx = html.indexOf('"profile_social_context"');
  if (socialContextIdx !== -1) {
    const chunk = html.slice(socialContextIdx, socialContextIdx + 2000);
    const mFollowers = chunk.match(FB_FOLLOWERS_RE);
    if (mFollowers) {
      followers = parseCount(mFollowers[1].trim());
      if (followers != null) followersApprox = true;
    }
    const mFollowing = chunk.match(FB_FOLLOWING_RE);
    if (mFollowing) {
      following = parseCount(mFollowing[1].trim());
    }
  }

  if (followers == null) {
    const mFollowers = html.match(FB_FOLLOWERS_RE);
    if (mFollowers) {
      followers = parseCount(mFollowers[1].trim());
      if (followers != null) followersApprox = true;
    }
  }

  if (followers == null) {
    return { ok: false, error: "parse_failed" };
  }

  // 4. Story bucket
  let hasStory = null;
  let storyRef = null;

  const storyBucketMatch = html.match(
    /"story_bucket"\s*:\s*\{\s*"nodes"\s*:\s*\[\s*\{([\s\S]*?)\}\s*\]\s*\}/,
  );
  if (storyBucketMatch) {
    const nodeContent = storyBucketMatch[1];
    hasStory = /"first_story_to_show"\s*:\s*\{/.test(nodeContent);
    const idM = nodeContent.match(/"id"\s*:\s*"(\d+)"/);
    if (idM) storyRef = idM[1];
  }

  // 5. Verified
  let verified = null;
  const verifiedMatch = html.match(/"show_verified_badge_on_profile"\s*:\s*(true|false)/);
  if (verifiedMatch) {
    verified = verifiedMatch[1] === "true";
  }

  // 6. Name
  let name = null;
  let nameMatch = html.match(
    /(?:"profile_user"|"header_top_row")\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/,
  );
  if (!nameMatch) {
    nameMatch = html.match(
      /"actors"\s*:\s*\[\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/,
    );
  }
  if (!nameMatch) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
      const clean = h1Match[1].replace(/<[^>]+>/g, "").trim();
      if (clean) nameMatch = [null, clean];
    }
  }
  if (nameMatch) {
    try {
      name = JSON.parse(`"${nameMatch[1]}"`);
    } catch {
      name = nameMatch[1];
    }
  }

  // 7. Avatar URL
  // Look for the profile's own picture, explicitly avoiding the visitor's top-nav avatar
  let avatarUrl = null;
  let avatarMatch = html.match(
    /"profilePicLarge"\s*:\s*\{[\s\S]*?"uri"\s*:\s*"([^"]+)"/,
  );
  if (!avatarMatch) {
    avatarMatch = html.match(
      /(?:"profile_user"|"header_top_row"|"actors")\s*:\s*(?:\[\s*)?\{[\s\S]*?"profile_picture"\s*:\s*\{[\s\S]*?"uri"\s*:\s*"([^"]+)"/,
    );
  }
  if (!avatarMatch) {
    avatarMatch = html.match(
      /<image[^>]+(?:xlink:href|href)="([^"]+scontent[^"]+)"/,
    );
  }
  if (!avatarMatch) {
    const allMatches = [
      ...html.matchAll(
        /(?:"profile_picture"|"profilePicMedium"|"profilePicSmall")\s*:\s*\{[\s\S]*?"uri"\s*:\s*"([^"]+)"/g,
      ),
    ];
    for (const m of allMatches) {
      const idx = m.index ?? 0;
      const prefix = html.slice(Math.max(0, idx - 250), idx);
      if (
        !prefix.includes('"viewer"') &&
        !prefix.includes("useCometAppNavigationProfilePicture")
      ) {
        avatarMatch = m;
        break;
      }
    }
  }
  if (avatarMatch) {
    try {
      avatarUrl = JSON.parse(`"${avatarMatch[1]}"`);
    } catch {
      avatarUrl = avatarMatch[1].replace(/\\/g, "");
    }
  }

  // 8. User ID
  let userId = null;
  const actorIdMatch = html.match(/"actors"\s*:\s*\[\s*\{[\s\S]*?"id"\s*:\s*"(\d+)"/);
  if (actorIdMatch) {
    userId = actorIdMatch[1];
  } else {
    const idNearStory = html.match(/"id"\s*:\s*"(\d+)"[\s\S]{0,100}"story_bucket"/);
    if (idNearStory) userId = idNearStory[1];
  }

  return {
    ok: true,
    followers,
    followersApprox,
    following,
    hasStory,
    storyRef,
    verified,
    name,
    avatarUrl,
    userId,
  };
}

export function parseIgProfile(json) {
  if (!json || typeof json !== "object") {
    return { ok: false, error: "parse_failed" };
  }

  const user = json.data?.user || json.graphql?.user || json.user || json;
  if (!user || (!user.id && !user.pk && !user.userid && !user.username)) {
    return { ok: false, error: "parse_failed" };
  }

  const rawId = user.userid ?? user.id ?? user.pk;
  const userId = rawId == null ? null : String(rawId);
  const name = user.full_name ?? user.name ?? null;
  const bio = user.biography ?? user.bio ?? null;
  const externalUrl = user.external_url ?? user.externalUrl ?? null;
  const verified = user.is_verified ?? user.verified ?? null;
  const isPrivate = user.is_private ?? user.private ?? null;
  const avatarUrl = user.profile_pic_url_hd ?? user.profile_pic_url ?? user.avatarUrl ?? null;

  let followers = null;
  if (typeof user.follower_count === "number") {
    followers = user.follower_count;
  } else if (typeof user.edge_followed_by?.count === "number") {
    followers = user.edge_followed_by.count;
  }

  let following = null;
  if (typeof user.following_count === "number") {
    following = user.following_count;
  } else if (typeof user.edge_follow?.count === "number") {
    following = user.edge_follow.count;
  }

  let posts = null;
  if (typeof user.media_count === "number") {
    posts = user.media_count;
  } else if (typeof user.edge_owner_to_timeline_media?.count === "number") {
    posts = user.edge_owner_to_timeline_media.count;
  }

  // P0 did not establish an active-story signal. Highlights are not live stories.
  const hasStory = null;

  return {
    ok: true,
    userId,
    name,
    followers,
    followersApprox: false,
    following,
    posts,
    verified,
    private: isPrivate,
    avatarUrl,
    bio,
    externalUrl,
    hasStory,
  };
}
