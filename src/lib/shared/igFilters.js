// Panel-side knobs for the Instagram tool that the page ALSO needs — the overlay
// draws the same ER the panel sorts by, and the auto-scroll runs in the page.
// Canonical source, inlined into the capture scripts (see ./README.md).

// ---- date range (item 4) ----
// A hashtag search is mostly old posts; "what worked this month" is the question
// worth asking, and sorting alone can't answer it.
export const DATE_RANGES = [
  { value: "all", label: "Todo o período", days: null },
  { value: "7d", label: "Últimos 7 dias", days: 7 },
  { value: "14d", label: "Últimos 14 dias", days: 14 },
  { value: "30d", label: "Últimos 30 dias", days: 30 },
  { value: "90d", label: "Últimos 90 dias", days: 90 },
  { value: "180d", label: "Últimos 180 dias", days: 180 },
  { value: "1y", label: "Último ano", days: 365 },
  { value: "2y", label: "Últimos 2 anos", days: 730 },
];

/**
 * `takenAt` is IG's taken_at — UNIX SECONDS, like the payload gives it. A record
 * whose date never arrived is KEPT: the grid payloads often omit taken_at, and
 * hiding those posts would look like the filter had eaten real results.
 */
export function withinDateRange(takenAt, range, nowSec = Math.floor(Date.now() / 1000)) {
  const r = DATE_RANGES.find((x) => x.value === range);
  if (!r || r.days == null) return true;
  if (typeof takenAt !== "number" || !Number.isFinite(takenAt)) return true;
  return takenAt >= nowSec - r.days * 86400;
}

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

// ---- paced auto-scroll (item 6) ----
// IG Sorter scrolls to the bottom on a timer: 3 s for the first five, 6 s for the
// next five, then 10 s. Same shape here — a harvester that keeps a constant fast
// cadence is the part that reads as automation.
export function scrollGapMs(i) {
  if (i < 5) return 3000;
  if (i < 10) return 6000;
  return 10000;
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
