// @vitest-environment happy-dom
import { beforeAll, expect, it } from "vitest";

// The Spy's own TikTok tab (socialMate 1.29): a background tab never paints, so the
// capture asks for the grid itself, through the page's fetch, and the tee reads it.
const requested = [];
const posted = [];
const item = (id) => ({ id, desc: "x", createTime: 1793641740, author: { id: "7145819764362101765", uniqueId: "happymindmentor" },
  statsV2: { playCount: "6221", diggCount: "395", commentCount: "7", shareCount: "29", collectCount: "122" }, video: { id, duration: 147 } });

beforeAll(async () => {
  window.happyDOM.setURL("https://www.tiktok.com/@happymindmentor#socialmate-spy");
  const blob = document.createElement("script");
  blob.id = "__UNIVERSAL_DATA_FOR_REHYDRATION__";
  blob.type = "application/json";
  blob.textContent = JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.user-detail": { userInfo: {
    user: { id: "7145819764362101765", uniqueId: "happymindmentor", secUid: "MS4w-SEC", UserStoryStatus: 1 } } } } });
  document.head.append(blob);
  window.postMessage = (m) => posted.push(m);
  window.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify(/story/.test(url) ? { itemList: [item("7700000000000000001")] } : { itemList: [item("7703287306530098455")] }));
  };
  await import("./tt-capture.js");
  window.dispatchEvent(new Event("load"));
  await new Promise((r) => setTimeout(r, 1800));
});

it("asks for the profile's first grid page and its stories, and captures them as the profile's", () => {
  const grid = requested.find((u) => u.startsWith("/api/post/item_list/"));
  expect(new URLSearchParams(grid.split("?")[1]).get("secUid")).toBe("MS4w-SEC");
  expect(requested.some((u) => u.startsWith("/api/story/item_list/") && u.includes("authorId=7145819764362101765"))).toBe(true);
  const records = posted.flatMap((m) => m.records || []);
  expect(records.find((r) => r.id === "7703287306530098455")).toMatchObject({ __surface: "profile:happymindmentor", play_count: 6221, collect_count: 122 });
  expect(records.find((r) => r.id === "7700000000000000001")).toMatchObject({ __kind: "tt_story" });
});
