// fbcdn.js — pure helpers for Facebook video CDN (fbcdn) DASH track URLs.
//
// FB serves Watch/feed videos as DASH split streams: a video-only .mp4 track
// and a separate audio-only .mp4 track on *.fbcdn.net, fetched in byte ranges.
// The `efg` query param base64url-decodes to { vencode_tag, video_id, bitrate, ... }.
// `vencode_tag` containing "audio" marks the audio track.
//
// These run in the background SW (capture) and offscreen (selection). Pure, no DOM.

/** base64url → JSON object, or null. */
function decodeEfg(efg) {
  if (!efg) return null;
  try {
    let b64 = decodeURIComponent(efg).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Remove DASH byte-range params so the URL fetches the whole file. */
export function stripByteRange(url) {
  return url.replace(/&bytestart=\d+/g, "").replace(/&byteend=\d+/g, "");
}

/**
 * Parse an fbcdn media request URL into a track descriptor, or null if it
 * isn't a recognizable DASH media track.
 * @returns {{videoId:string, isAudio:boolean, bitrate:number, vencodeTag:string, url:string}|null}
 */
export function parseFbcdnTrack(url) {
  if (typeof url !== "string" || !/fbcdn\.net\/.*\.mp4/.test(url)) return null;
  let efg;
  try {
    efg = new URL(url).searchParams.get("efg");
  } catch {
    const m = url.match(/[?&]efg=([^&]+)/);
    efg = m ? m[1] : null;
  }
  const meta = decodeEfg(efg);
  if (!meta) return null;
  // FB usually stamps video_id, but some audio formats (e.g. dash_audio_aacp)
  // ship video_id:null and carry the id only in xpv_asset_id. Keep both ids so
  // the background can alias such an orphan to its sibling tracks' real video_id.
  const videoId = meta.video_id != null ? String(meta.video_id) : null;
  const xpvId = meta.xpv_asset_id != null ? String(meta.xpv_asset_id) : null;
  if (!videoId && !xpvId) return null;
  const vencodeTag = String(meta.vencode_tag || "");
  return {
    videoId,
    xpvId,
    isAudio: /audio/i.test(vencodeTag),
    bitrate: Number(meta.bitrate) || 0,
    durationS: Number(meta.duration_s) || 0,
    vencodeTag,
    url: stripByteRange(url),
  };
}

/**
 * Pick the registry record whose duration matches a DOM video's duration.
 * Feed surfaces (hashtag/home) bury the real video_id in page JSON only, so the
 * post markup can't name its video — but efg stamps duration_s on every track,
 * and durations disambiguate the handful of videos on screen. Recency alone is
 * NOT safe there: FB prefetches future posts' tracks while an earlier video
 * plays. Prefers a complete (audio+video) record, then the most recent.
 * @param {Iterable<object>} records registry values ({ videoId, durationS, audioUrl, videoUrl, lastSeen })
 * @param {number} durationHint seconds (DOM video.duration)
 * @param {number} [tolerance=2] max |durationS - hint| in seconds
 */
export function pickByDuration(records, durationHint, tolerance = 2, sinceTs = 0) {
  if (!Number.isFinite(durationHint) || durationHint <= 0) return null;
  let matches = [];
  for (const rec of records) {
    if (!rec || !rec.videoId || !rec.audioUrl || !rec.durationS) continue;
    if (Math.abs(rec.durationS - durationHint) > tolerance) continue;
    matches.push(rec);
  }
  const distinct = (list) => new Set(list.map((r) => r.videoId)).size;
  if (distinct(matches) > 1) {
    // Two DIFFERENT videos inside the tolerance window (spam feeds cluster
    // around the same lengths). If the caller just primed its video, only
    // tracks fetched during that window belong to it — filter by that. Still
    // ambiguous → null: no transcript beats a wrong transcript.
    if (!sinceTs) return null;
    matches = matches.filter((r) => (r.lastSeen || 0) >= sinceTs);
    if (distinct(matches) !== 1) return null;
  }
  let best = null;
  for (const rec of matches) {
    if (!best) {
      best = rec;
      continue;
    }
    const recComplete = !!(rec.audioUrl && rec.videoUrl);
    const bestComplete = !!(best.audioUrl && best.videoUrl);
    if (recComplete !== bestComplete) {
      if (recComplete) best = rec;
    } else if ((rec.lastSeen || 0) > (best.lastSeen || 0)) best = rec;
  }
  return best;
}

/**
 * Prime-window attribution: the tracks that hit the wire WHILE the caller was
 * playing its video are that video's tracks. This is the primary feed
 * resolution signal — efg's duration_s is unreliable (FB stamps preview-cut
 * durations on full videos), so duration only disambiguates among the fresh
 * records, never overrides them.
 * @param {Iterable<object>} recordsIter registry values
 * @param {number} sinceTs prime window start (ms epoch)
 * @param {number|null} durationHint seconds, used only to break fresh-set ties
 * @param {number} [tolerance=2]
 */
export function pickByWindow(recordsIter, sinceTs, durationHint, tolerance = 2) {
  const records = Array.from(recordsIter);
  if (!sinceTs) return pickByDuration(records, durationHint, tolerance);
  const valid = (r) => r && r.videoId && r.audioUrl;
  let fresh = records.filter((r) => valid(r) && (r.lastSeen || 0) >= sinceTs);
  const distinct = (list) => new Set(list.map((r) => r.videoId)).size;
  if (!fresh.length) {
    // Nothing new hit the wire (fully-buffered replay emits no fetches) →
    // strict duration match over everything, with its own ambiguity guard.
    return pickByDuration(records, durationHint, tolerance);
  }
  if (distinct(fresh) > 1 && Number.isFinite(durationHint) && durationHint > 0) {
    const narrowed = fresh.filter(
      (r) => r.durationS && Math.abs(r.durationS - durationHint) <= tolerance,
    );
    if (distinct(narrowed) === 1) fresh = narrowed;
  }
  if (distinct(fresh) !== 1) return null;
  let best = null;
  for (const rec of fresh) {
    if (!best) {
      best = rec;
      continue;
    }
    const recComplete = !!(rec.audioUrl && rec.videoUrl);
    const bestComplete = !!(best.audioUrl && best.videoUrl);
    if (recComplete !== bestComplete) {
      if (recComplete) best = rec;
    } else if ((rec.lastSeen || 0) > (best.lastSeen || 0)) best = rec;
  }
  return best;
}

/**
 * Fold a freshly-parsed track into an existing per-video record, keeping the
 * audio track and the highest-bitrate video track seen.
 * @param {object|undefined} prev existing { videoId, audioUrl, videoUrl, videoBitrate, lastSeen }
 * @param {ReturnType<typeof parseFbcdnTrack>} track
 * @param {number} now timestamp
 */
export function foldTrack(prev, track, now = Date.now()) {
  const rec = prev || {
    videoId: track.videoId,
    xpvId: track.xpvId || null,
    durationS: 0,
    audioUrl: null,
    videoUrl: null,
    videoBitrate: 0,
    lastSeen: 0,
  };
  // A later track may carry an id (or duration) the first one lacked — fill in.
  if (track.videoId && !rec.videoId) rec.videoId = track.videoId;
  if (track.xpvId && !rec.xpvId) rec.xpvId = track.xpvId;
  if (track.durationS && !rec.durationS) rec.durationS = track.durationS;
  if (track.isAudio) {
    rec.audioUrl = track.url;
  } else if (track.bitrate >= rec.videoBitrate) {
    rec.videoUrl = track.url;
    rec.videoBitrate = track.bitrate;
  }
  rec.lastSeen = now;
  return rec;
}
