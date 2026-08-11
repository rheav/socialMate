import { describe, it, expect } from "vitest";
import { serialQueue } from "./serialQueue.js";

// A storage.local map is read, mutated and written back. Two of those in flight
// at once and the slower read wins — the other write is simply gone. That is how
// a finished transcript could be overwritten by a "running" record written from
// the page a moment later.
function racyStore(initial = {}) {
  let data = initial;
  return {
    get: () => new Promise((r) => setTimeout(() => r({ ...data }), 5)),
    set: (next) => new Promise((r) => setTimeout(() => ((data = next), r()), 5)),
    read: () => data,
  };
}

describe("serialQueue", () => {
  it("keeps both writes when two read-modify-writes run concurrently", async () => {
    const store = racyStore({});
    const queue = serialQueue();
    const write = (id) =>
      queue(async () => {
        const map = await store.get();
        map[id] = true;
        await store.set(map);
      });
    await Promise.all([write("a"), write("b")]);
    expect(store.read()).toEqual({ a: true, b: true });
  });

  it("loses a write without the queue — the bug this exists for", async () => {
    const store = racyStore({});
    const write = async (id) => {
      const map = await store.get();
      map[id] = true;
      await store.set(map);
    };
    await Promise.all([write("a"), write("b")]);
    expect(Object.keys(store.read())).toHaveLength(1);
  });

  it("returns each job's own result to its own caller", async () => {
    const queue = serialQueue();
    const [a, b] = await Promise.all([queue(async () => "a"), queue(async () => "b")]);
    expect([a, b]).toEqual(["a", "b"]);
  });

  it("rejects the failing job without stalling the ones behind it", async () => {
    const queue = serialQueue();
    const failed = queue(async () => {
      throw new Error("boom");
    });
    const after = queue(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });

  it("runs jobs in the order they were queued", async () => {
    const queue = serialQueue();
    const order = [];
    await Promise.all([
      queue(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }),
      queue(async () => order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
