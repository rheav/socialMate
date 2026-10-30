// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

it("knows which feed video is playing from the player's wrapper", async () => {
  window.happyDOM.setURL("https://www.tiktok.com/foryou");
  document.body.innerHTML = `<article><section><div id="xgwrapper-0-7686143332346563861"><div><video></video></div></div></section></article>`;
  document.querySelector("video").getBoundingClientRect = () => ({ width: 544, height: 968, top: 16, bottom: 984 });
  const listeners = [];
  vi.stubGlobal("chrome", {
    runtime: { id: "test", onMessage: { addListener: (f) => listeners.push(f) }, sendMessage: async () => ({}) },
    storage: { local: { get: async () => ({}), set: async () => ({}) }, onChanged: { addListener() {} } },
  });
  await import("./tt-relay.js");
  let res;
  listeners.at(-1)({ type: "FBW_TT_LIST" }, {}, (r) => { res = r; });
  expect(res.current).toBe("7686143332346563861");

  // A photo post's tile gets the rail too, and one click saves its slides as one ZIP.
  document.body.innerHTML = `<a href="/@maker/photo/7683724573904243988"><img></a>`;
  document.querySelector("a").getBoundingClientRect = () => ({ width: 203, height: 269, top: 0, bottom: 269 });
  window.dispatchEvent(new MessageEvent("message", { source: window, data: { __fbwTt: true, records: [{ __kind: "video", id: "7683724573904243988", username: "maker", play_count: 5539, cover: "https://p16.tiktokcdn.com/c.jpeg",
    images: ["https://p16.tiktokcdn.com/1.jpeg", "https://p16.tiktokcdn.com/2.jpeg"] }] } }));
  await new Promise((r) => setTimeout(r, 120));
  const dl = [...document.querySelectorAll(".sw-ttacts button")].find((b) => b.title === "Baixar fotos");
  expect(document.querySelector("a > .sw-ttovl")).not.toBeNull();
  const sent = [];
  chrome.runtime.sendMessage = async (m) => { sent.push(m); return { ok: true }; };
  dl.click();
  await new Promise((r) => setTimeout(r, 30));
  expect(sent.map((m) => [m.type, m.filename])).toEqual([
    ["FBW_ZIP_ADD", "tt-maker-7683724573904243988_1.jpg"],
    ["FBW_ZIP_ADD", "tt-maker-7683724573904243988_2.jpg"],
    ["FBW_ZIP_FINISH", undefined],
  ]);
  expect(sent[0].zipName).toBe("tt-maker-7683724573904243988.zip");

  // The photo view: no <video>, so the player rail hangs on the swiper.
  window.happyDOM.setURL("https://www.tiktok.com/@maker/photo/7683724573904243988");
  document.body.innerHTML = `<div class="swiper"><img></div>`;
  document.querySelector(".swiper").getBoundingClientRect = () => ({ width: 1305, height: 900, top: 0, bottom: 900, left: 0, right: 1305 });
  window.dispatchEvent(new MessageEvent("message", { source: window, data: { __fbwTt: true, records: [{ __kind: "video", id: "7683724573904243988", username: "maker", play_count: 5540, images: ["https://p16.tiktokcdn.com/1.jpeg"] }] } }));
  await new Promise((r) => setTimeout(r, 120));
  expect([...document.querySelectorAll("#sw-tt-layer .sw-ttacts button")].map((b) => b.title)).toContain("Baixar fotos");
  // Below TikTok's close button, not on it.
  expect(document.querySelector("#sw-tt-layer .sw-ttacts").style.top).toBe("64px");

  // Closing the view takes the rail with it.
  window.happyDOM.setURL("https://www.tiktok.com/@maker");
  document.body.innerHTML = "";
  window.dispatchEvent(new Event("scroll"));
  await new Promise((r) => setTimeout(r, 350));
  expect(document.querySelectorAll("#sw-tt-layer .sw-ttacts")).toHaveLength(0);
});
