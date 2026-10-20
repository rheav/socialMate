import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  emptyStoriesState, parseReelsMediaJson, parseStoriesHtml, passDue, queueStory, reduceStory, slotJitterMs, storySlots, unwrapInstagramLink,
} from "./spyStories.js";
import { emptySpyQueue } from "./spyStore.js";

// Stories swipe file (hub spec docs/superpowers/specs/2026-10-19-stories-swipe-file-design.md).
// The page fixture is synthetic: made-up ids and CDN hosts, no cookies, no tokens.
const fixture = readFileSync(new URL("./fixtures/ig-stories-page.html", import.meta.url), "utf8");

describe("parseStoriesHtml", () => {
  it("reads the reel and its items out of the page's JSON blobs", () => {
    const page = parseStoriesHtml(fixture);
    expect(page).toMatchObject({ reelId: "27143148638", username: "claire_mayaus" });
    expect(page.items.map((i) => i.pk)).toEqual(["4010802020595923127", "4010802020595923128"]);
  });
  it("answers null for a page without the reel", () => {
    expect(parseStoriesHtml('<html><script type="application/json">{"a":1}</script></html>')).toBeNull();
  });
  it("answers an empty reel list as no story", () => {
    const html = '<html><script type="application/json">{"data":{"xdt_api__v1__feed__reels_media":{"reels_media":[]}}}</script></html>';
    expect(parseStoriesHtml(html)).toEqual({ reelId: null, username: null, items: [] });
  });
});

describe("parseReelsMediaJson", () => {
  it("reads the API's answer by user id or as a list", () => {
    const reel = parseStoriesHtml(fixture);
    const raw = { id: reel.reelId, user: { username: "claire_mayaus" }, items: reel.items };
    expect(parseReelsMediaJson({ reels: { 27143148638: raw } }, "27143148638").items.length).toBe(2);
    expect(parseReelsMediaJson({ reels_media: [raw] }, "27143148638").username).toBe("claire_mayaus");
    expect(parseReelsMediaJson({ reels: {} }, "27143148638")).toBeNull();
  });
});

describe("reduceStory", () => {
  it("reduces a video story to the hub's input, times in ms, link unwrapped", () => {
    const { items } = parseStoriesHtml(fixture);
    const { input, cover, media } = reduceStory(items[0], "27143148638");
    expect(input).toEqual({
      id: "4010802020595923127", reelId: "27143148638", mediaType: 2, takenAt: 1792345000000, expiringAt: 1792431400000,
      durationMs: 20015, width: 720, height: 1280, caption: null,
      links: [{ url: "https://app.auralyapp.com/x", text: "app.auralyapp.com" }],
      music: { title: "Heartfelt", artist: "Xuan" }, mentions: [], aiLabel: true, mediaMime: "video/mp4",
    });
    expect(cover).toMatch(/^https:\/\/scontent/);
    expect(media).toEqual({ url: "https://scontent.example.net/o1/v/story-video-720.mp4", mime: "video/mp4" });
  });
  it("reduces a photo story with the cover as its media", () => {
    const { items } = parseStoriesHtml(fixture);
    const { input, media } = reduceStory(items[1], "27143148638");
    expect(input).toMatchObject({ mediaType: 1, mediaMime: "image/jpeg", durationMs: null, music: null, aiLabel: false, mentions: ["nasa"] });
    expect(media).toEqual({ url: "https://scontent.example.net/v/t51/story-photo-1080.jpg", mime: "image/jpeg" });
  });
  it("answers null for an item without the essentials", () => {
    expect(reduceStory({ pk: "1" }, "27143148638")).toBeNull();
  });
});

describe("unwrapInstagramLink", () => {
  it("returns the destination without the fbclid", () => {
    expect(unwrapInstagramLink("https://l.instagram.com/?u=https%3A%2F%2Fx.y%2Fp%3Fa%3D1%26fbclid%3DZZ&e=AT")).toBe("https://x.y/p?a=1");
  });
  it("leaves other links alone", () => {
    expect(unwrapInstagramLink("https://x.y/p?a=1")).toBe("https://x.y/p?a=1");
  });
});

describe("slots", () => {
  const day = new Date(2026, 9, 19, 0, 0, 0).getTime(); // local midnight
  const start = day - 3600_000; // the passes' day starts at 23:00 the evening before (2026-10-20: the Mac is off at night)
  it("splits the day by passesPerDay, from 23:00", () => {
    expect(storySlots(2, day + 13 * 3600_000)).toEqual({ index: 1, startsAt: start + 12 * 3600_000, endsAt: start + 24 * 3600_000 });
    expect(storySlots(1, day + 13 * 3600_000)).toEqual({ index: 0, startsAt: start, endsAt: start + 24 * 3600_000 });
    expect(storySlots(2, day - 30 * 60_000)).toEqual({ index: 0, startsAt: start, endsAt: start + 12 * 3600_000 });
  });
  it("is due once per slot, after the jitter, and never twice", () => {
    const state = emptyStoriesState();
    expect(passDue(state, 2, start + 5 * 60_000, () => 0.5)).toBeNull(); // 23:05, before the 15 min jitter
    expect(passDue(state, 2, start + 16 * 60_000, () => 0)).toEqual({ index: 0, at: start + 15 * 60_000 });
    state.daily = { day: "2026-10-19", passes: [{ slot: 0, at: start + 16 * 60_000 }] };
    expect(passDue(state, 2, start + 3 * 3600_000, () => 0)).toBeNull();
    expect(passDue(state, 2, start + 12 * 3600_000 + 16 * 60_000, () => 0.5)).toEqual({ index: 1, at: start + 12 * 3600_000 + 15 * 60_000 });
  });
  it("keeps the jitter it drew for a slot, 0 to 29 min like the daily measurement", () => {
    const state = emptyStoriesState();
    expect(passDue(state, 2, start, () => 0.9)).toBeNull(); // jitter 27 min, drawn now
    expect(passDue(state, 2, start + 26 * 60_000, () => 0)).toBeNull();
    expect(passDue(state, 2, start + 28 * 60_000, () => 0)).toEqual({ index: 0, at: start + 27 * 60_000 });
    expect(slotJitterMs(() => 0.999)).toBe(29 * 60_000);
  });
});

describe("queueStory", () => {
  it("queues a story by id under the stories kind", () => {
    const q = queueStory(emptySpyQueue(), "instagram:natgeo", { id: "7", mediaType: 1 });
    expect(q.stories).toEqual({ 7: { profileId: "instagram:natgeo", id: "7", mediaType: 1 } });
  });
});
