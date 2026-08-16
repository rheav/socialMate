// Which transcript line is playing right now.
//
// The panel highlights a stored transcript in time with the video playing in the
// Facebook tab. The page reports its `currentTime`; this decides which chunk that
// time belongs to. Kept pure and separate from the React tree because every real
// bug here is a boundary bug — a chunk's own start counting as the previous line,
// a gap between caption cues blanking the highlight, playback running past the
// end of the transcript — and those are worth a test each.
//
// Chunks are Whisper segments (measured on a real reel: 1.31 s average, 4.8 words,
// contiguous) or WebVTT cues, which DO leave gaps. Both shapes go through here.

// Highlight this many seconds early. Whisper's segment boundaries land within a
// few hundred ms of the speech, and a line that appears exactly on the first
// syllable reads as late — a small lead reads as "on time".
export const PLAYHEAD_LEAD_S = 0.15;

/**
 * Index of the chunk playing at `t`, or -1 when the playhead is before the first
 * one (or there is nothing to search).
 *
 * Once a chunk has started it stays lit until the next one starts, so a gap
 * between cues holds the last line instead of flickering to nothing. Linear scan:
 * a transcript is tens of chunks and this runs ~4×/s.
 */
export function chunkIndexAt(chunks, t, { lead = PLAYHEAD_LEAD_S } = {}) {
  if (!Array.isArray(chunks) || !chunks.length) return -1;
  if (typeof t !== "number" || !Number.isFinite(t)) return -1;
  const at = t + lead;
  let found = -1;
  for (let i = 0; i < chunks.length; i++) {
    const start = chunks[i]?.timestamp?.[0];
    if (typeof start !== "number") continue;
    if (start > at) break; // chunks are in order — nothing later can have started
    found = i;
  }
  return found;
}

/**
 * Where the transcript box should be scrolled so the active line sits in its
 * middle. All measurements are viewport rects plus the box's current scrollTop,
 * so nothing depends on which ancestor happens to be positioned.
 *
 * The first version passed `row.offsetTop` straight to scrollTo(). offsetTop is
 * measured from the row's offsetParent, and the scroll box is not positioned — so
 * that number was the row's distance down the whole PANEL, and every line change
 * slammed the transcript to its bottom.
 *
 * Returns null when the box or the row was never laid out (nothing to centre).
 */
export function centerScrollTop({ scrollTop = 0, boxTop, boxHeight, rowTop, rowHeight, scrollHeight } = {}) {
  if (!boxHeight || !rowHeight) return null;
  const offsetInBox = rowTop - boxTop; // where the row sits inside the visible box
  const want = scrollTop + offsetInBox - (boxHeight - rowHeight) / 2;
  const max = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight - boxHeight) : Infinity;
  return Math.round(Math.min(Math.max(0, want), max));
}
