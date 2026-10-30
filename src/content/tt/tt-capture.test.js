// @vitest-environment happy-dom
import { beforeAll, expect, it } from "vitest";

const item = (id, uniqueId = "maker") => ({
  id, desc: "x", createTime: 1790000000,
  author: { id: "1", uniqueId, nickname: "Maker" },
  stats: { playCount: 10, diggCount: 2, commentCount: 1, shareCount: 0 },
  video: { id, duration: 9, playAddr: "https://v16-webapp-prime.tiktok.com/a.mp4", cover: "https://p16.tiktokcdn.com/c.jpg" },
});
const posted = [];
const captured = () => posted.flatMap((m) => m.records || []);

beforeAll(async () => {
  window.happyDOM.setURL("https://www.tiktok.com/foryou");
  const blob = document.createElement("script");
  blob.id = "__UNIVERSAL_DATA_FOR_REHYDRATION__";
  blob.type = "application/json";
  blob.textContent = JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.updated-items": [item("7681916289874414869")] } });
  document.head.append(blob);
  window.postMessage = (m) => posted.push(m);
  window.fetch = async (url) => new Response(JSON.stringify(/story/.test(url)
    ? { batchStoryItemLists: [{ AuthorId: "1", itemList: [item("7700000000000000001", "storyteller")] }, { AuthorId: "2" }] }
    : { itemList: [{ ...item("7683724573904243988"), video: { id: "7683724573904243988", cover: "https://p16.tiktokcdn.com/c.jpg" },
        imagePost: { images: [1, 2].map((n) => ({ imageURL: { urlList: [`https://p16-common-sign.tiktokcdn.com/${n}.jpeg`, `https://p19-common-sign.tiktokcdn.com/${n}.jpeg`] } })) } }] }));
  await import("./tt-capture.js");
  await new Promise((r) => setTimeout(r, 150));
});

it("captures the For You feed's server-rendered videos, media included", () => {
  const r = captured().find((x) => x.id === "7681916289874414869");
  expect(r).toMatchObject({ play_count: 10, video: "https://v16-webapp-prime.tiktok.com/a.mp4" });
});

it("reads a photo post's slides, first mirror of each", async () => {
  await window.fetch("https://www.tiktok.com/api/post/item_list/?count=16");
  await new Promise((r) => setTimeout(r, 50));
  const r = captured().find((x) => x.id === "7683724573904243988");
  expect(r.images).toEqual(["https://p16-common-sign.tiktokcdn.com/1.jpeg", "https://p16-common-sign.tiktokcdn.com/2.jpeg"]);
  expect(r.video).toBeNull();
});

it("captures the batched stories as stories of their author", async () => {
  await window.fetch("https://www.tiktok.com/api/story/batch/item_list/?authorIds=1,2");
  await new Promise((r) => setTimeout(r, 50));
  expect(captured().find((x) => x.id === "7700000000000000001")).toMatchObject({ __kind: "tt_story", reel_owner: "storyteller" });
});
