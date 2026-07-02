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
