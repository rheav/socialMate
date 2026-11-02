// Pure HTML and JSON parser for profile measurement in the spy area.
import { parseCount } from "./shared/counts.js";
import { reelsStart } from "./shared/fbReelsPaging.js";

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

  // 8. Bio and link: the intro text under the name, with the link Facebook marks in it.
  const { bio, externalUrl } = fbStatusText(html);

  // 9. User ID
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
    bio,
    externalUrl,
  };
}

/** The JSON object right after the first `"key":{` in the page's inline JSON, parsed; null when there is none. */
function jsonObjectAfter(html, key) {
  const needle = `"${key}":{`;
  for (let at = html.indexOf(needle); at !== -1; at = html.indexOf(needle, at + 1)) {
    const start = at + needle.length - 1;
    let depth = 0, inString = false;
    for (let j = start; j < html.length && j < start + 50_000; j++) {
      const c = html[j];
      if (inString) { if (c === "\\") j++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1)); } catch { break; }
      }
    }
  }
  return null;
}

/** profile_status_text: the bio, minus the link it carries, and that link. */
export function fbStatusText(html) {
  const status = jsonObjectAfter(html, "profile_status_text");
  const text = typeof status?.text === "string" ? status.text : "";
  const linkRange = (Array.isArray(status?.ranges) ? status.ranges : [])
    .find((r) => typeof r?.entity?.external_url === "string" && /^https?:\/\//.test(r.entity.external_url));
  const externalUrl = linkRange ? linkRange.entity.external_url : null;
  // Facebook's offsets count code points (an emoji is one), not UTF-16 units.
  const chars = Array.from(text);
  const { offset, length } = linkRange || {};
  const inRange = Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && offset + length <= chars.length;
  const cut = !externalUrl ? text
    : inRange ? chars.slice(0, offset).join("") + chars.slice(offset + length).join("")
    : text.replace(externalUrl, "");
  const bio = cut.trim() || null;
  return { bio, externalUrl };
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

const JSON_SCRIPT_RE = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

/**
 * The reels tab HTML ships its first page (10 newest reels) as
 * aggregated_fb_shorts inside <script type="application/json"> blocks; each
 * reel's likes, comments, shares and AI mark come in blocks of their own.
 * Returns the reels plus the paging state for a later continuation.
 */
const REEL_BLOCK_RE = /aggregated_fb_shorts|ai_generated_detected_info|fb_reel_react_button/;
export function parseFbReelsHtml(html) {
  if (typeof html !== "string") return { reels: [], hasNext: null, cursor: null };
  const blocks = [];
  for (const m of html.matchAll(JSON_SCRIPT_RE)) {
    if (!REEL_BLOCK_RE.test(m[1])) continue;
    try { blocks.push(JSON.parse(m[1])); } catch { /* not this block */ }
  }
  const start = reelsStart(blocks);
  return start.collectionId
    ? { reels: start.rows, hasNext: start.hasNext, cursor: start.cursor }
    : { reels: start.rows, hasNext: null, cursor: null };
}
