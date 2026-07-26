// The ONE shape of a saved-Library record, and the permalink rules behind it.
// INLINED into content scripts — see src/lib/shared/README.md before editing
// (no imports allowed in this file).
//
// This exists because `fbw_saved` used to be written from ten places (six panel
// tools, three page overlays, the transcription rail) with five different shapes:
//
//   * counts were pre-formatted strings, sometimes via an UNGUARDED fmtCount(null)
//     (so whatever that returned got persisted instead of null), and Pinterest
//     stored the literal string "—" for views where everything else stored null;
//   * `sourceUrl` was present in some and absent in others, and VideoCard falls
//     back to `facebook.com/reel/<id>` when it's missing — a dead link for a
//     TikTok or Pinterest item;
//   * TikTok stored a signed, expiring CDN URL as `thumb`.
//
// Counts are stored as RAW NUMBERS (or null) — never formatted. Formatting is a
// render-time concern, and storing numbers keeps the Library sortable. VideoCard
// tolerates strings for records written before schema 2.

export const SAVED_SCHEMA = 2;

// Absolute permalink back to the item, per platform. Centralized because a
// missing sourceUrl silently degrades into a wrong Facebook link.
export function savedSourceUrl(platform, { code, id, username } = {}) {
  const key = code || id;
  switch (platform) {
    case "instagram":
      return key ? `https://www.instagram.com/p/${key}/` : null;
    case "tiktok":
      return username && id ? `https://www.tiktok.com/@${username}/video/${id}` : null;
    case "facebook":
      return key ? `https://www.facebook.com/reel/${key}` : null;
    case "pinterest":
      return key ? `https://www.pinterest.com/pin/${key}/` : null;
    default:
      return null;
  }
}

// Profile URL. FB/IG are stored relative (VideoCard prepends the origin);
// TikTok/Pinterest are absolute, and prepending an origin to those would nest one
// URL inside another and produce a dead link.
export function savedAuthorUrl(platform, username) {
  if (!username) return null;
  switch (platform) {
    case "instagram":
      return `/${username}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${username}`;
    case "pinterest":
      return `https://www.pinterest.com/${username}/`;
    case "facebook":
      return null; // FB reels grids expose no reliable author URL
    default:
      return null;
  }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Build a Library record. `id` and `platform` are required; everything else
 * degrades to null rather than to a wrong value.
 *
 * counts: { like, comment, view, share, save } — raw numbers or null.
 * Pass `sourceUrl` to override the derived permalink (Pinterest carries its own).
 */
export function buildSavedEntry({
  id,
  platform,
  thumb = null,
  caption = null,
  authorName = null,
  username = null,
  authorUrl,
  counts = {},
  code = null,
  pk = null,
  mediaType = null,
  sourceUrl,
  now = Date.now(),
} = {}) {
  if (!id || !platform) return null;
  return {
    schema: SAVED_SCHEMA,
    videoId: String(id),
    platform,
    thumb: thumb || null,
    caption: caption || null,
    author: {
      name: authorName || username || "desconhecido",
      url: authorUrl !== undefined ? authorUrl : savedAuthorUrl(platform, username),
    },
    // `views` keeps its legacy key so existing VideoCard markup is unchanged.
    counts: {
      like: num(counts.like),
      comment: num(counts.comment),
      views: num(counts.view ?? counts.views),
      share: num(counts.share),
      save: num(counts.save),
    },
    code: code || null,
    pk: pk || null,
    media_type: mediaType || null,
    sourceUrl:
      sourceUrl !== undefined
        ? sourceUrl
        : savedSourceUrl(platform, { code, id, username }),
    updatedAt: now,
  };
}
