// Pure, DOM-free helpers for the FB comment scraper. Unit-tested.
//
// All comment data comes from the rendered DOM (comments parse on the main
// thread, but we read the article nodes directly — robust + locale-tolerant via
// aria-label). These helpers turn raw aria-labels / hrefs into clean records and
// assemble the JSON export envelope.

import { downloadPath, sanitizeFilenamePart } from "./downloadPath.js";
// These parsers are shared with src/content/fb/comments-scrape.js, which is
// inlined at build time because a content script cannot import (see
// src/lib/shared/README.md). Re-exported so callers and tests are unchanged.
import {
  COMMENT_PREFIX,
  TRAILING_TIME,
  parseReactions,
  parseAuthorFromAria,
  cleanAuthorUrl,
  dedupeKey,
} from "./shared/fbCommentParse.js";

export {
  COMMENT_PREFIX,
  TRAILING_TIME,
  parseReactions,
  parseAuthorFromAria,
  cleanAuthorUrl,
  dedupeKey,
};



// timestamp for filenames: 2026-07-18T13-40-00
function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// Both routes to a comments export — the content script's auto-save and the panel's
// "baixar JSON" button — call this, so they can never disagree about where it lands.
//
// `author` is optional and leads the name when known, the same way every media file
// does: in a flat folder (Opções → Downloads) the name is the only structure, so a
// post's comments sort next to that creator's videos instead of under "fb-".
export function filenameFor(postId, author) {
  const who = sanitizeFilenamePart(author);
  const base = `fb-${postId || "post"}-${stamp()}`;
  return downloadPath("comments", who ? `${who}-${base}.json` : `${base}.json`);
}

// Assemble the export envelope. Records arrive already ordered (top-level then its
// replies). Adds scrape metadata + counts.
export function buildExport(postMeta, records) {
  const comments = Array.isArray(records) ? records : [];
  return {
    post_url: postMeta.post_url || null,
    post_id: postMeta.post_id || null,
    scraped_at: new Date().toISOString(),
    sort_mode: postMeta.sort_mode || "relevant",
    count: comments.length,
    reply_count: comments.filter((c) => c.is_reply).length,
    comments,
  };
}
