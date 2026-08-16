// The engagement rule behind the Facebook research filter: "show me only the
// posts with at least N comments / N shares / N reactions". Pure and DOM-free, so
// the side panel that EDITS the rule and the page script that ENFORCES it agree on
// what passes — there is no second copy to drift.
//
// INLINED into content scripts — see src/lib/shared/README.md before editing (no
// imports allowed in this file).

// chrome.storage.local key. The rule is stored, not just messaged, so a page
// reload (or a second Facebook tab) keeps filtering without the panel being open.
export const FB_FILTER_KEY = "sw_fb_filter";

// Order matters: it is the order the panel renders the three inputs in, and the
// order of Facebook's own action row (reactions · comments · shares).
export const FILTER_METRICS = ["likes", "comments", "shares"];

export function emptyRule() {
  return { on: false, mode: "or", min: { likes: null, comments: null, shares: null } };
}

// A minimum is a whole count ≥ 0, or null for "ignore this metric". The panel's
// inputs hand over strings, so "" (the user cleared the field), "1.2k" and a
// negative all have to degrade to null rather than to NaN — a NaN threshold
// compares false against everything and would silently hide the whole feed.
function normMin(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

// Anything that arrives from storage or a message goes through here first.
export function normalizeRule(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const min = r.min && typeof r.min === "object" ? r.min : {};
  return {
    on: !!r.on,
    mode: r.mode === "and" ? "and" : "or",
    min: {
      likes: normMin(min.likes),
      comments: normMin(min.comments),
      shares: normMin(min.shares),
    },
  };
}

// The metrics the rule actually looks at (a blank field is not a "≥ 0" test).
export function activeMetrics(rule) {
  const min = (rule && rule.min) || {};
  return FILTER_METRICS.filter((m) => min[m] != null);
}

/**
 * Does this post's engagement clear the rule?
 *
 * A missing count is a ZERO, not an unknown: Facebook prints no number at all
 * beside a control whose count is 0 (verified live on /search/top, 2026-08-15), so
 * `null` here means "nobody did it" and must fail a positive minimum.
 *
 * An empty rule passes everything. Filtering the entire feed away because the
 * user has not typed a threshold yet would read as a broken tool.
 */
export function passesRule(counts, rule) {
  const active = activeMetrics(rule);
  if (!active.length) return true;
  const min = rule.min;
  const ok = (m) => ((counts && counts[m] != null ? counts[m] : 0) >= min[m]);
  return rule.mode === "and" ? active.every(ok) : active.some(ok);
}

/**
 * Identity of a rule's FILTERING behaviour, used by the page script to decide
 * whether a post's cached verdict is still valid.
 *
 * `on` is deliberately excluded: switching the filter off and back on must not
 * force every post in a long feed to be re-read, because the answer cannot have
 * changed. Only the thresholds and the combinator can change a verdict.
 */
export function ruleKey(rule) {
  const r = normalizeRule(rule);
  return `${r.mode}:${r.min.likes}/${r.min.comments}/${r.min.shares}`;
}
