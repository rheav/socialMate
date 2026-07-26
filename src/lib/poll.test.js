// poll.js was the one lib with no test, because `document?.addEventListener` does
// not guard an undeclared identifier — it throws ReferenceError under the `node`
// Vitest environment. With that fixed (typeof check) these can run.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startPolling } from "./poll.js";

describe("startPolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs without a document (node env) instead of throwing", () => {
    expect(typeof document).toBe("undefined");
    const fn = vi.fn();
    const stop = startPolling(fn, 1000);
    expect(fn).toHaveBeenCalledTimes(1); // fires immediately
    stop();
  });

  it("fires once on start so callers don't hand-roll an initial call", () => {
    const fn = vi.fn();
    const stop = startPolling(fn, 1000);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("can opt out of the immediate first call", () => {
    const fn = vi.fn();
    const stop = startPolling(fn, 1000, { immediate: false });
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps ticking on the interval", () => {
    const fn = vi.fn();
    const stop = startPolling(fn, 1000, { immediate: false });
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops on cleanup", () => {
    const fn = vi.fn();
    const stop = startPolling(fn, 1000, { immediate: false });
    vi.advanceTimersByTime(1000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never runs an async fn concurrently with itself", async () => {
    // The bug: a 1s poll whose fn takes longer than 1s used to overlap, so two
    // responses raced and the stale one could win.
    let active = 0;
    let maxActive = 0;
    let resolveFn;
    const fn = vi.fn(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((r) => {
        resolveFn = () => {
          active -= 1;
          r();
        };
      });
    });

    const stop = startPolling(fn, 100, { immediate: false });
    vi.advanceTimersByTime(100); // tick 1 starts, never settles yet
    vi.advanceTimersByTime(100); // tick 2 must be dropped
    vi.advanceTimersByTime(100); // tick 3 must be dropped
    expect(fn).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);

    resolveFn();
    await Promise.resolve();
    vi.advanceTimersByTime(100); // now free again
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a throwing fn does not wedge the loop", async () => {
    const fn = vi.fn(() => {
      throw new Error("boom");
    });
    const stop = startPolling(fn, 100, { immediate: false });
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });
});
