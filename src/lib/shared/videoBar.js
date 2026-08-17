// The maths behind the Instagram progress bar. Canonical source — inlined into
// the capture scripts (see ./README.md). The DOM half lives in the bridge.
//
// WHY A COMPOSITOR ANIMATION AND NOT A TICKER. Measured on instagram.com
// (2026-08-16): a Web Animations fill tracks the media clock to within 15-29 ms
// over six seconds while running ZERO JavaScript per frame — the browser
// interpolates a transform off the main thread, the same machinery a CSS
// transition uses. A rAF loop would burn a callback every frame on a page that
// already re-renders constantly, to land no closer.
//
// So the animation is the driver, and `timeupdate` — an event Instagram's player
// already fires ~4x/s, costing us nothing extra — is only a sanity check.
//
// WHY NOT THE BROWSER'S OWN CONTROLS, which would be lighter still: setting
// `video.controls = true` does render the native bar, but Instagram paints a
// full-size role="presentation" layer over the control strip, and the video
// cannot escape that stacking context without restyling Instagram's own
// containers. Winning that fight on every surface is exactly the fragile,
// hacky thing this avoids; the bar instead lives in the extension's own
// top-level layer, which already wins hit-testing.

// How far the bar may drift before it is worth touching. Well under the ~100 ms
// a viewer can notice against a moving picture, well over the 15-29 ms measured.
export const BAR_RESYNC_MS = 250;
// A jump larger than this is not drift — it is a loop (reels wrap to 0) or a
// scrub, and the animation has to be rebuilt rather than nudged.
export const BAR_RESTART_S = 1.5;

const usableDuration = (d) => typeof d === "number" && Number.isFinite(d) && d > 0;

/**
 * Where a pointer at `clientX` lands in the video, or null when the question
 * cannot be answered yet — an MSE video has no duration until the player has
 * appended, and seeking to NaN throws.
 */
export function seekTimeFromPointer(clientX, rect, duration) {
  if (!rect || !rect.width || !usableDuration(duration)) return null;
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return frac * duration;
}

/**
 * The animation to run from here to the end: where the fill starts (0..1) and
 * how long the rest of the video takes at the current rate. Null when there is
 * nothing left to animate.
 */
export function barAnimationSpec(currentTime, duration, playbackRate = 1) {
  if (!usableDuration(duration)) return null;
  const rate = playbackRate > 0 ? playbackRate : 1;
  const remaining = duration - currentTime;
  if (remaining <= 0.01) return null;
  return { from: Math.min(1, Math.max(0, currentTime / duration)), durationMs: (remaining / rate) * 1000 };
}

/**
 * What to do about the gap between where the bar is and where the video is:
 * nothing, a nudge, or a full restart. `barTime` and `videoTime` are seconds.
 */
export function barResync(barTime, videoTime) {
  const delta = barTime - videoTime;
  if (Math.abs(delta) >= BAR_RESTART_S) return "restart";
  if (Math.abs(delta) * 1000 > BAR_RESYNC_MS) return "nudge";
  return null;
}
