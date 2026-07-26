// Pure session math for the warm engine — no chrome.*, no DOM. Imported by
// src/content.js (engine) and WarmTool.jsx (reconciliation). Times are epoch ms
// unless noted.

// Run-loop gate: running, before the session clock, under the optional item cap
// (maxItems 0 = no cap).
export function shouldContinue(s, now = Date.now()) {
  if (!s?.isRunning) return false;
  if (s.willEndAt && now >= s.willEndAt) return false;
  if (s.maxItems > 0 && s.processed >= s.maxItems) return false;
  return true;
}

// profile: { everyMin, everyMax, lenMin, lenMax } — all ms.
export function scheduleNextBreak(profile, now, rnd = Math.random) {
  return now + profile.everyMin + Math.floor(rnd() * (profile.everyMax - profile.everyMin));
}

export function breakLengthMs(profile, rnd = Math.random) {
  return profile.lenMin + Math.floor(rnd() * (profile.lenMax - profile.lenMin));
}

// Watch-commitment dwell: fraction × video length, clamped to
// [dwellMinMs, 4 × dwellMaxMs]. Returns null when the duration is unusable so
// the caller can fall back to the plain random dwell range.
export function commitmentDwellMs(fraction, videoDurationSec, dwellMinMs, dwellMaxMs) {
  if (!isFinite(videoDurationSec) || videoDurationSec <= 0) return null;
  const target = fraction * videoDurationSec * 1000;
  return Math.round(Math.min(Math.max(target, dwellMinMs), 4 * dwellMaxMs));
}

// ---------------------------------------------------------------------------
// The safety ledger.
//
// A run navigates to its target surface (start() → location.assign for every
// Mode A run, TT_SEARCH's end-of-results → location.reload), which kills the
// content script. Only what persist() wrote and the resume path read back
// survives. These two functions ARE that contract, in one place, because when
// the two ends drifted the counters came back but the ledger didn't — so
// MAX_LIKES_PER_HOUR, MAX_LIKES_PER_AUTHOR and the per-author comment caps all
// silently reset to zero on every navigation, i.e. the caps stopped capping.
//
// Sets can't go through chrome.storage, hence the Array/Set conversion.
// ---------------------------------------------------------------------------
export const LEDGER_ARRAY_FIELDS = ["likeTimes", "commentTimes"];
export const LEDGER_MAP_FIELDS = ["authorLikes", "authorComments"];
export const LEDGER_SET_FIELDS = ["commentedIds", "capturedIds"];
export const LEDGER_COUNTER_FIELDS = [
  "consecLikes",
  "consecFollows",
  "consecComments",
  "softFailStreak",
];

export function serializeLedger(S) {
  const out = {};
  for (const k of LEDGER_ARRAY_FIELDS) out[k] = Array.isArray(S?.[k]) ? S[k] : [];
  for (const k of LEDGER_MAP_FIELDS) out[k] = S?.[k] || {};
  for (const k of LEDGER_SET_FIELDS) out[k] = Array.from(S?.[k] || []);
  for (const k of LEDGER_COUNTER_FIELDS) out[k] = S?.[k] || 0;
  out.lastPhrase = S?.lastPhrase ?? null;
  return out;
}

export function restoreLedger(saved) {
  const out = {};
  for (const k of LEDGER_ARRAY_FIELDS)
    out[k] = Array.isArray(saved?.[k]) ? saved[k] : [];
  for (const k of LEDGER_MAP_FIELDS)
    out[k] = saved?.[k] && typeof saved[k] === "object" ? saved[k] : {};
  for (const k of LEDGER_SET_FIELDS) out[k] = new Set(saved?.[k] || []);
  for (const k of LEDGER_COUNTER_FIELDS) out[k] = saved?.[k] || 0;
  out.lastPhrase = saved?.lastPhrase ?? null;
  return out;
}

// A persisted fbw_session that claims to be running but hasn't been persisted
// for staleMs is an abandoned run (browser/tab killed). A future breakUntil
// (+60s grace) means the engine is intentionally idle — not stale.
export function isStaleSession(saved, now = Date.now(), staleMs = 120000) {
  if (!saved?.isRunning || !saved.savedAt) return false;
  if (saved.breakUntil && saved.breakUntil + 60000 > now) return false;
  return now - saved.savedAt > staleMs;
}
