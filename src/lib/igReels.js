// Pure, DOM-free helpers for the IG Stories tool (panel side). Unit-tested.
// Mirrors igMedia.js. Stories/highlights are captured PASSIVELY (the reel JSON
// Instagram already parses when you open a story or highlight) — these helpers
// only shape that captured data for the panel. No Instagram API calls here or
// anywhere in this feature.

import { sanitizeFilenamePart } from "./igMedia.js";

// A reel = one highlight or one live-story tray. Highlights carry a title;
// live stories don't → label them "Stories".
export function reelLabel(reel) {
  return (reel && reel.title) || "Stories";
}

// Owner handle for a reel, however the record carries it.
export function reelOwner(reel) {
  return (
    (reel && (reel.owner_username || (reel.owner && reel.owner.username))) ||
    "unknown"
  );
}

// Newest item timestamp in a reel (for ordering).
export function reelLatest(reel) {
  let max = 0;
  for (const it of (reel && reel.items) || []) {
    const t = it.taken_at || 0;
    if (t > max) max = t;
  }
  return max;
}

// Story timestamp → "YYYY-MM-DD HH:MM" (empty when missing). Stories are
// ephemeral and several can share a day, so include the time.
export function storyDate(item) {
  const t = item && item.taken_at;
  if (!t) return "";
  const d = new Date(t * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const iso = d.toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 16);
}

// Map a captured story item to the flat shape the card renders.
export function storyToCard(item) {
  const type = item.media_type || (item.video ? "video" : "photo");
  return {
    id: item.pk || item.id || "",
    type,
    thumb: item.thumb || item.image || null,
    hasVideo: type === "video" || !!item.video,
    isCarousel: type === "carousel",
    date: storyDate(item),
    duration: item.duration || null,
  };
}

// Download filename for a story media (indexed for carousel children).
export function storyFilename(item, ext, idx) {
  const owner = sanitizeFilenamePart(item.owner_username || item.username || "unknown");
  const base = `ig-story-${owner}-${item.pk || item.id || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

// Group reels by owner → [{ owner, reels:[...] }]; owners A→Z, each owner's
// reels newest first (by their latest item).
export function groupReels(reels) {
  const map = new Map();
  for (const reel of reels || []) {
    const owner = reelOwner(reel);
    if (!map.has(owner)) map.set(owner, []);
    map.get(owner).push(reel);
  }
  const out = [];
  for (const [owner, list] of map) {
    list.sort((a, b) => reelLatest(b) - reelLatest(a));
    out.push({ owner, reels: list });
  }
  out.sort((a, b) => a.owner.localeCompare(b.owner));
  return out;
}
