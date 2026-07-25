// Shared polling for the panel's tools.
//
// Every data tool polls its content script on an interval (2.5s, 3s, 1s). Two things
// were wrong with doing that with a bare setInterval:
//   1. it kept firing while the panel was not visible (window minimised/occluded),
//      waking the content script and structured-cloning its whole store for nobody;
//   2. after becoming visible again you waited up to a full interval for fresh data.
//
// startPolling skips ticks while hidden and fires once immediately on becoming
// visible. Returns a cleanup function — call it from the useEffect return.
export function startPolling(fn, ms) {
  let stopped = false;
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const id = setInterval(() => {
    if (!stopped && visible()) fn();
  }, ms);
  const onVis = () => {
    if (!stopped && visible()) fn();
  };
  document?.addEventListener?.("visibilitychange", onVis);
  return () => {
    stopped = true;
    clearInterval(id);
    document?.removeEventListener?.("visibilitychange", onVis);
  };
}
