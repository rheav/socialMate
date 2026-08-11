// One-at-a-time execution for read-modify-write jobs against a shared store.
//
// chrome.storage.local holds whole MAPS (fbw_saved, fbw_transcripts), so every
// writer does get → mutate → set. Two of those in flight — a page overlay and the
// panel, two tabs, or a job finishing while another starts — and the slower read
// wins: the other write is silently gone. The saved store was fixed this way
// first; this is that fix, extracted so the transcript store can share it instead
// of growing a second hand-rolled chain.
//
// A failing job rejects to ITS OWN caller and never breaks the chain for the jobs
// queued behind it.
export function serialQueue() {
  let chain = Promise.resolve();
  return function queue(fn) {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  };
}
