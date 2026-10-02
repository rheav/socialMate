import { parseCount } from "./counts.js";

export function fbTileCount(anchor) {
  const clone = anchor.cloneNode(true);
  clone.querySelectorAll('.sw-fbr, .fbw-acts, button').forEach(e => e.remove());
  return parseCount(clone.textContent.trim());
}

export function fbPlayerMatches(record, video, routeId) {
  return !!record && record.id === routeId && !!video &&
    Number.isFinite(video.duration) && video.duration > 0 &&
    (!record.duration || Math.abs(record.duration - video.duration) < 1.5);
}
