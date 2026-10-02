// Filling the holes Instagram leaves in a captured record. Canonical source —
// inlined verbatim into the import-free capture scripts (see ./README.md).
//
// WHY THIS EXISTS. Measured live on /explore/search/keyword/?q=%23auralytrend
// (2026-08-15): the keyword-search SERP query (xdt_fbsearch__top_serp_graphql)
// returns `view_count: null` for 24 of 24 videos and carries no `play_count` /
// `ig_play_count` key at all — while like_count and comment_count are present on
// every one and `like_and_view_counts_disabled` is false. So the views did not
// move to another field; that endpoint simply stopped shipping them, which is why
// the overlay's eye row and the panel's views column went blank.
//
// The same post read through /api/v1/media/<pk>/info/ answers play_count 52222.
// So a video with no views is a record with a HOLE, and the hole has a cheap fix:
// ask for that one media. This module decides when to ask and how to merge the
// answer; the capture script owns the request itself.
//
// This is a deliberate break from "passive only" — until now the IG capture read
// what Instagram parsed and never called anything.
//
// POLICY (2026-09-26, user's call): fire every enrichment the moment its record is
// captured, all in parallel, the way SortFeed does. The old 1 req/s serial queue
// (ENRICH_MIN_GAP_MS) made tile N wait ~N seconds for its views — on a 24-tile
// page the last card sat without views for half a minute while SortFeed showed
// them at once. The only ordering left is which requests leave first: the tiles
// on screen (visibleFirst).

// Instagram's web app id — what SortFeed hardcodes. The capture script still
// prefers the id it sees on Instagram's own requests (it can rotate), but uses
// this one instead of waiting when no request has carried the header yet.
export const IG_WEB_APP_ID = "936619743392459";

/**
 * Order a batch of enrichment jobs so the ones for tiles on screen are sent
 * first. Stable: capture order is kept inside each group.
 */
export function visibleFirst(jobs, isOnScreen) {
  const on = [];
  const off = [];
  for (const j of jobs) (isOnScreen(j) ? on : off).push(j);
  return on.concat(off);
}

// Every key Instagram has shipped a media's view count under, most specific
// first. Which one a payload uses depends on the endpoint and its age: the v1 API
// says play_count / ig_play_count, the web SERP says view_count, the legacy
// GraphQL shape says video_view_count, and some clips payloads say
// content_views_count. fb_play_count is NOT here — those are Facebook plays of a
// cross-posted reel, a different audience, kept in their own field.
const IG_VIEW_KEYS = ["play_count", "ig_play_count", "view_count", "video_view_count", "content_views_count"];

/** The media's Instagram view count, or null when no key carries a number. */
export function igViewCount(m) {
  if (!m || typeof m !== "object") return null;
  for (const k of IG_VIEW_KEYS) {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** JSON Instagram serves inline sometimes carries a `for (;;);` anti-hijack prefix. */
export function stripJsonGuard(txt) {
  return String(txt).replace(/^\s*for\s*\(\s*;;\s*\)\s*;?/, "");
}

/**
 * Does this record still need a per-media fetch?
 *
 * Only videos: photos and carousels have no view count to recover, and asking for
 * them would double the request count for nothing. `pk` is what the endpoint is
 * keyed by, so a record without one can never be asked about.
 */
export function needsEnrichment(rec) {
  if (!rec || !rec.pk) return false;
  if (rec.media_type !== "video") return false;
  return rec.play_count == null || rec.video == null || rec.taken_at == null;
}

/**
 * The "how big is this creator" numbers out of an Instagram user dict, or null if
 * the object isn't one. These ride along in payloads we already parse — no extra
 * request — and they are what turns a list of posts into a list of creators worth
 * modelling (views per follower, small-account outliers, contactable bios).
 */
export function igUserStats(u) {
  if (!u || typeof u !== "object") return null;
  const id = u.pk != null ? String(u.pk) : u.id != null ? String(u.id) : null;
  if (!id) return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const follower_count = num(u.follower_count);
  const media_count = num(u.media_count);
  // A user dict without any of these is a mention/tag stub, not a profile payload.
  if (follower_count == null && media_count == null) return null;
  return {
    userid: id,
    username: u.username || null,
    full_name: u.full_name || null,
    profile_pic_url: u.profile_pic_url || null,
    is_verified: typeof u.is_verified === "boolean" ? u.is_verified : null,
    is_private: typeof u.is_private === "boolean" ? u.is_private : null,
    follower_count,
    following_count: num(u.following_count),
    media_count,
    total_clips_count: num(u.total_clips_count),
    biography: u.biography || null,
    external_url: u.external_url || null,
    is_business: !!u.is_business,
  };
}

/**
 * The sound a reel rides, so a trend can be traced back to its audio: original
 * sounds first (the creator's own), then a licensed track. `audio_id` deep-links
 * to instagram.com/reels/audio/<id>/, which lists every reel using it.
 */
export function igAudioInfo(m) {
  const meta = m && m.clips_metadata;
  if (!meta) return null;
  const orig = meta.original_sound_info;
  if (orig && orig.audio_asset_id != null)
    return {
      audio_id: String(orig.audio_asset_id),
      audio_author: (orig.ig_artist && orig.ig_artist.username) || null,
      audio_ms: typeof orig.duration_in_ms === "number" ? orig.duration_in_ms : null,
    };
  const track = meta.music_info && meta.music_info.music_asset_info;
  if (track && track.audio_cluster_id != null)
    return {
      audio_id: String(track.audio_cluster_id),
      audio_author: track.display_artist || null,
      audio_ms: typeof track.duration_in_ms === "number" ? track.duration_in_ms : null,
    };
  return null;
}

/**
 * Fold a fresh sighting into a stored one. A later payload is not necessarily a
 * richer payload — the SERP carries no views, the grid carries no video URL — so
 * a null in the incoming record means "this payload didn't say", never "it's gone".
 */
export function mergeIgRecord(prev, next) {
  if (!prev) return { ...next };
  const out = { ...prev };
  for (const [k, v] of Object.entries(next || {})) if (v != null) out[k] = v;
  return out;
}


// Signed avatar URLs rotate without the profile changing. Keep the latest URL
// in the replay cache, but do not emit a new sighting just for that rotation.
export function sameIgUserStats(prev, next) {
  if (!prev || !next) return false;
  const { profile_pic_url: _prevAvatar, ...a } = prev;
  const { profile_pic_url: _nextAvatar, ...b } = next;
  return JSON.stringify(a) === JSON.stringify(b);
}
