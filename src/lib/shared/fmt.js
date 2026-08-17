// Two formatters every platform needs: a date and an engagement rate. INLINED
// into content scripts — see ./README.md before editing (no imports allowed).
//
// These lived in igFormat.js and were hand-copied into ttMedia.js. Same numbers,
// two implementations, and only one of them was tested — exactly the drift this
// directory exists to stop. (Count formatting is next door, in counts.js.)

/** Unix SECONDS → "YYYY-MM-DD" (empty string when missing/invalid). */
export function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// Engagement-rate label. Never collapses to "0.0%": 1 decimal ≥10, 2 decimals
// ≥0.1, else 2 significant figures (e.g. "0.06%", "0.004%").
export function fmtER(er) {
  if (er == null) return null;
  if (er === 0) return "0%";
  if (er >= 10) return er.toFixed(1) + "%";
  if (er >= 0.1) return er.toFixed(2) + "%";
  return Number(er.toPrecision(2)) + "%";
}
