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
  window.fetch = async () => new Response(JSON.stringify({
    batchStoryItemLists: [{ AuthorId: "1", itemList: [item("7700000000000000001", "storyteller")] }, { AuthorId: "2" }],
  }));
  await import("./tt-capture.js");
  await new Promise((r) => setTimeout(r, 150));
});

it("captures the For You feed's server-rendered videos, media included", () => {
  const r = captured().find((x) => x.id === "7681916289874414869");
  expect(r).toMatchObject({ play_count: 10, video: "https://v16-webapp-prime.tiktok.com/a.mp4" });
});

it("captures the batched stories as stories of their author", async () => {
  await window.fetch("https://www.tiktok.com/api/story/batch/item_list/?authorIds=1,2");
  await new Promise((r) => setTimeout(r, 50));
  expect(captured().find((x) => x.id === "7700000000000000001")).toMatchObject({ __kind: "tt_story", reel_owner: "storyteller" });
});
