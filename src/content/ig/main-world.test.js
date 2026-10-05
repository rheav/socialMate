import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Run the actual import-free MAIN script: profile data can arrive at
// document_start, before the isolated bridge subscribes at document_idle.
describe("Instagram passive profile replay", () => {
  it("replays cached user stats to late and replacement bridges", () => {
    const delivered = [];
    const handlers = {};
    const page = {
      location: { pathname: "/nasa/", search: "", hash: "#socialmate-spy", origin: "https://www.instagram.com" },
      document: { visibilityState: "hidden", querySelectorAll: () => [], addEventListener: () => {} },
      setInterval: () => 1, setTimeout: () => 1, XMLHttpRequest: function () {}, URL,
    };
    page.XMLHttpRequest.prototype.setRequestHeader = () => {};
    page.window = page;
    page.postMessage = (message) => delivered.push(message);
    page.addEventListener = (event, listener) => { handlers[event] = listener; };
    const context = vm.createContext(page);
    vm.runInContext(readFileSync(new URL("./main-world.js", import.meta.url), "utf8"), context);
    vm.runInContext('JSON.parse(\'{"user":{"pk":"123","username":"nasa","follower_count":42}}\')', context);
    delivered.length = 0; // no bridge was listening to the original sighting
    page.relay = handlers.message;
    for (let bridge = 0; bridge < 2; bridge++) {
      vm.runInContext('relay({source:window,data:{__fbwIgReq:true}})', context);
      expect(delivered.at(-1)?.records || []).toContainEqual(expect.objectContaining({
        __kind: "user", userid: "123", username: "nasa", follower_count: 42,
      }));
      delivered.length = 0;
    }
  });
});

describe("Instagram grid posts for posts per day", () => {
  it("keeps the publication time, the surface and who pinned each post", () => {
    const delivered = [];
    const handlers = {};
    const page = {
      location: { pathname: "/nasa/", search: "", hash: "#socialmate-spy", origin: "https://www.instagram.com" },
      document: { visibilityState: "hidden", querySelectorAll: () => [], addEventListener: () => {} },
      setInterval: () => 1, setTimeout: () => 1, XMLHttpRequest: function () {}, URL,
    };
    page.XMLHttpRequest.prototype.setRequestHeader = () => {};
    page.window = page;
    page.postMessage = (message) => delivered.push(message);
    page.addEventListener = (event, listener) => { handlers[event] = listener; };
    const context = vm.createContext(page);
    vm.runInContext(readFileSync(new URL("./main-world.js", import.meta.url), "utf8"), context);
    const node = (code, pk, takenAt, pinned) => ({ code, pk, taken_at: takenAt, media_type: 1,
      image_versions2: { candidates: [{ url: "https://x/i.jpg" }] },
      timeline_pinned_user_ids: pinned, user: { pk: "123", username: "nasa" } });
    const payload = { data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [
      { node: node("AAA", "3001", 1791000000, ["123"]) }, { node: node("BBB", "3002", 1791000100, []) }] } } };
    vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(payload))})`, context);
    page.relay = handlers.message;
    vm.runInContext('relay({source:window,data:{__fbwIgReq:true}})', context);
    const records = delivered.flatMap((m) => m.records || []);
    expect(records).toContainEqual(expect.objectContaining({ code: "AAA", pk: "3001", taken_at: 1791000000,
      pinned_by: ["123"], __surface: "profile:nasa" }));
    expect(records).toContainEqual(expect.objectContaining({ code: "BBB", pinned_by: [] }));
  });
});
