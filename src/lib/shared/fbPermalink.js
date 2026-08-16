// Where a captured Facebook video actually lives. Canonical source — inlined
// verbatim into the import-free capture scripts by scripts/gen-inline.mjs.
//
// A video id ALONE does not say which URL opens it, and getting that wrong is not
// a dead link — it opens somebody else's video. Checked live on 2026-08-15:
//
//   /reel/<id>          opened the right video for every id tried, including ids
//                       whose record had been stored in watch form, and it is the
//                       form Facebook's own markup uses for reels
//   /watch/?v=<id>      usually right, but this route falls back to the reels FEED
//                       when Facebook won't serve the item — which is how a card
//                       opened "a totally different one"
//   /video.php?v=<id>   redirects into /watch/?v=<id>, so it inherits that
//
// (An earlier read of this said /watch/ ALWAYS bounces reels to the feed. That was
// measured while Facebook was serving this profile error pages, and the same probe
// gave the opposite answer an hour later. Don't rebuild anything on that signal.)
//
// So: capture records the FORM the post's own link used, and anything left over
// from before that is linked as a reel.
const KIND = { reel: "reel", video: "video" };

/**
 * The video a Facebook link points at: `{ id, kind }`, or null when it points at
 * no video. `kind` is "reel" for /reel/<id> and "video" for /videos/<id> and
 * ?v=<id> — the two shapes that need different permalinks.
 */
export function fbVideoRef(href) {
  const s = String(href || "");
  if (!s) return null;
  const reel = s.match(/\/reel\/(\d+)/);
  if (reel) return { id: reel[1], kind: KIND.reel };
  const videos = s.match(/\/videos\/(\d+)/);
  if (videos) return { id: videos[1], kind: KIND.video };
  const v = s.match(/[?&]v=(\d+)/);
  if (v) return { id: v[1], kind: KIND.video };
  return null;
}

/**
 * The URL to open for a captured video. An unknown kind gets the reel form: it is
 * what this extension captures most, and a wrong reel URL fails visibly instead of
 * silently playing a stranger's video.
 */
export function fbPermalink(ref) {
  const id = ref && ref.id;
  if (!id) return null;
  return ref.kind === KIND.video
    ? `https://www.facebook.com/watch/?v=${id}`
    : `https://www.facebook.com/reel/${id}`;
}

/**
 * The URL a Library card should open.
 *
 * Non-Facebook records keep whatever they stored (TikTok/Instagram/Pinterest URLs
 * are already canonical). A Facebook record stored before the capture fix carries
 * /watch/?v=<id>, which is the route that can dump the viewer into the reels feed
 * — rebuild those as /reel/<id>, which addressed every id correctly in testing.
 *
 * `videoKind` is what keeps that rebuild off the records it would BREAK. Capture
 * records it ("reel" or "video") from the post's own link, and a real page-video
 * post — /<page>/videos/<id>, or the theater's ?v=<id> — is stored in watch form
 * ON PURPOSE, because that is the URL that opens it. Rewriting one of those to
 * /reel/<id> points the card at something that is not a reel. So only a record
 * with no kind at all (legacy: captured before the fix, when watch form meant a
 * reel) is rebuilt.
 */
export function fbCardLink({ platform, videoId, sourceUrl, videoKind } = {}) {
  if (platform && platform !== "facebook") return sourceUrl || null;
  if (!sourceUrl)
    return videoId ? fbPermalink({ id: videoId, kind: videoKind || KIND.reel }) : null;
  if (!videoId || !/\/watch\/\?/.test(sourceUrl)) return sourceUrl;
  if (videoKind === KIND.video) return sourceUrl; // captured as a video post — watch IS its URL
  return fbPermalink({ id: videoId, kind: KIND.reel });
}
