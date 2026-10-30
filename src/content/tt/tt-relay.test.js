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
});
