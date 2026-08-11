// Merge a scraped-metadata patch into an existing record WITHOUT downgrading it.
//
// A transcript record is written more than once: the content script writes a
// "running" card the instant Transcribe is clicked, the background writes its own
// running record when the job starts, and the backfill patches whatever the first
// scrape missed. Those writes carry the SAME scrape, so a later one that found
// nothing must not erase what an earlier one found — a plain object spread does
// exactly that, which is how reels landed in the Library with `counts: null`
// beside a perfectly good author, caption and thumbnail.
//
// Rule: a null / undefined / empty-string value in the patch means "I didn't see
// it", not "it is gone". State fields (status, error) are the exception — pass
// them in `opts.clear` so a patch can genuinely reset them.
export function mergeMeta(prev, patch, opts = {}) {
  const clear = new Set(opts.clear || []);
  const out = { ...(prev || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (clear.has(k) || !(v == null || v === "")) out[k] = v;
  }
  return out;
}
