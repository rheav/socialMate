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
