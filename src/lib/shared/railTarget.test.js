import { describe, it, expect } from "vitest";
import { railHitsMedia, mediaUnderRail, boundMediaIsStale } from "./railTarget.js";

// Numbers taken from the live repro on facebook.com/hashtag/soulmate (2026-08-10):
// three feed videos, the viewport 1134px tall, and rails frozen at the positions
// they had been drawn at when scrollY was 0.
const V35 = { top: -1607, bottom: -927, left: 487, right: 1167 };
const V24 = { top: -777, bottom: -97, left: 487, right: 1167 };
const V8 = { top: 112, bottom: 1021, left: 487, right: 1167 };
const rect = (top, left = 497) => ({ top, bottom: top + 36, left, right: left + 36 });

describe("which media a rail points at", () => {
  it("accepts a rail drawn just inside its media", () => {
    expect(railHitsMedia(rect(122), V8)).toBe(true);
    expect(railHitsMedia(rect(1021), V8)).toBe(true); // exactly on the bottom edge
  });

  it("rejects a rail that has drifted off its media", () => {
    // The frozen rail from the repro: bound to the 35s video, drawn at 210.
    expect(railHitsMedia(rect(210), V35)).toBe(false);
    expect(railHitsMedia(rect(1040), V24)).toBe(false);
    expect(railHitsMedia(rect(1200), V8)).toBe(false); // below the media
    expect(railHitsMedia(rect(122, 100), V8)).toBe(false); // left of it
    expect(railHitsMedia(null, V8)).toBe(false);
    expect(railHitsMedia(rect(122), null)).toBe(false);
  });

  it("finds the media actually under a drifted rail", () => {
    // This is the bug in one line: the rail says "35s video", the screen says 8s.
    expect(mediaUnderRail(rect(210), [V35, V24, V8])).toBe(2);
    expect(mediaUnderRail(rect(1040), [V35, V24, V8])).toBe(-1); // over nothing
    expect(mediaUnderRail(rect(122), [V35, V24, V8])).toBe(2);
    expect(mediaUnderRail(rect(122), null)).toBe(-1);
  });

  it("trusts an in-page rail always, and a floating one only while it is on target", () => {
    // In-page rails hang off the post unit, OUTSIDE the media box — testing
    // containment on those would reject every one of them.
    expect(boundMediaIsStale({ floating: false, connected: true, railRect: rect(9999), boundRect: V8 })).toBe(false);
    expect(boundMediaIsStale({ floating: true, connected: true, railRect: rect(122), boundRect: V8 })).toBe(false);
    expect(boundMediaIsStale({ floating: true, connected: true, railRect: rect(210), boundRect: V35 })).toBe(true);
    // A remounted node is stale whatever the geometry says.
    expect(boundMediaIsStale({ floating: false, connected: false, railRect: rect(122), boundRect: V8 })).toBe(true);
    expect(boundMediaIsStale({ floating: true, connected: false, railRect: rect(122), boundRect: V8 })).toBe(true);
  });
});
