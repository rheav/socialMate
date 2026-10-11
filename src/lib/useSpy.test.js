// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSpy } from "./useSpy.js";
import { SPY_KEY, SPY_PREFS_KEY, mergeList } from "./spyStore.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, stored, serverProfiles, changed, visibility, refreshes, fail;
const profile = { id: "instagram:nasa", platform: "instagram", key: "nasa", savedAt: 1, listUpdatedAt: 1, removedAt: null };
function Panel() {
  const spy = useSpy();
  return h("div", null, spy.profiles.map((p) => h("span", { key: p.id }, p.key)), spy.error && h("p", { role: "alert" }, spy.error));
}
beforeEach(() => {
  vi.useFakeTimers();
  visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  stored = { [SPY_KEY]: { profiles: { [profile.id]: profile } }, [SPY_PREFS_KEY]: { daily: false } };
  serverProfiles = [profile]; refreshes = 0; fail = false;
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: async () => structuredClone(stored) },
      onChanged: { addListener: (fn) => { changed = fn; }, removeListener: () => { changed = null; } },
    },
    alarms: { get: async () => null },
    runtime: { sendMessage: (msg, reply) => {
      if (msg.type !== "FBW_SPY_REFRESH_LIST") throw new Error("Unexpected message");
      refreshes++;
      if (fail) { reply({ ok: false, error: "offline" }); return; }
      stored[SPY_KEY] = mergeList(stored[SPY_KEY], serverProfiles, []);
      changed?.({ [SPY_KEY]: { newValue: stored[SPY_KEY] } }, "local");
      reply({ ok: true });
    } },
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});
it("receives hub removals with daily measurement off while the Spy stays open", async () => {
  await act(async () => root.render(h(Panel)));
  expect(host.textContent).toContain("nasa");
  serverProfiles = [{ ...profile, removedAt: 2, listUpdatedAt: 2 }];
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(host.textContent).not.toContain("nasa");
});
it("pauses hidden polling, refreshes on return and stops when unmounted", async () => {
  await act(async () => root.render(h(Panel)));
  visibility.mockReturnValue("hidden");
  serverProfiles = [{ ...profile, removedAt: 2, listUpdatedAt: 2 }];
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(refreshes).toBe(1);
  expect(host.textContent).toContain("nasa");
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(host.textContent).not.toContain("nasa");
  await act(async () => root.unmount());
  const before = refreshes;
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(refreshes).toBe(before);
  root = createRoot(host);
});
it("keeps the cached list on failure and clears the error after recovery", async () => {
  fail = true;
  await act(async () => root.render(h(Panel)));
  expect(host.textContent).toContain("nasa");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  fail = false;
  serverProfiles = [{ ...profile, removedAt: 2, listUpdatedAt: 2 }];
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("nasa");
});
