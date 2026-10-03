import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseFbProfileHtml, parseIgProfile } from "./spyParse.js";

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
