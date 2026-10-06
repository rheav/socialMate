// Formatters every platform needs: a date, an engagement rate and the view
// velocity. INLINED into content scripts — see ./README.md before editing (no
// imports allowed beyond a sibling: fmtCount comes from ./counts.js, which every
// target inlines first).
import { fmtCount } from "./counts.js";
//
// These lived in igFormat.js and were hand-copied into ttMedia.js. Same numbers,
// two implementations, and only one of them was tested — exactly the drift this
// directory exists to stop. (Count formatting is next door, in counts.js.)

/** Unix SECONDS → "YYYY-MM-DD" in the viewer's time zone (empty string when
 *  missing/invalid). Local, like the hub's posts per day: a post at 23:56 in São
 *  Paulo is that day, not the next one in UTC. */
export function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

// ---- velocity -------------------------------------------------------------
// Views per day since the post went up. Unlike reach (views ÷ followers) it needs
// nothing but the post itself, so it exists on EVERY video — including hashtag
// and search results, where Instagram ships no follower count at all (measured
// on #soulmate, 2026-09-26: 0 of 28 posts). It answers "what is running right
// now": 1.2M views in 3 days (400K/dia) beats 6M in two years (8.2K/dia).
//
// A post younger than a day counts as one day: dividing by 2 hours would turn a
// fresh reel's first views into an absurd daily rate.

/** Views per day since `postedAt` (unix seconds or ms), or null when either is missing. */
export function viewsPerDay(views, postedAt, nowSec = Math.floor(Date.now() / 1000)) {
  if (views == null || !Number.isFinite(views) || !postedAt) return null;
  const posted = postedAt > 1e11 ? postedAt / 1000 : postedAt;
  const days = Math.max((nowSec - posted) / 86400, 1);
  return views / days;
}

/** "400K/dia" — the rate in the rail's own count style. */
export function fmtVelocity(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return `${fmtCount(Math.round(v))}/dia`;
}

