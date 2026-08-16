import { describe, it, expect } from "vitest";
import { chunkIndexAt, centerScrollTop, PLAYHEAD_LEAD_S } from "./playhead.js";

// Shape of the chunks actually stored (measured on a real 52 s reel: 40 chunks,
// 1.31 s average, contiguous, no null ends).
const chunks = [
  { text: " There's someone who loves you.", timestamp: [0, 1.5] },
  { text: " Did you know?", timestamp: [1.5, 2.3] },
  { text: " But they're really mad at you", timestamp: [2.3, 4.5] },
  { text: " but it's not hate;", timestamp: [4.5, 6.7] },
];

describe("chunkIndexAt", () => {
  it("finds the chunk the playhead is inside", () => {
    expect(chunkIndexAt(chunks, 3.0, { lead: 0 })).toBe(2);
  });

  it("treats a chunk's start as belonging to that chunk, not the previous one", () => {
    expect(chunkIndexAt(chunks, 1.5, { lead: 0 })).toBe(1);
  });

  it("lights the next line slightly early, the way a reader expects", () => {
    // 1.42 s is still inside chunk 0, but 80 ms from chunk 1 — with the lead the
    // highlight moves before the speaker does, which reads as "on time".
    expect(chunkIndexAt(chunks, 1.42, { lead: 0.15 })).toBe(1);
    expect(chunkIndexAt(chunks, 1.42, { lead: 0 })).toBe(0);
  });

  it("holds the last chunk once playback runs past the transcript", () => {
    expect(chunkIndexAt(chunks, 9.9, { lead: 0 })).toBe(3);
  });

  it("reports nothing before the first chunk starts", () => {
    const late = [{ text: "hi", timestamp: [2, 3] }];
    expect(chunkIndexAt(late, 0.5, { lead: 0 })).toBe(-1);
  });

  it("holds the previous line through a gap between chunks", () => {
    // Caption tracks (WebVTT) leave silent gaps; blanking there would flicker.
    const gapped = [
      { text: "a", timestamp: [0, 1] },
      { text: "b", timestamp: [5, 6] },
    ];
    expect(chunkIndexAt(gapped, 3, { lead: 0 })).toBe(0);
  });

  it("survives chunks with no end timestamp", () => {
    const open = [
      { text: "a", timestamp: [0, null] },
      { text: "b", timestamp: [4, null] },
    ];
    expect(chunkIndexAt(open, 5, { lead: 0 })).toBe(1);
  });

  it("returns -1 for nothing to search", () => {
    expect(chunkIndexAt([], 3)).toBe(-1);
    expect(chunkIndexAt(null, 3)).toBe(-1);
    expect(chunkIndexAt(chunks, null)).toBe(-1);
  });

  it("ships a small positive lead by default", () => {
    expect(PLAYHEAD_LEAD_S).toBeGreaterThan(0);
    expect(PLAYHEAD_LEAD_S).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// centerScrollTop — where the transcript box should be scrolled to.
//
// The first version fed scrollTo() `row.offsetTop`, which is measured from the
// row's offsetParent — NOT from the scroll box, which is not positioned. On a real
// card that number is the row's distance down the whole PANEL, so every highlight
// slammed the transcript to its bottom. Measuring from the box removes the
// question: the only inputs are the two rects and where the box is already
// scrolled.
// ---------------------------------------------------------------------------
describe("centerScrollTop", () => {
  // A 100px-tall box scrolled to the top, with a 20px row 300px down the page and
  // the box starting 200px down: the row sits 100px inside the box.
  const base = { scrollTop: 0, boxTop: 200, boxHeight: 100, rowTop: 300, rowHeight: 20 };

  it("centres the active row inside the box", () => {
    // row is 100px below the box top; centring it means scrolling 100 - (100-20)/2 = 60
    expect(centerScrollTop(base)).toBe(60);
  });

  it("adds to wherever the box is already scrolled", () => {
    expect(centerScrollTop({ ...base, scrollTop: 40 })).toBe(100);
  });

  it("scrolls back up for a row above the middle", () => {
    expect(centerScrollTop({ ...base, scrollTop: 200, rowTop: 210 })).toBe(170);
  });

  it("never scrolls past the top", () => {
    expect(centerScrollTop({ ...base, rowTop: 200 })).toBe(0);
    expect(centerScrollTop({ ...base, scrollTop: 0, rowTop: 120 })).toBe(0);
  });

  it("never scrolls past the bottom when the box reports its scroll height", () => {
    expect(centerScrollTop({ ...base, rowTop: 900, scrollHeight: 260 })).toBe(160);
  });

  it("ignores a row that was never laid out", () => {
    expect(centerScrollTop({ ...base, rowHeight: 0, rowTop: 0, boxHeight: 0 })).toBe(null);
  });
});
