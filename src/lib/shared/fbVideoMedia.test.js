// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { collectFbVideos, parseFbVideoResponse, matchFbVideo, fbCaptionFor, fbSearchVideosSurface } from "./fbVideoMedia.js";

const cdn = (file) => `https://scontent.example.fbcdn.net/${file}`;
const video = (id = "823150870841024", extra = {}) => ({
  __typename: "Video", id, playable_duration_in_ms: 141867,
  first_frame_thumbnail: cdn(`${id}.jpg?crop=1`),
  permalink_url: `https://www.facebook.com/reel/${id}/`,
  videoDeliveryResponseFragment: { videoDeliveryResponseResult: {
    progressive_urls: [
      { progressive_url: cdn("sd.mp4"), metadata: { quality: "SD" } },
      { progressive_url: cdn("hd.mp4"), metadata: { quality: "HD" } },
    ],
    dash_manifests: [{ manifest_xml: `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>
      <AdaptationSet><Representation mimeType="video/mp4"><BaseURL>${cdn("video.mp4")}</BaseURL></Representation></AdaptationSet>
      <AdaptationSet><Representation mimeType="audio/mp4"><BaseURL>${cdn("audio.mp4?a=1&amp;b=2")}</BaseURL></Representation></AdaptationSet>
    </Period></MPD>` }],
  } },
  ...extra,
});

describe("Facebook search media", () => {
  it("extracts audio from the DASH XML, HD video, covers and the actual permalink", () => {
    const [rec] = collectFbVideos({ data: { node: video() } });
    expect(rec).toMatchObject({ id: "823150870841024", durationS: 141.867,
      audio: cdn("audio.mp4?a=1&b=2"), progressive: cdn("hd.mp4"),
      permalink: "https://www.facebook.com/reel/823150870841024/" });
    expect(rec.thumbs).toContain(cdn("823150870841024.jpg?crop=1"));
  });
  it("parses streamed GraphQL lines independently and merges duplicate video fragments", () => {
    const id = "823150870841024";
    const text = ["for (;;);" + JSON.stringify({ data: video(id) }), "bad line",
      JSON.stringify({ data: { __typename: "Video", id, thumbnailImage: { uri: cdn("ad.jpg") } } })].join("\n");
    const rows = parseFbVideoResponse(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].audio).toBe(cdn("audio.mp4?a=1&b=2"));
    expect(rows[0].thumbs).toContain(cdn("ad.jpg"));
  });
  it("does not attribute a neighbouring video's media to its enclosing story ID", () => {
    const rows = collectFbVideos({ id: "999999999", story: { attachments: [video()] } });
    expect(rows.map(r => r.id)).toEqual(["823150870841024"]);
  });
  it("rejects non-Facebook CDN media and nonnumeric IDs", () => {
    const bad = video("not-an-id");
    expect(collectFbVideos(bad)).toEqual([]);
    const good = video();
    good.videoDeliveryResponseFragment.videoDeliveryResponseResult.progressive_urls = [{ progressive_url: "https://unrelated.test/file.mp4" }];
    expect(collectFbVideos(good)[0].progressive).toBeNull();
  });
  it("joins a cropped cover to its video despite changed CDN hosts and signed queries", () => {
    const rows = collectFbVideos([video(), video("1393672992797407", { playable_duration_in_ms: 142367 })]);
    expect(matchFbVideo(rows, { thumbs: ["https://other.fbcdn.net/823150870841024.jpg?crop=2"], durationS: 141.867 })?.id).toBe("823150870841024");
  });
  it("never guesses by duration alone, including two videos 0.5 seconds apart", () => {
    const rows = collectFbVideos([video(), video("1393672992797407", { playable_duration_in_ms: 142367 })]);
    expect(matchFbVideo(rows, { durationS: 141.867 })).toBeNull();
    expect(matchFbVideo(rows.slice(0, 1), { durationS: 141.867 })).toBeNull();
  });
  it("rejects reused covers with conflicting durations and ambiguous duplicate covers", () => {
    const [rec] = collectFbVideos(video());
    expect(matchFbVideo([rec], { thumbs: rec.thumbs, durationS: 8 })).toBeNull();
    expect(matchFbVideo([rec, { ...rec, id: "999999999" }], { thumbs: rec.thumbs, durationS: rec.durationS })).toBeNull();
  });
  it("does not replace an explicit ID with a cover from another post", () => {
    const [rec] = collectFbVideos(video());
    expect(matchFbVideo([rec], { id: "999999999", thumbs: rec.thumbs })).toBeNull();
    expect(matchFbVideo([rec], { id: rec.id })?.id).toBe(rec.id);
    expect(matchFbVideo([rec], { id: rec.id, thumbs: [cdn("another-post.jpg")] })).toBeNull();
  });
  it("selects only a subtitle matching the requested BR/EN language", () => {
    const [rec] = collectFbVideos(video(undefined, { video_available_captions_locales: [
      { locale: "id_ID", captions_url: cdn("id.srt") },
      { locale: "en_US", captions_url: cdn("en.srt") },
      { locale: "pt_BR", captions_url: cdn("pt.srt") },
    ] }));
    expect(fbCaptionFor(rec, "br")).toMatchObject({ url: cdn("pt.srt"), lang: "pt_BR" });
    expect(fbCaptionFor(rec, "en")).toMatchObject({ url: cdn("en.srt") });
    expect(fbCaptionFor({ ...rec, captions: rec.captions.slice(0, 1) }, "en")).toBeNull();
    expect(fbCaptionFor(rec, "auto")).toBeNull();
  });
  it("enables search feeds without decorating people, groups or home", () => {
    for (const path of ["/search/top", "/search/posts/", "/search/videos"]) expect(fbSearchVideosSurface(path)).toBe(true);
    for (const path of ["/", "/search/people", "/search/groups", "/search/topical"]) expect(fbSearchVideosSurface(path)).toBe(false);
  });
});
