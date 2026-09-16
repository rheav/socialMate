// Getting a FRESH thumbnail URL for a record whose stored one has expired.
//
// Companion to thumbCache.js: that one keeps new records from rotting, this one
// un-rots the records already in the store. Every route below was verified live
// (2026-09-15) against a real install's records:
//
//   instagram  GET /p/<code>/embed/captioned/  -> "display_url", THEN
//              GET /p/<code>/                  -> og:image
//              Both work LOGGED OUT, with no x-ig-app-id and no pk — the shortcode
//              is all they need, and every IG record carries one. The second is
//              not redundant: Instagram's embed answers "O link desta foto ou
//              vídeo pode estar quebrado ou o post pode ter sido removido" for
//              posts that are public and perfectly alive (6 of 6 reported by the
//              user, 2026-09-16). Only the post page tells the truth for those,
//              and it costs 737KB against the embed's 240KB — hence the order.
//   facebook   GET /plugins/video.php?href=<permalink> -> first scontent image
//              Needs the user's session. PARTIAL by nature: a video that is not
//              publicly embeddable answers with a ~59KB JS shell and no image —
//              2 of 4 records tested recovered. Nothing to do about the rest.
//   tiktok     GET /oembed?url=<permalink> -> thumbnail_url
//              Public JSON, no auth, no Referer needed on the URL it returns.
//   pinterest  the stored i.pinimg.com URL is UNSIGNED — it never expired in the
//              first place, so "recovery" is just fetching those bytes again.
//
// The parsers are pure so they can be tested without a network; resolveFreshThumb
// wires them to fetch.

import { isDataThumb, isThumbExpired } from "./thumbCache.js";

// Both payload families escape the URL twice over: JSON `\/` for the slashes and
// HTML `&amp;` for the query separators. A URL left half-escaped fetches as a 400.
function unescapeUrl(u) {
  return String(u)
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?38;/g, "&");
}

// ---- identifiers -----------------------------------------------------------

// A shortcode is letters/digits/-/_ — a bare number is a pk, which the embed
// route cannot take.
export function igCodeOf(rec = {}) {
  const fromUrl = String(rec.sourceUrl || "").match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  const code = rec.code || fromUrl?.[1] || rec.videoId;
  if (!code) return null;
  const s = String(code);
  return /^[A-Za-z0-9_-]{5,}$/.test(s) && !/^\d+$/.test(s) ? s : null;
}

export function fbPermalinkOf(rec = {}) {
  const src = String(rec.sourceUrl || "");
  if (/^https?:\/\/(?:[a-z-]+\.)*facebook\.com\//i.test(src)) return src;
  return rec.videoId ? `https://www.facebook.com/reel/${rec.videoId}` : null;
}

export function ttPermalinkOf(rec = {}) {
  const src = String(rec.sourceUrl || "");
  return /^https?:\/\/(?:[a-z-]+\.)*tiktok\.com\/@[^/]+\/video\/\d+/i.test(src) ? src : null;
}

// ---- endpoints -------------------------------------------------------------

export const igEmbedUrl = (code) => `https://www.instagram.com/p/${code}/embed/captioned/`;
export const igPostUrl = (code) => `https://www.instagram.com/p/${code}/`;
export const fbPluginUrl = (permalink) =>
  `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(permalink)}`;
export const ttOembedUrl = (permalink) =>
  `https://www.tiktok.com/oembed?url=${encodeURIComponent(permalink)}`;

// ---- parsers ---------------------------------------------------------------

// The post page. `og:image` is what every link preview in the world reads, so
// Instagram keeps it rendered server-side and public — including for the posts
// whose embed claims to be broken.
export function igThumbFromPostPage(html) {
  const s = String(html || "");
  const m =
    s.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) ||
    s.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/) ||
    s.match(/"display_url"\s*:\s*"([^"]+)"/);
  return m ? unescapeUrl(m[1]) : null;
}

export function igThumbFromEmbed(html) {
  const s = String(html || "");
  const m =
    s.match(/"display_url"\s*:\s*"([^"]+)"/) ||
    s.match(/"thumbnail_src"\s*:\s*"([^"]+)"/) ||
    s.match(/class="EmbeddedMediaImage"[^>]*\ssrc="([^"]+)"/) ||
    s.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
  return m ? unescapeUrl(m[1]) : null;
}

// The plugin page carries the poster AND the author's avatar. `t39.30808-1` is
// the avatar bucket (it repeats four times in the markup, so "first image" would
// pick it for any post whose poster sits later); `t15.` is Facebook's own video
// thumbnail bucket and `t51.` the one a reel cross-posted from Instagram keeps.
export function fbThumbFromPluginHtml(html) {
  const s = unescapeUrl(String(html || ""));
  const urls = (s.match(/https:\/\/[a-z0-9.-]*(?:scontent|fbcdn)[^\s"'\\<>]{20,500}/gi) || []).filter(
    (u) => /\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(u) && !/\/t39\.30808-1\//.test(u),
  );
  return urls.find((u) => /\/t15\./.test(u)) || urls.find((u) => /\/t51\./.test(u)) || urls[0] || null;
}

export function ttThumbFromOembed(json) {
  const u = json && json.thumbnail_url;
  return typeof u === "string" && u ? unescapeUrl(u) : null;
}

// ---- which records need this ----------------------------------------------

/**
 * A record is recoverable when its thumbnail is missing or its signed link has
 * expired. `brokenIds` is what the panel learned the hard way — an <img> that
 * fired onError — which catches the links that died without an expiry stamp
 * (deleted media, rotated signature).
 */
export function needsThumbRecovery(rec, { now = Date.now(), brokenIds } = {}) {
  if (!rec || !rec.videoId) return false;
  if (isDataThumb(rec.thumb)) return false;
  if (brokenIds && brokenIds.has(String(rec.videoId))) return true;
  if (!rec.thumb) return true;
  return isThumbExpired(rec.thumb, now);
}

export function recoverableRecords(records, opts) {
  return (records || []).filter((r) => needsThumbRecovery(r, opts) && recoveryRoutes(r).length > 0);
}

/**
 * The requests that can answer "where is this post's picture now?", cheapest
 * first — an empty list when the record carries no identifier a platform will
 * accept.
 *
 * A LIST, not one request, because a platform answering "nothing here" is not
 * the same as the post being gone: Instagram's embed says exactly that about
 * posts it will happily render on their own page.
 */
export function recoveryRoutes(rec = {}) {
  switch (rec.platform) {
    case "instagram": {
      const code = igCodeOf(rec);
      if (!code) return [];
      return [
        { kind: "html", url: igEmbedUrl(code), parse: igThumbFromEmbed },
        { kind: "html", url: igPostUrl(code), parse: igThumbFromPostPage },
      ];
    }
    case "facebook": {
      const link = fbPermalinkOf(rec);
      return link ? [{ kind: "html", url: fbPluginUrl(link), parse: fbThumbFromPluginHtml }] : [];
    }
    case "tiktok": {
      const link = ttPermalinkOf(rec);
      return link ? [{ kind: "json", url: ttOembedUrl(link), parse: ttThumbFromOembed }] : [];
    }
    case "pinterest":
      // Unsigned URL: if one is stored it is still the right one, expired or not.
      return rec.thumb && !isDataThumb(rec.thumb) ? [{ kind: "reuse", url: rec.thumb }] : [];
    default:
      return [];
  }
}

/** How long to wait between two recovery requests for a platform. */
export const RECOVER_GAP_MS = { instagram: 1200, facebook: 1500, tiktok: 800, pinterest: 200 };

/**
 * Resolve a live thumbnail URL for one record. Returns null when the platform
 * answered but had nothing (a private/deleted post, or Facebook's non-embeddable
 * shell) — that is a normal outcome, not an error.
 */
export async function resolveFreshThumb(rec, { fetchImpl = fetch } = {}) {
  let lastError = null;
  for (const route of recoveryRoutes(rec)) {
    if (route.kind === "reuse") return route.url;
    try {
      const r = await fetchImpl(route.url, { credentials: "include" });
      if (!r.ok) throw new Error(`recuperação HTTP ${r.status}`);
      const hit = route.parse(route.kind === "json" ? await r.json() : await r.text());
      if (hit) return hit;
    } catch (e) {
      // One route being unreachable must not hide a later one that works; the
      // error is only raised if NOTHING answered.
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return null;
}
