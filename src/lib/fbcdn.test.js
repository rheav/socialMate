import { describe, it, expect } from "vitest";
import { pickByDuration, pickByWindow, foldTrack, stripByteRange } from "./fbcdn.js";

const rec = (over = {}) => ({
  videoId: "111",
  durationS: 78,
  audioUrl: "a",
  videoUrl: "v",
  videoBitrate: 500,
  lastSeen: 1000,
  ...over,
});

describe("pickByDuration", () => {
  it("matches within tolerance", () => {
    const r = rec();
    expect(pickByDuration([r], 78.9)).toBe(r);
  });

  it("rejects outside tolerance", () => {
    expect(pickByDuration([rec()], 41.4)).toBeNull();
  });

  it("ignores records without an id, audio, or duration", () => {
    expect(
      pickByDuration(
        [rec({ videoId: null }), rec({ audioUrl: null }), rec({ durationS: 0 })],
        78,
      ),
    ).toBeNull();
  });

  it("prefers a complete (audio+video) record over a newer audio-only one", () => {
    const complete = rec({ videoId: "1", lastSeen: 1 });
    const audioOnly = rec({ videoId: "1", videoUrl: null, lastSeen: 9 });
    expect(pickByDuration([audioOnly, complete], 78)).toBe(complete);
  });

  it("returns null when two DIFFERENT videos match the window (ambiguous)", () => {
    const a = rec({ videoId: "1", lastSeen: 1 });
    const b = rec({ videoId: "2", lastSeen: 9 });
    expect(pickByDuration([a, b], 78)).toBeNull();
  });

  it("breaks a duration tie with the prime window (sinceTs)", () => {
    const before = rec({ videoId: "1", lastSeen: 100 });
    const during = rec({ videoId: "2", lastSeen: 900 });
    expect(pickByDuration([before, during], 78, 2, 500)).toBe(during);
    // both fetched during the window → still ambiguous → null
    const during2 = rec({ videoId: "3", lastSeen: 950 });
    expect(pickByDuration([before, during, during2], 78, 2, 500)).toBeNull();
  });

  it("still picks when the matches are the same video", () => {
    const a = rec({ videoId: "1", lastSeen: 1, videoUrl: null });
    const b = rec({ videoId: "1", lastSeen: 9 });
    expect(pickByDuration([a, b], 78)).toBe(b);
  });

  it("handles bad hints", () => {
    expect(pickByDuration([rec()], NaN)).toBeNull();
    expect(pickByDuration([rec()], 0)).toBeNull();
    expect(pickByDuration([rec()], Infinity)).toBeNull();
  });
});

describe("pickByWindow", () => {
  it("a single fresh video wins regardless of (unreliable) efg durations", () => {
    // FB stamped the WRONG duration on the fresh rec — window still wins.
    const stale = rec({ videoId: "old", durationS: 30, lastSeen: 100 });
    const freshRec = rec({ videoId: "new", durationS: 29, lastSeen: 900 });
    expect(pickByWindow([stale, freshRec], 500, 80.6)).toBe(freshRec);
  });

  it("two fresh videos → duration narrows to one", () => {
    const a = rec({ videoId: "a", durationS: 29, lastSeen: 900 });
    const b = rec({ videoId: "b", durationS: 78, lastSeen: 950 });
    expect(pickByWindow([a, b], 500, 78.9)).toBe(b);
  });

  it("two fresh videos and duration can't separate → null", () => {
    const a = rec({ videoId: "a", durationS: 29, lastSeen: 900 });
    const b = rec({ videoId: "b", durationS: 29, lastSeen: 950 });
    expect(pickByWindow([a, b], 500, 29.9)).toBeNull();
  });

  it("no fresh records → falls back to strict duration match", () => {
    const only = rec({ videoId: "x", durationS: 78, lastSeen: 100 });
    expect(pickByWindow([only], 500, 78.9)).toBe(only);
    const rival = rec({ videoId: "y", durationS: 78, lastSeen: 90 });
    expect(pickByWindow([only, rival], 500, 78.9)).toBeNull(); // ambiguous fallback
  });

  it("no sinceTs behaves as plain duration match", () => {
    const only = rec({ videoId: "x", durationS: 78 });
    expect(pickByWindow([only], 0, 78.9)).toBe(only);
  });
});

describe("foldTrack duration", () => {
  it("keeps the first duration seen and fills a missing one later", () => {
    const t1 = { videoId: "9", xpvId: null, isAudio: true, bitrate: 0, durationS: 0, url: "a1" };
    const t2 = { videoId: "9", xpvId: null, isAudio: false, bitrate: 100, durationS: 78, url: "v1" };
    const r = foldTrack(foldTrack(undefined, t1, 1), t2, 2);
    expect(r.durationS).toBe(78);
    expect(r.audioUrl).toBe("a1");
    expect(r.videoUrl).toBe("v1");
  });
});

describe("stripByteRange", () => {
  it("removes bytestart/byteend", () => {
    expect(stripByteRange("https://x.fbcdn.net/v.mp4?efg=e&bytestart=0&byteend=99")).toBe(
      "https://x.fbcdn.net/v.mp4?efg=e",
    );
  });
});
