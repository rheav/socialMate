import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fbStatusText, parseFbProfileHtml, parseFbReelsHtml, parseIgProfile, parseTtProfileHtml, ttSpyPost } from "./spyParse.js";

const fixturesDir = path.join(__dirname, "__fixtures__", "spy");
const nasaFixture = fs.readFileSync(path.join(fixturesDir, "fb_nasa_without_story.json"), "utf8");
const personalFixture = fs.readFileSync(path.join(fixturesDir, "fb_personal_with_story.json"), "utf8");

describe("spyParse", () => {
  describe("parseFbProfileHtml", () => {
    it("parses NASA profile fixture without active story", () => {
      const res = parseFbProfileHtml(nasaFixture);
      expect(res).toMatchObject({
        ok: true,
        followers: 28_000_000,
        followersApprox: true,
        following: 52,
        hasStory: false,
        storyRef: "169769551185096",
        verified: true,
        name: "NASA - National Aeronautics and Space Administration",
        userId: "100044561550831",
      });
      expect(res.avatarUrl).toContain("scontent.fna.fbcdn.net");
    });

    it("parses personal profile fixture with active story", () => {
      const res = parseFbProfileHtml(personalFixture);
      expect(res).toMatchObject({
        ok: true,
        followers: 476_000,
        followersApprox: true,
        following: 0,
        hasStory: true,
        storyRef: "123197747437002",
        verified: false,
        userId: "100092403319843",
      });
      expect(res.avatarUrl).toContain("scontent.fna.fbcdn.net");
    });

    it("parses localized follower counts in Portuguese and English", () => {
      const ptHtml = `
        "profile_social_context": {
          "content": [
            { "text": { "text": "1,2 mil seguidores" } },
            { "text": { "text": "350 seguindo" } }
          ]
        }
      `;
      const resPt = parseFbProfileHtml(ptHtml);
      expect(resPt.ok).toBe(true);
      expect(resPt.followers).toBe(1200);
      expect(resPt.following).toBe(350);

      const millionsPtHtml = `
        "profile_social_context": {
          "content": [
            { "text": { "text": "3,4 mi seguidores" } }
          ]
        }
      `;
      const resMi = parseFbProfileHtml(millionsPtHtml);
      expect(resMi.followers).toBe(3_400_000);
    });

    it("identifies login and checkpoint redirects or markup", () => {
      const loginUrlRes = parseFbProfileHtml("<html></html>", "https://www.facebook.com/login.php?next=xyz");
      expect(loginUrlRes).toEqual({ ok: false, error: "login_required" });

      const checkpointUrlRes = parseFbProfileHtml("<html></html>", "https://www.facebook.com/checkpoint/?next=xyz");
      expect(checkpointUrlRes).toEqual({ ok: false, error: "login_required" });

      const loginButtonRes = parseFbProfileHtml('<html><button id="loginbutton">Log In</button></html>');
      expect(loginButtonRes).toEqual({ ok: false, error: "login_required" });
    });

    it("identifies not found / content unavailable markup", () => {
      const notFoundRes = parseFbProfileHtml("<div>Este conteúdo não está disponível no momento</div>");
      expect(notFoundRes).toEqual({ ok: false, error: "not_found" });

      const notFoundEn = parseFbProfileHtml("<div>This content isn't available right now</div>");
      expect(notFoundEn).toEqual({ ok: false, error: "not_found" });
    });

    it("returns parse_failed when followers cannot be found and no known error matches", () => {
      const emptyHtml = "<html><head></head><body><div>Random text without stats</div></body></html>";
      expect(parseFbProfileHtml(emptyHtml)).toEqual({ ok: false, error: "parse_failed" });
    });

    it("ignores logged-in viewer top-bar avatar and picks profile avatar", () => {
      const htmlWithViewer = `
        <script>
          // Top-nav viewer relay cache
          "RelayPrefetchedStreamCache","next",[],["adp_useCometAppNavigationProfilePictureUrlQueryRelayPreloader",
          {"viewer":{"actor":{"__typename":"User","profile_picture":{"uri":"https://scontent.fna.fbcdn.net/viewer_avatar_40px.jpg"}}}}]
        </script>
        <div id="content">
          "header_top_row":{"__typename":"XFBProfileDirectoryHeaderTopRowRenderer",
          "profile_user":{"name":"Target Page Name","profilePicLarge":{"uri":"https://scontent.fna.fbcdn.net/page_profile_pic_960px.jpg"}}}
          "profile_social_context":{"content":[{"text":{"text":"1,5 mi seguidores"}}]}
        </div>
      `;
      const res = parseFbProfileHtml(htmlWithViewer);
      expect(res.ok).toBe(true);
      expect(res.followers).toBe(1_500_000);
      expect(res.name).toBe("Target Page Name");
      expect(res.avatarUrl).toBe("https://scontent.fna.fbcdn.net/page_profile_pic_960px.jpg");
      expect(res.avatarUrl).not.toContain("viewer_avatar");
    });
  });

  describe("parseIgProfile", () => {
    it("parses full Instagram web profile json", () => {
      const igJson = {
        data: {
          user: {
            id: "12345678",
            username: "nasa",
            full_name: "NASA",
            biography: "Exploring the secrets of the universe.",
            external_url: "https://www.nasa.gov",
            is_verified: true,
            is_private: false,
            profile_pic_url_hd: "https://instagram.cdn/nasa_hd.jpg",
            edge_followed_by: { count: 98_000_000 },
            edge_follow: { count: 52 },
            edge_owner_to_timeline_media: { count: 4200 },
            has_highlight_reels: true,
          },
        },
      };

      const res = parseIgProfile(igJson);
      expect(res).toEqual({
        ok: true,
        userId: "12345678",
        name: "NASA",
        followers: 98_000_000,
        followersApprox: false,
        following: 52,
        posts: 4200,
        verified: true,
        private: false,
        avatarUrl: "https://instagram.cdn/nasa_hd.jpg",
        bio: "Exploring the secrets of the universe.",
        externalUrl: "https://www.nasa.gov",
        hasStory: null,
      });
    });

    it("handles missing fields in Instagram json gracefully", () => {
      const minimalJson = {
        data: {
          user: {
            id: "999",
            username: "simple",
            follower_count: 1500,
          },
        },
      };

      const res = parseIgProfile(minimalJson);
      expect(res).toMatchObject({
        ok: true,
        userId: "999",
        followers: 1500,
        followersApprox: false,
        name: null,
        bio: null,
      });
    });

    it("returns parse_failed for invalid or empty inputs", () => {
      expect(parseIgProfile(null)).toEqual({ ok: false, error: "parse_failed" });
      expect(parseIgProfile({})).toEqual({ ok: false, error: "parse_failed" });
      expect(parseIgProfile({ data: {} })).toEqual({ ok: false, error: "parse_failed" });
    });
  });
});


it("parses the passive capture userid without treating highlights as active stories", () => {
  expect(parseIgProfile({ userid: "123", username: "nasa", follower_count: 42,
    has_highlight_reels: true })).toMatchObject({ userId: "123", followers: 42, hasStory: null });
});

describe("parseFbReelsHtml", () => {
  // Shape measured on a live reels tab (2026-10-03): the first page ships in a
  // <script type="application/json"> block as aggregated_fb_shorts.
  const reelNode = (id, created, views) => ({ profile_reel_node: { node: {
    __typename: "Story", creation_time: created, actors: [{ id: "615" }],
    attachments: [{ media: { __typename: "Video", id, created_time: created, length_in_second: 62.3, play_count_reduced: views } }],
  } } });
  const page = (edges, hasNext) => JSON.stringify({ require: [[{ __bbox: { result: { data: { node: { all_collections: { nodes: [{ style_renderer: { collection: {
    id: "COLLECTION", aggregated_fb_shorts: { edges, page_info: { end_cursor: "CUR", has_next_page: hasNext } },
  } } }] } } } } } }]] });
  const html = (json) => `<html><script type="application/json" data-sjs>{"other":1}</script><script type="application/json" data-content-len="9" data-sjs>${json}</script></html>`;

  it("reads the newest reels and the paging state from the reels tab HTML", () => {
    const res = parseFbReelsHtml(html(page([reelNode("2209826979599628", 1791000141, "9.1K"), reelNode("2209826979599629", 1790990000, "512")], true)));
    expect(res.reels).toEqual([
      expect.objectContaining({ id: "2209826979599628", createdAt: 1791000141, views: 9100 }),
      expect.objectContaining({ id: "2209826979599629", createdAt: 1790990000, views: 512 }),
    ]);
    expect(res).toMatchObject({ hasNext: true, cursor: "CUR" });
  });

  it("answers an empty first page without failing", () => {
    expect(parseFbReelsHtml(html(page([], false)))).toEqual({ reels: [], hasNext: false, cursor: "CUR" });
    expect(parseFbReelsHtml("<html></html>")).toEqual({ reels: [], hasNext: null, cursor: null });
  });
});

describe("fbStatusText", () => {
  // Shape measured on a live reels tab (2026-11-02): the intro text under the name, the link inside it.
  const page = (status) => `<script type="application/json">{"x":{"profile_status":null,"profile_status_text":${JSON.stringify(status)},"id":"1"}}</script>`;
  const text = "✨ Just a girl who believes\n🦋 Good energy\n🌙 Your next chapter starts here👇\n\nhttps://0rly4u0.s.gy/Elisemanifest";

  it("reads the bio without the link, and the link", () => {
    // Code points: each emoji counts one, as Facebook counts them.
    const at = Array.from(text.slice(0, text.indexOf("https://"))).length;
    expect(fbStatusText(page({ text, ranges: [{ offset: at, length: Array.from(text).length - at,
      entity: { __typename: "ExternalUrl", url: "https://l.facebook.com/l.php?u=x", external_url: "https://0rly4u0.s.gy/Elisemanifest" } }] })))
      .toEqual({ bio: "✨ Just a girl who believes\n🦋 Good energy\n🌙 Your next chapter starts here👇", externalUrl: "https://0rly4u0.s.gy/Elisemanifest" });
  });

  it("keeps a bio without a link, and answers nothing without a bio", () => {
    expect(fbStatusText(page({ text: "change your mind {braces} \"quoted\"", ranges: [] })))
      .toEqual({ bio: "change your mind {braces} \"quoted\"", externalUrl: null });
    expect(fbStatusText("<html></html>")).toEqual({ bio: null, externalUrl: null });
    expect(fbStatusText('<script>{"profile_status_text":null}</script>')).toEqual({ bio: null, externalUrl: null });
  });
});

describe("TikTok", () => {
  // Shapes measured on @happymindmentor (2026-11-02).
  const page = (detail) => `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.user-detail": detail } })}</script></html>`;
  const user = { id: "7145819764362101765", uniqueId: "happymindmentor", nickname: "Hanna Hattson", avatarMedium: "https://p16.tiktokcdn.com/a.jpg",
    signature: "I help people transform their lives\n⬇️ Manifestation Steps", bioLink: { link: "https://payhip.com/HappyMindMentor", risk: 3 },
    verified: false, privateAccount: false, createTime: 1663765856, UserStoryStatus: 0 };
  const statsV2 = { followerCount: "150858", followingCount: "126", heart: "1394474", heartCount: "1394474", videoCount: "522", diggCount: "0" };

  it("reads the exact numbers, the bio, the link and the account's age from the profile page", () => {
    expect(parseTtProfileHtml(page({ statusCode: 0, userInfo: { user, stats: { followerCount: 150900 }, statsV2 } }))).toEqual({
      ok: true, userId: "7145819764362101765", name: "Hanna Hattson", avatarUrl: "https://p16.tiktokcdn.com/a.jpg", verified: false, private: false,
      bio: "I help people transform their lives\n⬇️ Manifestation Steps", externalUrl: "https://payhip.com/HappyMindMentor", accountCreatedAt: 1663765856,
      followers: 150858, followersApprox: false, following: 126, posts: 522, hearts: 1394474, hasStory: false,
    });
  });

  it("names a missing account, a login wall and a changed page", () => {
    expect(parseTtProfileHtml(page({ statusCode: 10221, userInfo: {} }))).toEqual({ ok: false, error: "not_found" });
    expect(parseTtProfileHtml("<html></html>", "https://www.tiktok.com/login?redirect=x")).toEqual({ ok: false, error: "login_required" });
    expect(parseTtProfileHtml("<html></html>")).toEqual({ ok: false, error: "parse_failed" });
  });

  it("turns a grid record into a post with every number, the audio, the AI mark and the transcript flag", () => {
    const rec = { id: "7703287306530098455", username: "happymindmentor", create_time: 1793641740, images: false, pinned: false,
      play_count: 6221, digg_count: 395, comment_count: 7, share_count: 29, collect_count: 122, repost_count: 0, duration: 147,
      desc: "Remember to focus on what you want", is_aigc: false, music: { title: "Dawn Of Life", original: false },
      hashtags: ["manifestation", "lawofattraction"], subtitle: true, cover: "https://p16.tiktokcdn.com/c.jpg" };
    expect(ttSpyPost(rec, 5)).toEqual({ id: "7703287306530098455", createdAt: 1793641740, mediaType: "video", pinned: false,
      views: 6221, likes: 395, comments: 7, shares: 29, saves: 122, reposts: 0, durationS: 147, caption: "Remember to focus on what you want",
      aiLabel: "NONE", audio: "Dawn Of Life", audioOriginal: false, hashtags: ["manifestation", "lawofattraction"], hasCaptions: true,
      thumbUrl: "https://p16.tiktokcdn.com/c.jpg", observedAt: 5 });
    expect(ttSpyPost({ ...rec, images: true, is_aigc: true, music: { title: "original sound", original: true }, pinned: true }, 5))
      .toMatchObject({ mediaType: "photo", durationS: null, aiLabel: "AIGC", audioOriginal: true, pinned: true });
    expect(ttSpyPost({ ...rec, create_time: "x" })).toBeNull();
  });
});
