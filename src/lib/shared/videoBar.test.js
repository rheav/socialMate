import { describe, it, expect } from "vitest";
import {
  seekTimeFromPointer,
  barResync,
  barAnimationSpec,
  BAR_RESYNC_MS,
} from "./videoBar.js";

// MEASURED on instagram.com (2026-08-16), and the reason this bar is a compositor
// animation rather than a per-frame JS ticker:
//
//   • IG media is MSE (blob: src). duration/seekable only exist once the player
//     has fed the MediaSource — a bar built at DOM time must handle "not yet".
//   • A programmatic seek is exact and sticks: currentTime 2.77 -> 20.00.
//   • The clip buffers whole (33.6 of 33.6 s), so seeking anywhere is instant.
//   • A WAAPI animation tracks the media clock to within 15-29 ms over 6 s, with
//     no JS running per frame. That is the whole point: the browser animates it.
//   • Reels LOOP — currentTime wraps to ~0 — so the bar has to notice going
//     BACKWARDS and restart, not just drift forwards.

describe("seekTimeFromPointer", () => {
  const rect = { left: 100, width: 200 };

  it("maps a click in the middle of the bar to the middle of the video", () => {
    expect(seekTimeFromPointer(200, rect, 60)).toBe(30);
  });

  it("clamps a drag past either end", () => {
    expect(seekTimeFromPointer(20, rect, 60)).toBe(0);
    expect(seekTimeFromPointer(9999, rect, 60)).toBe(60);
  });

  it("refuses to guess before the media source has published a duration", () => {
    // MSE: duration is 0/NaN until the player appends. Seeking to NaN throws.
    expect(seekTimeFromPointer(200, rect, 0)).toBe(null);
    expect(seekTimeFromPointer(200, rect, NaN)).toBe(null);
    expect(seekTimeFromPointer(200, rect, Infinity)).toBe(null); // live stream
  });

  it("refuses a bar that was never laid out", () => {
    expect(seekTimeFromPointer(200, { left: 0, width: 0 }, 60)).toBe(null);
  });
});

describe("barAnimationSpec", () => {
  it("runs from where playback is to the end, in the time that is left", () => {
    expect(barAnimationSpec(15, 60, 1)).toEqual({ from: 0.25, durationMs: 45000 });
  });

  it("shortens the animation when playback is sped up", () => {
    expect(barAnimationSpec(0, 60, 2)).toEqual({ from: 0, durationMs: 30000 });
  });

  it("returns null when there is nothing to animate", () => {
    expect(barAnimationSpec(0, 0, 1)).toBe(null);
    expect(barAnimationSpec(60, 60, 1)).toBe(null); // sitting on the last frame
    expect(barAnimationSpec(0, Infinity, 1)).toBe(null);
  });
});

describe("barResync", () => {
  // The animation is the driver; `timeupdate` (which fires ~4x/s anyway) is only
  // a cheap sanity check. Nudging on every tick would defeat the point.
  it("leaves the animation alone while it tracks", () => {
    expect(barResync(10.02, 10.0)).toBe(null);
    expect(barResync(9.95, 10.0)).toBe(null);
  });

  it("nudges when the bar has drifted further than a viewer would forgive", () => {
    expect(barResync(10.6, 10.0)).toBe("nudge");
    expect(barResync(9.2, 10.0)).toBe("nudge");
  });

  it("restarts when playback jumped — a loop, or the user scrubbing", () => {
    // A reel wrapping 33.5 -> 0.2 is a restart, not a drift correction.
    expect(barResync(33.5, 0.2)).toBe("restart");
    expect(barResync(2, 25)).toBe("restart");
  });

  it("treats a hair over the nudge threshold as a nudge, not a restart", () => {
    expect(barResync(10, 10 + BAR_RESYNC_MS / 1000 + 0.05)).toBe("nudge");
  });
});
