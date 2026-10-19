// Stories of the tracked Instagram profiles, for the hub's swipe file. Pure
// helpers: reading the stories page's JSON, reducing an item to what the hub
// stores, the passes' slots, and the queue kind. The service worker side
// (fetching, pacing, sending) is background/spyStories.js.
//
// What was measured (hub spec §2, 2026-10-19): `GET /stories/<username>/` with
// the session's cookies carries the whole reel inside a
// `<script type="application/json">` blob, under
// `…result.data.xdt_api__v1__feed__reels_media.reels_media[0]`, before any
// click; only "Ver story" marks the story as seen. The CDN URLs expire in
// about 1.5 days (video) and 4 days (image).
//
// Design: ~/Code/apps/socialmate-hub/docs/superpowers/specs/2026-10-19-stories-swipe-file-design.md

const REELS_KEY = "xdt_api__v1__feed__reels_media";
const SCRIPT_RE = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

function findKey(root, key, depth = 0) {
  if (!root || typeof root !== "object" || depth > 40) return undefined;
  if (Object.prototype.hasOwnProperty.call(root, key)) return root[key];
  for (const value of Array.isArray(root) ? root : Object.values(root)) {
    const found = findKey(value, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function reelShape(reel) {
  if (!reel || typeof reel !== "object") return null;
  const items = Array.isArray(reel.items) ? reel.items.filter((i) => i && typeof i === "object") : [];
  return { reelId: reel.id != null ? String(reel.id) : null, username: reel.user?.username ?? null, items };
}

/**
 * The reel inside the stories page: null when the page carries no reel data at
 * all (the page changed, or it is a login wall); an empty `items` when the
 * account has no story right now.
 */
export function parseStoriesHtml(html) {
  if (typeof html !== "string") return null;
  for (const match of html.matchAll(SCRIPT_RE)) {
    const text = match[1];
    if (!text.includes(REELS_KEY)) continue;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const block = findKey(json, REELS_KEY);
    if (!block || typeof block !== "object") continue;
    const list = Array.isArray(block.reels_media) ? block.reels_media : [];
    if (!list.length) return { reelId: null, username: null, items: [] };
    return reelShape(list[0]);
  }
  return null;
}

/** The `/api/v1/feed/reels_media/?reel_ids=<userId>` answer, by id or as a list. */
export function parseReelsMediaJson(json, userId) {
  if (!json || typeof json !== "object") return null;
  const byId = json.reels && typeof json.reels === "object" ? json.reels[String(userId)] : null;
  const raw = byId ?? (Array.isArray(json.reels_media) ? json.reels_media[0] : null);
  return raw ? reelShape(raw) : null;
}

/** `l.instagram.com/?u=<destination>` → the destination, without the `fbclid`; other links as they are. */
export function unwrapInstagramLink(url) {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url);
    if (!/(^|\.)instagram\.com$/.test(u.hostname) || !u.searchParams.get("u")) return url;
    const dest = new URL(u.searchParams.get("u"));
    dest.searchParams.delete("fbclid");
    return dest.toString();
  } catch {
    return url;
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const biggest = (list) => (Array.isArray(list) ? list.filter((c) => c && typeof c.url === "string")
  .sort((a, b) => (b.width || 0) - (a.width || 0))[0] ?? null : null);

/**
 * One story item → `input` (what the hub stores, times in ms), its `cover`
 * (the still) and its `media` (the file to download: the video, or the cover
 * for a photo). Null when the item lacks the essentials.
 */
export function reduceStory(item, reelId) {
  if (!item || typeof item !== "object") return null;
  const pk = item.pk != null ? String(item.pk) : "";
  const takenAt = num(item.taken_at);
  const expiringAt = num(item.expiring_at);
  const mediaType = item.media_type === 2 ? 2 : item.media_type === 1 ? 1 : null;
  if (!/^\d{1,30}$/.test(pk) || takenAt == null || expiringAt == null || mediaType == null) return null;

  const cover = biggest(item.image_versions2?.candidates)?.url ?? null;
  const video = mediaType === 2 ? biggest(item.video_versions) : null;
  const media = video ? { url: video.url, mime: "video/mp4" } : cover ? { url: cover, mime: "image/jpeg" } : null;

  const links = [];
  for (const sticker of Array.isArray(item.story_link_stickers) ? item.story_link_stickers : []) {
    const url = unwrapInstagramLink(sticker?.story_link?.url);
    if (!/^https?:\/\//.test(url)) continue;
    let text = typeof sticker?.story_link?.link_title === "string" ? sticker.story_link.link_title : "";
    try {
      text = new URL(url).hostname;
    } catch {
      /* keep the sticker's title */
    }
    links.push(text ? { url, text } : { url });
  }
  const musicInfo = Array.isArray(item.story_music_stickers) ? item.story_music_stickers[0]?.music_asset_info : null;
  const music = musicInfo && typeof musicInfo.title === "string"
    ? { title: musicInfo.title, ...(typeof musicInfo.display_artist === "string" ? { artist: musicInfo.display_artist } : {}) }
    : null;
  const mentions = (Array.isArray(item.reel_mentions) ? item.reel_mentions : [])
    .map((m) => m?.user?.username).filter((u) => typeof u === "string" && u);
  const duration = num(item.video_duration);

  return {
    input: {
      id: pk,
      reelId: reelId != null ? String(reelId) : null,
      mediaType,
      takenAt: takenAt * 1000,
      expiringAt: expiringAt * 1000,
      durationMs: duration != null ? Math.round(duration * 1000) : null,
      width: num(item.original_width),
      height: num(item.original_height),
      caption: typeof item.caption?.text === "string" ? item.caption.text : null,
      links,
      music,
      mentions,
      aiLabel: !!item.ai_label_info,
      mediaMime: media?.mime ?? (mediaType === 2 ? "video/mp4" : "image/jpeg"),
    },
    cover,
    media,
  };
}

// ---- passes by slot ----

const DAY_MS = 86_400_000;
const localDayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const localMidnight = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** The local day split in `passesPerDay` equal slots: the one `now` falls in. */
export function storySlots(passesPerDay, now) {
  const n = Math.max(1, Math.min(4, Math.round(passesPerDay) || 1));
  const start = localMidnight(now);
  const length = DAY_MS / n;
  const index = Math.min(n - 1, Math.floor((now - start) / length));
  return { index, startsAt: start + index * length, endsAt: start + (index + 1) * length };
}

/** 10–90 min, like the daily measurement's spread. */
export function slotJitterMs(random = Math.random) {
  return (10 + Math.floor(random() * 80)) * 60_000;
}

export function emptyStoriesState() {
  return { job: null, daily: { day: "", passes: [] }, pendingMedia: [], jitter: {} };
}

/**
 * The slot to run now, or null: the current slot, not yet run today, once its
 * start plus a jitter (drawn once per slot and kept in `state.jitter`) has
 * passed. A slot whose window closed is never run late.
 */
export function passDue(state, passesPerDay, now, random = Math.random) {
  const slot = storySlots(passesPerDay, now);
  const day = localDayKey(now);
  const key = `${day}:${slot.index}`;
  if (!state.jitter || typeof state.jitter !== "object") state.jitter = {};
  if (!Number.isFinite(state.jitter[key])) {
    // Yesterday's draws are not needed any more.
    for (const k of Object.keys(state.jitter)) if (!k.startsWith(`${day}:`)) delete state.jitter[k];
    state.jitter[key] = slotJitterMs(random);
  }
  const at = slot.startsAt + state.jitter[key];
  if (now < at) return null;
  const ran = state.daily?.day === day && (state.daily.passes || []).some((p) => p.slot === slot.index);
  return ran ? null : { index: slot.index, at };
}

/** The `stories` kind of the Spy's queue: one entry per story id. */
export function queueStory(queue, profileId, input) {
  if (!profileId || !input?.id) return queue;
  return { ...queue, stories: { ...(queue.stories || {}), [input.id]: { profileId, ...input } } };
}
