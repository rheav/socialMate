import { describe, it, expect } from "vitest";
import {
  PWS_HANDLERS,
  surfaceOf,
  resourceGetUrl,
  resourceHeaders,
  parseEnvelope,
  boardFeedOptions,
} from "./pinMedia.js";
import {
  mediaItems,
  parseHlsMaster,
  mp4CandidatesFromHls,
  pinToRecord,
  recordToCard,
  sanitizeFilenamePart,
  filenameFor,
  extFromUrl,
  fmtCount,
  fmtDate,
  sortRecords,
} from "./pinMedia.js";

describe("surfaceOf", () => {
  it("detects a board", () => {
    const s = surfaceOf("https://br.pinterest.com/marianam7536/tarot/");
    expect(s.kind).toBe("board");
    expect(s.username).toBe("marianam7536");
    expect(s.slug).toBe("tarot");
    expect(s.handler).toBe(PWS_HANDLERS.board);
    expect(s.sourceUrl).toBe("/marianam7536/tarot/");
  });

  it("detects a board section", () => {
    const s = surfaceOf("https://br.pinterest.com/marianam7536/tarot/lenormand/");
    expect(s.kind).toBe("section");
    expect(s.sectionSlug).toBe("lenormand");
    expect(s.handler).toBe(PWS_HANDLERS.section);
  });

  it("detects search and keeps the query", () => {
    const s = surfaceOf("https://br.pinterest.com/search/pins/?q=tarot%20cards");
    expect(s.kind).toBe("search");
    expect(s.query).toBe("tarot cards");
    expect(s.handler).toBe(PWS_HANDLERS.search);
    expect(s.sourceUrl).toBe("/search/pins/?q=tarot%20cards");
  });

  it("treats reserved first segments as non-boards", () => {
    expect(surfaceOf("https://br.pinterest.com/pin/12345/").kind).toBe("pin");
    expect(surfaceOf("https://br.pinterest.com/today/").kind).toBe("other");
    expect(surfaceOf("https://br.pinterest.com/").kind).toBe("home");
  });

  it("treats /_saved/ and /_created/ as user pages, not boards", () => {
    expect(surfaceOf("https://br.pinterest.com/rheav7/_saved/").kind).toBe("user");
    expect(surfaceOf("https://br.pinterest.com/rheav7/").kind).toBe("user");
  });

  it("returns a stable key that changes with the surface", () => {
    const a = surfaceOf("https://br.pinterest.com/u/b/");
    const b = surfaceOf("https://br.pinterest.com/u/b/");
    const c = surfaceOf("https://br.pinterest.com/u/other/");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it("never throws on garbage", () => {
    expect(surfaceOf("not a url").kind).toBe("other");
    expect(surfaceOf(null).kind).toBe("other");
  });
});

describe("resourceGetUrl", () => {
  it("encodes source_url and the data envelope", () => {
    const u = resourceGetUrl("BoardFeedResource", { board_id: "1" }, "/a/b/", 1700000000000);
    expect(u).toContain("/resource/BoardFeedResource/get/?");
    expect(u).toContain("source_url=%2Fa%2Fb%2F");
    expect(u).toContain(encodeURIComponent(JSON.stringify({ options: { board_id: "1" }, context: {} })));
    expect(u).toContain("&_=1700000000000");
  });
});

describe("resourceHeaders", () => {
  const base = { appVersion: "d97c852", sourceUrl: "/a/b/", handler: PWS_HANDLERS.board };

  it("always sends the pws-handler — omitting it 403s", () => {
    expect(resourceHeaders(base)["x-pinterest-pws-handler"]).toBe(PWS_HANDLERS.board);
  });

  it("omits x-csrftoken for GET", () => {
    expect(resourceHeaders(base)["x-csrftoken"]).toBeUndefined();
  });

  it("includes x-csrftoken when given (POST)", () => {
    expect(resourceHeaders({ ...base, csrfToken: "abc" })["x-csrftoken"]).toBe("abc");
  });

  it("sends the app version and XHR marker", () => {
    const h = resourceHeaders(base);
    expect(h["x-app-version"]).toBe("d97c852");
    expect(h["x-requested-with"]).toBe("XMLHttpRequest");
    expect(h["x-pinterest-appstate"]).toBe("active");
    expect(h["x-pinterest-source-url"]).toBe("/a/b/");
  });
});

describe("parseEnvelope", () => {
  it("reads array data and the cursor", () => {
    const r = parseEnvelope({ resource_response: { status: "success", data: [{ id: "1" }], bookmark: "BM" } });
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([{ id: "1" }]);
    expect(r.bookmark).toBe("BM");
    expect(r.isEnd).toBe(false);
  });

  it("reads search-shaped data.results", () => {
    const r = parseEnvelope({ resource_response: { status: "success", data: { results: [{ id: "2" }] }, bookmark: "-end-" } });
    expect(r.results).toEqual([{ id: "2" }]);
    expect(r.isEnd).toBe(true);
  });

  it("treats a missing bookmark as the end", () => {
    expect(parseEnvelope({ resource_response: { data: [] } }).isEnd).toBe(true);
  });

  it("surfaces an API error", () => {
    const r = parseEnvelope({ resource_response: { error: { message: "Invalid Resource Request" } } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid Resource Request");
  });

  it("does not throw on null", () => {
    expect(parseEnvelope(null).ok).toBe(false);
  });
});

describe("boardFeedOptions", () => {
  const board = { id: "590745744811011892", url: "/marianam7536/tarot/" };

  it("sets filter_section_pins false — true returns only un-sectioned pins", () => {
    expect(boardFeedOptions(board, null).filter_section_pins).toBe(false);
  });

  it("omits bookmarks on the first page and wraps it in an array after", () => {
    expect(boardFeedOptions(board, null).bookmarks).toBeUndefined();
    expect(boardFeedOptions(board, "BM").bookmarks).toEqual(["BM"]);
  });

  it("carries the verified option set", () => {
    const o = boardFeedOptions(board, null);
    expect(o.board_id).toBe(board.id);
    expect(o.board_url).toBe(board.url);
    expect(o.field_set_key).toBe("react_grid_pin");
    expect(o.redux_normalize_feed).toBe(true);
    expect(o.page_size).toBe(25);
  });
});

const IMAGE_PIN = {
  id: "819655200979225688",
  type: "pin",
  grid_title: "The Illuminated Tarot",
  description: "deck",
  link: "https://example.com/x",
  repin_count: 120,
  comment_count: 3,
  created_at: "Thu, 04 Aug 2016 06:01:07 +0000",
  pinner: { username: "marianam7536", full_name: "Mariana M" },
  images: {
    "236x": { url: "https://i.pinimg.com/236x/86/30/a0/8630a02b653ff40f60be0853a587ebdc.jpg", width: 236, height: 277 },
    orig: { url: "https://i.pinimg.com/originals/86/30/a0/8630a02b653ff40f60be0853a587ebdc.png", width: 1535, height: 1802 },
  },
};

const MP4_IDEA_PIN = {
  id: "12455336471243517",
  type: "pin",
  story_pin_data: {
    page_count: 1,
    pages: [
      {
        blocks: [
          {
            type: "story_pin_video_block",
            video: {
              video_list: {
                V_EXP7: { width: 1080, height: 1920, duration: 10700, url: "https://v1.pinimg.com/videos/mc/720p/22/10/04/abc.mp4", thumbnail: "https://i.pinimg.com/videos/thumbnails/originals/22/10/04/abc.0000000.jpg" },
                V_HLSV3_MOBILE: { width: 1080, height: 1920, url: "https://v1.pinimg.com/videos/mc/hls/22/10/04/abc.m3u8", thumbnail: "https://i.pinimg.com/t.jpg" },
              },
            },
          },
        ],
      },
    ],
  },
};

const HLS_ONLY_PIN = {
  id: "596164069470205442",
  type: "pin",
  videos: {
    video_list: {
      V_HLSV4: { width: 720, height: 1280, url: "https://v1.pinimg.com/videos/iht/hls/be/0c/11/be0c11.m3u8", thumbnail: "https://i.pinimg.com/th.jpg" },
      V_HLSV3_MOBILE: { width: 480, height: 854, url: "https://v1.pinimg.com/videos/iht/hls/be/0c/11/be0c11_mob.m3u8" },
    },
  },
};

describe("mediaItems", () => {
  it("uses images.orig — never a rewritten thumbnail (extensions differ, rewrite 403s)", () => {
    const items = mediaItems(IMAGE_PIN);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("image");
    expect(items[0].url).toBe(IMAGE_PIN.images.orig.url);
    expect(items[0].url).toContain(".png");
  });

  it("prefers a direct MP4 over HLS on an idea pin", () => {
    const items = mediaItems(MP4_IDEA_PIN);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("video");
    expect(items[0].hls).toBe(false);
    expect(items[0].url).toContain(".mp4");
    expect(items[0].duration).toBe(10700);
  });

  it("falls back to the highest-res HLS and flags it for resolution", () => {
    const items = mediaItems(HLS_ONLY_PIN);
    expect(items[0].kind).toBe("video");
    expect(items[0].hls).toBe(true);
    expect(items[0].url).toBe(HLS_ONLY_PIN.videos.video_list.V_HLSV4.url);
  });

  it("returns one item per page of a multi-page idea pin", () => {
    const multi = {
      id: "m1",
      story_pin_data: {
        page_count: 2,
        pages: [
          { blocks: [{ video: { video_list: { V_EXP7: { url: "https://v1.pinimg.com/a.mp4", width: 1, height: 2 } } } }] },
          { blocks: [{ image: { images: { orig: { url: "https://i.pinimg.com/originals/b.jpg", width: 3, height: 4 } } } }] },
        ],
      },
    };
    const items = mediaItems(multi);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("video");
    expect(items[1].kind).toBe("image");
  });

  it("returns [] rather than throwing when a pin has no media", () => {
    expect(mediaItems({ id: "x" })).toEqual([]);
    expect(mediaItems(null)).toEqual([]);
  });

  it("uses images.originals (not 736x) for an Idea Pin block that has no orig — live-verified shape", () => {
    const ideaImagePin = {
      id: "idea1",
      story_pin_data: {
        page_count: 1,
        pages: [
          {
            blocks: [
              {
                type: "story_pin_image_block",
                image: {
                  images: {
                    originals: { url: "https://i.pinimg.com/originals/0d/93/45/full.jpg", width: 1080, height: 1920 },
                    "1200x": { url: "https://i.pinimg.com/1200x/0d/93/45/full.jpg", width: 1200, height: 2133 },
                    "474x": { url: "https://i.pinimg.com/474x/0d/93/45/full.jpg", width: 474, height: 843 },
                    "236x": { url: "https://i.pinimg.com/236x/0d/93/45/full.jpg", width: 236, height: 419 },
                    "736x": { url: "https://i.pinimg.com/736x/0d/93/45/full.jpg", width: 736, height: 1309 },
                  },
                },
              },
            ],
          },
        ],
      },
    };
    const items = mediaItems(ideaImagePin);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("image");
    expect(items[0].url).toBe("https://i.pinimg.com/originals/0d/93/45/full.jpg");
    expect(items[0].url).not.toContain("/736x/");
    expect(items[0].width).toBe(1080);
    expect(items[0].height).toBe(1920);
  });

  it("still uses images.orig for an ordinary pin (regression guard)", () => {
    const items = mediaItems(IMAGE_PIN);
    expect(items[0].url).toBe(IMAGE_PIN.images.orig.url);
  });

  it("falls back to 736x when neither orig nor originals is present", () => {
    const noFullRes = {
      id: "nofull1",
      images: {
        "736x": { url: "https://i.pinimg.com/736x/aa/bb/cc/thumb.jpg", width: 736, height: 1104 },
        "474x": { url: "https://i.pinimg.com/474x/aa/bb/cc/thumb.jpg", width: 474, height: 711 },
        "236x": { url: "https://i.pinimg.com/236x/aa/bb/cc/thumb.jpg", width: 236, height: 354 },
      },
    };
    const items = mediaItems(noFullRes);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://i.pinimg.com/736x/aa/bb/cc/thumb.jpg");
  });
});

describe("parseHlsMaster", () => {
  const MASTER = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio1",URI="abc_audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=560544,RESOLUTION=234x416,AUDIO="audio1"',
    "abc_240w.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=937320,RESOLUTION=360x640,AUDIO="audio1"',
    "abc_360w.m3u8",
  ].join("\n");

  it("returns variants sorted by bandwidth descending", () => {
    const v = parseHlsMaster(MASTER);
    expect(v).toHaveLength(2);
    expect(v[0].file).toBe("abc_360w.m3u8");
    expect(v[0].bandwidth).toBe(937320);
    expect(v[0].resolution).toBe("360x640");
  });

  it("ignores the audio-only EXT-X-MEDIA line", () => {
    expect(parseHlsMaster(MASTER).some((v) => v.file.includes("audio"))).toBe(false);
  });

  it("returns [] on junk", () => {
    expect(parseHlsMaster("")).toEqual([]);
    expect(parseHlsMaster(null)).toEqual([]);
  });
});

describe("mp4CandidatesFromHls", () => {
  it("swaps /hls/ for /expMp4/ and keeps the manifest's variant filename", () => {
    const c = mp4CandidatesFromHls("https://v1.pinimg.com/videos/iht/hls/fb/03/c7/sig.m3u8", "sig_360w.m3u8");
    expect(c[0]).toBe("https://v1.pinimg.com/videos/iht/expMp4/fb/03/c7/sig_360w.mp4");
  });

  it("offers hevcMp4V3 as the second candidate", () => {
    const c = mp4CandidatesFromHls("https://v1.pinimg.com/videos/iht/hls/fb/03/c7/sig.m3u8", "sig_360w.m3u8");
    expect(c[1]).toContain("/hevcMp4V3/");
    expect(c[1]).toContain("sig_360w.mp4");
  });

  it("returns [] when the URL is not an hls path", () => {
    expect(mp4CandidatesFromHls("https://v1.pinimg.com/videos/mc/720p/a/b/c/sig.mp4", "x.m3u8")).toEqual([]);
  });
});

describe("pinToRecord", () => {
  it("flattens a pin into the panel record", () => {
    const r = pinToRecord(IMAGE_PIN, "board:marianam7536/tarot");
    expect(r.id).toBe(IMAGE_PIN.id);
    expect(r.title).toBe("The Illuminated Tarot");
    expect(r.username).toBe("marianam7536");
    expect(r.saves).toBe(120);
    expect(r.comments).toBe(3);
    expect(r.mediaType).toBe("image");
    expect(r.thumb).toContain("236x");
    expect(r.surface).toBe("board:marianam7536/tarot");
    expect(r.permalink).toBe("https://www.pinterest.com/pin/819655200979225688/");
  });

  it("parses Pinterest's HTTP-date created_at into unix seconds", () => {
    expect(pinToRecord(IMAGE_PIN, "s").created_at).toBe(Math.floor(Date.parse("Thu, 04 Aug 2016 06:01:07 +0000") / 1000));
  });

  it("labels idea pins and counts their pages", () => {
    const r = pinToRecord(MP4_IDEA_PIN, "s");
    expect(r.mediaType).toBe("idea");
    expect(r.count).toBe(1);
  });

  it("labels a plain video pin", () => {
    expect(pinToRecord(HLS_ONLY_PIN, "s").mediaType).toBe("video");
  });
});

describe("filenames", () => {
  it("strips path-hostile characters", () => {
    expect(sanitizeFilenamePart('a/b:c*d?"<>|')).toBe("a_b_c_d");
  });

  it("builds pin-<user>-<id>.<ext> and suffixes multi-asset pins", () => {
    const rec = pinToRecord(IMAGE_PIN, "s");
    expect(filenameFor(rec, "png")).toBe("pin-marianam7536-819655200979225688.png");
    expect(filenameFor(rec, "mp4", 2)).toBe("pin-marianam7536-819655200979225688_2.mp4");
  });

  it("reads the real extension off the URL — orig can be png while the thumb is jpg", () => {
    expect(extFromUrl("https://i.pinimg.com/originals/a/b/c/d.png", "image")).toBe("png");
    expect(extFromUrl("https://i.pinimg.com/originals/a/b/c/d.jpeg", "image")).toBe("jpg");
    expect(extFromUrl("https://v1.pinimg.com/videos/x.m3u8", "video")).toBe("mp4");
    expect(extFromUrl("", "image")).toBe("jpg");
  });
});

describe("sortRecords", () => {
  const recs = [
    { id: "a", saves: 5, comments: 1, created_at: 300 },
    { id: "b", saves: 50, comments: 0, created_at: 100 },
    { id: "c", saves: null, comments: 9, created_at: 200 },
  ];

  it("sorts by saves descending with nulls last", () => {
    expect(sortRecords(recs, "saves", "desc").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps nulls last even ascending", () => {
    expect(sortRecords(recs, "saves", "asc").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("default preserves harvest order", () => {
    expect(sortRecords(recs, "default").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const copy = [...recs];
    sortRecords(recs, "saves", "desc");
    expect(recs).toEqual(copy);
  });
});

describe("formatters", () => {
  it("compacts counts", () => {
    expect(fmtCount(964490)).toBe("964.5K");
    expect(fmtCount(1200000)).toBe("1.2M");
    expect(fmtCount(null)).toBe("—");
  });

  it("formats dates and tolerates missing values", () => {
    expect(fmtDate(1470290467)).toBe("2016-08-04");
    expect(fmtDate(null)).toBe("");
  });
});

describe("recordToCard", () => {
  it("projects a record for the grid", () => {
    const c = recordToCard(pinToRecord(IMAGE_PIN, "s"));
    expect(c.id).toBe(IMAGE_PIN.id);
    expect(c.saves).toBe(120);
    expect(c.date).toBe("2016-08-04");
    expect(c.mediaType).toBe("image");
  });
});
