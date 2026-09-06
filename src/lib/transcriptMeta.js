// The second line of a Library transcript card: what we know about the POST,
// under the engagement counts that describe its performance.
//
// Everything here comes from data the capture already had in hand — no extra
// request anywhere. Instagram's on-page rail has been rendering `taken_at`,
// `video_duration`, `media_repost_count` and the joined `follower_count` for a
// while; `ovlTranscribe` simply never forwarded them. Facebook's is thinner on
// purpose: the embedded JSON block we already walk for `playable_duration_in_ms`
// carries the duration and a permalink and nothing else — verified live on a reel
// (owner is `{__typename, id}`, and there is no creation_time, view count or
// follower count anywhere in it, nor a date in the DOM). So a Facebook line shows
// a duration and stops, rather than inventing precision we do not have.

import { fmtCount, fmtDate, dateFromPk } from "./igMedia.js";
import { fmtRatio } from "./ttMedia.js";

/** Seconds → `m:ss`. Empty string for anything that is not a finite number. */
export function fmtClock(s) {
  if (typeof s !== "number" || !Number.isFinite(s)) return "";
  const x = Math.max(0, Math.floor(s));
  return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * When the post itself was published.
 *
 * `takenAt` is the captured truth. The fallback decodes Instagram's numeric pk,
 * which encodes its own creation time — but ONLY for Instagram: Facebook ids are
 * numeric too and mean nothing to that decoder, so it would print a confident,
 * wrong date.
 */
function postDate(rec) {
  const d = fmtDate(num(rec.takenAt));
  if (d) return d;
  return rec.platform === "instagram" ? dateFromPk(rec.videoId) : "";
}

/**
 * The chips for one card's metadata line, in reading order, skipping everything
 * we do not actually know. Returns `[]` when the record has nothing to add —
 * the caller renders no line at all rather than an empty strip.
 *
 * Each chip is `{ key, icon, text, title }`: `icon` is an emoji, matching the
 * counts strip above it, and `title` is the tooltip that says what the number is.
 */
export function transcriptMetaChips(rec) {
  if (!rec || typeof rec !== "object") return [];
  const out = [];

  const date = postDate(rec);
  if (date) out.push({ key: "date", icon: "📅", text: date, title: "Data da publicação" });

  const dur = num(rec.durationS);
  if (dur != null && dur > 0)
    out.push({ key: "duration", icon: "⏱", text: fmtClock(dur), title: "Duração do vídeo" });

  const followers = num(rec.followers);
  if (followers != null && followers > 0)
    out.push({ key: "followers", icon: "👤", text: fmtCount(followers), title: "Seguidores do autor" });

  // Reach: how far past its own audience the post travelled. Both halves must be
  // real numbers — records written before schema 2 store counts as pre-formatted
  // strings ("101,2 mil"), which divide into NaN.
  const views = num(rec.counts && rec.counts.views);
  if (followers != null && followers > 0 && views != null)
    out.push({
      key: "reach",
      icon: "📈",
      text: fmtRatio(views / followers),
      title: "Alcance: visualizações ÷ seguidores",
    });

  return out;
}
