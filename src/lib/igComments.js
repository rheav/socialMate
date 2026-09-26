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
export function igExportFilename(code, author) {
  const who = sanitizeFilenamePart(author);
  const base = `ig-${code || "post"}-${stamp()}`;
  return downloadPath("comments", who ? `${who}-${base}.json` : `${base}.json`);
}
