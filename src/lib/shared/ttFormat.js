// TikTok engagement maths and the permalink rule. Canonical source, INLINED into
// the TikTok content scripts — see ./README.md before editing (no imports allowed
// except from a sibling in this directory).
import { fmtER } from "./fmt.js";

// ER weights — like 1×, comment & share 4×, save 2×. TikTok exposes shares AND
// saves on the list (Instagram exposes neither), so the weight set is richer than
// IG's and lives apart from it, under its own storage key.
export const TT_ER_WEIGHTS = { like: 1, comment: 4, share: 4, save: 2 };
export const TT_ER_WEIGHTS_KEY = "fbw_tt_er_weights"; // storage.local — panel writes, page reads

/** Per-field fallback: one junk value must not throw away the other three. */
export function normalizeTtErWeights(w) {
  const out = { ...TT_ER_WEIGHTS };
  if (!w || typeof w !== "object") return out;
  for (const k of Object.keys(TT_ER_WEIGHTS)) {
    const n = Number(w[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/** ER = (like×w + comment×w + share×w + save×w) / plays × 100. Null without plays. */
export function ttEngagementRate(rec, weights) {
  if (!rec) return null;
  const v = rec.play_count;
  if (!v || v <= 0) return null;
  const w = weights || TT_ER_WEIGHTS;
  const eng =
    w.like * (rec.digg_count || 0) +
    w.comment * (rec.comment_count || 0) +
    w.share * (rec.share_count || 0) +
    w.save * (rec.collect_count || 0);
  return (eng / v) * 100;
}

/**
 * Views per follower — how far a video travelled beyond the audience it started
 * with. Null when either half is missing, so it degrades to "—" instead of to a
 * confident zero.
 */
export function ttViewsPerFollower(rec) {
  if (!rec) return null;
  const f = rec.user_follower_count;
  const v = rec.play_count;
  if (!f || f <= 0 || v == null) return null;
  return v / f;
}

/** One decimal below 10×, none above — "3.4×", "112×". */
export function fmtRatio(x) {
  if (x == null) return null;
  return (x >= 10 ? Math.round(x) : Number(x.toFixed(1))) + "×";
}

/** Absolute permalink back to a captured record, or null when it can't be built. */
export function ttPermalink(rec) {
  if (!rec || !rec.id || !rec.username) return null;
  return `https://www.tiktok.com/@${rec.username}/video/${rec.id}`;
}

/** The ER label the overlay and the panel both print. */
export function ttErLabel(rec, weights) {
  return fmtER(ttEngagementRate(rec, weights));
}

// ---- reach grade ----------------------------------------------------------
// Views-per-follower is the one figure on the rail that says whether the FORMAT
// worked, independent of how big the account already was — so it leads the rail
// and it is graded, rather than being one more number in a stack of eight.
//
// The ladder is a heat ramp, not a pass/fail: every tier above `baseline` is a
// good outcome, just a progressively rarer one. Red is deliberately absent —
// there is no failure state here, and red would read as an error badge.
//
// Thresholds are round numbers on purpose. They are a reading aid, not a
// measurement: 1× is the only one that means something exact (the video reached
// exactly as many views as the account has followers, i.e. it did not leave the
// follower base), and the rest are the magnitudes people actually talk in.
export const REACH_TIERS = [
  { key: "inside", min: 0, color: "#94a3b8", label: "Ficou na base de seguidores" },
  { key: "baseline", min: 1, color: "#7dd3fc", label: "Alcance normal" },
  { key: "working", min: 3, color: "#4ade80", label: "O formato funcionou" },
  { key: "strong", min: 10, color: "#fbbf24", label: "Alcance forte" },
  { key: "breakout", min: 50, color: "#fb923c", label: "Estourou" },
];

/** The tier a views-per-follower figure falls in, or null when it is unknown. */
export function reachTier(vpf) {
  if (vpf == null || !Number.isFinite(vpf)) return null;
  let out = REACH_TIERS[0];
  for (const t of REACH_TIERS) if (vpf >= t.min) out = t;
  return out;
}

/** Convenience: straight from a record to its tier. */
export function recordReachTier(rec) {
  return reachTier(ttViewsPerFollower(rec));
}
