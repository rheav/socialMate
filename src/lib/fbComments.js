// Pure, DOM-free helpers for the FB comment scraper. Unit-tested.
//
// All comment data comes from the rendered DOM (comments parse on the main
// thread, but we read the article nodes directly — robust + locale-tolerant via
// aria-label). These helpers turn raw aria-labels / hrefs into clean records and
// assemble the JSON export envelope.

import { parseCount } from "./fbReels.js";

// "22 reações, veja quem reagiu a isso" / "22 reactions" / "1,2 mil reações" → number.
// No reactions element → 0.
export function parseReactions(ariaLabel) {
  if (!ariaLabel) return 0;
  // number token immediately before the reaction word (handles abbreviations
  // like "1,2 mil" via parseCount).
  const m = String(ariaLabel).match(
    /([\d.,]+\s*(?:mil|mi|k|m|b)?)\s*(?:rea(?:ç|c)|react|reação|reaction)/i,
  );
  if (!m) return 0;
  const n = parseCount(m[1]);
  return n == null ? 0 : n;
}

// Localized "comment by <author>" aria-label prefixes.
const COMMENT_PREFIX =
  /^(?:coment[áa]rio de|comment(?:ed)? by|comentario de|commentaire de|commento di|kommentar von)\s+/i;
// Trailing relative-time expression to strip off the author name.
const TRAILING_TIME =
  /\s*(?:h[áa]|hace|il y a|vor|fa)\s+.+$|\s*\d+\s*(?:s|sem|semana?s?|min|minuto?s?|h|hora?s?|d|dia?s?|w|week?s?|day?s?|hr?s?|mo|month?s?|y|year?s?|ano?s?)\.?$/i;

// "Comentário de Melanie May há 4 semanas" → { name: "Melanie May", time: "há 4 semanas" }.
// Best-effort: the content script prefers the author LINK text for the name and
// falls back to this. Returns { name, time } (either may be null).
export function parseAuthorFromAria(ariaLabel) {
  if (!ariaLabel) return { name: null, time: null };
  const body = String(ariaLabel).replace(COMMENT_PREFIX, "");
  const tm = body.match(TRAILING_TIME);
  const time = tm ? tm[0].trim() : null;
  const name = body.replace(TRAILING_TIME, "").trim() || null;
  return { name: name && name.length <= 80 ? name : null, time };
}

// A commenter's profile link carries a ?comment_id / tracking tail. Strip it to a
// clean profile URL and derive a stable id (numeric for profile.php, else the
// vanity slug).
export function cleanAuthorUrl(href) {
  if (!href) return { url: null, id: null };
  try {
    const u = new URL(href, "https://www.facebook.com");
    if (u.pathname === "/profile.php") {
      const id = u.searchParams.get("id");
      return { url: id ? `https://www.facebook.com/profile.php?id=${id}` : u.origin + u.pathname, id: id || null };
    }
    const slug = u.pathname.replace(/^\/+|\/+$/g, "");
    return { url: `https://www.facebook.com${u.pathname.replace(/\/+$/, "")}`, id: slug || null };
  } catch {
    const clean = String(href).split("?")[0];
    const slug = clean.replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "");
    return { url: clean, id: slug || null };
  }
}


// Stable dedupe key: the comment_id if we have one, else author + text prefix.
export function dedupeKey(rec) {
  if (rec.comment_id) return rec.comment_id;
  return (rec.author?.id || "?") + "|" + String(rec.text || "").slice(0, 40);
}

// timestamp for filenames: 2026-07-18T13-40-00
function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function filenameFor(postId) {
  return `socialmate-comments/fb-${postId || "post"}-${stamp()}.json`;
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
