// A whole Instagram comment thread through the app's REST endpoints, on the
// user's command ("Coletar todos" in the panel's Comentários). INLINED into the
// Instagram MAIN world — see src/lib/shared/README.md before editing (no imports
// allowed in this file).
//
// Measured 2026-10-22, logged in, post DeJ9CWsm_YJ (318 comments):
//   GET /api/v1/media/<pk>/comments/?can_support_threading=true&sort_order=popular
//     15 comments a page. `next_min_id` is a JSON string
//     ({cached_comments_cursor, bifilter_token}) passed back as `min_id`; the
//     next page shares no comment with the first. `has_more_comments` is false
//     while `has_more_headload_comments` is true: the head flag is the one that
//     pages. Each comment: pk, text, created_at, comment_like_count,
//     child_comment_count, preview_child_comments, user{username, is_verified}.
//   GET /api/v1/media/<pk>/comments/<commentPk>/child_comments/
//     The first answer held 9 of 10 replies, with has_more_head_child_comments
//     and next_min_child_cursor (passed back as `min_id`). The tail direction
//     (has_more_tail_child_comments + next_max_child_cursor → `max_id`) is the
//     one the Comments Exporter extension pages; both are followed.

export const IG_COMMENTS_QUERY = "can_support_threading=true&sort_order=popular";

/** The top-level page after `cursor` (none: the first page). */
export function igCommentsPath(mediaPk, cursor) {
  const q = IG_COMMENTS_QUERY + (cursor ? "&min_id=" + encodeURIComponent(cursor) : "");
  return `/api/v1/media/${mediaPk}/comments/?${q}`;
}

/** A page of a comment's replies; `page` is null for the first, else {dir, cursor}. */
export function igRepliesPath(mediaPk, commentPk, page) {
  const base = `/api/v1/media/${mediaPk}/comments/${commentPk}/child_comments/`;
  if (!page || !page.cursor) return base;
  return base + "?" + (page.dir === "max" ? "max_id=" : "min_id=") + encodeURIComponent(page.cursor);
}

/** The cursor of the next top-level page, or null at the end of the thread. */
export function igNextCommentsCursor(json) {
  const more = !!(json && (json.has_more_headload_comments || json.has_more_comments));
  const cursor = json && json.next_min_id;
  return more && cursor ? String(cursor) : null;
}

/** A top-level comment whose replies are not all in its preview. */
export function igNeedsReplies(comment) {
  const total = Number(comment && comment.child_comment_count) || 0;
  const shown = Array.isArray(comment && comment.preview_child_comments) ? comment.preview_child_comments.length : 0;
  return total > shown || !!(comment && (comment.has_more_head_child_comments || comment.has_more_tail_child_comments));
}

/** The next page of replies, or null when the replies are all in. */
export function igNextRepliesPage(json) {
  if (json && json.has_more_head_child_comments && json.next_min_child_cursor)
    return { dir: "min", cursor: String(json.next_min_child_cursor) };
  if (json && json.has_more_tail_child_comments && json.next_max_child_cursor)
    return { dir: "max", cursor: String(json.next_max_child_cursor) };
  return null;
}

const RATE_WORDS = /feedback_required|rate.?limit|please wait|too many requests|tente novamente mais tarde/i;
const LOGIN_WORDS = /login_required|checkpoint_required|challenge_required|consent_required|\/accounts\/login|\/challenge\//i;

/**
 * Why an answer stops the collection, or null when it is a usable page.
 * "rate_limited" (429 or Instagram's wait message), "login" (logged out, a
 * checkpoint or a challenge), "bad_response", or "http_<status>".
 */
export function igCommentBlock({ status, url, redirected, contentType, body }) {
  const text = typeof body === "string" ? body.slice(0, 4000) : "";
  if (status === 429 || RATE_WORDS.test(text)) return "rate_limited";
  if (status === 401 || status === 403 || (redirected && LOGIN_WORDS.test(String(url || ""))) || LOGIN_WORDS.test(text))
    return "login";
  if (!(status >= 200 && status < 300)) return "http_" + status;
  if (!/json/i.test(String(contentType || ""))) return "bad_response";
  return null;
}

/** The pause before the next request: 4–8 s, so a 300-comment post takes minutes. */
export function igCommentGapMs(random = Math.random) {
  return 4000 + Math.floor(random() * 4000);
}
