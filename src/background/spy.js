// The spy area's half of the service worker: measuring saved Instagram and
// Facebook profiles, the Instagram batch tab, the Facebook reels job, and the
// upload queue to the hub. Moved out of background.js unchanged; background.js
// keeps the message router and the alarm listener and calls in through the
// exports below.
//
// Two helpers stay in background.js because the archive uses them too; they
// arrive through useSpyDeps(), at the top of the worker, before any listener
// can fire.

import { batchRecords, backoffDelay, getSpyProfiles, isRetryable, isSyncConfigured, postSpy } from "../lib/syncClient.js";
import { parseProfileUrl, profileUrl, reelsUrl, spyId } from "../lib/spyProfile.js";
import { parseFbProfileHtml, parseFbReelsHtml, parseIgProfile } from "../lib/spyParse.js";
import {
  SPY_KEY,
  SPY_PREFS_KEY,
  SPY_QUEUE_KEY,
  SPY_RETRY_MS,
  SPY_STATE_KEY,
  SPY_THUMB_URLS_KEY,
  dayKey,
  dueProfiles,
  emptySpyQueue,
  emptySpyState,
  igLimit,
  isBlocked,
  mergeList,
  queueError,
  queuePosts,
  queueProfile,
  queueReading,
  queueReels,
  queueReelsStatus,
  queueSnapshot,
  queueThumb,
  rememberThumbUrls,
  thumbsToFetch,
} from "../lib/spyStore.js";
import { SPY_ACTIVITY_KEY, SPY_HUB_KEY, appendActivity, clockText, countText, errorText, profileName } from "../lib/spyActivity.js";
import { hubErrorText } from "../lib/spyStatus.js";

const deps = {
  /** background.durableThumb: a remote image as a small data: URL, or null. */
  durableThumb: async () => null,
  /** background.readSyncSettings: { enabled, url, token } from chrome.storage. */
  readSyncSettings: async () => ({ enabled: false, url: "", token: "" }),
};

/** Wires in the two helpers background.js owns. */
export function useSpyDeps(next) {
  Object.assign(deps, next);
}

// ============================================================================
// SPY AREA — PROFILE MEASUREMENT & HUB SYNC
// ============================================================================

const SPY_DEBOUNCE_MS = 4000;
let spyFlushTimer = null;
let spyFlushing = false;
let spyTicking = false;
// All spy writers share this short storage critical section. Network requests
// stay outside it; removing a profile cannot race a capture or an upload ACK.
let spyMutation = Promise.resolve();
export function mutateSpy(work) {
  const next = spyMutation.then(work, work);
  spyMutation = next.catch(() => {});
  return next;
}

// The panel's activity log (lib/spyActivity.js). Its own short write chain, so a
// log line never waits on the spy state's critical section and can be written
// from anywhere, inside a mutateSpy callback included.
let activityWrite = Promise.resolve();
function logSpy(platform, tone, text) {
  const entry = { at: Date.now(), platform, tone, text };
  activityWrite = activityWrite.then(async () => {
    const r = await chrome.storage.local.get(SPY_ACTIVITY_KEY);
    await chrome.storage.local.set({ [SPY_ACTIVITY_KEY]: appendActivity(r[SPY_ACTIVITY_KEY], entry) });
  }).catch(() => {});
  return activityWrite;
}
const platformOf = (id) => String(id || "").split(":")[0] || null;

// ---- Top 3 thumbnails ----
// Readings remember each post's image address for a few days; the hub answers
// every upload with its top 3 still lacking a thumbnail (wantThumbs), and those
// are made here from a fresh address. A failed one is not retried for 6 h.
let thumbUrlWrite = Promise.resolve();
function rememberThumbs(profileId, items) {
  if (!items?.some((i) => i?.thumbUrl)) return thumbUrlWrite;
  thumbUrlWrite = thumbUrlWrite.then(async () => {
    const r = await chrome.storage.local.get(SPY_THUMB_URLS_KEY);
    await chrome.storage.local.set({ [SPY_THUMB_URLS_KEY]: rememberThumbUrls(r[SPY_THUMB_URLS_KEY], profileId, items) });
  }).catch(() => {});
  return thumbUrlWrite;
}
const thumbTried = new Map(); // "<profileId>|<id>" -> ms
export async function fetchWantedThumbs(profiles, makeThumb = (url) => deps.durableThumb(url)) {
  await thumbUrlWrite;
  const r = await chrome.storage.local.get(SPY_THUMB_URLS_KEY);
  const now = Date.now();
  const jobs = thumbsToFetch(r[SPY_THUMB_URLS_KEY], profiles, now)
    .filter((j) => now - (thumbTried.get(`${j.profileId}|${j.id}`) || 0) > 6 * 3600000).slice(0, 12);
  let made = 0;
  for (const job of jobs) {
    thumbTried.set(`${job.profileId}|${job.id}`, now);
    const thumb = await makeThumb(job.url);
    if (typeof thumb !== "string" || !thumb.startsWith("data:image/")) continue;
    await mutateSpy(async () => {
      const q = await chrome.storage.local.get(SPY_QUEUE_KEY);
      await chrome.storage.local.set({ [SPY_QUEUE_KEY]: queueThumb(q[SPY_QUEUE_KEY], job.profileId, job.id, thumb) });
    });
    made += 1;
  }
  if (made) scheduleFlushSpy();
  return made;
}
// Instagram lines always use the @handle, the same one the batch lines show.
const nameOf = (spy, id) => (platformOf(id) === "instagram" ? `@${String(id).split(":")[1]}`
  : profileName(spy?.profiles?.[id] || { key: String(id || "").split(":")[1] }));
// Only the first failure of a streak and the recovery are logged; every retry is not.
async function recordHubResult(result) {
  const r = await chrome.storage.local.get(SPY_HUB_KEY);
  const before = r[SPY_HUB_KEY];
  await chrome.storage.local.set({ [SPY_HUB_KEY]: { ...result, at: Date.now() } });
  if (!result.ok && before?.ok !== false) {
    await logSpy("hub", "error", `Envio ao hub falhou (${hubErrorText(result)}) · os registros ficam guardados e o envio é tentado de novo`);
  } else if (result.ok && before?.ok === false) {
    await logSpy("hub", "ok", `Envio ao hub voltou a funcionar · ${result.sent} ${result.sent === 1 ? "registro enviado" : "registros enviados"}`);
  }
}

function spyQueuePending(queue) {
  return !!(queue?.ops?.length || ["profiles", "snapshots", "errors", "reels", "reelsStatus", "readings", "posts", "thumbs"]
    .some((kind) => Object.keys(queue?.[kind] || {}).length));
}

export async function recoverSpySync() {
  // One independent, persisted wakeup survives MV3 suspension and browser
  // startup. Daily collection preferences never disable pending user changes.
  const settings = await deps.readSyncSettings();
  const r = await chrome.storage.local.get(SPY_QUEUE_KEY);
  if (isSyncConfigured(settings) && spyQueuePending(r[SPY_QUEUE_KEY])) {
    scheduleFlushSpy();
  } else {
    if (spyFlushTimer) clearTimeout(spyFlushTimer);
    spyFlushTimer = null;
    await chrome.alarms?.clear?.("fbw-spy-sync");
  }
}

function scheduleFlushSpy(delay = SPY_DEBOUNCE_MS, attempt = 0) {
  chrome.alarms?.create?.("fbw-spy-sync", { when: Date.now() + Math.max(60000, delay) });
  if (spyFlushTimer) clearTimeout(spyFlushTimer);
  spyFlushTimer = setTimeout(() => {
    spyFlushTimer = null;
    flushSpy({ attempt }).catch(() => {});
  }, delay);
}

// Work queued by "Medir agora" that still has to run.
function manualPending(state) {
  return !!(state?.fbManual?.length || state?.igBatch?.manualAt);
}
async function armSpyTickSoon() {
  // Every capture rewrites the list and lands in scheduleSpy again (every 20–40 s
  // in an Instagram batch); recreating the alarm each time would postpone it forever.
  const pending = await chrome.alarms.get?.("fbw-spy-tick");
  if (!pending || pending.scheduledTime > Date.now() + 60000) chrome.alarms.create("fbw-spy-tick", { delayInMinutes: 1 });
}

export async function scheduleSpy() {
  if (!chrome.alarms?.create) return;
  try {
    const settings = await deps.readSyncSettings();
    const r = await chrome.storage.local.get([SPY_PREFS_KEY, SPY_KEY, SPY_STATE_KEY]);
    const prefs = r[SPY_PREFS_KEY] ?? { daily: true };
    const spy = r[SPY_KEY] || { profiles: {} };
    const state = r[SPY_STATE_KEY] || emptySpyState();

    const isConfigured = isSyncConfigured(settings);
    const dailyOn = prefs.daily !== false;

    if (!isConfigured || (!dailyOn && !manualPending(state))) {
      await chrome.alarms.clear("fbw-spy-tick");
      serializeIg(() => closeIgBatch({ why: !isConfigured ? "acervo não configurado" : "medição desligada em Opções" })).catch(() => {});
      return;
    }
    // Daily pass off: only what "Medir agora" queued keeps the worker ticking.
    if (!dailyOn) { await armSpyTickSoon(); return; }

    const dues = dueProfiles(spy.profiles, state, Date.now())
      .filter((p) => p.platform !== "instagram" || igDailyCount(state) < igLimit(prefs));
    const hasIgBatch = !!state.igBatch;
    const reelsPending = !!state.reelsJob || !!pickReelsWork(spy.profiles, state, Date.now());

    if (dues.length > 0 || hasIgBatch || reelsPending || state.fbManual?.length) {
      await armSpyTickSoon();
    } else {
      const now = new Date();
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      const randomDelayMs = (10 + Math.floor(Math.random() * 80)) * 60 * 1000;
      let when = nextDay.getTime() + randomDelayMs;
      // A temporarily ineligible profile can become due before midnight. Do
      // not postpone its second attempt or a platform unblock until tomorrow.
      const at = now.getTime();
      for (const p of Object.values(spy.profiles || {})) {
        if (!p || p.removedAt != null || (p.lastMeasuredAt && dayKey(p.lastMeasuredAt) === dayKey(at))) continue;
        if (p.platform === "instagram" && igDailyCount(state, at) >= igLimit(prefs)) continue;
        const attempt = state.day === dayKey(at) ? state.attempts?.[p.id] : null;
        const count = typeof attempt === "number" ? attempt : attempt?.n || 0;
        if (count >= 2) continue;
        const retryAt = count > 0 && attempt?.at ? attempt.at + SPY_RETRY_MS : at;
        when = Math.min(when, Math.max(at + 60000, retryAt, state.blocked?.[p.platform] || 0));
      }
      chrome.alarms.create("fbw-spy-tick", { when });
    }
  } catch {
    /* storage or alarms unavailable during teardown */
  }
}

export async function flushSpy({ attempt = 0 } = {}) {
  if (spyFlushing) {
    scheduleFlushSpy();
    return { ok: true, skipped: "busy" };
  }
  spyFlushing = true;
  try {
    const settings = await deps.readSyncSettings();
    if (!isSyncConfigured(settings)) {
      await chrome.alarms?.clear?.("fbw-spy-sync");
      return { ok: false, error: "acervo não configurado" };
    }

    const r = await chrome.storage.local.get([SPY_QUEUE_KEY, SPY_KEY]);
    const queue = r[SPY_QUEUE_KEY] || emptySpyQueue();
    const currentSpy = r[SPY_KEY] || { profiles: {} };

    const opsToSend = [...(queue.ops || [])];
    const profilesToSend = Object.values(queue.profiles || {});
    const snapshotsToSend = Object.values(queue.snapshots || {});
    const errorsToSend = Object.values(queue.errors || {});
    const reelsToSend = Object.values(queue.reels || {});
    const reelsStatusToSend = Object.values(queue.reelsStatus || {});
    const readingsToSend = Object.values(queue.readings || {});
    const postsToSend = Object.values(queue.posts || {});
    const thumbsToSend = Object.values(queue.thumbs || {});

    if (
      !opsToSend.length &&
      !profilesToSend.length &&
      !snapshotsToSend.length &&
      !errorsToSend.length &&
      !reelsToSend.length &&
      !reelsStatusToSend.length &&
      !readingsToSend.length &&
      !postsToSend.length &&
      !thumbsToSend.length
    ) {
      await chrome.alarms?.clear?.("fbw-spy-sync");
      return { ok: true, sent: 0 };
    }

    // Keep recovery armed before the first HTTP await, including manual saves.
    chrome.alarms?.create?.("fbw-spy-sync", { when: Date.now() + 60000 });
    // Size every kind of record, not only profile metadata: a long offline
    // period piles up snapshots. Order is kept, so ops land before the
    // metadata/snapshots that depend on them and errors after the snapshots.
    const records = [
      ...opsToSend.map((r) => ["ops", r]),
      ...profilesToSend.map((r) => ["profiles", r]),
      ...snapshotsToSend.map((r) => ["snapshots", r]),
      ...errorsToSend.map((e) => ["errors", { ...e, profileId: e.profileId || e.id }]),
      ...reelsToSend.map((r) => ["reels", r]),
      ...reelsStatusToSend.map((r) => ["reelsStatus", r]),
      ...readingsToSend.map((r) => ["readings", r]),
      ...postsToSend.map((r) => ["posts", r]),
      // Thumbnails are heavier: a few per request.
      ...thumbsToSend.map((r) => ["thumbs", r]),
    ];
    let lastRes = null;
    for (const batch of batchRecords(records, { maxItems: 500 })) {
      const body = {};
      for (const [kind, rec] of batch) (body[kind] ||= []).push(rec);
      lastRes = await postSpy(settings, body);
    }

    const rejected = [];
    if (Array.isArray(lastRes?.profiles)) {
      const server = new Map(lastRes.profiles.map((p) => [p.id, p]));
      const latestOps = new Map();
      for (const op of opsToSend) latestOps.set(op.id || spyId(op.platform, op.key), op);
      for (const [id, op] of latestOps) {
        const active = server.has(id) && server.get(id).removedAt == null;
        if ((op.op === "save") !== active) rejected.push(id);
      }
    }
    const rejectionError = rejected.length && lastRes?.results?.ops?.invalid > 0
      && lastRes.profiles.filter((p) => p.removedAt == null).length >= (lastRes.max || 100)
      ? "limit_reached" : "O hub não aceitou a alteração. Atualize a lista e tente novamente.";

    await mutateSpy(async () => {
      const freshR = await chrome.storage.local.get([SPY_QUEUE_KEY, SPY_KEY]);
      const freshQueue = freshR[SPY_QUEUE_KEY] || emptySpyQueue();
      const freshSpy = freshR[SPY_KEY] || currentSpy;

      const remainingOps = freshQueue.ops ? freshQueue.ops.slice(opsToSend.length) : [];

      const remainingProfiles = { ...(freshQueue.profiles || {}) };
      for (const p of profilesToSend) {
        const pid = p.id || (p.platform && p.key ? `${p.platform}:${p.key}` : null);
        if (pid && JSON.stringify(remainingProfiles[pid]) === JSON.stringify(queue.profiles[pid])) {
          delete remainingProfiles[pid];
        }
      }

      const remainingSnapshots = { ...(freshQueue.snapshots || {}) };
      for (const s of snapshotsToSend) {
        const pid = s.profileId || s.profile_id || s.id;
        const key = `${pid}|${s.day}`;
        if (JSON.stringify(remainingSnapshots[key]) === JSON.stringify(queue.snapshots[key])) {
          delete remainingSnapshots[key];
        }
      }

      const remainingErrors = { ...(freshQueue.errors || {}) };
      for (const e of errorsToSend) {
        if (JSON.stringify(remainingErrors[e.id]) === JSON.stringify(queue.errors[e.id])) {
          delete remainingErrors[e.id];
        }
      }

      // Keyed kinds: drop what was sent unless it changed during the upload.
      const unsent = (kind) => {
        const left = { ...(freshQueue[kind] || {}) };
        for (const [key, value] of Object.entries(queue[kind] || {})) {
          if (JSON.stringify(left[key]) === JSON.stringify(value)) delete left[key];
        }
        return left;
      };

      const nextQueue = {
        ops: remainingOps,
        profiles: remainingProfiles,
        snapshots: remainingSnapshots,
        errors: remainingErrors,
        reels: unsent("reels"),
        reelsStatus: unsent("reelsStatus"),
        readings: unsent("readings"),
        posts: unsent("posts"),
        thumbs: unsent("thumbs"),
      };

      let nextSpy = freshSpy;
      if (lastRes?.profiles) {
        const settled = new Set(opsToSend.map((op) => op.id || spyId(op.platform, op.key)));
        nextSpy = mergeList(freshSpy, lastRes.profiles, remainingOps, { settled });
      }

      await chrome.storage.local.set({
        [SPY_QUEUE_KEY]: nextQueue,
        [SPY_KEY]: nextSpy,
      });
      if (spyQueuePending(nextQueue)) scheduleFlushSpy();
      else {
        if (spyFlushTimer) clearTimeout(spyFlushTimer);
        spyFlushTimer = null;
        await chrome.alarms?.clear?.("fbw-spy-sync");
      }
      if (rejected.length) {
        const stateR = await chrome.storage.local.get(SPY_STATE_KEY);
        await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...(stateR[SPY_STATE_KEY] || emptySpyState()), lastError: rejectionError } });
      }
    });

    await recordHubResult({ ok: true, sent: records.length });
    if (Array.isArray(lastRes?.profiles)) fetchWantedThumbs(lastRes.profiles).catch(() => {});
    scheduleSpy().catch(() => {});
    return {
      ok: !rejected.length,
      ...(rejected.length ? { error: rejectionError, rejected } : {}),
      sent: records.length,
    };
  } catch (err) {
    const status = err?.status || 0;
    await recordHubResult({ ok: false, status, error: String(err?.message || err) }).catch(() => {});
    if (isRetryable(status) && attempt < 4) {
      scheduleFlushSpy(backoffDelay(attempt), attempt + 1);
    } else if (!isRetryable(status)) {
      await chrome.alarms?.clear?.("fbw-spy-sync");
    }
    return { ok: false, error: String(err?.message || err), status };
  } finally {
    spyFlushing = false;
  }
}

function recordAttempt(state, profileId, success, now = Date.now()) {
  const today = dayKey(now);
  const attempts = state.day === today ? { ...(state.attempts || {}) } : {};
  const prev = attempts[profileId] || { n: 0, at: 0 };
  attempts[profileId] = {
    n: prev.n + 1,
    at: now,
  };
  return {
    ...state,
    day: today,
    attempts,
  };
}

// `reading` ({ kind, source }) also logs the failed attempt for the hub's
// readings history.
async function blockPlatform(platform, errorCode, profileId, reading = null) {
  return mutateSpy(async () => {
  const now = Date.now();
  const r = await chrome.storage.local.get([SPY_STATE_KEY, SPY_QUEUE_KEY, SPY_KEY]);
  let state = r[SPY_STATE_KEY] || emptySpyState(now);
  let queue = r[SPY_QUEUE_KEY] || emptySpyQueue();

  state = {
    ...state,
    blocked: {
      ...(state.blocked || {}),
      [platform]: now + 12 * 3600 * 1000,
    },
    blockedReason: { ...(state.blockedReason || {}), [platform]: errorCode },
    lastError: errorCode,
  };
  await logSpy(platform, "error", `${profileId ? `${nameOf(r[SPY_KEY], profileId)}: ` : ""}${errorText(errorCode)} · coleta pausada até ${clockText(now + 12 * 3600 * 1000)}`);

  if (profileId) {
    queue = queueError(queue, profileId, errorCode, now);
    if (reading) queue = queueReading(queue, { profileId, at: now, ...reading, ok: false, error: errorCode });
  }

  await chrome.storage.local.set({
    [SPY_STATE_KEY]: state,
    [SPY_QUEUE_KEY]: queue,
  });

  scheduleFlushSpy();
  });
}

async function recordProfileError(profileId, errorCode, reading = null) {
  return mutateSpy(async () => {
  const now = Date.now();
  const r = await chrome.storage.local.get([SPY_QUEUE_KEY, SPY_STATE_KEY, SPY_KEY]);
  let queue = r[SPY_QUEUE_KEY] || emptySpyQueue();
  let state = r[SPY_STATE_KEY] || emptySpyState(now);
  await logSpy(platformOf(profileId), "warn", `${nameOf(r[SPY_KEY], profileId)}: ${errorText(errorCode)}`);

  queue = queueError(queue, profileId, errorCode, now);
  if (reading) queue = queueReading(queue, { profileId, at: now, ...reading, ok: false, error: errorCode });
  state = {
    ...state,
    lastError: errorCode,
  };

  await chrome.storage.local.set({
    [SPY_QUEUE_KEY]: queue,
    [SPY_STATE_KEY]: state,
  });

  scheduleFlushSpy();
  });
}

const fbMeasurements = new Map();
export function measureFbProfile(profile, source = "daily", fetchImpl = fetch, { force = false } = {}) {
  // Every entry point shares the same request, including manual/visit/daily.
  if (fbMeasurements.has(profile.id)) return fbMeasurements.get(profile.id);
  const work = collectFbProfile(profile, source, fetchImpl, force).finally(() => fbMeasurements.delete(profile.id));
  fbMeasurements.set(profile.id, work);
  return work;
}
async function collectFbProfile(profile, source, fetchImpl, force) {
  // The reels tab answers followers AND the newest reels in this one request.
  const url = reelsUrl(profile.key);
  const readingSource = force ? "manual" : source;
  const followersReading = { kind: "followers", source: readingSource };
  const startAt = Date.now();
  const reserved = await mutateSpy(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    const state = r[SPY_STATE_KEY] || emptySpyState(startAt);
    if (isBlocked(state, "facebook", startAt)) return false;
    const attempt = state.day === dayKey(startAt) ? state.attempts?.[profile.id] : null;
    const count = typeof attempt === "number" ? attempt : attempt?.n || 0;
    // An explicit user request skips the automatic retry budget; blocks still apply.
    if (!force && (count >= 2 || (count > 0 && startAt - (attempt?.at || 0) < SPY_RETRY_MS))) return false;
    await chrome.storage.local.set({
      [SPY_STATE_KEY]: {
        ...recordAttempt(state, profile.id, false, startAt),
        measuring: { id: profile.id, platform: "facebook", key: profile.key, at: startAt },
      },
    });
    return true;
  });
  if (!reserved) return { ok: false, error: "Aguarde o intervalo de coleta ou o fim da pausa do Facebook.", code: "cooldown" };
  try {
    const res = await fetchImpl(url, {
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(30000),
    });

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const errCode = res.status === 429 ? "rate_limited" : "login_required";
      await blockPlatform("facebook", errCode, profile.id, followersReading);
      return { ok: false, error: errCode };
    }

    if (res.status === 404) {
      await recordProfileError(profile.id, "not_found", followersReading);
      return { ok: false, error: "not_found" };
    }

    const finalUrl = res.url || url;
    const html = await res.text();
    const parsed = parseFbProfileHtml(html, finalUrl);
    const reels = parsed.ok ? parseFbReelsHtml(html) : { reels: [], hasNext: null, cursor: null };

    if (!parsed.ok) {
      if (parsed.error === "login_required" || parsed.error === "rate_limited") {
        await blockPlatform("facebook", parsed.error, profile.id, followersReading);
      } else {
        await recordProfileError(profile.id, parsed.error || "parse_failed", followersReading);
      }
      return parsed;
    }

    const now = Date.now();
    const today = dayKey(now);

    const snapshot = {
      profileId: profile.id,
      day: today,
      measuredAt: now,
      followers: parsed.followers,
      followersApprox: parsed.followersApprox,
      following: parsed.following ?? null,
      posts: null,
      hasStory: parsed.hasStory,
      source,
    };

    let avatarThumb = null;
    if (parsed.avatarUrl) {
      avatarThumb = await deps.durableThumb(parsed.avatarUrl);
    }

    const profilePatch = {
      id: profile.id,
      platform: "facebook",
      key: profile.key,
      userId: parsed.userId || undefined,
      name: parsed.name || undefined,
      avatar: avatarThumb || undefined,
      verified: parsed.verified !== null && parsed.verified !== undefined ? (parsed.verified ? 1 : 0) : undefined,
      storyRef: parsed.storyRef || undefined,
      at: now,
    };

    let added = 0;
    await mutateSpy(async () => {
      const r = await chrome.storage.local.get([SPY_QUEUE_KEY, SPY_KEY, SPY_STATE_KEY]);
      let queue = r[SPY_QUEUE_KEY] || emptySpyQueue();
      let spy = r[SPY_KEY] || { profiles: {} };
      let state = r[SPY_STATE_KEY] || emptySpyState(now);

      queue = queueSnapshot(queue, snapshot);
      if (parsed.name || avatarThumb || parsed.userId || parsed.storyRef) {
        queue = queueProfile(queue, profilePatch);
      }
      // Newest reels: the hub keeps each once and counts them as the posts.
      const known = new Set(spy.profiles?.[profile.id]?.reels?.recent || profile.reels?.recent || []);
      added = reels.reels.filter((reel) => !known.has(reel.id)).length;
      queue = queueReels(queue, profile.id, reels.reels);
      queue = queueReading(queue, { profileId: profile.id, at: now, ...followersReading, ok: true, followers: parsed.followers });
      // The week's views: when this page does not reach 7 days back, the reels job
      // pages on today until it does (mode "refresh").
      const weekStart = Math.floor(now / 1000) - 7 * 86400;
      const oldest = Math.min(...reels.reels.map((reel) => reel.createdAt).filter(Number.isFinite));
      const reelsRefresh = { ...(state.reelsRefresh || {}) };
      if (reels.hasNext && !(oldest <= weekStart)) reelsRefresh[profile.id] = { day: today };
      else delete reelsRefresh[profile.id];
      state = { ...state, reelsRefresh };
      queue = queueReading(queue, { profileId: profile.id, at: now, kind: "reels", source: readingSource, ok: true,
        reelsAdded: added, pages: 1 });
      // More than a page of new reels since the last reading: page on until the
      // first known one (the reels job picks this up).
      const status = spy.profiles?.[profile.id]?.reels?.status ?? profile.reels?.status;
      if (status === "done" && known.size > 0 && reels.reels.length > 0 && added === reels.reels.length && reels.hasNext) {
        state = { ...state, reelsCatchup: { ...(state.reelsCatchup || {}), [profile.id]: true } };
      }

      if (spy.profiles?.[profile.id]) {
        spy = {
          ...spy,
          profiles: {
            ...spy.profiles,
            [profile.id]: {
              ...spy.profiles[profile.id],
              name: parsed.name || spy.profiles[profile.id].name,
              lastMeasuredAt: now,
              hasAvatar: avatarThumb ? true : spy.profiles[profile.id].hasAvatar,
              userId: parsed.userId || spy.profiles[profile.id].userId,
            },
          },
        };
      }

      await chrome.storage.local.set({
        [SPY_QUEUE_KEY]: queue,
        [SPY_KEY]: spy,
        [SPY_STATE_KEY]: state,
      });

    });

    await rememberThumbs(profile.id, reels.reels);
    await logSpy("facebook", "ok", `${parsed.name || profileName(profile)}: ${countText(parsed.followers)} seguidores`
      + `${added ? ` · ${added} ${added === 1 ? "reel novo" : "reels novos"}` : ""}`
      + (force ? " · Medir agora" : source === "visit" ? " · lido pela sua visita" : " · passada diária"));
    scheduleFlushSpy();
    return { ok: true, snapshot };
  } catch (err) {
    await recordProfileError(profile.id, "network", followersReading);
    return { ok: false, error: "network" };
  } finally {
    await mutateSpy(async () => {
      const r = await chrome.storage.local.get(SPY_STATE_KEY);
      const state = r[SPY_STATE_KEY] || emptySpyState();
      if (state.measuring?.id === profile.id) {
        await chrome.storage.local.set({
          [SPY_STATE_KEY]: { ...state, measuring: null },
        });
      }
    });
  }
}

// Path B: the worker owns navigation; page capture remains passive. Persist the
// deadline and request budget before navigating so a worker restart cannot repeat
// a profile or reset the daily cap. The ordinary alarm is the recovery watchdog.
let igStepTimer = null;
let igOwnedTab = null;
let igStopReason = null;
let igWork = Promise.resolve();
export function serializeIg(work) {
  const next = igWork.then(() => work(), () => work());
  igWork = next.catch(() => {});
  return next;
}
const IG_SPY_MARKER = "#socialmate-spy";
// First reading of a profile's grid: at most this many extra pages (12 posts
// each), stopping at this many days back.
// Every reading covers the whole week: the grid back 7 days (15 on a profile's
// first reading) for posts per day, then the Reels tab back 7 days for views.
const IG_DEEP_PAGES = 8;
const IG_DEEP_DAYS = 15;
const IG_WEEK_DAYS = 7;
const IG_DEEP_HOLD_MS = 120000;
// The batch tab's previous document (Instagram's home, or the last profile) can
// finish loading after the navigation to the next profile started (measured
// 2026-10-05): only the profile's own page is asked for the week.
function onProfilePage(url, key) {
  try { return new URL(url).pathname.toLowerCase().startsWith(`/${String(key).toLowerCase()}/`); } catch { return false; }
}
async function deliverIgBatch(tabId, message, tries = 15) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (res?.ok) return true;
    } catch { /* no listener yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    if (r[SPY_STATE_KEY]?.igBatch?.tabId !== tabId) return false; // the batch moved on
  }
  return false;
}
async function holdIgBatchForDeep(key) {
  const batch = await mutateSpy(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    const state = r[SPY_STATE_KEY] || emptySpyState();
    const b = state.igBatch;
    if (!b || b.current !== key) return null;
    const next = { ...b, deep: key, deepAsked: [...(b.deepAsked || []), key], baseNextAt: b.nextAt,
      nextAt: Math.max(b.nextAt || 0, Date.now() + IG_DEEP_HOLD_MS) };
    await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...state, igBatch: next } });
    return next;
  });
  if (batch) armIgStep(batch.nextAt);
}
// The bridge's report that the extra grid pages were read (or why not). The
// profile is marked either way, so a failure is not retried every reading.
function weekErrorText(code) {
  if (code === "no_grid") return "a página do perfil não carregou os posts";
  if (code === "no_reels") return "a aba de reels não carregou";
  if (/^http_|^no_page$/.test(code || "")) return "o Instagram não respondeu à consulta";
  return "erro inesperado";
}
export async function finishIgDeep(msg, sender) {
  if (sender.frameId && sender.frameId !== 0) return { ok: false, error: "invalid_sender" };
  const key = String(msg.key || "").toLowerCase();
  const id = spyId("instagram", key);
  let wasSeeded = false;
  const batch = await mutateSpy(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    const state = r[SPY_STATE_KEY] || emptySpyState();
    const b = state.igBatch;
    if (!b?.own || b.tabId !== sender.tab?.id) return null;
    wasSeeded = !!state.igSeeded?.[id];
    const now = Date.now();
    const next = b.deep === key ? { ...b, deep: null, nextAt: Math.max(now + 4000, b.baseNextAt || 0) } : b;
    await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...state, igSeeded: { ...(state.igSeeded || {}), [id]: now }, igBatch: next } });
    return next;
  });
  if (!batch) return { ok: false, error: "unknown" };
  // A profile with no reels has no Reels tab: nothing to read there, not a failure.
  const noReels = msg.reelsError === "no_reels_tab";
  const first = !wasSeeded;
  const posts = first ? "posts dos últimos 15 dias" : "posts dos últimos 7 dias";
  if (msg.error === "rate_limited" || msg.reelsError === "rate_limited") await blockPlatform("instagram", "rate_limited", id, igReading(batch));
  else if (msg.ok && (!msg.reelsError || noReels)) {
    await logSpy("instagram", "ok", `@${key}: ${first ? "primeira leitura feita" : "semana em dia"} · ${posts}`
      + (noReels ? " (o perfil não tem reels)" : " e visualizações dos reels da semana"));
  } else {
    await logSpy("instagram", "warn", `@${key}: não deu para ler a semana inteira — ${weekErrorText(msg.error || msg.reelsError)}; tento de novo na próxima leitura`);
  }
  armIgStep(batch.nextAt);
  return { ok: true };
}
const IG_DAILY_READING = { kind: "followers", source: "daily" };
// A batch started or widened by "Medir agora" carries manualAt: it re-reads
// profiles measured earlier today and logs its readings as manual.
const igReading = (batch) => (batch?.manualAt ? { kind: "followers", source: "manual" } : IG_DAILY_READING);
function igStillPending(profile, batch) {
  if (!profile || profile.removedAt != null) return false;
  if (!profile.lastMeasuredAt) return true;
  return batch.manualAt ? profile.lastMeasuredAt < batch.manualAt : dayKey(profile.lastMeasuredAt) !== dayKey();
}
function igDailyCount(state, now = Date.now()) {
  return state.igDaily?.day === dayKey(now) ? state.igDaily.count || 0 : 0;
}
function armIgStep(at) {
  clearTimeout(igStepTimer);
  igStepTimer = setTimeout(() => {
    igStepTimer = null;
    serializeIg(advanceIgBatch).catch(() => {});
  }, Math.max(0, at - Date.now()));
}
// why: shown in the activity log when the batch stops before reading everyone.
async function closeIgBatch({ abandoned = false, why = null } = {}) {
  clearTimeout(igStepTimer);
  igStepTimer = null;
  const batch = await mutateSpy(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    let state = r[SPY_STATE_KEY] || emptySpyState();
    const batch = state.igBatch;
    if (!batch) return null;
    igOwnedTab = null;
    igStopReason = null;
    if (abandoned) {
      for (const key of batch.pending) {
        // A navigation already spent its attempt; only untouched pending items
        // need accounting on timeout.
        if (key !== batch.current) state = recordAttempt(state, spyId("instagram", key), false);
      }
    }
    const measuring = state.measuring?.platform === "instagram" ? null : state.measuring;
    await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...state, igBatch: null, measuring } });
    return batch;
  });
  if (!batch) return;
  const total = Math.max(batch.total || 0, batch.pending.length);
  const done = total - batch.pending.length;
  const failed = Math.min(batch.failed || 0, done);
  const read = `${done} de ${total} perfis (${done - failed} ${done - failed === 1 ? "lido" : "lidos"}${failed ? `, ${failed} com falha` : ""})`;
  if (!batch.pending.length) await logSpy("instagram", failed ? "warn" : "ok", `Lote concluído · ${read} · aba fechada`);
  else await logSpy("instagram", "warn", `Lote encerrado · ${read} — ${why || (abandoned ? "passou de 15 min" : "interrompido")}`);
  if (batch.own) {
    try {
      const tab = await chrome.tabs.get(batch.tabId);
      // If the user repurposed the tab, relinquish it.
      if (tab?.url?.endsWith(IG_SPY_MARKER) || /instagram\.com\/(accounts\/login|challenge|checkpoint)/.test(tab?.url || "")) {
        await chrome.tabs.remove(batch.tabId);
      }
    } catch { /* tab already closed */ }
  }
}
async function advanceIgBatch({ manual = false } = {}) {
  const settings = await deps.readSyncSettings();
  const r = await chrome.storage.local.get([SPY_KEY, SPY_STATE_KEY, SPY_PREFS_KEY]);
  const now = Date.now();
  let state = r[SPY_STATE_KEY] || emptySpyState(now);
  const profiles = r[SPY_KEY]?.profiles || {};
  let batch = state.igBatch;
  // The daily switch stops the automatic batch only; a manual one runs regardless.
  const dailyOff = r[SPY_PREFS_KEY]?.daily === false && !manual && !batch?.manualAt;
  if (!isSyncConfigured(settings) || dailyOff || isBlocked(state, "instagram", now)) {
    if (manual && isBlocked(state, "instagram", now)) {
      await logSpy("instagram", "warn", `Medir agora não abriu o Instagram: em pausa até ${clockText(state.blocked.instagram)} (${errorText(state.blockedReason?.instagram || "rate_limited")})`);
    }
    await closeIgBatch({ why: isBlocked(state, "instagram", now) ? "Instagram em pausa"
      : !isSyncConfigured(settings) ? "acervo não configurado" : "medição desligada em Opções" });
    return;
  }
  if (batch && (now - batch.startedAt >= 900000 || dayKey(batch.startedAt) !== dayKey(now))) {
    await closeIgBatch({ abandoned: true });
    return;
  }
  if (batch && manual) {
    // A click during a running batch widens it: every profile it has not read yet.
    const widened = { ...batch, manualAt: batch.manualAt || batch.startedAt };
    const extra = Object.values(profiles)
      .filter((p) => p?.platform === "instagram" && !batch.pending.includes(p.key) && igStillPending(p, widened))
      .sort((a, b) => (a.lastMeasuredAt || 0) - (b.lastMeasuredAt || 0)).map((p) => p.key);
    batch = { ...widened, pending: [...batch.pending, ...extra],
      total: Math.max(batch.total || 0, batch.pending.length) + extra.length };
    await logSpy("instagram", "info", extra.length
      ? `Lote em andamento ampliado: +${extra.length} ${extra.length === 1 ? "perfil" : "perfis"} (${extra.map((k) => `@${k}`).join(", ")})`
      : "Lote já em andamento com todos os perfis");
    await mutateSpy(async () => {
      const latest = await chrome.storage.local.get(SPY_STATE_KEY);
      state = { ...(latest[SPY_STATE_KEY] || state), igBatch: batch };
      await chrome.storage.local.set({ [SPY_STATE_KEY]: state });
    });
  }
  if (!batch) {
    const limit = igLimit(r[SPY_PREFS_KEY]);
    const remaining = limit - igDailyCount(state, now);
    // "Medir agora" reads every Instagram profile; the daily pass only the due ones.
    const candidates = manual
      ? Object.values(profiles).filter((p) => p && p.removedAt == null)
      : dueProfiles(profiles, state, now);
    const pending = candidates
      .filter((p) => p.platform === "instagram")
      .sort((a, b) => (a.lastMeasuredAt || 0) - (b.lastMeasuredAt || 0))
      .slice(0, Math.max(0, remaining)).map((p) => p.key);
    if (!pending.length) {
      if (manual && remaining <= 0) {
        await logSpy("instagram", "warn", `Limite de ${limit} leituras do Instagram hoje já atingido · Medir agora volta amanhã (o limite se ajusta em Opções)`);
      }
      return;
    }
    const cut = candidates.filter((p) => p.platform === "instagram").length - pending.length;
    await logSpy("instagram", "info", `Lote ${manual ? "manual" : "diário"} com ${pending.length} ${pending.length === 1 ? "perfil" : "perfis"}`
      + `${manual && cut > 0 ? ` (${cut} ${cut === 1 ? "fica" : "ficam"} para amanhã: limite de ${limit} por dia, ajustável em Opções)` : ""} · abrindo aba do Instagram em segundo plano, 1 perfil a cada 20–40 s`);
    const tab = await chrome.tabs.create({ url: "https://www.instagram.com/" + IG_SPY_MARKER, active: false });
    igOwnedTab = tab.id;
    igStopReason = null;
    batch = { tabId: tab.id, own: true, startedAt: now, pending, total: pending.length, current: null, nextAt: now,
      ...(manual ? { manualAt: now } : {}) };
    await mutateSpy(async () => {
      const latest = await chrome.storage.local.get(SPY_STATE_KEY);
      state = { ...(latest[SPY_STATE_KEY] || state), igBatch: batch };
      await chrome.storage.local.set({ [SPY_STATE_KEY]: state });
    });
    // Poll only our bridge, for at most 20 seconds. These are extension messages,
    // not requests to Instagram.
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        const pong = await chrome.tabs.sendMessage(tab.id, { type: "FBW_PING" });
        if (pong?.spy) { ready = true; break; }
      } catch { /* document still loading */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (igStopReason) {
      await blockPlatform("instagram", igStopReason, null);
      await closeIgBatch();
      return;
    }
    if (!ready) {
      await closeIgBatch({ abandoned: true, why: "a aba do Instagram não respondeu em 20 s; abra o Instagram neste Chrome e confira se está logado" });
      return;
    }
  }
  if (!batch.own) { await closeIgBatch(); return; }
  igOwnedTab = batch.tabId;
  if (batch.nextAt > Date.now()) { armIgStep(batch.nextAt); return; }
  try {
    const tab = await chrome.tabs.get(batch.tabId);
    if (!tab?.url?.endsWith(IG_SPY_MARKER)) { await closeIgBatch({ why: "a aba do lote foi usada para outra coisa" }); return; }
  } catch { await closeIgBatch({ why: "a aba do lote foi fechada" }); return; }
  if (batch.current) {
    await recordProfileError(spyId("instagram", batch.current), "parse_failed", igReading(batch));
    batch = { ...batch, pending: batch.pending.filter((key) => key !== batch.current), current: null, failed: (batch.failed || 0) + 1 };
  }
  const navigate = await mutateSpy(async () => {
    const currentR = await chrome.storage.local.get([SPY_STATE_KEY, SPY_KEY, SPY_PREFS_KEY]);
    state = currentR[SPY_STATE_KEY] || state;
    const live = currentR[SPY_KEY]?.profiles || {};
    batch.pending = batch.pending.filter((key) => igStillPending(live[spyId("instagram", key)], batch));
    const stop = currentR[SPY_PREFS_KEY]?.daily === false && !batch.manualAt ? "medição desligada em Opções"
      : isBlocked(state, "instagram") ? "Instagram em pausa"
      : !batch.pending.length ? "nada mais a ler"
      : igDailyCount(state) >= igLimit(currentR[SPY_PREFS_KEY]) ? `limite de ${igLimit(currentR[SPY_PREFS_KEY])} leituras por dia atingido` : null;
    if (stop) {
      // closeIgBatch reads the batch back: keep the progress made in this step.
      await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...state, igBatch: batch } });
      return stop;
    }
    const key = batch.pending[0];
    const at = Date.now();
    batch = { ...batch, current: key, nextAt: at + 20000 + Math.floor(Math.random() * 20001) };
    state = recordAttempt(state, spyId("instagram", key), false, at);
    state = {
      ...state,
      igBatch: batch,
      igDaily: { day: dayKey(at), count: igDailyCount(state, at) + 1 },
      measuring: { id: spyId("instagram", key), platform: "instagram", key, at },
    };
    await chrome.storage.local.set({ [SPY_STATE_KEY]: state });
    return null;
  });
  if (navigate) { await closeIgBatch({ why: navigate }); return; }
  if (igStopReason) {
    await blockPlatform("instagram", igStopReason, batch.current ? spyId("instagram", batch.current) : null, igReading(batch));
    await closeIgBatch();
    return;
  }
  try {
    await chrome.tabs.update(batch.tabId, { url: profileUrl("instagram", batch.current) + IG_SPY_MARKER });
    const total = Math.max(batch.total || 0, batch.pending.length);
    await logSpy("instagram", "info", `Abrindo @${batch.current} (${total - batch.pending.length + 1} de ${total})`);
    armIgStep(batch.nextAt);
  } catch {
    await recordProfileError(spyId("instagram", batch.current), "network", igReading(batch));
    await closeIgBatch();
  }
}
// Posts in a saved profile's grid, with their publication time, for posts per
// day. The bridge sends each one once per document; the hub keeps each once.
export async function receiveIgPosts(msg, sender) {
  if (sender.frameId && sender.frameId !== 0) return { ok: false, error: "invalid_sender" };
  let origin;
  try { origin = new URL(sender.url || sender.tab?.url).hostname; } catch { return { ok: false }; }
  if (!sender.tab || !(origin === "instagram.com" || origin.endsWith(".instagram.com"))) return { ok: false };
  const key = String(msg.key || "").toLowerCase();
  const id = spyId("instagram", key);
  const posts = (Array.isArray(msg.posts) ? msg.posts : []).slice(0, 60);
  const queued = await mutateSpy(async () => {
    const r = await chrome.storage.local.get([SPY_KEY, SPY_QUEUE_KEY]);
    const profile = r[SPY_KEY]?.profiles?.[id];
    if (msg.platform !== "instagram" || !profile || profile.removedAt != null) return null;
    // Rewrite when anything moved: a post still waiting can get its views from
    // the Reels tab a moment after the grid sent it.
    const before = JSON.stringify(r[SPY_QUEUE_KEY]?.posts || {});
    const queue = queuePosts(r[SPY_QUEUE_KEY], id, posts);
    const changed = JSON.stringify(queue.posts) !== before;
    if (changed) await chrome.storage.local.set({ [SPY_QUEUE_KEY]: queue });
    return changed;
  });
  if (queued == null) return { ok: false, error: "unknown" };
  await rememberThumbs(id, posts);
  const valid = posts.filter((p) => /^\d{3,30}$/.test(p?.id || "") && Number.isInteger(p.createdAt));
  if (queued && valid.length) {
    const withViews = valid.filter((p) => Number.isInteger(p.views)).length;
    await logSpy("instagram", "info", `@${key}: ${valid.length} ${valid.length === 1 ? "post lido" : "posts lidos"}`
      + (withViews ? `, ${withViews} com visualizações` : ""));
  }
  if (queued) scheduleFlushSpy();
  return { ok: true, queued: valid.length };
}
export async function observeIgProfile(msg, sender) {
  if (sender.frameId && sender.frameId !== 0) return { ok: false, error: "invalid_sender" };
  let origin;
  try { origin = new URL(sender.url || sender.tab?.url).hostname; } catch { return { ok: false }; }
  if (!sender.tab || !(origin === "instagram.com" || origin.endsWith(".instagram.com"))) return { ok: false };
  const key = String(msg.key || "").toLowerCase();
  if (msg.platform !== "instagram" || String(msg.data?.username || "").toLowerCase() !== key) return { ok: false };
  const id = spyId("instagram", key);
  let r = await chrome.storage.local.get([SPY_KEY, SPY_STATE_KEY]);
  let state = r[SPY_STATE_KEY] || emptySpyState();
  let profile = r[SPY_KEY]?.profiles?.[id];
  if (!profile || profile.removedAt != null) return { ok: false, error: "unknown" };
  const batch = state.igBatch;
  const inOwnTab = batch?.own && batch.tabId === sender.tab.id;
  if (inOwnTab && batch.current !== key) return { ok: false };
  const daily = !!inOwnTab;
  const now = Date.now();
  if (!daily && now - (profile.lastObservedAt || 0) < 600000) return { ok: true, skipped: true };
  // An old document in a completed batch must not turn a daily result into a visit.
  if (!daily && (sender.url || "").endsWith(IG_SPY_MARKER)) return { ok: false };
  const parsed = parseIgProfile(msg.data);
  if (!parsed.ok || !Number.isInteger(parsed.followers) || parsed.followers < 0) return { ok: false, error: "parse_failed" };
  let avatar = null;
  if (parsed.avatarUrl && (!profile.hasAvatar || now - (profile.avatarUpdatedAt || 0) >= 7 * 86400000)) {
    avatar = await deps.durableThumb(parsed.avatarUrl);
  }
  // Re-read after fetching the avatar: a concurrent removal must win.
  const recorded = await mutateSpy(async () => {
    r = await chrome.storage.local.get([SPY_KEY, SPY_QUEUE_KEY, SPY_STATE_KEY]);
    state = r[SPY_STATE_KEY] || state;
    profile = r[SPY_KEY]?.profiles?.[id];
    if (!profile || profile.removedAt != null) return false;
    let queue = queueSnapshot(r[SPY_QUEUE_KEY], { profileId: id, day: dayKey(now), measuredAt: now,
      followers: parsed.followers, followersApprox: false, following: parsed.following, posts: parsed.posts,
      hasStory: null, source: daily ? "daily" : "visit" });
    const patch = { id, at: now, userId: parsed.userId, name: parsed.name, bio: parsed.bio,
      externalUrl: parsed.externalUrl, verified: parsed.verified, private: parsed.private };
    if (avatar) patch.avatar = avatar;
    queue = queueProfile(queue, patch);
    queue = queueReading(queue, { profileId: id, at: now, kind: "followers", source: daily ? igReading(batch).source : "visit",
      ok: true, followers: parsed.followers });
    if (daily && state.igBatch?.tabId === sender.tab.id) {
      state = {
        ...state,
        igBatch: { ...state.igBatch, current: null, pending: state.igBatch.pending.filter((u) => u !== key) },
        measuring: state.measuring?.id === id ? null : state.measuring,
      };
    }
    await chrome.storage.local.set({
      [SPY_QUEUE_KEY]: queue,
      [SPY_KEY]: { ...r[SPY_KEY], profiles: { ...r[SPY_KEY].profiles, [id]: { ...profile,
        name: parsed.name || profile.name, userId: parsed.userId || profile.userId, lastMeasuredAt: now,
        ...(!daily ? { lastObservedAt: now } : {}),
        ...(avatar ? { hasAvatar: true, avatarUpdatedAt: now } : {}) } } },
      [SPY_STATE_KEY]: state,
    });
    return true;
  });
  if (!recorded) return { ok: false, error: "unknown" };
  await logSpy("instagram", "ok", `@${key}: ${countText(parsed.followers)} seguidores · ${daily
    ? (batch?.manualAt ? "Medir agora" : "passada diária") : "lido pela sua visita ao perfil"}`);
  if (daily) {
    // A first reading still paging through the grid keeps the tab open.
    if (!state.igBatch?.pending.length && !state.igBatch?.deep) await closeIgBatch();
    else armIgStep(state.igBatch.nextAt);
  }
  scheduleFlushSpy();
  return { ok: true };
}
// ---- Facebook reels: first full reading and catch-up ----
// Facebook exposes no reel total, so each profile is read in full once, slowly,
// in a background tab the worker owns; afterwards the daily reading only adds
// the newest reels. One page (10 reels) every 20–40 s, at most 30 pages per
// profile and 60 in all per day. The cursor persists, so a long profile simply
// continues the next day. A catch-up (a day with more than 10 new reels) pages
// until the first reel the hub already has.
const REELS_MARKER = "#socialmate-reels";
const REELS_PAGES_PER_PROFILE = 30;
const REELS_PAGES_PER_DAY = 60;
const REELS_JOB_MAX_MS = 40 * 60000;
let reelsStepTimer = null;
let reelsWork = Promise.resolve();
function serializeReels(work) {
  const next = reelsWork.then(work, work);
  reelsWork = next.catch(() => {});
  return next;
}
function armReelsStep(at) {
  clearTimeout(reelsStepTimer);
  reelsStepTimer = setTimeout(() => {
    reelsStepTimer = null;
    advanceReelsJob().catch(() => {});
  }, Math.max(0, at - Date.now()));
}
function reelsDaily(state, now = Date.now()) {
  return state.reelsDaily?.day === dayKey(now) ? state.reelsDaily : { day: dayKey(now), total: 0, byProfile: {} };
}
/** Next profile whose reels need reading: catch-ups, the week's views, then first readings. */
function pickReelsWork(profiles, state, now = Date.now()) {
  if (isBlocked(state, "facebook", now)) return null;
  const daily = reelsDaily(state, now);
  if (daily.total >= REELS_PAGES_PER_DAY) return null;
  const eligible = Object.values(profiles || {}).filter((p) => p && p.platform === "facebook" && p.removedAt == null &&
    p.reels && (daily.byProfile[p.id] || 0) < REELS_PAGES_PER_PROFILE && !((state.reelsRetryAt?.[p.id] || 0) > now));
  const catchup = eligible.find((p) => state.reelsCatchup?.[p.id] && p.reels.status === "done");
  if (catchup) return { profile: catchup, mode: "catchup" };
  // The week's views come before the long first readings.
  const refresh = eligible.find((p) => state.reelsRefresh?.[p.id]?.day === dayKey(now));
  if (refresh) return { profile: refresh, mode: "refresh" };
  const initial = eligible.find((p) => p.reels.status !== "done");
  return initial ? { profile: initial, mode: "initial" } : null;
}
async function startReelsJob() {
  const settings = await deps.readSyncSettings();
  const r = await chrome.storage.local.get([SPY_KEY, SPY_STATE_KEY, SPY_PREFS_KEY]);
  if (!isSyncConfigured(settings) || r[SPY_PREFS_KEY]?.daily === false) return null;
  const now = Date.now();
  const state = r[SPY_STATE_KEY] || emptySpyState(now);
  const work = pickReelsWork(r[SPY_KEY]?.profiles, state, now);
  if (!work) return null;
  const { profile, mode } = work;
  const tab = await chrome.tabs.create({ url: reelsUrl(profile.key) + REELS_MARKER, active: false });
  const progress = mode === "initial" ? state.reelsProgress?.[profile.id] : null;
  const job = { profileId: profile.id, key: profile.key, mode, tabId: tab.id, startedAt: now, nextAt: now + 8000,
    ...(mode === "refresh" ? { untilSec: Math.floor(now / 1000) - 7 * 86400 } : {}),
    cursor: progress?.cursor || null, collectionId: progress?.collectionId || null,
    known: profile.reels.recent || [], seen: [], pages: 0, added: 0, waits: 0 };
  await mutateSpy(async () => {
    const latest = await chrome.storage.local.get([SPY_STATE_KEY, SPY_QUEUE_KEY, SPY_KEY]);
    let queue = latest[SPY_QUEUE_KEY] || emptySpyQueue();
    const writes = { [SPY_STATE_KEY]: { ...(latest[SPY_STATE_KEY] || state), reelsJob: job } };
    if (mode === "initial" && profile.reels.status === "pending") {
      queue = queueReelsStatus(queue, profile.id, "running", now);
      writes[SPY_KEY] = withReelsStatus(latest[SPY_KEY], profile.id, "running");
    }
    await chrome.storage.local.set({ ...writes, [SPY_QUEUE_KEY]: queue });
  });
  await logSpy("facebook", "info", `Reels de ${profileName(profile)}: ${mode === "catchup" ? "buscando os novos desde a última leitura"
    : mode === "refresh" ? "atualizando as visualizações da semana" : "leitura completa"}`
    + " numa aba em segundo plano, 1 página a cada 20–40 s");
  armReelsStep(job.nextAt);
  return job;
}
/** Ends the session: logs one reading, keeps or clears progress, closes the tab. */
async function finishReelsJob(job, { error = null, done = false, logged = false } = {}) {
  clearTimeout(reelsStepTimer);
  reelsStepTimer = null;
  const now = Date.now();
  await mutateSpy(async () => {
    const r = await chrome.storage.local.get([SPY_STATE_KEY, SPY_QUEUE_KEY, SPY_KEY]);
    let state = r[SPY_STATE_KEY] || emptySpyState(now);
    let queue = r[SPY_QUEUE_KEY] || emptySpyQueue();
    const active = r[SPY_KEY]?.profiles?.[job.profileId];
    if (active && active.removedAt == null) {
      if (!logged) {
        queue = queueReading(queue, { profileId: job.profileId, at: now, kind: "reels", source: job.mode,
          ok: !error, ...(error ? { error } : {}), reelsAdded: job.added, pages: job.pages });
      }
      if (done && job.mode === "initial") queue = queueReelsStatus(queue, job.profileId, "done", now);
    }
    // Until the hub's list comes back, the local copy must already say "done",
    // or the next tick would start the same first reading again.
    const spyNext = done && job.mode === "initial" ? withReelsStatus(r[SPY_KEY], job.profileId, "done") : null;
    const reelsProgress = { ...(state.reelsProgress || {}) };
    const reelsCatchup = { ...(state.reelsCatchup || {}) };
    const reelsRetryAt = { ...(state.reelsRetryAt || {}) };
    const reelsRefresh = { ...(state.reelsRefresh || {}) };
    if (done && job.mode === "refresh") delete reelsRefresh[job.profileId];
    else if (done) {
      delete reelsProgress[job.profileId];
      delete reelsCatchup[job.profileId];
    }
    if (error) reelsRetryAt[job.profileId] = now + SPY_RETRY_MS;
    state = { ...state, reelsJob: null, reelsProgress, reelsCatchup, reelsRetryAt, reelsRefresh };
    await chrome.storage.local.set({ [SPY_STATE_KEY]: state, [SPY_QUEUE_KEY]: queue, ...(spyNext ? { [SPY_KEY]: spyNext } : {}) });
    if (!active || active.removedAt != null) return;
    const what = `Reels de ${profileName(active)}: +${job.added} em ${job.pages} ${job.pages === 1 ? "página" : "páginas"}`;
    if (error) await logSpy("facebook", "warn", `${what} · parou: ${errorText(error)} · tenta de novo em 6 h`);
    else if (done && job.mode === "refresh") await logSpy("facebook", "ok", `Reels de ${profileName(active)}: visualizações dos últimos 7 dias atualizadas`);
    else if (done) await logSpy("facebook", "ok", `${what} · ${job.mode === "initial" ? "leitura completa concluída" : "em dia"}`);
    else await logSpy("facebook", "info", `${what} · pausado, continua na próxima passada`);
  });
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (tab?.url?.includes(REELS_MARKER)) await chrome.tabs.remove(job.tabId);
  } catch { /* already closed */ }
  scheduleFlushSpy();
  scheduleSpy().catch(() => {});
}
async function stepReelsJob(job) {
  const now = Date.now();
  const r = await chrome.storage.local.get([SPY_KEY, SPY_STATE_KEY, SPY_PREFS_KEY]);
  const state = r[SPY_STATE_KEY] || emptySpyState(now);
  const profile = r[SPY_KEY]?.profiles?.[job.profileId];
  if (!profile || profile.removedAt != null || r[SPY_PREFS_KEY]?.daily === false || isBlocked(state, "facebook", now)) {
    return finishReelsJob(job, { logged: !profile || profile.removedAt != null });
  }
  if (now - job.startedAt > REELS_JOB_MAX_MS) return finishReelsJob(job);
  if (job.nextAt > now) { armReelsStep(job.nextAt); return; }
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (!tab?.url?.includes(REELS_MARKER)) return finishReelsJob(job, { error: "tab_closed" });
  } catch { return finishReelsJob(job, { error: "tab_closed" }); }

  let page;
  try {
    page = await chrome.tabs.sendMessage(job.tabId, { type: "FBW_SPY_REELS_PAGE", cursor: job.cursor, collectionId: job.collectionId }, { frameId: 0 });
  } catch {
    page = null; // content script not ready yet
  }
  if (!page) {
    if (job.waits >= 20) return finishReelsJob(job, { error: "no_bridge" });
    const next = { ...job, waits: job.waits + 1, nextAt: now + 3000 };
    await saveReelsJob(next);
    armReelsStep(next.nextAt);
    return;
  }
  if (!page.ok) {
    if (page.error === "login_required" || page.error === "rate_limited") {
      await blockPlatform("facebook", page.error, job.profileId, { kind: "reels", source: job.mode });
      return finishReelsJob(job, { error: page.error, logged: true });
    }
    return finishReelsJob(job, { error: page.error || "failed" });
  }

  const known = new Set(job.known);
  const seen = new Set(job.seen);
  const fresh = (page.rows || []).filter((row) => !known.has(row.id) && !seen.has(row.id));
  const reachedKnown = (page.rows || []).some((row) => known.has(row.id));
  const next = { ...job, waits: 0, pages: job.pages + 1, added: job.added + fresh.length,
    seen: [...seen, ...fresh.map((row) => row.id)].slice(-400),
    cursor: page.cursor || null, collectionId: page.collectionId || job.collectionId,
    nextAt: now + 20000 + Math.floor(Math.random() * 20001) };
  let capped = false;
  await mutateSpy(async () => {
    const latest = await chrome.storage.local.get([SPY_STATE_KEY, SPY_QUEUE_KEY]);
    const st = latest[SPY_STATE_KEY] || state;
    const daily = reelsDaily(st, now);
    const byProfile = { ...daily.byProfile, [job.profileId]: (daily.byProfile[job.profileId] || 0) + 1 };
    const reelsDailyNext = { day: daily.day, total: daily.total + 1, byProfile };
    capped = byProfile[job.profileId] >= REELS_PAGES_PER_PROFILE || reelsDailyNext.total >= REELS_PAGES_PER_DAY;
    const reelsProgress = { ...(st.reelsProgress || {}) };
    if (job.mode === "initial" && page.hasNext && next.cursor) {
      reelsProgress[job.profileId] = { cursor: next.cursor, collectionId: next.collectionId };
    }
    await chrome.storage.local.set({
      [SPY_QUEUE_KEY]: queueReels(latest[SPY_QUEUE_KEY] || emptySpyQueue(), job.profileId, page.rows || []),
      [SPY_STATE_KEY]: { ...st, reelsJob: next, reelsDaily: reelsDailyNext, reelsProgress },
    });
  });
  await rememberThumbs(job.profileId, page.rows || []);
  scheduleFlushSpy();
  const pageOldest = Math.min(...(page.rows || []).map((row) => row.createdAt).filter(Number.isFinite));
  const reachedWeekStart = job.mode === "refresh" && pageOldest <= job.untilSec;
  if (!page.hasNext || (job.mode === "catchup" && reachedKnown) || reachedWeekStart) return finishReelsJob(next, { done: true });
  if (capped) return finishReelsJob(next);
  armReelsStep(next.nextAt);
}
function withReelsStatus(spy, profileId, status) {
  const p = spy?.profiles?.[profileId];
  if (!p) return spy;
  return { ...spy, profiles: { ...spy.profiles, [profileId]: { ...p, reels: { ...(p.reels || {}), status } } } };
}
async function saveReelsJob(job) {
  await mutateSpy(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...(r[SPY_STATE_KEY] || emptySpyState()), reelsJob: job } });
  });
}
/** One step of the reels work: start the next profile or read its next page. */
export function advanceReelsJob() {
  return serializeReels(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    const job = r[SPY_STATE_KEY]?.reelsJob;
    if (job) await stepReelsJob(job);
    else await startReelsJob();
  });
}

// Inspect only traffic belonging to the tab this batch opened. A rate-limit or
// login response stops this network; no request is made by this observer.
chrome.webRequest?.onCompleted?.addListener((details) => {
  if (![401, 403, 429].includes(details.statusCode)) return;
  if (details.tabId === igOwnedTab) igStopReason = details.statusCode === 429 ? "rate_limited" : "login_required";
  serializeIg(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    const batch = r[SPY_STATE_KEY]?.igBatch;
    if (!batch?.own || batch.tabId !== details.tabId) return;
    await blockPlatform("instagram", details.statusCode === 429 ? "rate_limited" : "login_required",
      batch.current ? spyId("instagram", batch.current) : null, igReading(batch));
    await closeIgBatch();
  }).catch(() => {});
}, { urls: ["https://*.instagram.com/*"] });
chrome.tabs?.onUpdated?.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== "complete") return;
  if (tabId === igOwnedTab && /instagram\.com\/(accounts\/login|challenge|checkpoint)/.test(change.url || tab?.url || "")) igStopReason = "login_required";
  serializeIg(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    const batch = r[SPY_STATE_KEY]?.igBatch;
    if (!batch?.own || batch.tabId !== tabId) return;
    const url = change.url || tab?.url || "";
    if (/instagram\.com\/(accounts\/login|challenge|checkpoint)/.test(url)) {
      await blockPlatform("instagram", "login_required", batch.current ? spyId("instagram", batch.current) : null, igReading(batch));
      await closeIgBatch();
    } else if (change.status === "complete" && batch.current && onProfilePage(url, batch.current)) {
      // A profile never read in depth gets its first reading: up to 15 days of
      // grid, a few pages, read by the page itself (the tab is hidden and never
      // scrolls). The batch waits for it.
      const current = batch.current;
      let deep = null;
      if (!(batch.deepAsked || []).includes(current)) {
        const nowS = Math.floor(Date.now() / 1000);
        const first = !r[SPY_STATE_KEY]?.igSeeded?.[spyId("instagram", current)];
        deep = {
          grid: { maxPages: IG_DEEP_PAGES, untilSec: nowS - (first ? IG_DEEP_DAYS : IG_WEEK_DAYS) * 86400 },
          reels: { maxPages: IG_DEEP_PAGES, untilSec: nowS - IG_WEEK_DAYS * 86400 },
        };
        await holdIgBatchForDeep(current);
      }
      // The bridge loads at document_idle, which can come after "complete": keep
      // asking (outside the Instagram queue) until it answers.
      deliverIgBatch(tabId, { type: "FBW_SPY_IG_BATCH", usernames: [current], deep }).catch(() => {});
    }
  }).catch(() => {});
});

async function setFbManual(ids) {
  return mutateSpy(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    const state = { ...(r[SPY_STATE_KEY] || emptySpyState()), fbManual: ids.length ? ids : null };
    await chrome.storage.local.set({ [SPY_STATE_KEY]: state });
    return state;
  });
}

export async function spyTick({ manual = false } = {}) {
  if (spyTicking) return { ok: false, error: "busy" };
  spyTicking = true;

  try {
    const settings = await deps.readSyncSettings();
    if (manual) await logSpy(null, "info", "Medir agora: pedido recebido");
    if (!isSyncConfigured(settings)) {
      if (manual) await logSpy(null, "error", "Acervo não configurado · configure o hub em Opções");
      return { ok: false, error: "acervo não configurado" };
    }

    const now = Date.now();
    const today = dayKey(now);

    const r = await chrome.storage.local.get([SPY_KEY, SPY_STATE_KEY, SPY_QUEUE_KEY]);
    let spy = r[SPY_KEY] || { profiles: {} };
    let state = r[SPY_STATE_KEY] || emptySpyState(now);

    if (state.day !== today) {
      await mutateSpy(async () => {
        const fresh = await chrome.storage.local.get(SPY_STATE_KEY);
        state = fresh[SPY_STATE_KEY] || state;
        if (state.day !== today) {
          state = { ...state, day: today, attempts: {}, lastError: null };
          await chrome.storage.local.set({ [SPY_STATE_KEY]: state });
        }
      });
    }

    const prefs = await chrome.storage.local.get(SPY_PREFS_KEY);
    // The daily switch stops only the automatic pass: "Medir agora" and the work
    // it queued run regardless.
    const dailyOn = prefs[SPY_PREFS_KEY]?.daily !== false;
    if (!dailyOn && !manual && !manualPending(state)) {
      await serializeIg(() => closeIgBatch({ why: "medição desligada em Opções" }));
      return { ok: true, skipped: "disabled" };
    }
    if (!dailyOn && manual) await logSpy(null, "info", "Medição diária desligada em Opções · o Medir agora roda mesmo assim");

    // 1. Refresh profile list if older than 10 minutes or manual
    const tenMinAgo = now - 10 * 60 * 1000;
    if (!spy.fetchedAt || spy.fetchedAt < tenMinAgo || manual) {
      try {
        const res = await getSpyProfiles(settings);
        if (res?.profiles) {
          fetchWantedThumbs(res.profiles).catch(() => {});
          await mutateSpy(async () => {
            const freshR = await chrome.storage.local.get([SPY_KEY, SPY_QUEUE_KEY]);
            const currentSpy = freshR[SPY_KEY] || spy;
            const currentQueue = freshR[SPY_QUEUE_KEY] || emptySpyQueue();
            spy = mergeList(currentSpy, res.profiles, currentQueue.ops || []);
            await chrome.storage.local.set({ [SPY_KEY]: spy });
          });

        }
      } catch (e) {
        if (e?.status === 404) {
          await mutateSpy(async () => {
            const fresh = await chrome.storage.local.get(SPY_STATE_KEY);
            await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...(fresh[SPY_STATE_KEY] || state), lastError: "hub_sem_spy" } });
          });
          return { ok: false, error: "hub_sem_spy" };
        }
      }
    }

    // 2. Facebook measurement: ONE profile per tick. "Medir agora" queues every
    // Facebook profile (fbManual) and the following one-minute ticks work through it.
    const fbBlocked = isBlocked(state, "facebook", now);
    if (manual || (fbBlocked && state.fbManual)) {
      const ids = manual && !fbBlocked ? Object.values(spy.profiles || {})
        .filter((p) => p && p.platform === "facebook" && p.removedAt == null).map((p) => p.id) : [];
      state = await setFbManual(ids);
      if (manual && fbBlocked) {
        await logSpy("facebook", "warn", `Medir agora não mede o Facebook: em pausa até ${clockText(state.blocked.facebook)} (${errorText(state.blockedReason?.facebook || "rate_limited")})`);
      } else if (manual && ids.length) {
        await logSpy("facebook", "info", `${ids.length} ${ids.length === 1 ? "perfil" : "perfis"} na fila · 1 por minuto`);
      }
    }
    if (!fbBlocked) {
      const manualId = state.fbManual?.[0];
      if (manualId) {
        state = await setFbManual(state.fbManual.slice(1));
        const profile = spy.profiles?.[manualId];
        if (profile && profile.removedAt == null) await measureFbProfile(profile, "visit", fetch, { force: true });
      } else if (dailyOn) {
        const fbDues = dueProfiles(spy.profiles, state, now).filter((p) => p.platform === "facebook");
        if (fbDues.length > 0) await measureFbProfile(fbDues[0], "daily");
      }
    }

    // 3. Instagram path B (resumes the persisted batch after a worker wake).
    await serializeIg(() => advanceIgBatch({ manual }));

    // 3b. Facebook reels: first full reading / catch-up, one page per step.
    await advanceReelsJob();

    // 4. Flush spy queue
    await flushSpy();

    await mutateSpy(async () => {
      const latestState = await chrome.storage.local.get(SPY_STATE_KEY);
      await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...(latestState[SPY_STATE_KEY] || state), lastPassAt: Date.now() } });
    });

    // 5. Schedule next tick
    await scheduleSpy();

    return { ok: true };
  } finally {
    spyTicking = false;
  }
}

// On-visit Facebook measurement trigger
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo?.url && changeInfo?.status !== "complete") return;
  const url = changeInfo?.url || tab?.url;
  if (!url || typeof url !== "string") return;

  // Early exit before reading storage if host is not facebook.com
  if (!url.includes("facebook.com")) return;
  // The worker's own reels tab is not a visit.
  if (url.includes(REELS_MARKER)) return;

  const parsed = parseProfileUrl(url);
  if (!parsed || parsed.platform !== "facebook") return;

  const pid = spyId("facebook", parsed.key);

  (async () => {
    try {
      const r = await chrome.storage.local.get([SPY_KEY, SPY_STATE_KEY]);
      const spy = r[SPY_KEY] || { profiles: {} };
      const profile = spy.profiles?.[pid];
      if (!profile || profile.removedAt != null) return;

      const now = Date.now();
      const last = profile.lastMeasuredAt || 0;
      if (now - last < 6 * 3600 * 1000) return;

      const state = r[SPY_STATE_KEY] || emptySpyState(now);
      if (isBlocked(state, "facebook", now)) return;

      await measureFbProfile(profile, "visit");
    } catch {
      /* ignore */
    }
  })();
});
