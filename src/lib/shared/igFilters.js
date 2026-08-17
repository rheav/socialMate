// Panel-side knobs for the Instagram tool that the page ALSO needs — the overlay
// draws the same ER the panel sorts by, and the auto-scroll runs in the page.
// Canonical source, inlined into the capture scripts (see ./README.md).

// DATE_RANGES / withinDateRange / scrollGapMs used to live here. Nothing in them
// was Instagram — TikTok's createTime is the same unix-seconds stamp and the
// scroll cadence is the same anti-automation shape — so they moved to
// ./harvest.js, where the TikTok scripts can inline them without dragging
// Instagram's ER weights and React prop reader along.

// ---- ER weights (item 5) ----
// Defaults match IG Sorter's, which is what these numbers were copied from: a
// comment and a repost each cost far more intent than a like.
export const ER_WEIGHTS = { like: 1, comment: 4, repost: 4 };
export const ER_WEIGHTS_KEY = "fbw_ig_er_weights"; // storage.local — panel writes, page reads

/** Per-field fallback: one junk value must not throw away the other two. */
export function normalizeErWeights(w) {
  const out = { ...ER_WEIGHTS };
  if (!w || typeof w !== "object") return out;
  for (const k of Object.keys(ER_WEIGHTS)) {
    const n = Number(w[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

// ---- React-props media resolution (item 8) ----
// The full-screen /reels/ player renders no <a> around the video, so an
// anchor-based overlay finds nothing there. Instagram's own props do carry an
// identifier — a shortcode on some surfaces, a media id or the video's FB id on
// others — so the overlay resolves whichever one is present and looks it up.
const CODE_RE = /\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/;

export function readReactMediaRef(props) {
  if (!props || typeof props !== "object") return null;
  const code = props.post && props.post.code;
  if (code) return { kind: "code", value: String(code) };
  const mediaKeyId = props.media$key && props.media$key.id;
  if (mediaKeyId) return { kind: "id", value: String(mediaKeyId) };
  if (props.mediaId) return { kind: "id", value: String(props.mediaId) };
  const fbid = (props.coreVideoPlayerMetaData && props.coreVideoPlayerMetaData.videoFBID) || props.videoFBID;
  if (fbid) return { kind: "pk", value: String(fbid) };
  if (props.postId) return { kind: "pk", value: String(props.postId) };
  const postIdNested = props.post && props.post.id;
  if (postIdNested) return { kind: "id", value: String(postIdNested) };
  if (typeof props.href === "string") {
    const m = props.href.match(CODE_RE);
    if (m) return { kind: "code", value: m[1] };
  }
  return null;
}
