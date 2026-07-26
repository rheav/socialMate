// Shared polling for the panel's tools.
//
// Every data tool polls its content script on an interval (1s–5s). Three things
// were wrong with doing that with a bare setInterval:
//   1. it kept firing while the panel was not visible (window minimised/occluded),
//      waking the content script and structured-cloning its whole store for nobody;
//   2. after becoming visible again you waited up to a full interval for fresh data;
//   3. an async `fn` slower than `ms` overlapped with itself, so two responses could
//      land out of order and the stale one win. WarmTool polls at 1s into a content
//      script that may be mid-scroll, so this was reachable.
//
// startPolling skips hidden ticks, fires immediately on becoming visible, fires once
// on start (every caller used to hand-roll that with its own initial call), and never
// runs `fn` concurrently with itself. Returns a cleanup function — call it from the
// useEffect return.
//
// NOTE `document` is reached through hasDocument() rather than optional chaining:
// `document?.x` does NOT guard an UNDECLARED identifier, it still throws
// ReferenceError. That is why this module was the one lib with no test under the
// `node` Vitest environment.
const hasDocument = () => typeof document !== "undefined";

export function startPolling(fn, ms, { immediate = true } = {}) {
  let stopped = false;
  let running = false;

  const visible = () => !hasDocument() || document.visibilityState === "visible";

  // Never overlap: a tick arriving while the previous one is still in flight is
  // dropped, not queued — the next interval picks up fresher data anyway.
  const failed = (e) => {
    // A loader that throws must not become an unhandled rejection on every tick,
    // and must not wedge the loop either — the next tick gets a clean slate.
    console.warn("[fbw] poll failed", e);
  };

  // Only a loader that actually returns a promise holds the lock across ticks. An
  // `async` wrapper here would make even a SYNCHRONOUS fn hold `running` until the
  // next microtask, so ticks could be dropped for no reason.
  const tick = () => {
    if (stopped || running || !visible()) return;
    let out;
    running = true;
    try {
      out = fn();
    } catch (e) {
      running = false;
      failed(e);
      return;
    }
    if (out && typeof out.then === "function") {
      out.then(
        () => {
          running = false;
        },
        (e) => {
          running = false;
          failed(e);
        },
      );
    } else {
      running = false;
    }
  };

  if (immediate) tick();
  const id = setInterval(tick, ms);
  const onVis = () => tick();
  if (hasDocument()) document.addEventListener("visibilitychange", onVis);

  return () => {
    stopped = true;
    clearInterval(id);
    if (hasDocument()) document.removeEventListener("visibilitychange", onVis);
  };
}
