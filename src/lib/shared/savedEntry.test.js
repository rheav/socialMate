// Guards the ONE shape of a Library record. Before this existed, ten writers
// produced five shapes and the divergences were all silent: an unguarded
// fmtCount(null) persisted whatever that returned, Pinterest wrote the string "—"
// for views, and a missing sourceUrl made VideoCard render a dead
// facebook.com/reel/<id> link for TikTok and Pinterest items.
import { describe, it, expect } from "vitest";
import {
  SAVED_SCHEMA,
  buildSavedEntry,
  savedSourceUrl,
  savedAuthorUrl,
} from "./savedEntry.js";

describe("buildSavedEntry", () => {
  it("requires an id and a platform", () => {
    expect(buildSavedEntry({ platform: "tiktok" })).toBeNull();
    expect(buildSavedEntry({ id: "1" })).toBeNull();
    expect(buildSavedEntry()).toBeNull();
  });

  it("stores counts as raw numbers and non-numbers as null", () => {
    const e = buildSavedEntry({
      id: "1",
      platform: "tiktok",
      counts: { like: 1234, comment: 0, view: 987654, share: null, save: undefined },
    });
    expect(e.counts).toEqual({
      like: 1234,
      comment: 0,
      views: 987654,
      share: null,
      save: null,
    });
  });

  it("never persists a formatted string or a placeholder dash", () => {
    // The two shapes that used to reach storage.
    const e = buildSavedEntry({
      id: "1",
      platform: "pinterest",
      counts: { like: "964.5K", comment: "—", view: "—" },
    });
    expect(e.counts.like).toBeNull();
    expect(e.counts.comment).toBeNull();
    expect(e.counts.views).toBeNull();
  });

  it("accepts the legacy `views` input key as well as `view`", () => {
    expect(buildSavedEntry({ id: "1", platform: "tiktok", counts: { views: 42 } }).counts.views).toBe(42);
    expect(buildSavedEntry({ id: "1", platform: "tiktok", counts: { view: 42 } }).counts.views).toBe(42);
  });

  it("derives a working permalink per platform so no caller can forget one", () => {
    expect(
      buildSavedEntry({ id: "7", platform: "tiktok", username: "ivy" }).sourceUrl,
    ).toBe("https://www.tiktok.com/@ivy/video/7");
    expect(
      buildSavedEntry({ id: "9", platform: "instagram", code: "Cabc" }).sourceUrl,
    ).toBe("https://www.instagram.com/p/Cabc/");
    expect(buildSavedEntry({ id: "5", platform: "facebook" }).sourceUrl).toBe(
      "https://www.facebook.com/reel/5",
    );
  });

  it("lets a platform override the permalink with its own canonical URL", () => {
    const e = buildSavedEntry({
      id: "p1",
      platform: "pinterest",
      sourceUrl: "https://www.pinterest.com/pin/p1/",
    });
    expect(e.sourceUrl).toBe("https://www.pinterest.com/pin/p1/");
  });

  it("keeps FB/IG author URLs relative and TikTok/Pinterest absolute", () => {
    // VideoCard prepends an origin to relative URLs; doing that to an absolute one
    // nests two URLs and produces a dead link.
    expect(savedAuthorUrl("instagram", "ivy")).toBe("/ivy/");
    expect(savedAuthorUrl("tiktok", "ivy")).toBe("https://www.tiktok.com/@ivy");
    expect(savedAuthorUrl("pinterest", "ivy")).toBe("https://www.pinterest.com/ivy/");
    expect(savedAuthorUrl("instagram", null)).toBeNull();
  });

  it("falls back to the username, then to a pt-BR placeholder, for the author name", () => {
    expect(buildSavedEntry({ id: "1", platform: "tiktok", username: "ivy" }).author.name).toBe("ivy");
    expect(buildSavedEntry({ id: "1", platform: "tiktok" }).author.name).toBe("desconhecido");
    expect(
      buildSavedEntry({ id: "1", platform: "tiktok", authorName: "Ivy V", username: "ivy" }).author.name,
    ).toBe("Ivy V");
  });

  it("stamps the schema and a string videoId the background can key on", () => {
    const e = buildSavedEntry({ id: 12345, platform: "facebook", now: 1000 });
    expect(e.schema).toBe(SAVED_SCHEMA);
    expect(e.videoId).toBe("12345");
    expect(e.updatedAt).toBe(1000);
  });

  it("survives a JSON round-trip (it goes through chrome.storage)", () => {
    const e = buildSavedEntry({
      id: "1",
      platform: "instagram",
      code: "Cabc",
      pk: "99",
      mediaType: "carousel",
      thumb: "data:image/jpeg;base64,AAA",
      caption: "café ☕",
      username: "ivy",
      counts: { like: 5, comment: 6, view: 7 },
      now: 42,
    });
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });

  it("unknown platform yields no permalink rather than a wrong one", () => {
    expect(savedSourceUrl("myspace", { id: "1" })).toBeNull();
    expect(savedAuthorUrl("myspace", "ivy")).toBeNull();
  });
});
