// Which Instagram surface a record belongs to. INLINED into content scripts —
// see src/lib/shared/README.md before editing (no imports allowed in this file
// beyond a sibling).
//
// This is shared between the MAIN-world capture and the isolated bridge because
// the surface has to be decided WHERE AND WHEN the record is captured, not when it
// is relayed. The bridge used to stamp `surfaceKey()` at relay time, which is
// wrong for replays: after "Atualizar" the MAIN world resends everything it ever
// captured, so records from profile A arrived while the user was on profile B and
// got labelled `profile:B` — and the username backfill then attributed A's posts
// to B, defeating the Sort tool's ownership filter.
//
// THE REDIRECT THAT BROKE THE HASHTAG BUCKET (measured live 2026-09-22).
// Instagram no longer serves /explore/tags/<t>/ — it 302s to
//
//     /explore/search/keyword/?q=%23<t>
//
// This function only ever read `location.pathname`, so every hashtag page fell
// through to `p.startsWith("/explore")` and was bucketed as plain "explore" —
// the SAME bucket as the Explore recommendation feed and as every other hashtag.
// 30 tarot posts captured on #soulmate came back stamped "explore", sitting in a
// list that already held cars and graduation photos from an earlier Explore visit,
// and no amount of scrolling removed them. The query string is now load-bearing:
// pass it in, or hashtags silently pool again.

import { makeSurfaceTracker } from "./surfaceTracker.js";

// Top-level IG routes that are features, not usernames. A path like /explore/ or
// /direct/ must never be read as a profile.
export const IG_RESERVED_SEGMENTS = [
  "explore",
  "reels",
  "reel",
  "p",
  "direct",
  "stories",
  "accounts",
  "tv",
  "guides",
  "challenges",
  "about",
  "legal",
  "privacy",
  "terms",
];

// Routes that show ONE item you arrived at from a grid. They never become the
// surface — see surfaceTracker.js for why (the panel emptied while a post was
// open, and the post left the hashtag list it came from).
const IG_TRANSPARENT = /^\/(?:p|reel|stories|direct|accounts)(?:\/|$)/;

/** `?q=` off a search route: "#soulmate" -> tag:soulmate, "tarot" -> search:tarot. */
function searchSurface(search) {
  let q = "";
  try {
    q = new URLSearchParams(search || "").get("q") || "";
  } catch {
    q = ""; // a malformed query must not throw inside JSON.parse
  }
  q = q.trim().toLowerCase();
  if (!q) return "explore";
  // A hashtag search and a word search return different result sets (the word one
  // mixes in accounts and audio), so they stay separate buckets.
  return q.startsWith("#") ? "tag:" + q.slice(1) : "search:" + q;
}

/**
 * `path` is a pathname and `search` a query string (both default to the live
 * location). Returns the surface key, or **null** for a transparent detail route —
 * callers must go through `igSurface` (the tracker) rather than use null directly.
 *
 *   "tag:<name>" | "search:<term>" | "explore" | "reels" | "profile:<user>"
 *   | "tagged:<user>" | "saved:<user>" | "feed" | null
 */
export function igSurfaceKey(path, search) {
  const p = path == null ? (typeof location !== "undefined" ? location.pathname : "/") : String(path);
  const q = search == null ? (typeof location !== "undefined" ? location.search : "") : String(search);
  let m;
  if (IG_TRANSPARENT.test(p)) return null;
  if ((m = p.match(/\/explore\/tags\/([^/]+)/))) {
    try {
      return "tag:" + decodeURIComponent(m[1]).toLowerCase();
    } catch {
      return "tag:" + m[1].toLowerCase(); // a malformed escape must not throw here
    }
  }
  // /explore/search/keyword/, /explore/search/top/, and whatever IG renames it to
  // next — all of them carry the term in ?q=.
  if (p.startsWith("/explore/search")) return searchSurface(q);
  if (p.startsWith("/explore")) return "explore";
  // The Reels feed AND its player: /reels/ is the tab, /reels/<code>/ is the same
  // vertical feed with one reel addressed. Found live 2026-09-22 — clicking a reel
  // from a post page lands on /reels/<code>/, which matched nothing and fell
  // through to "feed", pooling the Reels feed with the home timeline. Note this is
  // NOT /reel/<code>/ (singular), which is a permalink out of a grid and stays
  // transparent.
  if (/^\/reels(?:\/|$)/.test(p)) return "reels";
  // Other people's posts that tag this profile: multi-author, so it must NOT be
  // "profile:<u>" — filterBySurface drops a profile record whose author isn't the
  // owner, which would empty the tab.
  if ((m = p.match(/^\/([^/]+)\/tagged\/?$/)) && !IG_RESERVED_SEGMENTS.includes(m[1]))
    return "tagged:" + m[1].toLowerCase();
  if ((m = p.match(/^\/([^/]+)\/saved(?:\/|$)/)) && !IG_RESERVED_SEGMENTS.includes(m[1]))
    return "saved:" + m[1].toLowerCase();
  if ((m = p.match(/^\/([^/]+)\/?(?:reels\/?)?$/))) {
    const u = m[1];
    if (!IG_RESERVED_SEGMENTS.includes(u)) return "profile:" + u;
  }
  return "feed";
}

/**
 * The live tracker. One instance per document — the MAIN world and the bridge each
 * hold their own, and both see the same URLs, so they agree.
 */
export const igSurface = makeSurfaceTracker(igSurfaceKey);
