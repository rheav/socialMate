import { describe, it, expect, vi } from "vitest";
import {
  fbPermalinkOf,
  fbThumbFromPluginHtml,
  igCodeOf,
  igThumbFromEmbed,
  igThumbFromPostPage,
  needsThumbRecovery,
  recoverableRecords,
  recoveryRoutes,
  resolveFreshThumb,
  ttPermalinkOf,
  ttThumbFromOembed,
} from "./thumbRecover.js";

// Shapes below are trimmed from real responses captured 2026-09-15.
const IG_EMBED = `<script>window.__additionalData={"shortcode_media":{"display_url":"https:\\/\\/instagram.fumu2-2.fna.fbcdn.net\\/v\\/t51.82787-15\\/730192094_18617231530021457_n.jpg?stp=dst-jpg_e15_tt6&amp;_nc_cat=110&amp;oe=6AC12345"}}</script>`;
const FB_PLUGIN = `
  <img src="https:\\/\\/scontent.fumu2-2.fna.fbcdn.net\\/v\\/t39.30808-1\\/736367156_122106781557372141_n.jpg?stp=c0.453a_dst-jpg_s160x160_tt6&amp;oe=6AB0" />
  <div data-x="https:\\/\\/scontent.fumu2-1.fna.fbcdn.net\\/v\\/t15.5256-10\\/738570596_1359129042848618_n.jpg?_nc_cat=107&amp;oe=6AB1"></div>`;
const FB_PLUGIN_CROSSPOST = `<img src="https://scontent.fbcdn.net/v/t39.30808-1/avatar_n.jpg?oe=1" /><img src="https://scontent.fbcdn.net/v/t51.82787-10/747235988_17888339937596643_n.jpg?oe=2" />`;

describe("instagram", () => {
  it("pulls display_url out of the embed page and un-escapes it twice over", () => {
    expect(igThumbFromEmbed(IG_EMBED)).toBe(
      "https://instagram.fumu2-2.fna.fbcdn.net/v/t51.82787-15/730192094_18617231530021457_n.jpg?stp=dst-jpg_e15_tt6&_nc_cat=110&oe=6AC12345",
    );
  });

  it("falls back to the rendered <img> and to og:image", () => {
    expect(igThumbFromEmbed(`<img class="EmbeddedMediaImage" alt="" src="https://cdn/a.jpg" />`)).toBe("https://cdn/a.jpg");
    expect(igThumbFromEmbed(`<meta property="og:image" content="https://cdn/b.jpg" />`)).toBe("https://cdn/b.jpg");
  });

  it("returns null for a page with no media at all", () => {
    expect(igThumbFromEmbed("<html>login</html>")).toBeNull();
  });

  it("falls back to the post page when the embed claims the post is broken", () => {
    // Instagram's own words for a post that is public and alive (2026-09-16).
    const brokenEmbed = "<html>O link desta foto ou vídeo pode estar quebrado ou o post pode ter sido removido.</html>";
    expect(igThumbFromEmbed(brokenEmbed)).toBeNull();
    const routes = recoveryRoutes({ platform: "instagram", code: "DdAYZN4OETz" });
    expect(routes.map((r) => r.url)).toEqual([
      "https://www.instagram.com/p/DdAYZN4OETz/embed/captioned/",
      "https://www.instagram.com/p/DdAYZN4OETz/",
    ]);
  });

  it("reads og:image off the post page, either attribute order", () => {
    expect(
      igThumbFromPostPage('<meta property="og:image" content="https://cdn/a.jpg?x=1&amp;y=2" />'),
    ).toBe("https://cdn/a.jpg?x=1&y=2");
    expect(igThumbFromPostPage('<meta content="https://cdn/b.jpg" property="og:image" />')).toBe("https://cdn/b.jpg");
    expect(igThumbFromPostPage("<html>nada</html>")).toBeNull();
  });

  it("takes the shortcode from the record, the permalink, or the id", () => {
    expect(igCodeOf({ code: "DZ-dSUgSRiy" })).toBe("DZ-dSUgSRiy");
    expect(igCodeOf({ sourceUrl: "https://www.instagram.com/reel/DXYSzTsEhzM/" })).toBe("DXYSzTsEhzM");
    expect(igCodeOf({ videoId: "DdJvUTvywGM" })).toBe("DdJvUTvywGM");
  });

  it("refuses a bare pk — the embed route only speaks shortcode", () => {
    expect(igCodeOf({ videoId: "3712345678901234567" })).toBeNull();
    expect(igCodeOf({})).toBeNull();
  });
});

describe("facebook", () => {
  it("skips the author avatar and takes the video thumbnail bucket", () => {
    expect(fbThumbFromPluginHtml(FB_PLUGIN)).toBe(
      "https://scontent.fumu2-1.fna.fbcdn.net/v/t15.5256-10/738570596_1359129042848618_n.jpg?_nc_cat=107&oe=6AB1",
    );
  });

  it("takes the t51 bucket for a reel cross-posted from Instagram", () => {
    expect(fbThumbFromPluginHtml(FB_PLUGIN_CROSSPOST)).toBe(
      "https://scontent.fbcdn.net/v/t51.82787-10/747235988_17888339937596643_n.jpg?oe=2",
    );
  });

  it("returns null for the 59KB shell a non-embeddable video answers with", () => {
    expect(fbThumbFromPluginHtml('<script>envFlush({"ajaxpipe_token":"x"})</script>')).toBeNull();
  });

  it("keeps a watch permalink and rebuilds a reel one from the id", () => {
    expect(fbPermalinkOf({ sourceUrl: "https://www.facebook.com/watch/?v=1281558873921942" })).toBe(
      "https://www.facebook.com/watch/?v=1281558873921942",
    );
    expect(fbPermalinkOf({ videoId: "1846308513007203" })).toBe("https://www.facebook.com/reel/1846308513007203");
  });
});

describe("tiktok", () => {
  it("reads thumbnail_url out of the oembed payload", () => {
    expect(ttThumbFromOembed({ thumbnail_url: "https://p16-common-sign.tiktokcdn.com/x~tplv.image?x-expires=1" })).toBe(
      "https://p16-common-sign.tiktokcdn.com/x~tplv.image?x-expires=1",
    );
    expect(ttThumbFromOembed({})).toBeNull();
  });

  it("only accepts a permalink oembed can resolve", () => {
    expect(ttPermalinkOf({ sourceUrl: "https://www.tiktok.com/@zachking/video/7655004069190192398" })).toBe(
      "https://www.tiktok.com/@zachking/video/7655004069190192398",
    );
    expect(ttPermalinkOf({ sourceUrl: "https://www.tiktok.com/video/7655004069190192398" })).toBeNull();
    expect(ttPermalinkOf({ videoId: "7655004069190192398" })).toBeNull();
  });
});

describe("needsThumbRecovery", () => {
  const NOW = 1789083756 * 1000 + 1;
  const expired = "https://scontent.fbcdn.net/v/t15.x/a.jpg?oe=6AA3406C";

  it("is true for an expired link and for a record with no thumbnail at all", () => {
    expect(needsThumbRecovery({ videoId: "1", thumb: expired }, { now: NOW })).toBe(true);
    expect(needsThumbRecovery({ videoId: "1", thumb: null }, { now: NOW })).toBe(true);
  });

  it("is false for a data: thumbnail — that is the whole point of caching them", () => {
    expect(needsThumbRecovery({ videoId: "1", thumb: "data:image/webp;base64,AA" }, { now: NOW })).toBe(false);
  });

  it("is false for a signed link that is still inside its window", () => {
    expect(needsThumbRecovery({ videoId: "1", thumb: expired }, { now: 1789083756 * 1000 - 1000 })).toBe(false);
  });

  it("trusts what the panel saw: an <img> that errored counts as broken", () => {
    const rec = { videoId: "7", thumb: "https://i.pinimg.com/a.jpg" };
    expect(needsThumbRecovery(rec, { now: NOW })).toBe(false);
    expect(needsThumbRecovery(rec, { now: NOW, brokenIds: new Set(["7"]) })).toBe(true);
  });

  it("lists only the records a platform can actually answer for", () => {
    const list = [
      { videoId: "a", platform: "instagram", code: "DZ-dSUgSRiy", thumb: expired },
      { videoId: "3712345678901234567", platform: "instagram", thumb: expired }, // pk only → no route
      { videoId: "c", platform: "facebook", thumb: "data:image/jpeg;base64,AA" }, // already durable
    ];
    expect(recoverableRecords(list, { now: NOW }).map((r) => r.videoId)).toEqual(["a"]);
  });
});

describe("recoveryRoute / resolveFreshThumb", () => {
  it("routes each platform to the endpoint verified for it", () => {
    expect(recoveryRoutes({ platform: "instagram", code: "ABC12" })[0].url).toBe(
      "https://www.instagram.com/p/ABC12/embed/captioned/",
    );
    expect(recoveryRoutes({ platform: "facebook", videoId: "99" })[0].url).toBe(
      "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F99",
    );
    expect(recoveryRoutes({ platform: "tiktok", sourceUrl: "https://www.tiktok.com/@a/video/1" })[0].url).toBe(
      "https://www.tiktok.com/oembed?url=https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F1",
    );
  });

  it("re-uses the stored Pinterest URL — i.pinimg.com is unsigned, it never expired", async () => {
    const rec = { platform: "pinterest", videoId: "1", thumb: "https://i.pinimg.com/236x/a.jpg" };
    const fetchImpl = vi.fn();
    expect(await resolveFreshThumb(rec, { fetchImpl })).toBe("https://i.pinimg.com/236x/a.jpg");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and parses for the platforms that need a request", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => IG_EMBED }));
    const out = await resolveFreshThumb({ platform: "instagram", code: "ABC12", videoId: "ABC12" }, { fetchImpl });
    expect(out).toContain("t51.82787-15");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the post page is not paid for when the embed answers
    expect(fetchImpl.mock.calls[0][1]).toEqual({ credentials: "include" });
  });

  it("tries the post page when the embed answered but had nothing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "<html>quebrado</html>" })
      .mockResolvedValueOnce({ ok: true, text: async () => '<meta property="og:image" content="https://cdn/ok.jpg" />' });
    const out = await resolveFreshThumb({ platform: "instagram", code: "ABC12" }, { fetchImpl });
    expect(out).toBe("https://cdn/ok.jpg");
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "https://www.instagram.com/p/ABC12/embed/captioned/",
      "https://www.instagram.com/p/ABC12/",
    ]);
  });

  it("does not let a failing first route hide a working second one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, text: async () => '<meta property="og:image" content="https://cdn/ok.jpg" />' });
    await expect(resolveFreshThumb({ platform: "instagram", code: "ABC12" }, { fetchImpl })).resolves.toBe(
      "https://cdn/ok.jpg",
    );
  });

  it("returns null — not an error — when the post is gone or not embeddable", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => "<html>nope</html>" }));
    expect(await resolveFreshThumb({ platform: "facebook", videoId: "9" }, { fetchImpl })).toBeNull();
  });

  it("throws when the endpoint itself fails", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }));
    await expect(resolveFreshThumb({ platform: "facebook", videoId: "9" }, { fetchImpl })).rejects.toThrow(/429/);
  });

  it("has no route for a record whose platform cannot be asked", () => {
    expect(recoveryRoutes({ platform: "youtube", videoId: "1" })).toEqual([]);
    expect(resolveFreshThumb({ platform: "youtube", videoId: "1" }, { fetchImpl: vi.fn() })).resolves.toBeNull();
  });
});
