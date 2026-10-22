import { describe, it, expect } from "vitest";
import { downloadLimited, isInstagramCdn, pickVideoVariant, sha256Hex, igEmbedVideo } from "./analysisMedia.js";

describe("pickVideoVariant", () => {
  const v = (w, h) => ({ w, h, url: `https://scontent.cdninstagram.com/v/${w}x${h}.mp4?oe=1` });

  it("takes the smallest variant that is at least 720p (shorter side)", () => {
    expect(pickVideoVariant([v(1080, 1920), v(720, 1280), v(480, 854)])).toMatchObject({ w: 720, h: 1280 });
    expect(pickVideoVariant([v(1280, 720), v(1920, 1080)])).toMatchObject({ w: 1280, h: 720 });
  });

  it("falls back to the largest when none reaches 720", () => {
    expect(pickVideoVariant([v(240, 426), v(360, 640)])).toMatchObject({ w: 360, h: 640 });
  });

  it("ignores variants off Instagram's CDN or without a size", () => {
    expect(pickVideoVariant([{ w: 720, h: 1280, url: "https://evil.example/x.mp4" }, v(480, 854)])).toMatchObject({ w: 480 });
    expect(pickVideoVariant([{ url: "https://scontent.cdninstagram.com/a.mp4" }])).toMatchObject({ w: null, h: null });
    expect(pickVideoVariant([])).toBeNull();
  });
});

describe("isInstagramCdn", () => {
  it("accepts Instagram/Facebook CDN hosts over https only", () => {
    expect(isInstagramCdn("https://scontent-gru1-1.cdninstagram.com/v/t.mp4")).toBe(true);
    expect(isInstagramCdn("https://video.fgru3-1.fna.fbcdn.net/v/t.mp4")).toBe(true);
    expect(isInstagramCdn("http://scontent.cdninstagram.com/v/t.mp4")).toBe(false);
    expect(isInstagramCdn("https://cdninstagram.com.evil.example/v.mp4")).toBe(false);
    expect(isInstagramCdn("blob:https://www.instagram.com/abc")).toBe(false);
  });
});

function streamResponse(chunks, { status = 200, length = null } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-length" && length != null ? String(length) : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        cancel: async () => {},
      }),
    },
  };
}

describe("downloadLimited", () => {
  it("returns the bytes and their sha256", async () => {
    const fetchImpl = async () => streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const r = await downloadLimited("https://scontent.cdninstagram.com/v.mp4", { maxBytes: 10, fetchImpl });
    expect(r).toMatchObject({ ok: true, bytes: 3 });
    expect(r.sha256).toBe(await sha256Hex(new Uint8Array([1, 2, 3])));
  });

  it("stops past the limit, announced or not", async () => {
    const announced = async () => streamResponse([], { length: 11 });
    expect(await downloadLimited("https://scontent.cdninstagram.com/v.mp4", { maxBytes: 10, fetchImpl: announced })).toEqual({ ok: false, code: "media_too_large" });
    const silent = async () => streamResponse([new Uint8Array(6), new Uint8Array(6)]);
    expect(await downloadLimited("https://scontent.cdninstagram.com/v.mp4", { maxBytes: 10, fetchImpl: silent })).toEqual({ ok: false, code: "media_too_large" });
  });

  it("tells an expired CDN link from a refused session, and refuses other hosts", async () => {
    expect(await downloadLimited("https://scontent.cdninstagram.com/v.mp4", { maxBytes: 10, fetchImpl: async () => streamResponse([], { status: 403 }) })).toEqual({ ok: false, code: "url_expired" });
    expect(await downloadLimited("https://scontent.cdninstagram.com/v.mp4", { maxBytes: 10, fetchImpl: async () => streamResponse([], { status: 429 }) })).toEqual({ ok: false, code: "rate_limited" });
    expect(await downloadLimited("https://evil.example/v.mp4", { maxBytes: 10, fetchImpl: async () => streamResponse([]) })).toEqual({ ok: false, code: "bad_host" });
  });
});

describe("igEmbedVideo", () => {
  // The embed page's script as measured on 2026-10-22: the post is a JSON string
  // (slashes escaped inside it) inside the page's own JSON.
  const media = {
    __typename: "GraphVideo",
    shortcode: "Derfz6wtPtt",
    dimensions: { height: 1280, width: 720 },
    video_duration: 62.6,
    video_url: "https://scontent-gru1-2.cdninstagram.com/o1/v/t2/f2/m86/AQP.mp4?_nc_cat=108&_nc_sid=5e9851",
  };
  const page = (m) =>
    `<script>requireLazy(["x"],function(){{"isProfileEmbed":false,"contextJSON":${JSON.stringify(
      JSON.stringify({ context: { type: "GraphVideo", shortcode: m.shortcode }, gql_data: { shortcode_media: m } }).replace(/\//g, "\\/"),
    )},"other":1}});</script>`;

  it("reads the video, its size and duration from the page's JSON string", () => {
    expect(igEmbedVideo(page(media), "Derfz6wtPtt")).toEqual({ url: media.video_url, w: 720, h: 1280, durationS: 62.6 });
  });

  it("refuses another post's media, a non-CDN link and a page without the JSON", () => {
    expect(igEmbedVideo(page(media), "OTHER")).toBeNull();
    expect(igEmbedVideo(page({ ...media, video_url: "https://evil.example/a.mp4" }), "Derfz6wtPtt")).toBeNull();
    expect(igEmbedVideo(page({ ...media, video_url: undefined }), "Derfz6wtPtt")).toBeNull();
    expect(igEmbedVideo("<html>O link desta foto ou vídeo pode estar quebrado</html>", "Derfz6wtPtt")).toBeNull();
  });
});
