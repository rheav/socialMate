// Pure, DOM-free helpers for the TikTok Comments tool (panel side). Unit-tested.
//
// Comments are captured passively from /api/comment/list/ responses (teed by the
// MAIN-world fetch hook) when the user opens a video. Replies carry a `parent`
// (reply_id); top-level comments don't. These helpers order a thread (top-level,
// each followed by its replies), sort, and map to display rows.

import { downloadPath } from "./downloadPath.js";

// Order a flat comment list as top-level comments each immediately followed by
// their replies (by capture order within each group). Orphan replies (parent not
// present) fall back to the tail so nothing is dropped.
export function threadComments(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const tops = list.filter((c) => !c.is_reply);
  const repliesByParent = new Map();
  for (const c of list) {
    if (c.is_reply && c.parent) {
      if (!repliesByParent.has(c.parent)) repliesByParent.set(c.parent, []);
      repliesByParent.get(c.parent).push(c);
    }
  }
  const out = [];
  const seen = new Set();
  for (const t of tops) {
    out.push(t);
    seen.add(t.cid);
    for (const r of repliesByParent.get(t.cid) || []) { out.push(r); seen.add(r.cid); }
  }
  // Orphan replies whose parent wasn't captured.
  for (const c of list) if (!seen.has(c.cid)) out.push(c);
  return out;
}

const CKEY = {
  likes: (c) => c.digg_count,
  date: (c) => c.create_time,
};

// Sort within a thread. "thread" keeps top-level→reply order (calm default);
// "likes"/"date" rank the flat list (replies mixed in), missing values last.
export function sortComments(comments, key = "thread", dir = "desc") {
  if (key === "thread") return threadComments(comments);
  const get = CKEY[key] || CKEY.likes;
  const sign = dir === "asc" ? 1 : -1;
  return [...(comments || [])].sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign;
  });
}

// Filter by free text over comment body or author (case-insensitive).
export function filterComments(comments, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return comments || [];
  return (comments || []).filter(
    (c) =>
      (c.text || "").toLowerCase().includes(q) ||
      (c.username || "").toLowerCase().includes(q) ||
      (c.nickname || "").toLowerCase().includes(q),
  );
}

export function commentToRow(c) {
  return {
    cid: c.cid,
    text: c.text || "",
    likes: c.digg_count ?? null,
    replies: c.reply_count ?? null,
    author: c.nickname || c.username || "unknown",
    handle: c.username || null,
    isReply: !!c.is_reply,
    time: c.create_time || null,
  };
}

// Count top-level vs replies for the header.
export function commentCounts(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const replies = list.filter((c) => c.is_reply).length;
  return { total: list.length, replies, topLevel: list.length - replies };
}

// JSON export envelope for a captured video's comment thread.
export function buildExport(video) {
  const comments = threadComments(video?.comments || []);
  const meta = video?.meta || {};
  return {
    aweme_id: video?.aweme_id || null,
    video_url: meta.username && video?.aweme_id ? `https://www.tiktok.com/@${meta.username}/video/${video.aweme_id}` : null,
    author: meta.username || meta.nickname || null,
    desc: meta.desc || null,
    scraped_at: new Date().toISOString(),
    count: comments.length,
    reply_count: comments.filter((c) => c.is_reply).length,
    comments,
  };
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function exportFilename(awemeId) {
  return downloadPath("comments", `tt-${awemeId || "video"}-${stamp()}.json`);
}
