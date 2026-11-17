import { describe, it, expect, vi } from "vitest";
import { createViralSearch, searchQuery, searchRows, searchSurface, searchUrl } from "./viralSearch.js";

const igVideo = (code, extra = {}) => ({ code, pk: "pk" + code, username: "maga", media_type: "video", play_count: 1000, like_count: 50,
  comment_count: 5, thumb: "https://cdn/x.jpg", taken_at: 1_700_000_000, surface: "search:tarot amor", ...extra });
const ttVideo = (id, extra = {}) => ({ __kind: "video", id, username: "bruxa", play_count: 9000, digg_count: 300, comment_count: 20,
  share_count: 40, user_follower_count: 1200, create_time: 1_700_000_000, cover: "https://cdn/c.jpg", desc: "tarot", surface: "search:tarot amor", ...extra });

describe("search words", () => {
  it("drops the #, squeezes spaces, files under one surface", () => {
    expect(searchQuery("  #Tarot   Amor ")).toBe("Tarot Amor");
    expect(searchSurface("#Tarot  Amor")).toBe("search:tarot amor");
    expect(searchUrl("instagram", "#tarot amor")).toBe("https://www.instagram.com/explore/search/keyword/?q=tarot%20amor");
    expect(searchUrl("tiktok", "tarot")).toBe("https://www.tiktok.com/search/video?q=tarot");
  });
});

describe("searchRows", () => {
  it("keeps this search's Instagram videos only, once each", () => {
    const rows = searchRows("instagram", [igVideo("A"), igVideo("A"), igVideo("B", { media_type: "photo" }),
      igVideo("C", { surface: "profile:maga" }), igVideo("D", { play_count: null })], "tarot amor");
    expect(rows.map((r) => r.id)).toEqual(["pkA", "pkD"]);
    expect(rows[0]).toMatchObject({ url: "https://www.instagram.com/reel/A/", author: "maga", views: 1000, likes: 50, shares: null, followers: null });
    expect(rows[1].views).toBeNull();
  });
  it("keeps TikTok videos with shares and followers, not photo posts", () => {
    const rows = searchRows("tiktok", [ttVideo("1"), ttVideo("2", { images: ["a"] }), { __kind: "tt_story", id: "3", surface: "search:tarot amor" }], "tarot amor");
    expect(rows).toEqual([expect.objectContaining({ id: "1", url: "https://www.tiktok.com/@bruxa/video/1", views: 9000, shares: 40, followers: 1200 })]);
  });
  it("stops at the limit", () => {
    expect(searchRows("tiktok", [ttVideo("1"), ttVideo("2"), ttVideo("3")], "tarot amor", 2)).toHaveLength(2);
  });
});

describe("createViralSearch", () => {
  function setup({ blocked = false, lists = [], url = "https://www.tiktok.com/search/video?q=tarot" } = {}) {
    let t = 0;
    const sent = [];
    const tabs = { get: vi.fn(async () => ({ url })), sendMessage: vi.fn(async (_id, m) => { sent.push(m.type); if (m.type.endsWith("_SCROLL")) return { ok: true }; return lists.length ? { records: lists.shift() } : { records: [] }; }) };
    const windows = { create: vi.fn(async () => ({ id: 7, tabs: [{ id: 70 }] })), remove: vi.fn(async () => {}) };
    const search = createViralSearch({ windows, tabs, isBlocked: async () => blocked, sleep: async (ms) => { t += ms; }, now: () => t });
    const reply = { progress: vi.fn(), result: vi.fn() };
    return { search, reply, windows, sent };
  }
  it("refuses a bad request and a paused platform without opening a window", async () => {
    const a = setup();
    await a.search.run({ platform: "x", q: "tarot" }, a.reply);
    expect(a.reply.result).toHaveBeenCalledWith(false, { error: "bad_request" });
    const b = setup({ blocked: true });
    await b.search.run({ platform: "tiktok", q: "tarot" }, b.reply);
    expect(b.reply.result).toHaveBeenCalledWith(false, { error: "rate_limited" });
    expect(b.windows.create).not.toHaveBeenCalled();
  });
  it("scrolls once, stops when the list stops growing, closes its window", async () => {
    const page1 = [ttVideo("1"), ttVideo("2")];
    const s = setup({ lists: [page1, [...page1, ttVideo("3")]] });
    await s.search.run({ platform: "tiktok", q: "Tarot Amor" }, s.reply);
    expect(s.sent.filter((x) => x === "FBW_TT_SCROLL")).toHaveLength(1);
    const [ok, out] = s.reply.result.mock.calls[0];
    expect(ok).toBe(true);
    expect(out.results.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(s.windows.remove).toHaveBeenCalledWith(7);
  });
  it("answers login_required when the search turns into the login page", async () => {
    const s = setup({ url: "https://www.instagram.com/accounts/login/?next=%2Fexplore%2F", lists: [[igVideo("A")]] });
    await s.search.run({ platform: "instagram", q: "tarot" }, s.reply);
    expect(s.reply.result).toHaveBeenCalledWith(false, { error: "login_required" });
    expect(s.windows.remove).toHaveBeenCalledWith(7);
  });
  it("stops at the limit", async () => {
    const s = setup({ lists: [[ttVideo("1"), ttVideo("2"), ttVideo("3")]] });
    await s.search.run({ platform: "tiktok", q: "tarot amor", limit: 2 }, s.reply);
    expect(s.reply.result.mock.calls[0][1].results).toHaveLength(2);
  });
});
