// Opening an Instagram post's comment thread, under a budget. INLINED into the
// Instagram bridge — see src/lib/shared/README.md before editing (no imports
// allowed in this file).
//
// The analysis of a top video wants the comments' TEXT, not their count. A post
// page shows the first ~15; the rest sit behind "Load more comments" and each
// thread's "View replies (n)". This presses those, one at a time with a human
// gap, and stops at the first limit hit — and says which one, so the report can
// call a partial capture partial instead of pretending it read everything.
//
// The page-facing parts (counting what is on screen, finding a button, clicking,
// sleeping, the clock) are injected, so the stop rules are tested without a DOM.

/** Defaults from the design: 200 comments, 20 presses or 90 s per post. */
export const IG_COMMENT_EXPAND_LIMITS = { maxComments: 200, maxExpansions: 20, maxMs: 90_000, gapMs: [1200, 2600] };

/** Presses in a row that revealed nothing before the page is taken as stuck. */
const IG_EXPAND_STALL = 3;

/**
 * Press "more" buttons until a limit, the end of the thread, a stuck page or a
 * cancel. Resolves to { stopReason, captured, expansions }, where stopReason is
 * one of limit_comments | limit_expansions | limit_time | exhausted |
 * no_progress | cancelled.
 */
export async function expandComments({ count, findButton, click, sleep, now, limits = IG_COMMENT_EXPAND_LIMITS, random = Math.random, cancelled = () => false }) {
  const { maxComments, maxExpansions, maxMs, gapMs } = { ...IG_COMMENT_EXPAND_LIMITS, ...limits };
  const start = now();
  let expansions = 0;
  let stalled = 0;
  const done = (stopReason) => ({ stopReason, captured: Math.min(count(), maxComments), expansions });
  for (;;) {
    if (cancelled()) return done("cancelled");
    const before = count();
    if (before >= maxComments) return done("limit_comments");
    if (expansions >= maxExpansions) return done("limit_expansions");
    const left = maxMs - (now() - start);
    if (left <= 0) return done("limit_time");
    const button = findButton();
    if (!button) return done("exhausted");
    await click(button);
    expansions += 1;
    const [lo, hi] = gapMs;
    await sleep(Math.min(left, Math.round(lo + random() * Math.max(0, hi - lo))));
    stalled = count() > before ? 0 : stalled + 1;
    if (stalled >= IG_EXPAND_STALL) return done("no_progress");
  }
}

/**
 * Whether a button label opens more of the thread ("View replies (3)",
 * "Ver todas as 4 respostas", "Load more comments"). Hiding, replying, liking
 * and translating are never pressed.
 */
export function isExpandLabel(label) {
  const s = String(label ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^a-z]+/, "")
    .trim();
  if (!s || /^(ocultar|hide)\b/.test(s)) return false;
  return (
    /^(ver|view)( todas as| all)?( \d+)?( mais| more)? (respostas?|repl(y|ies))\b/.test(s) ||
    /^(carregar|ver) mais comentarios?\b/.test(s) ||
    /^(load|view) more comments?\b/.test(s)
  );
}
