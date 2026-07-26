// FB comment-thread parsing: aria-label and href → clean record fields.
// INLINED into content scripts — see src/lib/shared/README.md before editing.
// A shared module may import only from a sibling in this directory; the generator
// strips that line and inlines the sibling alongside (which is why counts.js is
// listed before this file in scripts/gen-inline.mjs).
import { parseCount } from "./counts.js";

// Localized "comment by <author>" aria-label prefixes.
export const COMMENT_PREFIX =
  /^(?:coment[áa]rio de|comment(?:ed)? by|comentario de|commentaire de|commento di|kommentar von)\s+/i;
// Trailing relative-time expression to strip off the author name.
export const TRAILING_TIME =
  /\s*(?:h[áa]|hace|il y a|vor|fa)\s+.+$|\s*\d+\s*(?:s|sem|semana?s?|min|minuto?s?|h|hora?s?|d|dia?s?|w|week?s?|day?s?|hr?s?|mo|month?s?|y|year?s?|ano?s?)\.?$/i;

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
// vanity slug). The catch branch derives the slug too — the page copy used to
// return id:null there, so an unparseable href lost the author identity.
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
