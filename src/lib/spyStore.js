// Pure store and queue logic for the spy area in the Chrome extension.
// Manages local state, synchronization queue, due calculations, and day boundaries.

export const SPY_KEY = "fbw_spy";
export const SPY_QUEUE_KEY = "fbw_spy_queue";
export const SPY_STATE_KEY = "fbw_spy_state";
export const SPY_PREFS_KEY = "fbw_spy_prefs";
// Automatic collection: a failed profile is retried after this long, at most
// twice a day. Instagram profile visits are capped per day.
export const SPY_RETRY_MS = 6 * 3600 * 1000;
export const IG_SPY_LIMIT = 20;
// The cap is the owner's to set in Options (fbw_spy_prefs.igLimit). Each reading
// is a full profile page load in a background tab; Instagram publishes no
// threshold, so the range stays bounded.
export const IG_SPY_LIMIT_MAX = 60;
export function igLimit(prefs) {
  const n = Math.round(Number(prefs?.igLimit));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, IG_SPY_LIMIT_MAX) : IG_SPY_LIMIT;
}

export function emptySpyQueue() {
  return {
    ops: [],
    profiles: {},
    snapshots: {},
    errors: {},
    reels: {},       // "<profileId>|<reelId>" -> Facebook reel
    reelsStatus: {}, // profileId -> first full reading state
    readings: {},    // "<profileId>|<at>|<kind>" -> collection attempt
    posts: {},       // "<profileId>|<postId>" -> Instagram post seen in the profile's grid
    thumbs: {},      // "<profileId>|<postId>" -> thumbnail of a top 3 post the hub asked for
  };
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function emptySpyState(now = Date.now()) {
  return {
    day: dayKey(now),
    attempts: {},
    blocked: {},
    igBatch: null,
    measuring: null,
    lastPassAt: null,
    lastError: null,
  };
}

function normalizeQueue(queue) {
  if (!queue || typeof queue !== "object") return emptySpyQueue();
  return {
    ops: Array.isArray(queue.ops) ? queue.ops : [],
    profiles: queue.profiles && typeof queue.profiles === "object" ? queue.profiles : {},
    snapshots: queue.snapshots && typeof queue.snapshots === "object" ? queue.snapshots : {},
    errors: queue.errors && typeof queue.errors === "object" ? queue.errors : {},
    reels: queue.reels && typeof queue.reels === "object" ? queue.reels : {},
    reelsStatus: queue.reelsStatus && typeof queue.reelsStatus === "object" ? queue.reelsStatus : {},
    readings: queue.readings && typeof queue.readings === "object" ? queue.readings : {},
    posts: queue.posts && typeof queue.posts === "object" ? queue.posts : {},
    thumbs: queue.thumbs && typeof queue.thumbs === "object" ? queue.thumbs : {},
  };
}

export function queueOp(queue, opOrType, maybePayload, maybeAt) {
  const q = normalizeQueue(queue);
  let opObj;
  if (typeof opOrType === "object" && opOrType !== null) {
    opObj = { ...opOrType };
  } else {
    const payload = typeof maybePayload === "object" && maybePayload !== null ? maybePayload : {};
    opObj = { op: opOrType, ...payload, at: maybeAt ?? Date.now() };
  }
  return {
    ...q,
    ops: [...q.ops, opObj],
  };
}

export function queueSnapshot(queue, snap) {
  const q = normalizeQueue(queue);
  if (!snap) return q;
  const pid = snap.profileId || snap.profile_id || snap.id;
  const day = snap.day;
  if (!pid || !day) return q;

  const key = `${pid}|${day}`;
  const prev = q.snapshots[key];

  let next;
  if (!prev) {
    next = { ...snap };
  } else {
    const snapAt = snap.measuredAt ?? snap.measured_at ?? 0;
    const prevAt = prev.measuredAt ?? prev.measured_at ?? 0;

    if (snapAt >= prevAt) {
      next = {
        ...prev,
        ...snap,
        followers: snap.followers != null ? snap.followers : prev.followers,
        followersApprox:
          snap.followers != null
            ? (snap.followersApprox ?? snap.followers_approx ?? false)
            : prev.followersApprox,
        following: snap.following != null ? snap.following : prev.following,
        posts: snap.posts != null ? snap.posts : prev.posts,
        hasStory:
          snap.hasStory !== undefined && snap.hasStory !== null ? snap.hasStory : prev.hasStory,
      };
    } else {
      next = {
        ...snap,
        ...prev,
        followers: prev.followers != null ? prev.followers : snap.followers,
        followersApprox:
          prev.followers != null
            ? (prev.followersApprox ?? prev.followers_approx ?? false)
            : snap.followersApprox,
        following: prev.following != null ? prev.following : snap.following,
        posts: prev.posts != null ? prev.posts : snap.posts,
        hasStory:
          prev.hasStory !== undefined && prev.hasStory !== null ? prev.hasStory : snap.hasStory,
      };
    }
  }

  return {
    ...q,
    snapshots: {
      ...q.snapshots,
      [key]: next,
    },
  };
}

export function queueProfile(queue, patch) {
  const q = normalizeQueue(queue);
  if (!patch) return q;
  const id = patch.id || (patch.platform && patch.key ? `${patch.platform}:${patch.key}` : null);
  if (!id) return q;
  const prev = q.profiles[id] || {};
  return {
    ...q,
    profiles: {
      ...q.profiles,
      [id]: {
        ...prev,
        ...patch,
        id,
      },
    },
  };
}

export function queueError(queue, idOrObj, maybeErr, maybeAt) {
  const q = normalizeQueue(queue);
  let id;
  let errObj;
  if (typeof idOrObj === "object" && idOrObj !== null) {
    id = idOrObj.id;
    errObj = { ...idOrObj, at: idOrObj.at ?? Date.now() };
  } else {
    id = idOrObj;
    errObj = { id, error: maybeErr, at: maybeAt ?? Date.now() };
  }
  if (!id) return q;
  return {
    ...q,
    errors: {
      ...q.errors,
      [id]: errObj,
    },
  };
}

export function isBlocked(state, platform, now = Date.now()) {
  const until = state?.blocked?.[platform];
  if (typeof until !== "number") return false;
  return now < until;
}

export function dueProfiles(list, state, now = Date.now()) {
  const profiles = Array.isArray(list)
    ? list
    : list?.profiles
      ? Object.values(list.profiles)
      : Object.values(list || {});

  const today = dayKey(now);
  const stateDay = state?.day;
  const isSameDay = stateDay === today;

  return profiles.filter((p) => {
    if (!p) return false;
    if (p.removedAt != null) return false;

    // 1. lastMeasuredAt does not fall on today
    if (p.lastMeasuredAt != null && dayKey(p.lastMeasuredAt) === today) {
      return false;
    }

    // 2. Platform is not blocked
    if (isBlocked(state, p.platform, now)) {
      return false;
    }

    // 3 & 4. Attempts logic
    const attempt = isSameDay ? state?.attempts?.[p.id] : null;
    const count = typeof attempt === "number" ? attempt : (attempt?.n ?? 0);
    if (count >= 2) {
      return false;
    }
    const attemptAt = typeof attempt === "object" ? (attempt?.at || 0) : 0;
    if (count > 0 && attemptAt > 0) {
      const elapsed = now - attemptAt;
      if (elapsed < SPY_RETRY_MS) {
        return false;
      }
    }

    return true;
  });
}

// `settled`: ids whose list ops the server has just answered. For those the
// server reply is final (a rejected save must not linger); every other local
// profile keeps the ordinary merge, so a hub that does not know the list (reset
// or restored database, new URL) cannot wipe it.
export function mergeList(cache, serverList, pendingOps = [], { settled = new Set() } = {}) {
  const rawCacheProfiles = cache?.profiles || cache || {};
  const sList = Array.isArray(serverList) ? serverList : (serverList?.profiles || []);

  const merged = {};

  const serverById = new Map();
  let maxServerAt = 0;
  for (const item of sList) {
    if (item && item.id) {
      serverById.set(item.id, item);
      if ((item.listUpdatedAt || 0) > maxServerAt) {
        maxServerAt = item.listUpdatedAt;
      }
    }
  }

  const opsById = new Map();
  for (const op of pendingOps || []) {
    const id = op.id || (op.platform && op.key ? `${op.platform}:${op.key}` : null);
    if (id) {
      const prev = opsById.get(id);
      if (!prev || (op.at || 0) >= (prev.at || 0)) {
        opsById.set(id, op);
      }
    }
  }

  // 1. Process items from server
  for (const [id, sProfile] of serverById.entries()) {
    const local = rawCacheProfiles[id];
    const pendingOp = opsById.get(id);

    const localUpdatedAt = Math.max(local?.listUpdatedAt || 0, pendingOp?.at || 0);
    const serverUpdatedAt = sProfile.listUpdatedAt || 0;

    if (localUpdatedAt > serverUpdatedAt && (!settled.has(id) || pendingOp)) {
      // Local is newer
      if (pendingOp) {
        if (pendingOp.op === "save") {
          merged[id] = {
            ...sProfile,
            ...local,
            removedAt: null,
            listUpdatedAt: localUpdatedAt,
            lastMeasuredAt: local?.lastMeasuredAt ?? null,
            hasAvatar: local?.hasAvatar ?? false,
          };
        } else if (pendingOp.op === "remove") {
          delete merged[id];
        }
      } else if (local && local.removedAt == null) {
        merged[id] = { ...sProfile, ...local };
      }
    } else {
      // Server is newer or equal
      if (sProfile.removedAt == null) {
        merged[id] = {
          ...local,
          ...sProfile,
        };
      }
    }
  }

  // 2. Process local items not in server list
  for (const [id, local] of Object.entries(rawCacheProfiles)) {
    if (serverById.has(id)) continue;
    const pendingOp = opsById.get(id);

    if (pendingOp) {
      if (pendingOp.op === "save") {
        merged[id] = {
          ...local,
          removedAt: null,
          listUpdatedAt: Math.max(local?.listUpdatedAt || 0, pendingOp.at || 0),
        };
      }
    } else if (!settled.has(id) && local && local.removedAt == null) {
      if ((local.listUpdatedAt || 0) > maxServerAt || sList.length === 0) {
        merged[id] = local;
      }
    }
  }

  return {
    profiles: merged,
    fetchedAt: Date.now(),
  };
}

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Facebook reels read for a profile; the hub stores each one once. */
export function queueReels(queue, profileId, reels) {
  const q = normalizeQueue(queue);
  const next = { ...q.reels };
  for (const r of reels || []) {
    if (!profileId || !/^\d{6,}$/.test(r?.id || "")) continue;
    next[`${profileId}|${r.id}`] = {
      profileId, id: r.id, createdAt: finite(r.createdAt), duration: finite(r.duration), views: finite(r.views),
    };
  }
  return { ...q, reels: next };
}

/** Instagram posts from a saved profile's grid, with their publication time (s),
 *  for posts per day. A collab sits in each co-author's grid and counts for each. */
export function queuePosts(queue, profileId, posts) {
  const q = normalizeQueue(queue);
  const next = { ...q.posts };
  for (const p of posts || []) {
    if (!profileId || !/^\d{3,30}$/.test(p?.id || "") || !Number.isInteger(p.createdAt)) continue;
    const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    next[`${profileId}|${p.id}`] = {
      profileId, id: p.id, createdAt: p.createdAt,
      mediaType: typeof p.mediaType === "string" ? p.mediaType : null, pinned: p.pinned === true,
      code: typeof p.code === "string" && /^[\w-]{5,40}$/.test(p.code) ? p.code : null,
      views: count(p.views), likes: count(p.likes), comments: count(p.comments),
      exactDate: p.exactDate !== false,
    };
  }
  return { ...q, posts: next };
}

/** A top 3 post's thumbnail (small data: URL) for the hub to keep. */
export function queueThumb(queue, profileId, id, thumb) {
  const q = normalizeQueue(queue);
  if (!profileId || !id || typeof thumb !== "string" || !thumb.startsWith("data:image/")) return q;
  return { ...q, thumbs: { ...q.thumbs, [`${profileId}|${id}`]: { profileId, id, thumb } } };
}

// Image addresses of recent posts and reels, kept a few days: the hub names its
// top 3 after the upload that brought their numbers, and the networks' image
// links are signed and expire, so the thumbnail is made from a recent address.
export const SPY_THUMB_URLS_KEY = "fbw_spy_thumb_urls";
const THUMB_URLS_CAP = 500;
const THUMB_URL_TTL_MS = 3 * 86400000;
export function rememberThumbUrls(cache, profileId, items, now = Date.now()) {
  const next = { ...(cache && typeof cache === "object" ? cache : {}) };
  for (const item of items || []) {
    if (!profileId || !item?.id || typeof item.thumbUrl !== "string" || !/^https:\/\//.test(item.thumbUrl)) continue;
    delete next[`${profileId}|${item.id}`]; // re-insert: newest last
    next[`${profileId}|${item.id}`] = { url: item.thumbUrl, at: now };
  }
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - THUMB_URLS_CAP))) delete next[key];
  return next;
}
/** The thumbnails the hub asked for (profile.wantThumbs) whose address is still fresh. */
export function thumbsToFetch(cache, profiles, now = Date.now()) {
  const out = [];
  for (const p of profiles || []) {
    for (const id of Array.isArray(p?.wantThumbs) ? p.wantThumbs : []) {
      const hit = cache?.[`${p.id}|${id}`];
      if (hit && now - hit.at < THUMB_URL_TTL_MS) out.push({ profileId: p.id, id, url: hit.url });
    }
  }
  return out;
}

/** State of a profile's first full reels reading: pending -> running -> done. */
export function queueReelsStatus(queue, profileId, status, at = Date.now()) {
  const q = normalizeQueue(queue);
  if (!profileId) return q;
  return { ...q, reelsStatus: { ...q.reelsStatus, [profileId]: { profileId, status, at } } };
}

const READINGS_CAP = 400;

/** One collection attempt for the hub's readings history; only the newest are kept. */
export function queueReading(queue, reading) {
  const q = normalizeQueue(queue);
  if (!reading?.profileId || !Number.isFinite(reading.at)) return q;
  const readings = { ...q.readings, [`${reading.profileId}|${reading.at}|${reading.kind}`]: reading };
  const keys = Object.keys(readings);
  if (keys.length > READINGS_CAP) {
    keys.sort((a, b) => readings[a].at - readings[b].at);
    for (const key of keys.slice(0, keys.length - READINGS_CAP)) delete readings[key];
  }
  return { ...q, readings };
}
