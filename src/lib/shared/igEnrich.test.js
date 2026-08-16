import { describe, it, expect } from "vitest";
import {
  needsEnrichment,
  igUserStats,
  igAudioInfo,
  mergeIgRecord,
  ENRICH_MIN_GAP_MS,
} from "./igEnrich.js";

// VERIFIED live on /explore/search/keyword/?q=%23auralytrend (2026-08-15):
// the search SERP (xdt_fbsearch__top_serp_graphql) returns view_count: null for
// 24/24 videos and carries no play_count / ig_play_count key at all, while
// like_count is present on all 24 and like_and_view_counts_disabled is false.
// /api/v1/media/<pk>/info/ for the same post returns play_count 52222.
describe("needsEnrichment", () => {
  const video = { pk: "1", code: "abc", media_type: "video", play_count: 12, taken_at: 5, video: "u" };

  it("asks for a video whose views never arrived", () => {
    expect(needsEnrichment({ ...video, play_count: null })).toBe(true);
  });

  it("leaves a video that already has its views alone", () => {
    expect(needsEnrichment(video)).toBe(false);
  });

  it("asks when the media URL is missing on a video", () => {
    expect(needsEnrichment({ ...video, video: null })).toBe(true);
  });

  it("asks when the post date never arrived", () => {
    expect(needsEnrichment({ ...video, taken_at: null })).toBe(true);
  });

  it("never asks for a photo or carousel — they have no views to fetch", () => {
    expect(needsEnrichment({ pk: "2", code: "b", media_type: "photo", play_count: null, taken_at: 1 })).toBe(false);
    expect(needsEnrichment({ pk: "3", code: "c", media_type: "carousel", play_count: null, taken_at: 1 })).toBe(false);
  });

  it("never asks without a pk to ask about", () => {
    expect(needsEnrichment({ ...video, pk: null, play_count: null })).toBe(false);
  });

  it("paces requests — one call per second is a browsing human, 24 at once is a bot", () => {
    expect(ENRICH_MIN_GAP_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("igUserStats", () => {
  it("reads the numbers that say how big a creator is", () => {
    expect(
      igUserStats({
        pk: "77",
        username: "mystic",
        follower_count: 1200,
        following_count: 30,
        media_count: 88,
        total_clips_count: 40,
        biography: "bio",
        external_url: "https://x.dev",
        is_business: true,
      }),
    ).toEqual({
      userid: "77",
      username: "mystic",
      follower_count: 1200,
      following_count: 30,
      media_count: 88,
      total_clips_count: 40,
      biography: "bio",
      external_url: "https://x.dev",
      is_business: true,
    });
  });

  it("ignores an object that is not a user dict", () => {
    expect(igUserStats({ pk: "1", username: "x" })).toBe(null); // no counts → not a profile payload
    expect(igUserStats(null)).toBe(null);
  });
});

describe("igAudioInfo", () => {
  it("reads the original sound so a trend can be traced back to it", () => {
    const m = {
      clips_metadata: {
        original_sound_info: {
          audio_asset_id: "999",
          ig_artist: { username: "creator" },
          duration_in_ms: 24000,
        },
      },
    };
    expect(igAudioInfo(m)).toEqual({ audio_id: "999", audio_author: "creator", audio_ms: 24000 });
  });

  it("falls back to a licensed track's own asset id", () => {
    const m = { clips_metadata: { music_info: { music_asset_info: { audio_cluster_id: "555", display_artist: "Band" } } } };
    expect(igAudioInfo(m)).toEqual({ audio_id: "555", audio_author: "Band", audio_ms: null });
  });

  it("returns null for a post with no sound metadata", () => {
    expect(igAudioInfo({})).toBe(null);
  });
});

describe("mergeIgRecord", () => {
  it("fills only the gaps — a late payload never downgrades a full record", () => {
    const prev = { code: "a", play_count: 100, like_count: 5, video: "u1" };
    const next = { code: "a", play_count: null, like_count: 9, comment_count: 3, video: null };
    expect(mergeIgRecord(prev, next)).toEqual({
      code: "a",
      play_count: 100, // kept
      like_count: 9, // refreshed
      comment_count: 3, // added
      video: "u1", // kept
    });
  });

  it("takes everything when there was no previous record", () => {
    expect(mergeIgRecord(null, { code: "a", play_count: 1 })).toEqual({ code: "a", play_count: 1 });
  });
});
