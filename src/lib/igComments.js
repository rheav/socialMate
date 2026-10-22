// Pure helpers for the Instagram Comments tool (panel side). Unit-tested.
//
// Comments are captured passively from the comment connections Instagram itself
// parses when you open a post (see src/content/ig/main-world.js). The records use
// the TikTok comment's field names, so threading / sorting / filtering / rows come
// straight from ./ttComments.js — only the export envelope is Instagram's own.

import { downloadPath, sanitizeFilenamePart } from "./downloadPath.js";
import { threadComments } from "./ttComments.js";

export { threadComments, sortComments, filterComments, commentToRow, commentCounts } from "./ttComments.js";

/** JSON export envelope for one post's captured comment thread. */
export function buildIgExport(post) {
  const comments = threadComments(post?.comments || []);
  const meta = post?.meta || {};
  return {
    shortcode: post?.code || null,
    post_url: post?.code ? `https://www.instagram.com/p/${post.code}/` : null,
    author: meta.username || null,
    caption: meta.caption || null,
    scraped_at: new Date().toISOString(),
    count: comments.length,
    reply_count: comments.filter((c) => c.is_reply).length,
    comments,
  };
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// `author` leads the name when known — see fbComments.filenameFor.
export function igExportFilename(code, author, ext = "json") {
  const who = sanitizeFilenamePart(author);
  const base = `ig-${code || "post"}-${stamp()}`;
  return downloadPath("comments", who ? `${who}-${base}.${ext}` : `${base}.${ext}`);
}

/** The sheet columns of a comment export (CSV and XLSX share them). */
export const IG_COMMENT_COLS = [
  { key: "username", label: "Usuário" },
  { key: "text", label: "Comentário" },
  { key: "likes", label: "Curtidas" },
  { key: "replies", label: "Respostas" },
  { key: "date", label: "Data" },
  { key: "reply_to", label: "Responde a" },
  { key: "verified", label: "Verificado" },
  { key: "id", label: "ID" },
  { key: "parent_id", label: "ID do comentário pai" },
  { key: "profile", label: "Perfil" },
];

const pad2 = (n) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD HH:mm" for a unix time in seconds; null when missing. */
export function commentDate(sec) {
  if (!Number.isFinite(Number(sec)) || !sec) return null;
  const d = new Date(Number(sec) * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** One row per comment, in thread order (each reply under its comment). */
export function igCommentRows(post) {
  const list = threadComments(post?.comments || []);
  const byId = new Map(list.map((c) => [c.cid, c]));
  return list.map((c) => ({
    username: c.username || null,
    text: c.text || "",
    likes: c.digg_count ?? null,
    replies: c.is_reply ? null : (c.reply_count ?? null),
    date: commentDate(c.create_time),
    reply_to: c.is_reply ? (byId.get(c.parent)?.username || null) : null,
    verified: c.verified ? "sim" : "",
    id: c.cid || null,
    parent_id: c.is_reply ? (c.parent || null) : null,
    profile: c.username ? `https://www.instagram.com/${c.username}/` : null,
  }));
}

/** RFC 4180 CSV with a header row; a leading BOM so Excel reads it as UTF-8. */
export function toCsv(cols, rows) {
  const cell = (v) => {
    if (v == null) return "";
    const t = String(v);
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [cols.map((c) => cell(c.label)).join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c.key])).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/**
 * The posts a comment sweep opens: listed order, only those with comments and a
 * shortcode, each once, at most `max` (the background caps it too).
 */
export function commentSweepTargets(records, max = 15) {
  const seen = new Set();
  const out = [];
  for (const r of records || []) {
    const code = r && r.code;
    if (!code || seen.has(code) || !(Number(r.comment_count) > 0)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= max) break;
  }
  return out;
}
