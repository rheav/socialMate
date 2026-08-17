import { describe, it, expect } from "vitest";
import {
  ttItemsIn,
  ttUsersIn,
  ttBestBitrate,
  ttBestSubtitle,
  ttHashtags,
  ttLiteItem,
  ttLiteUser,
  ttSurfaceKey,
} from "./ttItems.js";

// Shapes below are trimmed from real captures taken on 2026-08-16 (see
// docs/research/tiktok-data-map.md): /api/search/general/full/,
// /api/search/item/full/, /api/search/user/full/ and the video page's
// __UNIVERSAL_DATA_FOR_REHYDRATION__ blob.

const ITEM = {
  id: "7527787226860686622",
  desc: "#faith #tarotreading #cardreading",
  createTime: 1752699568,
  author: {
    id: "6729305884641838086",
    uniqueId: "maryamfaresh",
    nickname: "Maryam Faresh",
    secUid: "MS4wLjABAA",
    signature: "Medical Intuitive",
    verified: false,
    privateAccount: false,
    avatarThumb: "https://p16/avatar.jpeg",
  },
  authorStats: { followerCount: 161900, followingCount: 250, heartCount: 3600000, videoCount: 1144 },
  stats: { diggCount: 489600, shareCount: 4630, commentCount: 4943, playCount: 2300000, collectCount: 31900 },
  statsV2: {
    diggCount: "489600", shareCount: "4630", commentCount: "4943",
    playCount: "2300000", collectCount: "31888", repostCount: "0",
  },
  challenges: [{ id: "9425", title: "faith" }, { id: "78030373", title: "tarotreading" }],
  textExtra: [{ hashtagName: "faith" }, { hashtagName: "cardreading" }],
  music: { id: "713333", title: "Healing music", authorName: "Healing Music Lab", playUrl: "https://sf16/music.mp3", duration: 283, original: "False" },
  video: {
    id: "7527787226860686622",
    duration: 23,
    width: 576,
    height: 1024,
    cover: "https://p16/cover.jpeg",
    dynamicCover: "https://p16/dyn.webp",
    playAddr: "https://v16/play.mp4",
    downloadAddr: "https://v16/download.mp4",
    bitrateInfo: [
      { GearName: "normal_540_0", Bitrate: 1346500, CodecType: "h264", PlayAddr: { UrlList: ["https://v16/540.mp4"], Width: 576, Height: 1024 } },
      { GearName: "adapt_lower_720_1", Bitrate: 1206903, CodecType: "h265_hvc1", PlayAddr: { UrlList: ["https://v16/720.mp4"], Width: 720, Height: 1280 } },
    ],
    subtitleInfos: [
      { LanguageID: "2", LanguageCodeName: "eng-US", Url: "https://v16/cap.vtt", Format: "webvtt", Source: "ASR", Size: 726 },
    ],
  },
};

describe("ttItemsIn — the shape of every TikTok list payload", () => {
  it("reads itemList (post / recommend / related / challenge item_list)", () => {
    expect(ttItemsIn({ itemList: [{ id: "1" }, { id: "2" }] })).toHaveLength(2);
  });

  // The "Vídeos" search tab. This URL DID match the old endpoint regex, so the
  // silent drop was purely the snake_case root — the worst kind of miss.
  it("reads item_list (/api/search/item/full/)", () => {
    expect(ttItemsIn({ item_list: [{ id: "1" }] })).toEqual([{ id: "1" }]);
  });

  // The default "Melhores" tab, which is what a hashtag search actually lands on.
  it("unwraps data[].item (/api/search/general/full/)", () => {
    const payload = { data: [{ type: 1, item: { id: "7" }, common: {} }, { type: 1, item: { id: "8" } }] };
    expect(ttItemsIn(payload).map((i) => i.id)).toEqual(["7", "8"]);
  });

  it("skips search cards that carry no video (user / live rows)", () => {
    expect(ttItemsIn({ data: [{ type: 4 }, { type: 1, item: { id: "9" } }, null] })).toEqual([{ id: "9" }]);
  });

  it("returns nothing for a payload with no list at all", () => {
    expect(ttItemsIn({ status_code: 0 })).toEqual([]);
    expect(ttItemsIn(null)).toEqual([]);
  });
});

describe("ttUsersIn", () => {
  it("reads user_list[].user_info (/api/search/user/full/)", () => {
    const out = ttUsersIn({ user_list: [{ user_info: { uid: "1", unique_id: "a" } }, { user_info: { uid: "2" } }] });
    expect(out.map((u) => u.uid)).toEqual(["1", "2"]);
  });

  it("normalizes /api/user/detail/, whose stats live beside the user", () => {
    const out = ttUsersIn({ userInfo: { user: { id: "9", uniqueId: "b" }, stats: { followerCount: 31400 } } });
    expect(out[0].__stats.followerCount).toBe(31400);
  });
});

describe("ttBestBitrate", () => {
  it("picks max resolution before max bitrate — gear 0 is the default, not the best", () => {
    // The 720 gear has the LOWER bitrate here, exactly as measured live.
    expect(ttBestBitrate(ITEM.video).url).toBe("https://v16/720.mp4");
    expect(ttBestBitrate(ITEM.video).height).toBe(1280);
  });

  it("ignores gears with no URL, and has no opinion without a ladder", () => {
    expect(ttBestBitrate({ bitrateInfo: [{ PlayAddr: {} }] })).toBe(null);
    expect(ttBestBitrate({})).toBe(null);
    expect(ttBestBitrate(null)).toBe(null);
  });
});

describe("ttBestSubtitle — a free transcript when TikTok has one", () => {
  it("returns the WebVTT track, preferring English", () => {
    expect(ttBestSubtitle(ITEM.video)).toEqual({
      url: "https://v16/cap.vtt", lang: "eng-US", format: "webvtt", source: "ASR",
    });
  });

  it("prefers an English track over the first one listed", () => {
    const v = { subtitleInfos: [
      { LanguageCodeName: "por-PT", Url: "https://pt.vtt", Format: "webvtt" },
      { LanguageCodeName: "eng-US", Url: "https://en.vtt", Format: "webvtt" },
    ] };
    expect(ttBestSubtitle(v).url).toBe("https://en.vtt");
  });

  it("falls back to claInfo.captionInfos, which carries the same URLs", () => {
    const v = { claInfo: { captionInfos: [{ language: "por-PT", url: "https://cla.vtt", captionFormat: "webvtt", isAutoGen: "True" }] } };
    expect(ttBestSubtitle(v)).toEqual({ url: "https://cla.vtt", lang: "por-PT", format: "webvtt", source: "ASR" });
  });

  // ~1/3 of sampled videos report claInfo.noCaptionReason instead — those need Whisper.
  it("returns null when the video has no caption track", () => {
    expect(ttBestSubtitle({ claInfo: { hasOriginalAudio: false, noCaptionReason: 3 } })).toBe(null);
    expect(ttBestSubtitle({})).toBe(null);
  });
});

describe("ttHashtags", () => {
  it("merges challenges and textExtra without repeating a tag", () => {
    expect(ttHashtags(ITEM)).toEqual(["faith", "tarotreading", "cardreading"]);
  });

  it("survives an item with neither", () => {
    expect(ttHashtags({})).toEqual([]);
  });
});

describe("ttLiteItem", () => {
  const rec = ttLiteItem(ITEM);

  it("prefers statsV2 — it is the only one carrying repostCount", () => {
    expect(rec.play_count).toBe(2300000);
    expect(rec.collect_count).toBe(31888); // statsV2's value, not stats'
    expect(rec.repost_count).toBe(0);
  });

  it("keeps authorStats — the follower count IG needs a second request for", () => {
    expect(rec.user_follower_count).toBe(161900);
    expect(rec.user_heart_count).toBe(3600000);
    expect(rec.user_video_count).toBe(1144);
  });

  it("downloads from the best gear and never has an empty fallback", () => {
    expect(rec.hd_url).toBe("https://v16/720.mp4");
    expect(rec.hd_res).toBe("720x1280");
    expect(rec.download_url).toBe("https://v16/download.mp4");
  });

  // Half the search results have no downloadAddr; playAddr is on every one.
  it("falls back to playAddr when TikTok withholds downloadAddr", () => {
    const noDl = ttLiteItem({ ...ITEM, video: { ...ITEM.video, bitrateInfo: [], downloadAddr: undefined } });
    expect(noDl.hd_url).toBe("https://v16/play.mp4");
    expect(noDl.download_url).toBe("https://v16/play.mp4");
  });

  it("carries the caption track and the audio URL", () => {
    expect(rec.subtitle.url).toBe("https://v16/cap.vtt");
    expect(rec.music.url).toBe("https://sf16/music.mp3");
  });

  it("refuses an item with no id rather than storing an empty key", () => {
    expect(ttLiteItem({ desc: "x" })).toBe(null);
    expect(ttLiteItem(null)).toBe(null);
  });

  // Grid records simply lack these; only the video page's SSR blob has them.
  it("leaves video-page-only fields null on a grid record", () => {
    expect(rec.location).toBe(null);
    expect(rec.topics).toEqual([]);
  });

  it("keeps them when the video page does supply them", () => {
    const detail = ttLiteItem({ ...ITEM, locationCreated: "BR", diversificationLabels: ["Random Shoot"], suggestedWords: ["tarot"] });
    expect(detail.location).toBe("BR");
    expect(detail.topics).toEqual(["Random Shoot"]);
    expect(detail.suggested_words).toEqual(["tarot"]);
  });
});

describe("ttLiteUser", () => {
  it("maps a search result", () => {
    const u = ttLiteUser({ uid: "688", unique_id: "tarotreadings.live", nickname: "Life is Love", follower_count: 1776, total_favorited: 8636, signature: "bio" });
    expect(u).toMatchObject({ author_id: "688", username: "tarotreadings.live", follower_count: 1776, heart_count: 8636 });
  });

  it("maps a profile page, whose counts arrive in a sibling stats object", () => {
    const u = ttLiteUser({ id: "9", uniqueId: "veloria691", __stats: { followerCount: 31400, videoCount: 46 } });
    expect(u).toMatchObject({ author_id: "9", username: "veloria691", follower_count: 31400, video_count: 46 });
  });

  it("refuses a record that names nobody", () => {
    expect(ttLiteUser({})).toBe(null);
    expect(ttLiteUser(null)).toBe(null);
  });
});

describe("ttSurfaceKey", () => {
  it("names the surfaces the panel scopes its grid to", () => {
    expect(ttSurfaceKey("/@Veloria691", "")).toBe("profile:veloria691");
    expect(ttSurfaceKey("/@veloria691/video/765", "")).toBe("profile:veloria691");
    expect(ttSurfaceKey("/tag/CardReading", "")).toBe("tag:cardreading");
    expect(ttSurfaceKey("/search", "?q=%23cardreading")).toBe("search:#cardreading");
    expect(ttSurfaceKey("/search/video", "?q=Tarot")).toBe("search:tarot");
    expect(ttSurfaceKey("/foryou", "")).toBe("feed");
    expect(ttSurfaceKey("/", "")).toBe("feed");
    expect(ttSurfaceKey("/explore", "")).toBe("explore");
  });
});
