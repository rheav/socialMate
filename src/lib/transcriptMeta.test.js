import { describe, it, expect } from "vitest";
import { transcriptMetaChips, fmtClock } from "./transcriptMeta.js";

const keys = (rec) => transcriptMetaChips(rec).map((c) => c.key);
const byKey = (rec, k) => transcriptMetaChips(rec).find((c) => c.key === k);

describe("fmtClock", () => {
  it("formats seconds as m:ss", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(47)).toBe("0:47");
    expect(fmtClock(95.6)).toBe("1:35");
    expect(fmtClock(3600)).toBe("60:00");
  });
  it("returns empty for anything that is not a finite number", () => {
    for (const v of [null, undefined, NaN, Infinity, "12", {}]) expect(fmtClock(v)).toBe("");
  });
});

describe("transcriptMetaChips", () => {
  it("has nothing to show for a record with no post metadata", () => {
    expect(transcriptMetaChips(null)).toEqual([]);
    expect(transcriptMetaChips({})).toEqual([]);
    expect(transcriptMetaChips({ videoId: "abc", platform: "facebook" })).toEqual([]);
  });

  // The Instagram shape after ovlTranscribe forwards what the on-page rail already
  // holds: taken_at, duration, user_follower_count, play_count.
  const ig = {
    platform: "instagram",
    videoId: "DbrWBt5v4Tu",
    takenAt: 1785931200, // 2026-08-05 UTC
    durationS: 47,
    followers: 12400,
    counts: { like: 23500, comment: 10300, views: 101200, share: 981 },
  };

  it("orders the line date → duration → followers → reach", () => {
    expect(keys(ig)).toEqual(["date", "duration", "followers", "reach"]);
  });

  it("formats each value the way the rest of the app does", () => {
    expect(byKey(ig, "date").text).toBe("2026-08-05");
    expect(byKey(ig, "duration").text).toBe("0:47");
    expect(byKey(ig, "followers").text).toBe("12.4K");
    expect(byKey(ig, "reach").text).toBe("8.2×"); // 101200 / 12400
  });

  it("gives every chip an icon and a title for the tooltip", () => {
    for (const c of transcriptMetaChips(ig)) {
      expect(c.icon).toBeTruthy();
      expect(c.title).toBeTruthy();
    }
  });

  // Facebook: the embedded JSON we already parse yields a duration and nothing
  // else — no post date, no follower count, no views. The line just gets shorter.
  it("shows only what a Facebook record actually carries", () => {
    expect(keys({ platform: "facebook", videoId: "1846308513007203", durationS: 62,
      counts: { like: 218, comment: 311, share: 65, views: null } })).toEqual(["duration"]);
  });

  // TikTok records carry create_time, duration and the creator's followerCount in
  // the same payload the panel already sorts by, so a TT card gets the full line.
  it("fills the whole line for a TikTok record", () => {
    const tt = {
      platform: "tiktok",
      videoId: "7412345678901234567",
      takenAt: 1785931200,
      durationS: 128,
      followers: 250000,
      counts: { like: 45700, comment: 9700, views: 636000, share: 1200 },
    };
    expect(keys(tt)).toEqual(["date", "duration", "followers", "reach"]);
    expect(byKey(tt, "duration").text).toBe("2:08");
    expect(byKey(tt, "reach").text).toBe("2.5×");
  });

  it("skips reach unless views AND followers are both real numbers", () => {
    expect(keys({ ...ig, followers: null })).toEqual(["date", "duration"]);
    expect(keys({ ...ig, counts: { ...ig.counts, views: null } })).toEqual(["date", "duration", "followers"]);
    // Records written before schema 2 carry pre-formatted count STRINGS, which
    // cannot be divided — the chip must drop out rather than print NaN.
    expect(keys({ ...ig, counts: { ...ig.counts, views: "101,2 mil" } })).toEqual(["date", "duration", "followers"]);
    expect(keys({ ...ig, followers: 0 })).toEqual(["date", "duration"]);
  });

  it("ignores a duration that is missing or not a positive number", () => {
    for (const d of [null, undefined, 0, -3, "47", NaN])
      expect(keys({ platform: "facebook", durationS: d })).toEqual([]);
  });

  it("falls back to the Instagram pk timestamp when taken_at was never captured", () => {
    // A numeric IG pk encodes its own creation time; a shortcode does not.
    const withPk = { platform: "instagram", videoId: "3512345678901234567", durationS: 10 };
    const chip = byKey(withPk, "date");
    expect(chip && /^\d{4}-\d{2}-\d{2}$/.test(chip.text)).toBe(true);
    expect(keys({ platform: "instagram", videoId: "DbrWBt5v4Tu", durationS: 10 })).toEqual(["duration"]);
  });

  it("never guesses a date from a Facebook video id", () => {
    // FB ids are numeric too, but they are not IG pks — decoding one would print
    // a confident, wrong date.
    expect(keys({ platform: "facebook", videoId: "1846308513007203" })).toEqual([]);
  });

  it("prefers a captured taken_at over the pk fallback", () => {
    expect(byKey({ platform: "instagram", videoId: "3512345678901234567", takenAt: 1785931200 }, "date").text)
      .toBe("2026-08-05");
  });
});
