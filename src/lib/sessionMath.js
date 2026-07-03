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

// A persisted fbw_session that claims to be running but hasn't been persisted
// for staleMs is an abandoned run (browser/tab killed). A future breakUntil
// (+60s grace) means the engine is intentionally idle — not stale.
export function isStaleSession(saved, now = Date.now(), staleMs = 120000) {
  if (!saved?.isRunning || !saved.savedAt) return false;
  if (saved.breakUntil && saved.breakUntil + 60000 > now) return false;
  return now - saved.savedAt > staleMs;
}
