// Pure store and queue logic for the spy area in the Chrome extension.
// Manages local state, synchronization queue, due calculations, and day boundaries.

export const SPY_KEY = "fbw_spy";
export const SPY_QUEUE_KEY = "fbw_spy_queue";
export const SPY_STATE_KEY = "fbw_spy_state";
export const SPY_PREFS_KEY = "fbw_spy_prefs";

export function emptySpyQueue() {
  return {
    ops: [],
    profiles: {},
    snapshots: {},
    errors: {},
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
      if (elapsed < 6 * 3600 * 1000) {
        return false;
      }
    }

    return true;
  });
}

export function mergeList(cache, serverList, pendingOps = []) {
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

    if (localUpdatedAt > serverUpdatedAt) {
      // Local is newer
      if (pendingOp) {
        if (pendingOp.op === "save") {
          merged[id] = { ...sProfile, ...local, removedAt: null, listUpdatedAt: localUpdatedAt };
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
    } else if (local && local.removedAt == null) {
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
