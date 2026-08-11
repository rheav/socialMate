// Did a transcript removal actually remove anything?
//
// The Library's delete hands the work to the background (FBW_TRANSCRIPT_REMOVE),
// which replies {removed:n} — n is the number of records it deleted, or -1 for
// "limpar tudo". sendBg turns a dead or asleep service worker into {ok:false}.
//
// The panel used to ignore the reply entirely, so a removal that deleted NOTHING
// (an id the store doesn't hold, a worker that never answered) looked exactly like
// one that worked: the card stayed on screen and nothing was said. That is
// indistinguishable from a button with no handler wired at all.
export function removalFailed(res) {
  if (!res || res.ok === false) return true;
  return !res.removed; // 0 / undefined — nothing was deleted
}
