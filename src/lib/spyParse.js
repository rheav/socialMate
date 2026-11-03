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

// ---- TikTok (socialMate 1.29) ----
//
// Measured 2026-11-02 on @happymindmentor: GET https://www.tiktok.com/@<key> with
// the session answers 200 with `__UNIVERSAL_DATA_FOR_REHYDRATION__`, whose
// `webapp.user-detail.userInfo` carries the exact counts (statsV2, as strings),
// the bio, the link and when the account was created. Its itemList is empty: the
// videos come from /api/post/item_list, signed, so only a tab reads them.

const TT_SSR_RE = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;
const ttCount = (v) => (v == null || v === "" ? null : Number.isFinite(+v) && +v >= 0 ? Math.trunc(+v) : null);

export function parseTtProfileHtml(html, responseUrl = "") {
  if (typeof html !== "string") return { ok: false, error: "parse_failed" };
  if (/\/login(\/|\?|$)/.test(responseUrl)) return { ok: false, error: "login_required" };
  const m = html.match(TT_SSR_RE);
  if (!m) return { ok: false, error: "parse_failed" };
  let detail;
  try { detail = JSON.parse(m[1])?.__DEFAULT_SCOPE__?.["webapp.user-detail"]; } catch { return { ok: false, error: "parse_failed" }; }
  const info = detail?.userInfo;
  // statusCode 10221 / 10202: no such account (banned or renamed).
  if (!info?.user?.id) return { ok: false, error: detail?.statusCode ? "not_found" : "parse_failed" };
  const u = info.user;
  const s = info.statsV2 || info.stats || {};
  const followers = ttCount(s.followerCount);
  if (followers == null) return { ok: false, error: "parse_failed" };
  const link = typeof u.bioLink?.link === "string" && /^https?:\/\//.test(u.bioLink.link) ? u.bioLink.link : null;
  return {
    ok: true,
    userId: String(u.id),
    name: u.nickname || null,
    avatarUrl: u.avatarMedium || u.avatarThumb || null,
    verified: u.verified === true ? true : u.verified === false ? false : null,
    private: u.privateAccount === true ? true : u.privateAccount === false ? false : null,
    bio: typeof u.signature === "string" && u.signature.trim() ? u.signature.trim() : null,
    externalUrl: link,
    accountCreatedAt: Number.isSafeInteger(u.createTime) ? u.createTime : null,
    followers,
    followersApprox: false,
    following: ttCount(s.followingCount),
    posts: ttCount(s.videoCount),
    hearts: ttCount(s.heartCount ?? s.heart),
    // 1 = a story is up now (0 measured on a profile without one).
    hasStory: u.UserStoryStatus == null ? null : u.UserStoryStatus === 1,
  };
}

/**
 * A grid record (lib/shared/ttItems.js ttLiteItem, as the relay forwards it) → a
 * post for the hub's spy_posts. TikTok's grid has no other AI flag than the label
 * it shows, so a video without one is "NONE".
 */
export function ttSpyPost(r, observedAt = Date.now()) {
  if (!r || !/^\d{3,30}$/.test(String(r.id || "")) || !Number.isInteger(r.create_time)) return null;
  const photo = Array.isArray(r.images) ? r.images.length > 0 : !!r.images;
  return {
    id: String(r.id),
    createdAt: r.create_time,
    mediaType: photo ? "photo" : "video",
    pinned: r.pinned === true,
    views: ttCount(r.play_count),
    likes: ttCount(r.digg_count),
    comments: ttCount(r.comment_count),
    shares: ttCount(r.share_count),
    saves: ttCount(r.collect_count),
    reposts: ttCount(r.repost_count),
    durationS: !photo && Number.isFinite(r.duration) && r.duration > 0 ? r.duration : null,
    caption: typeof r.desc === "string" && r.desc.trim() ? r.desc.trim() : null,
    aiLabel: r.is_aigc === true ? "AIGC" : "NONE",
    audio: typeof r.music?.title === "string" && r.music.title ? r.music.title : null,
    audioOriginal: r.music ? r.music.original === true : null,
    hashtags: Array.isArray(r.hashtags) ? r.hashtags.filter((t) => typeof t === "string" && t) : [],
    hasCaptions: !!r.subtitle,
    thumbUrl: typeof r.cover === "string" ? r.cover : null,
    observedAt,
  };
}
