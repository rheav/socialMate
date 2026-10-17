// Captured Instagram records → events for the Instagram Scraper backend's
// /ingest/socialmate (schemaVersion 1). One capture, one mapping: the backend
// receives socialMate's own normalized records, never a re-forged GraphQL body.
//
// An event id is a hash of what the event says (not of when it was seen), so a
// re-capture of unchanged content is the same event — the outbox keeps it once —
// and any relevant change (a count, a longer caption, an edited comment) is a
// new event the backend will see.

import { igIdBase, igPkFromCode } from "./shared/igCode.js";

export const IG_CAPTION_MAX = 20_000;
const PREVIEW_LEN = 500;
const USERNAME = /^[a-z0-9._]{1,30}$/;
const NUMERIC = /^\d{1,25}$/;
const MEDIA_TYPE = { photo: 1, video: 2, carousel: 8 };

/** FNV-1a, 32-bit, hex: stable and cheap; collisions only merge two events of one item. */
export function contentHash(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function username(value) {
  const u = String(value || "").toLowerCase();
  return USERNAME.test(u) && !u.startsWith(".") ? u : null;
}

function mediaPkOf(rec) {
  const base = igIdBase(rec?.pk || "");
  if (base && NUMERIC.test(base)) return base;
  const fromCode = rec?.code ? igPkFromCode(rec.code) : null;
  return fromCode && NUMERIC.test(String(fromCode)) ? String(fromCode) : null;
}

function event(kind, key, record, observedAt) {
  return {
    eventId: `${kind}:${key}:${contentHash(record)}`,
    kind,
    observedAt: new Date(observedAt).toISOString(),
    record,
  };
}

/** A captured post (main-world `lite()` record) → post event, or null. */
export function postEvent(rec, observedAt) {
  const owner = username(rec?.username);
  const mediaPk = mediaPkOf(rec);
  if (!owner || !mediaPk) return null;
  const full = typeof rec.caption_full === "string" ? rec.caption_full : null;
  const preview = typeof rec.caption === "string" ? rec.caption : null;
  const text = full ?? preview;
  const caption = text == null ? null : text.slice(0, IG_CAPTION_MAX);
  const captionTruncated =
    text == null ? false : full != null ? full.length > IG_CAPTION_MAX : preview.length >= PREVIEW_LEN;
  const record = {
    mediaPk,
    shortcode: rec.code || null,
    ownerUsername: owner,
    ownerPk: rec.userid && NUMERIC.test(String(rec.userid)) ? String(rec.userid) : null,
    coauthors: Array.isArray(rec.coauthors) ? rec.coauthors.map((c) => username(c?.username)).filter(Boolean) : null,
    productType: rec.product_type || null,
    mediaType: MEDIA_TYPE[rec.media_type] ?? null,
    takenAt: numOrNull(rec.taken_at),
    caption,
    captionTruncated,
    likes: numOrNull(rec.like_count),
    comments: numOrNull(rec.comment_count),
    views: numOrNull(rec.play_count),
    reposts: numOrNull(rec.repost),
    durationS: numOrNull(rec.duration),
    audioTitle: rec.audio_title || null,
    imageUrl: rec.thumb || rec.image || null,
    carouselCount: Array.isArray(rec.carousel) ? rec.carousel.length : null,
  };
  // The thumbnail URL is signed and rotates; it must not mint new events.
  const { imageUrl, ...identity } = record;
  return { ...event("post", mediaPk, identity, observedAt), record };
}

/** Captured comments of ONE post → comment events (others are skipped). */
export function commentEvents(comments, post, observedAt) {
  const owner = username(post?.username);
  const mediaPk = mediaPkOf(post);
  if (!owner || !mediaPk) return [];
  const out = [];
  for (const c of comments || []) {
    if (!c?.cid || !NUMERIC.test(String(c.cid))) continue;
    if (post.code && c.post && c.post !== post.code) continue;
    const parent = c.parent != null && c.parent !== "" ? String(c.parent) : null;
    const record = {
      commentPk: String(c.cid),
      mediaPk,
      ownerUsername: owner,
      parentPk: parent && NUMERIC.test(parent) ? parent : null,
      text: String(c.text || ""),
      createdAt: numOrNull(c.create_time),
      likeCount: numOrNull(c.digg_count),
      childCount: numOrNull(c.reply_count),
      authorUsername: c.username || null,
      authorVerified: !!c.verified,
      isOwnerReply: username(c.username) === owner,
    };
    out.push(event("comment", record.commentPk, record, observedAt));
  }
  return out;
}

/** A finished Instagram transcript (fbw_transcripts record) → transcript event, or null. */
export function transcriptEvent(tx) {
  if (!tx || tx.status !== "done" || tx.platform !== "instagram") return null;
  // `author.name` may be a display name; the profile link is the handle.
  const fromUrl = String(tx.author?.url || "").match(/^\/([^/?#]+)\/?$/);
  const owner = username(fromUrl && fromUrl[1]);
  const id = String(tx.videoId || "");
  const isPk = NUMERIC.test(igIdBase(id));
  const mediaPk = isPk ? igIdBase(id) : mediaPkOf({ code: id });
  if (!owner || !mediaPk || typeof tx.text !== "string") return null;
  const record = {
    mediaPk,
    shortcode: isPk ? null : id,
    ownerUsername: owner,
    status: "done",
    language: tx.language || null,
    source: tx.source === "caption" ? "socialmate-caption" : "socialmate-whisper",
    text: tx.text,
    chunks: Array.isArray(tx.chunks) ? tx.chunks.map((c) => ({ timestamp: c.timestamp, text: c.text })) : [],
  };
  return event("transcript", mediaPk, record, tx.updatedAt || Date.now());
}

function build(capture, context = {}) {
  const at = context.observedAt || Date.now();
  const byCode = context.postsByCode || {};
  const events = [];
  for (const rec of capture.posts || []) {
    const ev = postEvent(rec, at);
    if (ev) events.push(ev);
  }
  const groups = new Map();
  const unresolved = [];
  for (const c of capture.comments || []) {
    const post = c?.post ? byCode[c.post] : null;
    if (!post || !username(post.username) || !mediaPkOf(post)) {
      unresolved.push(c);
      continue;
    }
    if (!groups.has(c.post)) groups.set(c.post, { post, list: [] });
    groups.get(c.post).list.push(c);
  }
  for (const { post, list } of groups.values()) events.push(...commentEvents(list, post, at));
  return { events, unresolved };
}

/**
 * One capture → events. `context.postsByCode` resolves each comment's post
 * (owner and media pk); a comment whose post is unknown yields no event.
 */
export function toIgExportEvents(capture, context) {
  return build(capture || {}, context).events;
}
toIgExportEvents.withUnresolved = (capture, context) => build(capture || {}, context);
