// FB Research — background service worker.
//  1) open the side panel on toolbar click
//  2) reflect run state on the action badge (watches chrome.storage)
//  3) capture fbcdn video/audio track URLs (webRequest) + drive offscreen
//     Whisper transcription / ffmpeg download for FB feed videos.

import { parseFbcdnTrack, foldTrack, pickByWindow } from "./lib/fbcdn.js";
import { downloadPath, underDownloadRoot, initDownloadPrefs } from "./lib/downloadPath.js";

// The folder/flat settings are read synchronously by every path builder, so the
// cache behind them has to be primed the moment this worker wakes — an MV3 worker
// is torn down at 30s idle and re-created for the next message.
initDownloadPrefs();
import { mergeMeta } from "./lib/shared/metaMerge.js";
import { serialQueue } from "./lib/serialQueue.js";
import {
  applyTranscriptLanguageDefaultOnce,
  captionTrackLanguage,
  whisperTranscriptLanguage,
} from "./lib/transcriptionLanguage.js";
import { resolveTranscriptLanguage } from "./lib/captionLanguage.js";
import {
  TX_INTERRUPTED_ERROR,
  TX_STALL_MS,
  fmtDeadline,
  isActiveTxStatus,
  orphanedTranscriptIds,
  savedTranscriptPatch,
  txDeadlineMs,
} from "./lib/transcriptJobs.js";
import { idsOverCap, readTranscriptCap } from "./lib/transcriptCap.js";
import { readStoredTxPenalty, txPenaltyValue } from "./lib/txPenalty.js";
import { bytesToBase64, isDataThumb, toDurableThumb } from "./lib/thumbCache.js";
import { RECOVER_GAP_MS, recoverableRecords, resolveFreshThumb } from "./lib/thumbRecover.js";
import {
  SYNC_KEY,
  SYNC_QUEUE_KEY,
  SYNC_STATE_KEY,
  backoffDelay,
  batchRecords,
  isRetryable,
  isSyncConfigured,
  isSyncReady,
  pingSync,
  postSync,
  getSpyProfiles,
  postSpy,
  syncSettings,
} from "./lib/syncClient.js";

import { parseProfileUrl, profileUrl, reelsUrl, spyId } from "./lib/spyProfile.js";
import { parseFbProfileHtml, parseFbReelsHtml, parseIgProfile } from "./lib/spyParse.js";
import {
  SPY_KEY,
  SPY_PREFS_KEY,
  SPY_QUEUE_KEY,
  SPY_STATE_KEY,
  dayKey,
  dueProfiles,
  emptySpyQueue,
  emptySpyState,
  igLimit,
  SPY_RETRY_MS,
  isBlocked,
  mergeList,
  queueError,
  queueOp,
  queueProfile,
  queueSnapshot,
  queueReading,
  queueReels,
  queuePosts,
  queueReelsStatus,
} from "./lib/spyStore.js";
import { SPY_ACTIVITY_KEY, SPY_HUB_KEY, appendActivity, clockText, countText, errorText, profileName } from "./lib/spyActivity.js";
import { hubErrorText } from "./lib/spyStatus.js";

import { createVoiceJobs } from "./lib/voiceJobs.js";

const SESSION_KEY = "fbw_session";
const TRANSCRIPTS_KEY = "fbw_transcripts"; // storage.local map: videoId -> { status, text, chunks, error, updatedAt }
const NEED_RELOAD_KEY = "fbw_need_reload"; // panel hint: active FB tab has no live content script

// TikTok's video CDN 403s a hotlinked download (no Referer). fetch/downloads can't
// set Referer (forbidden header), so add it via a declarativeNetRequest session
// rule scoped to the TikTok video CDN hosts. Idempotent; installed lazily on the
// first TikTok download and harmless if the CDN doesn't actually require it.
const TT_REFERER_RULE_ID = 9101;
let ttRefererReady = false;
// Same hosts as the DNR rule below. This test was written out three times as an
// inline regex, and it could drift from the rule's requestDomains list — a URL the
// regex matched but the rule did not would silently 403.
const TT_CDN_RE = /(?:^|\.)(?:tiktok|tiktokcdn|tiktokcdn-us|tiktokv|muscdn|ibytedtos)\.com/i;
function isTiktokCdn(url) {
  if (!url) return false;
  try {
    return TT_CDN_RE.test(new URL(String(url)).hostname);
  } catch {
    // Not a parseable URL (a bare name, a blob:) — fall back to a substring test
    // rather than reporting "not TikTok" and losing the Referer header.
    return /tiktok|tiktokcdn|tiktokv|muscdn|ibytedtos/i.test(String(url));
  }
}
async function ensureTiktokReferer() {
  if (ttRefererReady || !chrome.declarativeNetRequest?.updateSessionRules) return;
  ttRefererReady = true;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [TT_REFERER_RULE_ID],
      addRules: [
        {
          id: TT_REFERER_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "referer", operation: "set", value: "https://www.tiktok.com/" },
              { header: "origin", operation: "set", value: "https://www.tiktok.com" },
            ],
          },
          condition: {
            requestDomains: ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "tiktok.com", "muscdn.com", "ibytedtos.com"],
            resourceTypes: ["media", "xmlhttprequest", "other", "image"],
          },
        },
      ],
    });
  } catch {
    ttRefererReady = false; // let a later download retry the install
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor)
    chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

// Map persisted session → badge.
//   halted        → red "!"
//   paused/break  → amber "II"
//   running       → azure processed count ("•" before first item)
//   idle/done     → cleared
function updateBadge(s) {
  if (s && s.haltReason) return setBadge("!", "#EF4444");
  if (!s || !s.isRunning) return setBadge("", "#3C7CFC");
  if (s.isPaused || s.isAutoBreak) return setBadge("II", "#F59E0B");
  const n = s.processed || 0;
  return setBadge(n > 0 ? (n > 999 ? "999+" : String(n)) : "•", "#3C7CFC");
}

function syncBadge() {
  chrome.storage.local.get(SESSION_KEY, (r) => updateBadge(r[SESSION_KEY]));
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === "fbw-spy-tick") {
    spyTick().catch(() => {});
  } else if (alarm.name === "fbw-spy-sync") {
    flushSpy().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  syncBadge();
  reinjectContentScripts();
  scheduleSpy().catch(() => {});
  recoverSpySync().catch(() => {});
  // Per-run event telemetry (and the JSON it used to download after every run)
  // was removed; drop the buffer key left behind by pre-0.68 versions so it
  // doesn't sit in storage forever holding a few thousand stale events.
  chrome.storage.local.remove("fbw_run_events").catch(() => {});
  // 0.97.1 moved the transcription default to English; installs that already
  // stored a pick get it once, here (see lib/transcriptionLanguage.js).
  applyTranscriptLanguageDefaultOnce().catch(() => {});
});

// Re-inject content scripts into already-open platform tabs after an extension
// reload/update — otherwise every open FB/IG/TT tab silently loses its engine
// ("Receiving end does not exist") until the tab is manually reloaded. All our
// content scripts carry an init guard, so double-injection is a no-op.
//
// `onlyTabId` narrows the sweep to a single tab. The panel's one-click recovery
// needs exactly this manifest → executeScript mapping, so it reuses this
// function instead of keeping a second copy that could drift — the `world`
// mapping especially: a MAIN-world script injected as ISOLATED runs happily and
// does nothing, which is the hardest possible bug to see.
async function reinjectContentScripts(onlyTabId = null) {
  let injected = 0;
  for (const cs of chrome.runtime.getManifest().content_scripts || []) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: cs.matches });
    } catch {
      continue;
    }
    for (const t of tabs) {
      if (onlyTabId != null && t.id !== onlyTabId) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          files: cs.js,
          world: cs.world === "MAIN" ? "MAIN" : "ISOLATED",
        });
        injected += 1;
      } catch {
        /* discarded/errored tabs — the panel's reload banner covers those */
      }
    }
  }
  return injected;
}

// ---- one-click recovery for a tab whose content scripts are gone ----
// Every content script answers FBW_PING, so a ping is the liveness test — the
// same test tabs.onActivated already uses to set fbw_need_reload.
function pingTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "FBW_PING" }).then(
    () => true,
    () => false,
  );
}
async function waitForPing(tabId, attempts, delayMs) {
  for (let i = 0; i < attempts; i += 1) {
    if (await pingTab(tabId)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// Cheapest repair first. Re-injection keeps the page exactly as the user left
// it — scroll position, the open reel, a half-typed comment — so it is tried
// before the blunt fallback. A reload is only needed for tabs executeScript
// cannot reach: one open since before the extension had its host permission, or
// one Chrome discarded. A reload re-runs the manifest's content scripts by
// itself, so afterwards we only wait for one of them to answer.
//
// WHY THE LADDER TAKES ITS STEPS AS AN ARGUMENT. Only the `alive` rung is
// reachable on demand in a real browser: Chrome heals the tab before the
// fallbacks can run — a discarded tab resurrects on the very first sendMessage,
// and an extension reload re-injects every content script from onInstalled. Three
// live attempts to force `inject`/`reload` all came back `alive`. So the rungs
// below it are covered by unit tests instead (src/background.test.js), which
// hand in fake steps. `steps` is the ONLY change from the previous shape; the
// order, the retry counts and every return value are byte-for-byte the same.
export async function reviveWith(steps, tabId) {
  if (tabId == null) return { ok: false, error: "nenhuma aba para reconectar" };
  if (await steps.ping(tabId)) return { ok: true, method: "alive" };
  try {
    await steps.reinject(tabId);
  } catch {
    /* fall through to the reload path */
  }
  if (await steps.waitForPing(tabId, 6, 250)) return { ok: true, method: "inject" };
  try {
    await steps.reload(tabId);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // ≤10s covers a cold facebook.com load on a slow connection.
  if (await steps.waitForPing(tabId, 20, 500)) return { ok: true, method: "reload" };
  return { ok: false, error: "a aba não respondeu depois de recarregar" };
}

const REVIVE_STEPS = {
  ping: (tabId) => pingTab(tabId),
  reinject: (tabId) => reinjectContentScripts(tabId),
  waitForPing: (tabId, attempts, delayMs) => waitForPing(tabId, attempts, delayMs),
  reload: (tabId) => chrome.tabs.reload(tabId),
};

function reviveTab(tabId) {
  return reviveWith(REVIVE_STEPS, tabId);
}

// Recovery succeeded → the stale-tab hint is provably wrong, so retire it. This
// is what lets the panel re-enable itself without being reopened: the panel and
// the Library both watch this key through storage.onChanged.
async function markTabHealthy() {
  try {
    await chrome.storage.local.set({ [NEED_RELOAD_KEY]: false });
  } catch {
    /* storage unavailable during teardown */
  }
}
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  syncBadge();
  scheduleSpy().catch(() => {});
  recoverSpySync().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SESSION_KEY]) updateBadge(changes[SESSION_KEY].newValue);
  if (changes[SAVED_KEY]) capSavedStore(changes[SAVED_KEY].newValue);
  if (changes[SPY_PREFS_KEY] || changes[SYNC_KEY] || changes[SPY_KEY]) {
    scheduleSpy().catch(() => {});
  }
  if (changes[SPY_QUEUE_KEY] || changes[SYNC_KEY]) recoverSpySync().catch(() => {});
});

// `fbw_saved` is the shared Library. It used to be written from TEN places (six
// panel tools, three page overlays, the transcription rail), each doing its own
// get → mutate → set, which is a lost-update race: two toggles in flight (panel +
// page, or two tabs) and one silently overwrites the other. They also wrote five
// different record shapes.
//
// Now every write goes through FBW_SAVED_TOGGLE below, serialized here. The cap
// stays a single owner too: capping in every writer would have meant ten copies.
// ---- durable thumbnails ----------------------------------------------------
// Every record that reaches storage passes through here. The platforms hand out
// SIGNED thumbnail URLs (`oe=` on fbcdn/cdninstagram, `x-expires=` on tiktokcdn)
// that die in days, which is why an Arquivo card that looked fine on Monday was a
// broken-image icon by Friday — the record was intact, the LINK had expired. The
// bytes are fetched once and stored as a small `data:` URL instead, which is what
// Facebook's transcription rail always did (it canvases a frame off the <video>).
//
// Failure keeps the original URL: it may still render in a page context, and the
// Arquivo's recovery pass can ask the platform for a fresh one later.
async function durableThumb(url) {
  if (!url || isDataThumb(url)) return url || null;
  try {
    if (isTiktokCdn(url)) await ensureTiktokReferer();
    return await toDurableThumb(url);
  } catch {
    return url;
  }
}

const SAVED_KEY = "fbw_saved";
const SAVED_CAP = 300;

function capMap(map) {
  const keys = Object.keys(map);
  if (keys.length <= SAVED_CAP) return map;
  const kept = keys
    .sort((a, b) => (map[b]?.updatedAt || 0) - (map[a]?.updatedAt || 0))
    .slice(0, SAVED_CAP);
  const next = {};
  for (const k of kept) next[k] = map[k];
  return next;
}

// Backstop for anything still writing the key directly (and for records arriving
// from an older build). Trims oldest-first by updatedAt; the write re-fires this
// listener but by then we're at the cap, so the guard stops it (no loop).
function capSavedStore(map) {
  if (!map || typeof map !== "object") return;
  if (Object.keys(map).length <= SAVED_CAP) return;
  chrome.storage.local.set({ [SAVED_KEY]: capMap(map) });
}

// Serialize the read-modify-write. Every toggle queues behind the previous one, so
// concurrent saves from different tabs/worlds can't clobber each other.
const queueSavedWrite = serialQueue();

// Toggle one entry: present → remove, absent → insert. Returns whether the item
// is saved AFTER the call, so a caller can paint the bookmark from the truth
// rather than from an optimistic guess.
function toggleSaved(entry) {
  return queueSavedWrite(async () => {
    if (!entry || !entry.videoId) throw new Error("entrada inválida");
    const id = String(entry.videoId);
    const r = await chrome.storage.local.get(SAVED_KEY);
    const map = r[SAVED_KEY] || {};
    let saved;
    if (map[id]) {
      delete map[id];
      saved = false;
    } else {
      // Inside the queue on purpose: un-saving must not pay for a thumbnail
      // fetch, and only this branch knows the entry is actually being stored.
      map[id] = { ...entry, thumb: await durableThumb(entry.thumb) };
      saved = true;
    }
    await chrome.storage.local.set({ [SAVED_KEY]: capMap(map) });
    if (saved) queueForSync("saved", id).catch(() => {});
    return saved;
  });
}

// Insert-or-refresh, never remove — the auto-capture path (favorite a post while
// warming) must not toggle a record off just because it was already there. Merges
// by default so an existing record's transcript text/chunks survive a metadata
// refresh.
async function upsertSaved(entry, merge = true) {
  const e = entry && entry.thumb ? { ...entry, thumb: await durableThumb(entry.thumb) } : entry;
  return queueSavedWrite(async () => {
    if (!e || !e.videoId) throw new Error("entrada inválida");
    const id = String(e.videoId);
    const r = await chrome.storage.local.get(SAVED_KEY);
    const map = r[SAVED_KEY] || {};
    map[id] = merge ? { ...map[id], ...e, videoId: id } : e;
    if (!map[id].updatedAt) map[id].updatedAt = Date.now();
    await chrome.storage.local.set({ [SAVED_KEY]: capMap(map) });
    queueForSync("saved", id).catch(() => {});
    return true;
  });
}

// Unconditional remove (the Library's per-item delete and "limpar tudo").
function removeSaved(ids) {
  return queueSavedWrite(async () => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
    const r = await chrome.storage.local.get(SAVED_KEY);
    const map = r[SAVED_KEY] || {};
    let removed = 0;
    for (const id of list)
      if (map[id]) {
        delete map[id];
        removed++;
      }
    if (removed) await chrome.storage.local.set({ [SAVED_KEY]: map });
    return removed;
  });
}

// ---- thumbnail recovery ----------------------------------------------------
// The repair pass for records already in storage with a dead link. Routes and
// their limits are documented in lib/thumbRecover.js; this is just the driver:
// one request at a time, a per-platform gap between them, and the result written
// back as `data:` bytes so the card can never rot again.
//
// A recovered thumbnail does NOT bump updatedAt — the Arquivo is ordered by it,
// and repairing a picture is not the user editing the record. That is why this
// patches the maps directly instead of going through putTranscript/upsertSaved.
let thumbSweep = { running: false, done: 0, total: 0, fixed: 0, failed: 0 };

function patchThumbs(key, patches) {
  const queue = key === TRANSCRIPTS_KEY ? queueTranscriptWrite : queueSavedWrite;
  return queue(async () => {
    const r = await chrome.storage.local.get(key);
    const map = r[key] || {};
    let n = 0;
    for (const [id, thumb] of Object.entries(patches)) {
      if (!map[id] || !thumb) continue;
      map[id] = { ...map[id], thumb };
      n += 1;
    }
    if (n) {
      await chrome.storage.local.set({ [key]: map });
      queueForSync(key === TRANSCRIPTS_KEY ? "transcripts" : "saved", Object.keys(patches)).catch(() => {});
    }
    return n;
  });
}

function reportThumbSweep() {
  // No panel open is the normal case for a long sweep — ignore the "receiving
  // end does not exist" that follows.
  chrome.runtime.sendMessage({ type: "FBW_THUMB_PROGRESS", ...thumbSweep }).catch(() => {});
}

async function recoverThumbs({ brokenIds } = {}) {
  if (thumbSweep.running) return { ok: true, ...thumbSweep };
  const broken = new Set((brokenIds || []).map(String));
  const stores = [
    [TRANSCRIPTS_KEY, await getTranscripts()],
    [SAVED_KEY, (await chrome.storage.local.get(SAVED_KEY))[SAVED_KEY] || {}],
  ];
  const jobs = [];
  for (const [key, map] of stores)
    for (const rec of recoverableRecords(Object.values(map), { brokenIds: broken }))
      jobs.push({ key, rec });

  thumbSweep = { running: jobs.length > 0, done: 0, total: jobs.length, fixed: 0, failed: 0 };
  if (!jobs.length) return { ok: true, ...thumbSweep };

  (async () => {
    let batch = {};
    let batchKey = null;
    const flush = async () => {
      if (batchKey && Object.keys(batch).length) await patchThumbs(batchKey, batch);
      batch = {};
      batchKey = null;
    };
    for (const { key, rec } of jobs) {
      try {
        const fresh = await resolveFreshThumb(rec);
        const data = fresh ? await durableThumb(fresh) : null;
        // durableThumb hands the URL back when the bytes could not be fetched;
        // storing that would just be the same dead link under a new signature.
        if (data && isDataThumb(data)) {
          if (batchKey && batchKey !== key) await flush();
          batchKey = key;
          batch[String(rec.videoId)] = data;
          thumbSweep.fixed += 1;
        } else {
          thumbSweep.failed += 1; // deleted, private, or not embeddable
        }
      } catch {
        thumbSweep.failed += 1;
      }
      thumbSweep.done += 1;
      if (Object.keys(batch).length >= 4) await flush();
      reportThumbSweep();
      // An MV3 worker dies after 30s with no extension API call, and fetch is not
      // one. This is the keep-alive; the sweep is also resumable (a record whose
      // link is still dead comes back in the next pass), so a death mid-run costs
      // at most the batch that had not been flushed.
      await chrome.runtime.getPlatformInfo().catch(() => {});
      await new Promise((r) => setTimeout(r, RECOVER_GAP_MS[rec.platform] ?? 1000));
    }
    await flush();
    thumbSweep.running = false;
    reportThumbSweep();
  })();

  return { ok: true, ...thumbSweep };
}

// ---- hub sync --------------------------------------------------------------
// One-way push of both stores to the socialMate hub. The rules live in
// lib/syncClient.js; this is the part that touches storage and the network.
//
// The QUEUE IS PERSISTED (fbw_sync_queue). A service worker dies after 30s idle,
// and a record that was only in a variable would never be sent — the user would
// see it in the panel and never in the hub, with nothing to explain the gap.
//
// Deletes are deliberately NOT pushed. The local stores are capped (20
// transcriptions, 300 saved) and drop their oldest as they fill; forwarding that
// eviction would make the hub just as forgetful, which is the opposite of why it
// exists.
const SYNC_DEBOUNCE_MS = 4000;
let syncTimer = null;
let syncing = false;

async function readSyncSettings() {
  const r = await chrome.storage.local.get(SYNC_KEY);
  return syncSettings(r[SYNC_KEY]);
}

async function setSyncState(patch) {
  const r = await chrome.storage.local.get(SYNC_STATE_KEY);
  const next = { ...(r[SYNC_STATE_KEY] || {}), ...patch };
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: next });
  return next;
}

function scheduleSync(delay = SYNC_DEBOUNCE_MS) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    flushSync().catch(() => {});
  }, delay);
}

// Called from every write path. Cheap and silent when sync is off: the ids are
// still recorded, so switching it on later sends what happened in the meantime.
async function queueForSync(kind, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
  if (!list.length) return;
  const r = await chrome.storage.local.get(SYNC_QUEUE_KEY);
  const queue = r[SYNC_QUEUE_KEY] || {};
  const bucket = { ...(queue[kind] || {}) };
  for (const id of list) bucket[id] = 1;
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: { ...queue, [kind]: bucket } });
  scheduleSync();
}

async function storeFor(kind) {
  const key = kind === "transcripts" ? TRANSCRIPTS_KEY : SAVED_KEY;
  const r = await chrome.storage.local.get(key);
  return r[key] || {};
}

/**
 * Send everything the queue names. Ids that no longer exist locally are dropped
 * from the queue rather than retried forever (a record deleted before its first
 * sync has nothing to send).
 */
async function flushSync({ attempt = 0, manual = false } = {}) {
  if (syncing) return { ok: true, skipped: "busy" };
  const settings = await readSyncSettings();
  // A manual push only needs an address and a token: the switch in Opções governs
  // whether the worker sends BY ITSELF, not whether the user may ask for it.
  if (!isSyncConfigured(settings)) return { ok: false, error: "acervo não configurado" };
  if (!manual && !isSyncReady(settings)) return { ok: false, error: "envio automático desligado" };

  const r = await chrome.storage.local.get(SYNC_QUEUE_KEY);
  const queue = r[SYNC_QUEUE_KEY] || {};
  const kinds = ["transcripts", "saved"];
  const plan = [];
  for (const kind of kinds) {
    const ids = Object.keys(queue[kind] || {});
    if (!ids.length) continue;
    const map = await storeFor(kind);
    const records = ids.map((id) => map[id]).filter(Boolean);
    if (records.length) plan.push({ kind, ids, records });
    else queue[kind] = {}; // every id is gone locally
  }
  if (!plan.length) {
    await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
    return { ok: true, sent: 0 };
  }

  syncing = true;
  await setSyncState({ running: true, error: null });
  let sent = 0;
  try {
    for (const { kind, ids, records } of plan) {
      for (const batch of batchRecords(records)) {
        await postSync(settings, { [kind]: batch });
        sent += batch.length;
      }
      // Cleared only after the whole kind landed: a half-sent kind that cleared
      // its queue would lose the rest on the next flush.
      for (const id of ids) delete queue[kind][id];
    }
    await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
    await setSyncState({ running: false, lastOkAt: Date.now(), lastSent: sent, error: null, pending: 0 });
    return { ok: true, sent };
  } catch (e) {
    const status = e?.status || 0;
    const pending = kinds.reduce((n, k) => n + Object.keys(queue[k] || {}).length, 0);
    await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
    // errorAt: the header's connection dot weighs this failure against its own
    // pings by recency, and an error with no time can't be placed.
    await setSyncState({ running: false, error: String(e?.message || e), errorAt: Date.now(), pending });
    // A wrong token or a malformed body fails the same way forever; only retry
    // what another attempt could fix.
    if (isRetryable(status) && attempt < 4) scheduleSync(backoffDelay(attempt));
    return { ok: false, error: String(e?.message || e), status };
  } finally {
    syncing = false;
  }
}

/** "Sincronizar tudo": queue every record in both stores, then flush. */
async function syncAll() {
  for (const kind of ["transcripts", "saved"]) {
    const map = await storeFor(kind);
    await queueForSync(kind, Object.keys(map));
  }
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  return flushSync({ manual: true });
}

// A queue that survived the worker's death (or the browser's) gets one attempt on
// the way up, before anything else asks for it.
chrome.runtime.onStartup?.addListener(() => scheduleSync(8000));

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
function mutateSpy(work) {
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
  return !!(queue?.ops?.length || ["profiles", "snapshots", "errors", "reels", "reelsStatus", "readings", "posts"]
    .some((kind) => Object.keys(queue?.[kind] || {}).length));
}

async function recoverSpySync() {
  // One independent, persisted wakeup survives MV3 suspension and browser
  // startup. Daily collection preferences never disable pending user changes.
  const settings = await readSyncSettings();
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

async function scheduleSpy() {
  if (!chrome.alarms?.create) return;
  try {
    const settings = await readSyncSettings();
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

async function flushSpy({ attempt = 0 } = {}) {
  if (spyFlushing) {
    scheduleFlushSpy();
    return { ok: true, skipped: "busy" };
  }
  spyFlushing = true;
  try {
    const settings = await readSyncSettings();
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

    if (
      !opsToSend.length &&
      !profilesToSend.length &&
      !snapshotsToSend.length &&
      !errorsToSend.length &&
      !reelsToSend.length &&
      !reelsStatusToSend.length &&
      !readingsToSend.length &&
      !postsToSend.length
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
function measureFbProfile(profile, source = "daily", fetchImpl = fetch, { force = false } = {}) {
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
      avatarThumb = await durableThumb(parsed.avatarUrl);
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
function serializeIg(work) {
  const next = igWork.then(() => work(), () => work());
  igWork = next.catch(() => {});
  return next;
}
const IG_SPY_MARKER = "#socialmate-spy";
// First reading of a profile's grid: at most this many extra pages (12 posts
// each), stopping at this many days back.
const IG_DEEP_PAGES = 4;
const IG_DEEP_DAYS = 15;
const IG_DEEP_HOLD_MS = 60000;
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
async function finishIgDeep(msg, sender) {
  if (sender.frameId && sender.frameId !== 0) return { ok: false, error: "invalid_sender" };
  const key = String(msg.key || "").toLowerCase();
  const id = spyId("instagram", key);
  const batch = await mutateSpy(async () => {
    const r = await chrome.storage.local.get(SPY_STATE_KEY);
    const state = r[SPY_STATE_KEY] || emptySpyState();
    const b = state.igBatch;
    if (!b?.own || b.tabId !== sender.tab?.id) return null;
    const now = Date.now();
    const next = b.deep === key ? { ...b, deep: null, nextAt: Math.max(now + 4000, b.baseNextAt || 0) } : b;
    await chrome.storage.local.set({ [SPY_STATE_KEY]: { ...state, igSeeded: { ...(state.igSeeded || {}), [id]: now }, igBatch: next } });
    return next;
  });
  if (!batch) return { ok: false, error: "unknown" };
  const pages = Number.isInteger(msg.pages) ? msg.pages : 0;
  const pagesText = `${pages} ${pages === 1 ? "página" : "páginas"}`;
  if (msg.ok) await logSpy("instagram", "ok", `@${key}: leitura inicial do grid · +${pagesText}${msg.done ? " (o grid acabou)" : ""}`);
  else if (msg.error === "rate_limited") await blockPlatform("instagram", "rate_limited", id, igReading(batch));
  else await logSpy("instagram", "warn", `@${key}: leitura inicial do grid parou (${msg.error || "falhou"}) · +${pagesText}`);
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
  const settings = await readSyncSettings();
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
async function receiveIgPosts(msg, sender) {
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
    const before = Object.keys(r[SPY_QUEUE_KEY]?.posts || {}).length;
    const queue = queuePosts(r[SPY_QUEUE_KEY], id, posts);
    const added = Object.keys(queue.posts).length - before;
    if (added) await chrome.storage.local.set({ [SPY_QUEUE_KEY]: queue });
    return added;
  });
  if (queued == null) return { ok: false, error: "unknown" };
  if (queued) {
    await logSpy("instagram", "info", `@${key}: ${queued} ${queued === 1 ? "post" : "posts"} com data lidos do grid`);
    scheduleFlushSpy();
  }
  return { ok: true, queued };
}
async function observeIgProfile(msg, sender) {
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
    avatar = await durableThumb(parsed.avatarUrl);
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
/** Next profile whose reels need reading: catch-ups first, then first readings. */
function pickReelsWork(profiles, state, now = Date.now()) {
  if (isBlocked(state, "facebook", now)) return null;
  const daily = reelsDaily(state, now);
  if (daily.total >= REELS_PAGES_PER_DAY) return null;
  const eligible = Object.values(profiles || {}).filter((p) => p && p.platform === "facebook" && p.removedAt == null &&
    p.reels && (daily.byProfile[p.id] || 0) < REELS_PAGES_PER_PROFILE && !((state.reelsRetryAt?.[p.id] || 0) > now));
  const catchup = eligible.find((p) => state.reelsCatchup?.[p.id] && p.reels.status === "done");
  if (catchup) return { profile: catchup, mode: "catchup" };
  const initial = eligible.find((p) => p.reels.status !== "done");
  return initial ? { profile: initial, mode: "initial" } : null;
}
async function startReelsJob() {
  const settings = await readSyncSettings();
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
  await logSpy("facebook", "info", `Reels de ${profileName(profile)}: ${mode === "catchup" ? "buscando os novos desde a última leitura" : "leitura completa"}`
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
    if (done) {
      delete reelsProgress[job.profileId];
      delete reelsCatchup[job.profileId];
    }
    if (error) reelsRetryAt[job.profileId] = now + SPY_RETRY_MS;
    state = { ...state, reelsJob: null, reelsProgress, reelsCatchup, reelsRetryAt };
    await chrome.storage.local.set({ [SPY_STATE_KEY]: state, [SPY_QUEUE_KEY]: queue, ...(spyNext ? { [SPY_KEY]: spyNext } : {}) });
    if (!active || active.removedAt != null) return;
    const what = `Reels de ${profileName(active)}: +${job.added} em ${job.pages} ${job.pages === 1 ? "página" : "páginas"}`;
    if (error) await logSpy("facebook", "warn", `${what} · parou: ${errorText(error)} · tenta de novo em 6 h`);
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
  scheduleFlushSpy();
  if (!page.hasNext || (job.mode === "catchup" && reachedKnown)) return finishReelsJob(next, { done: true });
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
function advanceReelsJob() {
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
    } else if (change.status === "complete" && batch.current) {
      // A profile never read in depth gets its first reading: up to 15 days of
      // grid, a few pages, read by the page itself (the tab is hidden and never
      // scrolls). The batch waits for it.
      const current = batch.current;
      let deep = null;
      if (!r[SPY_STATE_KEY]?.igSeeded?.[spyId("instagram", current)] && !(batch.deepAsked || []).includes(current)) {
        deep = { maxPages: IG_DEEP_PAGES, untilSec: Math.floor(Date.now() / 1000) - IG_DEEP_DAYS * 86400 };
        await holdIgBatchForDeep(current);
      }
      try { await chrome.tabs.sendMessage(tabId, { type: "FBW_SPY_IG_BATCH", usernames: [current], deep }); } catch { /* alarm handles missing bridge */ }
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

async function spyTick({ manual = false } = {}) {
  if (spyTicking) return { ok: false, error: "busy" };
  spyTicking = true;

  try {
    const settings = await readSyncSettings();
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

// initial paint (SW may spin up mid-session)
syncBadge();

// ============================================================================
// VIDEO TRACK CAPTURE + TRANSCRIPTION / DOWNLOAD
// ============================================================================
//
// FB parses the feed AND fetches video segments off the main thread (worker),
// so a content script can't see media URLs. The background SW can: chrome.webRequest
// observes every tab request including worker-issued ones. We capture *.fbcdn.net
// .mp4 DASH track URLs, key them by video_id, and the currently-playing video is
// simply the one whose tracks were requested most recently (max lastSeen).

/** key -> { videoId, xpvId, durationS, audioUrl, videoUrl, videoBitrate, lastSeen }
 *  key = video_id when FB stamps one, else "xpv:<xpv_asset_id>" until aliased. */
const trackRegistry = new Map();
// xpv_asset_id -> video_id, learned from any track that carries BOTH ids. Lets us
// fold an orphaned (video_id:null) audio track into its real video record.
const xpvToVideoId = new Map();
const XPV_CAP = 600;

// The FB tab + video the panel is currently previewing (its in-view video).

function registryKeyFor(track) {
  if (track.videoId) return track.videoId;
  if (track.xpvId && xpvToVideoId.has(track.xpvId))
    return xpvToVideoId.get(track.xpvId);
  if (track.xpvId) return "xpv:" + track.xpvId;
  return null;
}

chrome.webRequest?.onBeforeRequest.addListener(
  (details) => {
    const track = parseFbcdnTrack(details.url);
    if (!track) return;
    // Learn the xpv->video_id alias and migrate any parked orphan audio record
    // into the real video_id record so a later resolve finds the full a/v pair.
    if (track.videoId && track.xpvId && !xpvToVideoId.has(track.xpvId)) {
      xpvToVideoId.set(track.xpvId, track.videoId);
      const orphan = trackRegistry.get("xpv:" + track.xpvId);
      if (orphan) {
        const dest = trackRegistry.get(track.videoId) || {
          videoId: track.videoId,
          xpvId: track.xpvId,
          durationS: orphan.durationS || 0,
          audioUrl: null,
          videoUrl: null,
          videoBitrate: 0,
          lastSeen: 0,
        };
        dest.audioUrl = dest.audioUrl || orphan.audioUrl;
        if (!dest.videoUrl && orphan.videoUrl) {
          dest.videoUrl = orphan.videoUrl;
          dest.videoBitrate = orphan.videoBitrate;
        }
        dest.lastSeen = Math.max(dest.lastSeen, orphan.lastSeen);
        trackRegistry.set(track.videoId, dest);
        trackRegistry.delete("xpv:" + track.xpvId);
      }
    }
    const key = registryKeyFor(track);
    if (!key) return;
    trackRegistry.set(key, foldTrack(trackRegistry.get(key), track, Date.now()));
    if (trackRegistry.size > TRACK_REGISTRY_CAP) pruneTrackRegistry();
    // The alias map can grow several times faster than the registry it's pruned
    // with (many xpv ids alias one video id), so cap it directly too.
    if (xpvToVideoId.size > XPV_CAP)
      for (const k of xpvToVideoId.keys()) {
        xpvToVideoId.delete(k);
        if (xpvToVideoId.size <= XPV_CAP) break;
      }
  },
  // Without `types` this fires for every image/avatar/sticker on Facebook —
  // thousands of dispatches a minute that only ever fail the .mp4 regex, and each
  // one keeps the MV3 service worker awake. Media/XHR only: same tracks, ~95%
  // fewer events.
  { urls: ["*://*.fbcdn.net/*"], types: ["media", "xmlhttprequest", "other"] },
);

// The registry only needs the handful of recently-played videos (a job resolves
// the most-recent match). Without a cap it grew for the whole warm session —
// every scrolled reel adds an entry. Prune the oldest by lastSeen back to CAP,
// and drop any now-dangling xpv→videoId aliases.
const TRACK_REGISTRY_CAP = 300;
function pruneTrackRegistry() {
  const keep = Array.from(trackRegistry.entries())
    .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
    .slice(0, TRACK_REGISTRY_CAP);
  trackRegistry.clear();
  const liveVideoIds = new Set();
  for (const [k, v] of keep) {
    trackRegistry.set(k, v);
    if (v.videoId) liveVideoIds.add(v.videoId);
  }
  for (const [xpv, vid] of xpvToVideoId)
    if (!liveVideoIds.has(vid)) xpvToVideoId.delete(xpv);
}

/** Most recently active (playing) video that has at least an audio track. */
function activeVideoId() {
  let best = null;
  for (const rec of trackRegistry.values()) {
    if (rec.audioUrl && (!best || rec.lastSeen > best.lastSeen)) best = rec;
  }
  return best ? best.videoId : null;
}

function resolveTracks(videoId, candidates, durationHint, primedAt) {
  // 1) Explicit id → ONLY that video's tracks. The content script only fills
  //    videoId when it's CONFIDENT (permalink/URL or a prior duration match) —
  //    a junk markup id here once collided with a real neighbour's id and
  //    transcribed the wrong video.
  if (videoId && trackRegistry.get(videoId)) return trackRegistry.get(videoId);
  // 2) Feed jobs (no trustworthy id anywhere in the post markup — proven
  //    live): prime-window attribution decides — the tracks fetched while the
  //    content script played THIS video. efg duration_s alone is NOT safe
  //    (FB stamps preview-cut durations on full videos); it only breaks ties.
  if (durationHint || primedAt)
    return pickByWindow(trackRegistry.values(), primedAt || 0, durationHint, 2);
  // 3) Candidate ids scraped from the post (FB buries the real video_id in the
  //    markup but not in a clean permalink). Intersect them with what we actually
  //    captured → deterministic match, no crossing to a prefetched neighbour.
  //    Prefer a record with both audio+video, then the most recently fetched.
  if (Array.isArray(candidates) && candidates.length) {
    let best = null;
    for (const id of candidates) {
      const rec = trackRegistry.get(String(id));
      if (!rec || !rec.audioUrl) continue;
      if (!best) {
        best = rec;
        continue;
      }
      const recComplete = !!(rec.audioUrl && rec.videoUrl);
      const bestComplete = !!(best.audioUrl && best.videoUrl);
      if (recComplete !== bestComplete) {
        if (recComplete) best = rec;
      } else if (rec.lastSeen > best.lastSeen) best = rec;
    }
    if (best) return best;
  }
  // 4) Explicit id was given but not captured yet → don't cross to another video.
  if (videoId) return null;
  // 5) No id at all (e.g. FB reels) → best-effort most-recently-active video.
  const id = activeVideoId();
  return id ? trackRegistry.get(id) : null;
}

// ---- transcript store (storage.local) ----
async function getTranscripts() {
  const r = await chrome.storage.local.get(TRANSCRIPTS_KEY);
  return r[TRANSCRIPTS_KEY] || {};
}
// The cap is a SETTING now (Opções → Arquivo), not a constant — see
// lib/transcriptCap.js for why it exists at all and what "unlimited" costs.
// Every transcript write queues behind the previous one. The store is one MAP
// with four writers — the job runner, the metadata backfill, the page's instant
// "running" card and the Library's delete — each doing get → mutate → set. Two of
// those in flight and the slower read wins, dropping the other write: a finished
// transcript overwritten by a running card, a delete resurrecting a record. The
// saved store was fixed this way first; the queue is shared now (lib/serialQueue).
const queueTranscriptWrite = serialQueue();

async function putTranscript(videoId, patch, opts = {}) {
  // Before the queue, not inside it: a thumbnail fetch inside the serial write
  // would stall every other writer behind the network.
  const p = patch && patch.thumb ? { ...patch, thumb: await durableThumb(patch.thumb) } : patch;
  const cap = await readTranscriptCap();
  return queueTranscriptWrite(async () => {
    const all = await getTranscripts();
    // mergeMeta, not a spread: a later write that scraped nothing must not erase
    // metadata an earlier one captured (a reel filed with `counts: null` beside a
    // good author and caption is exactly that bug). `error` is state, not scraped
    // metadata — a running record has to be able to clear a previous failure.
    // `opts.clear` extends that list for a writer that KNOWS a stored value no
    // longer describes the record (the caption path and `language`).
    all[videoId] = {
      ...mergeMeta(all[videoId] || {}, p, { clear: ["error", ...(opts.clear || [])] }),
      videoId,
      updatedAt: Date.now(),
    };
    // Rolling history, newest kept. Thumbs make each record 6–20KB and the
    // Library reads the whole map on every change, which is the cost the user
    // is choosing when they raise this.
    for (const id of idsOverCap(all, cap)) delete all[id];
    await chrome.storage.local.set({ [TRANSCRIPTS_KEY]: all });
    // The hub gets a copy. Fire-and-forget: a backend that is down or unset must
    // never make a local write look like it failed.
    queueForSync("transcripts", videoId).catch(() => {});
    return all[videoId];
  });
}

// The Library's per-item delete and "limpar tudo". Both used to run in the panel
// as its own get → mutate → set (clear-all as a blind `set({}: {})`), racing every
// write above — a job finishing mid-clear put its record straight back.
function removeTranscripts(ids) {
  return queueTranscriptWrite(async () => {
    if (ids && ids.all) {
      await chrome.storage.local.set({ [TRANSCRIPTS_KEY]: {} });
      return -1;
    }
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
    const all = await getTranscripts();
    let removed = 0;
    for (const id of list)
      if (all[id]) {
        delete all[id];
        removed++;
      }
    if (removed) await chrome.storage.local.set({ [TRANSCRIPTS_KEY]: all });
    return removed;
  });
}
// A finished (or failed) job refreshes the Library copy of the same post, if it
// has one. Starring a transcript copies the record as it is at that moment, so a
// star pressed mid-job used to leave the Library card "transcrevendo…" forever.
function refreshSavedTranscript(videoId, record) {
  if (!videoId || !record) return Promise.resolve(false);
  return queueSavedWrite(async () => {
    const id = String(videoId);
    const r = await chrome.storage.local.get(SAVED_KEY);
    const map = r[SAVED_KEY] || {};
    if (!map[id]) return false;
    map[id] = { ...map[id], ...savedTranscriptPatch(record), updatedAt: Date.now() };
    await chrome.storage.local.set({ [SAVED_KEY]: map });
    queueForSync("saved", id).catch(() => {});
    return true;
  });
}

// ---- orphaned jobs ----------------------------------------------------------
// Jobs live in this worker's memory, so none survives a restart of it: an
// extension reload, a browser quit, or Chrome retiring the worker mid-job. Any
// record still "queued"/"running" from BEFORE this boot has nothing behind it —
// file it as interrupted, in both stores, so the cards stop spinning and the hub
// gets the truth. Records written after boot are live jobs (the page's instant
// card can be the very message that woke us) and are left alone.
const SW_BOOT_AT = Date.now();

function sweepOrphanedTranscripts() {
  const tx = queueTranscriptWrite(async () => {
    const all = await getTranscripts();
    const ids = orphanedTranscriptIds(all, SW_BOOT_AT);
    if (!ids.length) return all;
    const now = Date.now();
    for (const id of ids) all[id] = { ...all[id], status: "error", error: TX_INTERRUPTED_ERROR, updatedAt: now };
    await chrome.storage.local.set({ [TRANSCRIPTS_KEY]: all });
    for (const id of ids) queueForSync("transcripts", id).catch(() => {});
    return all;
  });
  // The Library copies: take the transcript's own outcome when there is one,
  // otherwise the same "interrupted".
  return tx.then((transcripts) =>
    queueSavedWrite(async () => {
      const r = await chrome.storage.local.get(SAVED_KEY);
      const map = r[SAVED_KEY] || {};
      const ids = orphanedTranscriptIds(map, SW_BOOT_AT);
      if (!ids.length) return;
      const now = Date.now();
      for (const id of ids) {
        const t = transcripts[id];
        map[id] =
          t && !isActiveTxStatus(t.status)
            ? { ...map[id], ...savedTranscriptPatch(t), updatedAt: now }
            : { ...map[id], status: "error", error: TX_INTERRUPTED_ERROR, updatedAt: now };
      }
      await chrome.storage.local.set({ [SAVED_KEY]: map });
      for (const id of ids) queueForSync("saved", id).catch(() => {});
    }),
  );
}
// Top level, so it is queued ahead of whatever message woke the worker.
sweepOrphanedTranscripts().catch((e) => console.warn("[fbw] varredura de transcrições órfãs:", e));

export { putTranscript, removeTranscripts, sweepOrphanedTranscripts }; // test seam — see background.transcripts.test.js

// ---- offscreen document lifecycle ----
let offscreenReady = false;
let offscreenCreating = null;
const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

async function ensureOffscreen() {
  if (offscreenReady) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["DOM_SCRAPING"],
        justification:
          "Local Whisper transcription and ffmpeg muxing of FB videos.",
      });
    }
    offscreenReady = true;
  })();
  try {
    await offscreenCreating;
  } catch (e) {
    // Only ONE failure means "it's already there": the single-document error, which
    // we race against ourselves. Anything else is a real failure, and swallowing it
    // as ready left offscreenReady=true on a broken state — every later
    // callOffscreen then failed with "no receiver" until the worker restarted.
    const msg = String(e?.message || e);
    const single = /single offscreen document|only one offscreen/i.test(msg);
    let exists = single;
    if (!exists) {
      // Belt and braces: ask, in case the message wording changes.
      try {
        exists = !!(await chrome.offscreen.hasDocument?.());
      } catch {
        exists = false;
      }
    }
    offscreenReady = exists;
    offscreenCreating = null;
    if (!exists) throw new Error("não foi possível abrir o documento offscreen: " + msg);
  } finally {
    offscreenCreating = null;
  }
}

/** Send a request to the offscreen document and await its response. */
function callOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

export function offscreenTranscribeMessage(videoId, audioUrl, language, repetitionPenalty = 1) {
  return {
    action: "transcribeFromAudioUrl",
    videoId,
    audioUrl,
    language: whisperTranscriptLanguage(language),
    repetitionPenalty,
  };
}

// ---- job runners ----
// Parse a WebVTT caption file → { text, chunks:[{timestamp:[start,end], text}] }.
// Mirrors the Whisper chunk shape so the Library's SRT/txt export just works.
function vttTime(t) {
  const m = String(t).trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  const [, h, mm, ss, ms] = m;
  return (+(h || 0)) * 3600 + +mm * 60 + +ss + +("0." + ms);
}
function parseWebVtt(raw) {
  const body = String(raw).replace(/^﻿/, "").replace(/\r/g, "");
  const chunks = [];
  for (const block of body.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const tl = lines.findIndex((l) => l.includes("-->"));
    if (tl < 0) continue;
    const [a, b] = lines[tl].split("-->");
    const text = lines
      .slice(tl + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "") // inline karaoke/style tags
      .replace(/\{[^}]+\}/g, "")
      .trim();
    if (text) chunks.push({ timestamp: [vttTime(a), vttTime(b)], text });
  }
  return { text: chunks.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim(), chunks };
}

/**
 * The scraped-metadata half of a transcript record, as a patch.
 *
 * Both write sites below (caption-first and Whisper) file the same fields, and
 * they were two hand-kept copies of one list — adding a field meant remembering
 * to add it twice, and a record written down the caption path would silently lack
 * whatever the other path had learned to store.
 *
 * Every value is omitted when absent rather than written as null, because
 * `mergeMeta` reads a null as "I didn't see it" and would leave the previous
 * value in place anyway; omitting says the same thing with less noise.
 */
function transcriptMetaPatch(meta = {}) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const {
    thumb, counts, author, caption, platform, sourceUrl,
    // The link SHAPE the post used. Without it a Library card cannot tell a
    // correct /watch/?v= (a real video post) from a legacy reel record — see
    // fbCardLink in src/lib/shared/fbPermalink.js.
    videoKind,
  } = meta;
  // The post's own metadata, all of it already in the caller's hand: Instagram
  // reads taken_at / video_duration / follower_count off the payloads it already
  // parses, and Facebook's durationHint is the honest duration the content script
  // measured on the DOM video. None of this costs a request.
  const takenAt = num(meta.takenAt);
  const followers = num(meta.followers);
  const durationS = num(meta.durationS) ?? num(meta.durationHint);
  return {
    ...(thumb ? { thumb } : {}),
    ...(counts ? { counts } : {}),
    ...(author ? { author } : {}),
    ...(caption ? { caption } : {}),
    ...(platform ? { platform } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(videoKind ? { videoKind } : {}),
    ...(takenAt ? { takenAt } : {}),
    ...(followers ? { followers } : {}),
    ...(durationS && durationS > 0 ? { durationS } : {}),
  };
}

// ---- Whisper jobs, one at a time ------------------------------------------
// Whisper runs in ONE worker. Concurrent jobs used to all go straight to it:
// they interleaved (each slower, so more timeouts), shared the offscreen's single
// "current job" id (one card's progress bar drove another's), and one job timing
// out sent `abortTranscription`, which terminates the worker — killing every
// other job with it. Now they queue here, the record says "queued" while waiting,
// and each job's deadline starts when it actually gets the worker.
const queueWhisper = serialQueue();
const whisperJobs = new Set(); // videoIds queued or running — a double click is one job
// videoId → "it's alive" callback for the running job's stall watchdog, fed by
// the offscreen's FBW_TX_PROGRESS stream (see the message handler).
const txHeartbeats = new Map();

function whisperWithWatchdog(id, message, durationS) {
  const deadline = txDeadlineMs(durationS);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stall = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearTimeout(stall);
      if (txHeartbeats.get(id) === beat) txHeartbeats.delete(id);
      fn(v);
    };
    const hard = setTimeout(
      () => finish(reject, new Error(`transcrição expirou (${fmtDeadline(deadline)}) — tente de novo`)),
      deadline,
    );
    const beat = () => {
      clearTimeout(stall);
      stall = setTimeout(
        () => finish(reject, new Error(`transcrição travou (sem progresso por ${fmtDeadline(TX_STALL_MS)}) — tente de novo`)),
        TX_STALL_MS,
      );
    };
    beat();
    txHeartbeats.set(id, beat);
    callOffscreen(message).then((r) => finish(resolve, r), (e) => finish(reject, e));
  });
}

async function runTranscription(videoId, tabId, meta = {}) {
  // Caption-first: if the platform already ships an ASR/subtitle track (TikTok
  // `subtitleInfos`), download and parse it instead of running Whisper — far
  // faster/cheaper. Whisper stays the fallback when no caption URL is present.
  //
  // `language` is written with the RESULT, never with "running": a re-run of a
  // finished transcript keeps its old text on screen until the new one lands, and
  // stamping the new language at the start labelled that old text wrongly — for
  // good, when the re-run then failed.
  if (meta.captionUrl) {
    const id = videoId;
    // NOT the user's BR/EN pick: Whisper never runs on this path, so the text is
    // whatever language TikTok wrote its own subtitle track in. null when the track
    // is neither of ours — and cleared rather than inherited, so an earlier Whisper
    // run's language can't end up labelling someone else's caption file.
    const captionLang = captionTrackLanguage(meta.captionLang);
    await putTranscript(id, {
      status: "running", error: null,
      ...transcriptMetaPatch(meta),
    });
    try {
      if (isTiktokCdn(meta.captionUrl)) await ensureTiktokReferer();
      const r = await fetch(meta.captionUrl);
      if (!r.ok) throw new Error("caption fetch failed " + r.status);
      const { text, chunks } = parseWebVtt(await r.text());
      if (!text) throw new Error("empty caption");
      // repetitionPenalty cleared like language: Whisper never ran on this text.
      const saved = await putTranscript(
        id,
        {
          status: "done", source: "caption", language: captionLang,
          languageAuto: null, repetitionPenalty: null, text, chunks,
        },
        { clear: ["language", "languageAuto", "repetitionPenalty"] },
      );
      refreshSavedTranscript(id, saved).catch(() => {});
      notifyTab(tabId, { type: "FBW_TRANSCRIBE_RESULT", videoId: id, success: true, text: saved.text, chunks: saved.chunks });
      return;
    } catch (e) {
      // Fall through to Whisper if any audio source could still be resolved.
      // `durationHint`/`primedAt` count: that is the normal Facebook feed shape
      // (candidates are deliberately stripped for feed jobs — neighbour-id
      // poison) and resolveTracks below can still match it against the captured
      // wire tracks. Only give up when there is genuinely nothing to try.
      const canFallBack =
        meta.mediaUrl || meta.candidates || meta.durationHint || meta.primedAt;
      if (!canFallBack) {
        const failed = await putTranscript(id, { status: "error", error: e.message });
        refreshSavedTranscript(id, failed).catch(() => {});
        notifyTab(tabId, { type: "FBW_TRANSCRIBE_RESULT", videoId: id, success: false, error: e.message });
        return;
      }
    }
  }
  // Audio source, cheapest first:
  //   1. a captured DASH audio-only track (small, fast to fetch+decode), then
  //   2. meta.mediaUrl — a progressive MP4 (Instagram always; Facebook when we
  //      read progressive_url off the page for a video we never saw on the wire).
  //      It carries video too, so decoding its audio is heavier — used only as a
  //      fallback so cached videos still transcribe.
  let audioUrl = null;
  let id = videoId;
  const tracks = resolveTracks(videoId, meta.candidates, meta.durationHint, meta.primedAt);
  if (tracks && tracks.audioUrl) {
    audioUrl = tracks.audioUrl;
    id = tracks.videoId;
  } else if (meta.mediaUrl) {
    audioUrl = meta.mediaUrl;
  }
  // TikTok audio comes off the same Referer-gated CDN as its video — install the
  // header rule so the offscreen fetch of the audio doesn't 403.
  if (meta.platform === "tiktok" || isTiktokCdn(audioUrl)) await ensureTiktokReferer();
  if (!audioUrl) {
    notifyTab(tabId, {
      type: "FBW_TRANSCRIBE_RESULT",
      videoId,
      success: false,
      error: "No audio captured yet — let the video play once, then retry.",
    });
    return;
  }
  if (!id) {
    notifyTab(tabId, {
      type: "FBW_TRANSCRIBE_RESULT",
      videoId,
      success: false,
      error: "Couldn't identify the video.",
    });
    return;
  }
  // Already queued or running: the second click is the same job. Its button is
  // released by the first job's result, which carries the same videoId.
  if (whisperJobs.has(id)) return;
  whisperJobs.add(id);
  // The pick, with "auto" resolved from the post's caption (lib/captionLanguage).
  const { language, auto: languageAuto } = resolveTranscriptLanguage(meta.language, meta.caption);
  const waiting = whisperJobs.size > 1;
  await putTranscript(id, {
    status: waiting ? "queued" : "running",
    error: null,
    ...transcriptMetaPatch(meta),
  });
  try {
    await queueWhisper(async () => {
      if (waiting) await putTranscript(id, { status: "running" });
      // Read when the job starts, and filed on the record with the text it
      // produced: the point of storing it is tracing a bad transcript back to the
      // setting in force.
      const repetitionPenalty = txPenaltyValue(await readStoredTxPenalty());
      try {
        await ensureOffscreen();
        // Losing the watchdog used to leave Whisper running: the zombie job kept a
        // core busy, its late reply was dropped, and `inFlight` stayed above zero so
        // the offscreen document could not idle-release. The abort terminates and
        // respawns its worker — and with one job at a time it can only ever take
        // THIS job with it.
        const res = await whisperWithWatchdog(
          id,
          offscreenTranscribeMessage(id, audioUrl, language, repetitionPenalty),
          meta.durationS ?? meta.durationHint,
        ).catch(async (e) => {
          await callOffscreen({ action: "abortTranscription" }).catch(() => {});
          throw e;
        });
        if (!res?.success) throw new Error(res?.error || "Transcription failed");
        // `text` cleared, not merged: a run that heard no speech must say so,
        // not leave a previous run's text standing under the new language.
        const saved = await putTranscript(
          id,
          {
            status: "done",
            language,
            languageAuto,
            repetitionPenalty,
            text: res.text || "",
            chunks: res.chunks || [],
          },
          { clear: ["text"] },
        );
        refreshSavedTranscript(id, saved).catch(() => {});
        notifyTab(tabId, {
          type: "FBW_TRANSCRIBE_RESULT",
          videoId: id,
          success: true,
          text: saved.text,
          chunks: saved.chunks,
        });
      } catch (e) {
        const failed = await putTranscript(id, { status: "error", error: e.message });
        refreshSavedTranscript(id, failed).catch(() => {});
        notifyTab(tabId, {
          type: "FBW_TRANSCRIBE_RESULT",
          videoId: id,
          success: false,
          error: e.message,
        });
      }
    });
  } finally {
    whisperJobs.delete(id);
  }
}

// ---- where downloads land -------------------------------------------------
// The service worker is the only context that actually calls chrome.downloads for
// media/JSON, so it — not the sender — decides the folder. Two shapes arrive:
//
//   • Panels and pin-api.js CAN import lib/downloadPath.js, so they send a FINISHED
//     path, already rooted at social-mate/.
//   • The Facebook / Instagram / TikTok content scripts are import-free on purpose
//     (an ES import makes CRXJS emit a dynamic-import loader, which those origins'
//     CSP can kill — that would break all capture). They send a BARE file name plus
//     `kind`, and `folder` when the bucket isn't just the media kind.
//
// The two are told apart by the ROOT SEGMENT, not by which fields are set: a panel
// sends `kind: "video"` alongside its finished path, so keying off `kind` would run
// an already-rooted path back through downloadPath and produce
// "social-mate/videos/social-mate/videos/tt-x.mp4".
//
// Either way it is impossible for a caller to land a file in the Downloads root.
function resolveDownloadPath(msg, fallbackName) {
  const name = msg.filename || fallbackName;
  // The two shapes are told apart by whether the name carries a SEPARATOR, not by
  // the root segment. It used to compare against the literal "social-mate", which
  // stopped working the moment the folder became a setting (a path under a custom
  // folder looked "bare" and got the folder applied a second time). A content
  // script's bare name never contains a slash; a finished path always does —
  // except under `{folder:"", flat:true}`, where the two shapes are identical and
  // both functions are idempotent anyway.
  const finished = /[\\/]/.test(String(name == null ? "" : name));
  if (finished) return underDownloadRoot(name); // idempotent for a finished path
  return downloadPath(msg.folder || msg.kind || null, name);
}

async function runDownload(videoId, tabId, mediaUrl, candidates, mediaName, durationHint, primedAt) {
  // A direct progressive MP4 (Instagram, or a Facebook reel/video whose
  // progressive_url we read from the page JSON) → download it as-is, no mux.
  if (mediaUrl) {
    try {
      await chrome.downloads.download({
        url: mediaUrl,
        // mediaName arrives already rooted — the FBW_DOWNLOAD handler ran it through
        // downloadPath before calling us. underDownloadRoot is the belt-and-braces
        // guard so this stays safe if a future caller passes a raw name. The no-name
        // fallback is the Instagram case: the IG bridge is the only sender that omits
        // a name, and it always hands us a progressive MP4.
        filename: underDownloadRoot(
          mediaName || downloadPath("video", `ig-${videoId || Date.now()}.mp4`),
        ),
      });
      notifyTab(tabId, { type: "FBW_DOWNLOAD_RESULT", videoId, success: true });
    } catch (e) {
      notifyTab(tabId, {
        type: "FBW_DOWNLOAD_RESULT",
        videoId,
        success: false,
        error: e.message,
      });
    }
    return;
  }
  // Facebook = DASH split → mux the captured tracks in the offscreen ffmpeg.
  const tracks = resolveTracks(videoId, candidates, durationHint, primedAt);
  if (!tracks || !tracks.videoUrl) {
    notifyTab(tabId, {
      type: "FBW_DOWNLOAD_RESULT",
      videoId,
      success: false,
      error: "No video captured yet — let it play once, then retry.",
    });
    return;
  }
  const id = tracks.videoId;
  try {
    await ensureOffscreen();
    const res = await callOffscreen({
      action: "muxDownload",
      videoId: id,
      videoUrl: tracks.videoUrl,
      audioUrl: tracks.audioUrl,
    });
    if (!res?.success) throw new Error(res?.error || "Download failed");
    // offscreen minted a blob: URL (valid while the offscreen doc is alive) — no
    // base64 round-trip. Hand it straight to chrome.downloads.
    await chrome.downloads.download({
      url: res.blobUrl,
      // The offscreen doc returns a BARE name — it muxes bytes, it doesn't decide
      // where files live. A DASH mux is always a Facebook video, so the folder is
      // known here.
      filename: downloadPath("video", res.filename || `fb-${id}.mp4`),
    });
    notifyTab(tabId, {
      type: "FBW_DOWNLOAD_RESULT",
      videoId: id,
      success: true,
    });
  } catch (e) {
    notifyTab(tabId, {
      type: "FBW_DOWNLOAD_RESULT",
      videoId: id,
      success: false,
      error: e.message,
    });
  }
}

function notifyTab(tabId, msg) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// Tab awareness: when the user switches to a Facebook tab, ping it. If its content
// script answers, it re-publishes its in-view video (no hint). If it doesn't (tab
// loaded before the extension, or not yet injected), flag the panel to reload it.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!/^https?:\/\/[^/]*\.(facebook|instagram)\.com\//.test(tab.url || ""))
    return; // FB/IG tabs
  chrome.tabs
    .sendMessage(tabId, { type: "FBW_PING" })
    .then(() => chrome.storage.local.set({ [NEED_RELOAD_KEY]: false }))
    .catch(() => chrome.storage.local.set({ [NEED_RELOAD_KEY]: true }));
});

// ---- JSON exports ----
// Service workers have no URL.createObjectURL, so JSON files go out as a data:
// URL. It must be built through TextEncoder — btoa() alone throws on the emoji in
// comment text, which would silently lose exactly the exports worth reading.
// Bytes -> base64 lives in lib/thumbCache.js now — the thumbnail cache needs the
// same encoder, and this was already the second copy.

function jsonDataUrl(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
  return "data:application/json;base64," + bytesToBase64(bytes);
}

// ---- image downloads ------------------------------------------------------
// Images used to go out as a base64 data: URL too, which for a photo means the
// bytes, the binary string and the base64 string resident at once — ~3x the file,
// every time. The offscreen document HAS URL.createObjectURL, so it fetches and
// hands back a blob: URL (see fetchToBlobUrl there) and only the bytes exist.
//
// TikTok used to be excluded here on the suspicion that the declarativeNetRequest
// Referer rule might not reach a fetch issued by our own offscreen document. It
// does: a fetch from an extension page returns the real 200 + video/mp4 where
// chrome.downloads.download() on the same URL returns 403 + text/html. That is
// the ONLY route that works for TikTok media, so it is no longer an exclusion —
// it is the reason this function exists.

// downloadId -> blob: URL to release once the item stops being in_progress.
// chrome.downloads.download resolves when the item is CREATED, so revoking then
// would be racing the bytes; and leaving it to the offscreen idle release means a
// 100-photo save holds all 100 blobs at once.
const blobUrlByDownloadId = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current === "in_progress") return;
  const blobUrl = blobUrlByDownloadId.get(delta.id);
  if (!blobUrl) return;
  blobUrlByDownloadId.delete(delta.id);
  callOffscreen({ action: "revokeBlobUrl", blobUrl }).catch(() => {});
});

// chrome.downloads.download() RESOLVES WHEN THE ITEM IS CREATED, not when the
// bytes land — so a server that answers 403 reports success to the caller and
// leaves an error page on disk under the name we asked for. That is exactly how
// TikTok videos were arriving as .html: 403, `text/html`, 502 bytes, and a green
// tick in the panel.
//
// So: wait for the item to leave `in_progress` and surface the real failure.
// The cap exists because this must not outlive a genuinely long download — a
// rejected request fails within a second or two, so anything still running at
// the cap is a download that is working, and we let it finish unwatched.
const DOWNLOAD_VERIFY_MS = 30000;
function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      fn(arg);
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state || delta.state.current === "in_progress") return;
      if (delta.state.current === "complete") return finish(resolve);
      // `delta.error` is only present when the error itself changed in this
      // event, so read the item for the reason rather than trusting the delta.
      chrome.downloads
        .search({ id })
        .then((items) => finish(reject, new Error((items[0] && items[0].error) || "download interrompido")))
        .catch(() => finish(reject, new Error("download interrompido")));
    };
    const timer = setTimeout(() => finish(resolve), DOWNLOAD_VERIFY_MS);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// The worker-side route: fetch the bytes here (the DNR Referer rule DOES apply to
// a fetch from the service worker) and hand chrome.downloads a data: URL, which
// it reads out of the string instead of going back to the network. Costs a base64
// copy of the file, which is why it is the fallback and not the first choice.
async function downloadFetchedBytes(msg, filename, defaultType) {
  let res = await fetch(msg.url).catch(() => null);
  if ((!res || !res.ok) && msg.fallbackUrl) res = await fetch(msg.fallbackUrl).catch(() => null);
  if (!res || !res.ok) throw new Error("fetch failed " + (res ? res.status : "network"));
  const buf = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") || defaultType;
  const id = await chrome.downloads.download({ url: `data:${type};base64,${bytesToBase64(buf)}`, filename });
  await waitForDownload(id);
}

/** Returns false when the offscreen route produced no download — the caller then
 *  falls back to the data: URL path rather than losing the file. */
async function downloadViaOffscreen(msg, filename) {
  try {
    await ensureOffscreen();
    const res = await callOffscreen({
      action: "fetchToBlobUrl",
      url: msg.url,
      fallbackUrl: msg.fallbackUrl,
    });
    if (!res?.success || !res.blobUrl) return false;
    const id = await chrome.downloads.download({ url: res.blobUrl, filename });
    blobUrlByDownloadId.set(id, res.blobUrl);
    return true;
  } catch {
    // Whatever failed (no offscreen document, a dead CDN link, a bad filename) the
    // fallback re-runs it here and reports the real error. The blob, if one was
    // minted, is covered by the offscreen document's own revocation timers.
    return false;
  }
}


// Voice extraction is a download job; it never writes to the transcript library.
const voiceJobs = createVoiceJobs({
  ensureOffscreen,
  callOffscreen,
  notifyTab,
  download: (options) => chrome.downloads.download(options),
  trackDownload: (id, url) => {
    blobUrlByDownloadId.set(id, url);
    // A tiny MP3 can finish before the onChanged listener sees its mapping.
    chrome.downloads.search({ id }).then((items) => {
      if (items[0]?.state !== "in_progress" && blobUrlByDownloadId.get(id) === url) {
        blobUrlByDownloadId.delete(id);
        callOffscreen({ action: "revokeBlobUrl", blobUrl: url }).catch(() => {});
      }
    }).catch(() => {});
  },
  release: (blobUrl) => callOffscreen({ action: "revokeBlobUrl", blobUrl }),
});

// ---- message router (content + panel) ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ignore messages addressed to the offscreen document
  if (msg?.target === "offscreen") return false;

  switch (msg?.type) {
    // offscreen → bg: no jobs in flight, runtimes terminated. Close the document so
    // the WASM heaps (Whisper ~180 MB + MiniLM + ffmpeg) are actually returned to the
    // OS; WASM memory only shrinks by being discarded. Next job re-creates it.
    case "FBW_OFFSCREEN_IDLE": {
      // REFUSE while a download is still reading a blob: URL the offscreen document
      // owns. The idle timer arms as soon as fetchToBlobUrl RETURNS, which is before
      // chrome.downloads has finished writing — and closing the document revokes the
      // blob out from under an in-flight write. Reachable with "ask where to save
      // each file" on: leave the dialog open past the 45s idle window and the file
      // fails with an ok:true already sent. The offscreen re-arms its own timer, so
      // declining here just defers the release.
      if (blobUrlByDownloadId.size > 0) return false;
      (async () => {
        try {
          if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
        } catch {
          /* already gone */
        }
        offscreenReady = false;
      })();
      return false;
    }
    // panel → bg: bring ONE tab's content scripts back (re-inject, else reload)
    // and report what happened. The panel keeps its buttons enabled and shows
    // this result either way — the whole point is that a failed recovery is as
    // visible as a successful one.
    case "FBW_REVIVE_TAB": {
      (async () => {
        const res = await reviveTab(msg.tabId);
        if (res.ok) await markTabHealthy();
        sendResponse(res);
      })();
      return true; // async
    }
    case "FBW_RELOAD_TAB": {
      // The Library's stale-tab hint. Now routed through the same recovery as
      // the panel banner, so it re-injects (page state preserved) before
      // resorting to a reload — and clears the hint once the tab answers, which
      // a bare reload never did. Returning true keeps the worker alive for the
      // wait; the caller ignores the response.
      (async () => {
        const [t] = await chrome.tabs
          .query({ active: true, lastFocusedWindow: true })
          .catch(() => []);
        if (!t || !/(facebook|instagram)\.com/.test(t.url || "")) {
          sendResponse({ ok: false, error: "nenhuma aba compatível ativa" });
          return;
        }
        const res = await reviveTab(t.id);
        if (res.ok) await markTabHealthy();
        sendResponse(res);
      })();
      return true; // async
    }
    // The page's instant Library card, written the moment Transcribe is clicked.
    // It used to be a get → mutate → set from the content script, i.e. a fourth
    // racer on the transcript map; now it queues with every other write.
    case "FBW_TRANSCRIPT_PUT": {
      (async () => {
        const all = await getTranscripts();
        const prev = all[msg.videoId];
        if (!msg.videoId || (prev && prev.status === "done")) return; // never clobber a finished one
        // `language` is dropped: it is the PICK (maybe "auto"), and a record's
        // language is written with its result — stamped here it relabelled the
        // text of an earlier run that is still on the card.
        const { language: _pick, ...record } = msg.record || {};
        await putTranscript(msg.videoId, { ...record, status: record.status || "running" });
      })();
      return false;
    }
    // Library delete / "limpar tudo" (the panel used to write the map itself).
    case "FBW_TRANSCRIPT_REMOVE": {
      (async () => {
        const n = await removeTranscripts(msg.all ? { all: true } : msg.ids);
        sendResponse({ removed: n });
      })();
      return true; // async
    }
    // Late metadata from the page (counts hydrate after the job was requested).
    // Patches an EXISTING record only — a patch must never mint a record under an
    // id the transcription pipeline decided not to use — and fills gaps only.
    case "FBW_META_PATCH": {
      (async () => {
        const all = await getTranscripts();
        const prev = all[msg.videoId];
        if (!prev || prev.counts) return; // already has them — a patch never overwrites
        await putTranscript(msg.videoId, { counts: msg.counts || null });
      })();
      return false;
    }
    case "FBW_EXTRACT_VOICE": {
      voiceJobs.start(msg, sender.tab?.id).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case "FBW_CANCEL_VOICE": {
      voiceJobs.cancel(msg.jobId, sender.tab?.id).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case "FBW_GET_VOICE_STATUS": {
      sendResponse({ job: voiceJobs.status(sender.tab?.id) });
      return false;
    }
    // The offscreen's Whisper progress stream. The panel draws it; here every
    // message is proof of life for the running job's stall watchdog.
    case "FBW_TX_PROGRESS": {
      if (sender.url === chrome.runtime.getURL(OFFSCREEN_PATH)) txHeartbeats.get(msg.videoId)?.();
      return false;
    }
    case "FBW_VOICE_PROGRESS": {
      if (sender.url === chrome.runtime.getURL(OFFSCREEN_PATH)) voiceJobs.progress(msg);
      return false;
    }
    case "FBW_VOICE_COMPLETE": {
      if (sender.url === chrome.runtime.getURL(OFFSCREEN_PATH))
        voiceJobs.complete(msg).catch((e) => console.error("[fbw] voice download:", e));
      return false;
    }
    case "FBW_TRANSCRIBE": {
      runTranscription(msg.videoId, sender.tab?.id, {
        thumb: msg.thumb,
        counts: msg.counts,
        author: msg.author,
        caption: msg.caption,
        platform: msg.platform,
        sourceUrl: msg.sourceUrl,
        videoKind: msg.videoKind,
        // Post metadata the caller already had — see transcriptMetaPatch.
        takenAt: msg.takenAt,
        followers: msg.followers,
        durationS: msg.durationS,
        language: msg.language,
        mediaUrl: msg.mediaUrl,
        captionUrl: msg.captionUrl, // caption-first (TikTok subtitleInfos webvtt)
        captionFormat: msg.captionFormat,
        captionLang: msg.captionLang, // the TRACK's own language, not the user's pick
        // Feed post markup embeds NEIGHBOURING videos' ids — candidates from a
        // feed job are poison, refuse them even if a buggy/stale content
        // script sends some.
        candidates: msg.feedSurface ? null : msg.candidates,
        durationHint: msg.durationHint,
        primedAt: msg.primedAt,
      });
      sendResponse({ started: true });
      return false;
    }
    case "FBW_DOWNLOAD": {
      runDownload(
        msg.videoId,
        sender.tab?.id,
        msg.mediaUrl,
        msg.feedSurface ? null : msg.candidates,
        // The FB rail sends a bare "fb-<id>.mp4"; the IG bridge sends no name at all
        // (its progressive MP4 is always Instagram). The folder is decided here, not
        // by the content script — neither of them can import downloadPath.
        msg.mediaName ? downloadPath("video", msg.mediaName) : null,
        msg.durationHint,
        msg.primedAt,
      );
      sendResponse({ started: true });
      return false;
    }
    // content → bg: "which captured video is this DOM <video>?" — duration-keyed
    // lookup so a feed post with no permalink id still gets a deterministic
    // record id (and can then find its media in the page's embedded JSON).
    case "FBW_MATCH_TRACKS": {
      const rec = pickByWindow(trackRegistry.values(), msg.primedAt || 0, msg.durationHint, 2);
      sendResponse({ videoId: rec ? rec.videoId : null });
      return false;
    }
    // panel/content → bg: the ONLY writer of fbw_saved. Serialized here so two
    // toggles in flight (panel + page overlay, or two tabs) can't lose an update.
    // Replies { ok, saved } — `saved` is the state AFTER the toggle, so the caller
    // paints the bookmark from the truth instead of guessing.
    case "FBW_SAVED_TOGGLE": {
      toggleSaved(msg.entry)
        .then((saved) => sendResponse({ ok: true, saved }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    // Insert-or-refresh (auto-capture "favoritar"). Never removes, unlike TOGGLE.
    case "FBW_SAVED_UPSERT": {
      upsertSaved(msg.entry, msg.merge !== false)
        .then(() => sendResponse({ ok: true, saved: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    // panel → bg: repair the records whose signed thumbnail URL has expired.
    // `brokenIds` is what the panel watched fail in an <img>, which catches the
    // links that died without an expiry stamp.
    case "FBW_THUMB_RECOVER": {
      recoverThumbs({ brokenIds: msg.brokenIds })
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    // A panel opened mid-sweep has missed the progress messages so far.
    case "FBW_THUMB_STATUS": {
      sendResponse({ ok: true, ...thumbSweep });
      return false;
    }
    // panel → bg: hub sync. Push-only; see the notes above flushSync.
    case "FBW_SYNC_PING": {
      (async () => {
        try {
          const settings = msg.settings ? syncSettings(msg.settings) : await readSyncSettings();
          const r = await pingSync(settings);
          sendResponse({ ok: true, ...r });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e), status: e?.status || 0 });
        }
      })();
      return true;
    }
    case "FBW_SYNC_ALL": {
      syncAll()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "FBW_SYNC_NOW": {
      flushSync({ manual: true })
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "FBW_SPY_OBSERVE": {
      serializeIg(() => observeIgProfile(msg, sender)).then(sendResponse, () => sendResponse({ ok: false, error: "network" }));
      return true;
    }
    case "FBW_SPY_IG_DEEP_DONE": {
      finishIgDeep(msg, sender).then(sendResponse, () => sendResponse({ ok: false, error: "storage" }));
      return true;
    }
    case "FBW_SPY_POSTS": {
      receiveIgPosts(msg, sender).then(sendResponse, () => sendResponse({ ok: false, error: "storage" }));
      return true;
    }
    // panel → bg: Spy area operations
    case "FBW_SPY_SAVE": {
      (async () => {
        try {
          let platform = msg.platform;
          let key = msg.key;
          if (msg.url) {
            const parsed = parseProfileUrl(msg.url);
            if (!parsed) {
              sendResponse({ ok: false, error: "invalid_profile" });
              return;
            }
            platform = parsed.platform;
            key = parsed.key;
          }
          if (!platform || !key) {
            sendResponse({ ok: false, error: "invalid_profile" });
            return;
          }

          const id = spyId(platform, key);
          const now = Date.now();

          await mutateSpy(async () => {
            const r = await chrome.storage.local.get([SPY_QUEUE_KEY, SPY_KEY, SPY_STATE_KEY]);
            const queue = r[SPY_QUEUE_KEY] || emptySpyQueue();
            const spy = r[SPY_KEY] || { profiles: {} };
            const state = r[SPY_STATE_KEY] || emptySpyState(now);

            const nextQueue = queueOp(queue, "save", { platform, key, id }, now);

            // Re-added or newly added: MUST start from 0 with no cached measurements!
            const prev = spy.profiles?.[id] || {};
            const nextSpy = {
              ...spy,
              profiles: {
                ...(spy.profiles || {}),
                [id]: {
                  id,
                  platform,
                  key: String(key).toLowerCase(),
                  name: prev.name || null,
                  userId: prev.userId || null,
                  savedAt: now,
                  listUpdatedAt: now,
                  removedAt: null,
                  lastMeasuredAt: null,
                  hasAvatar: false,
                },
              },
            };

            const nextAttempts = { ...(state.attempts || {}) };
            delete nextAttempts[id];
            const nextState = {
              ...state,
              attempts: nextAttempts,
            };

            await chrome.storage.local.set({
              [SPY_QUEUE_KEY]: nextQueue,
              [SPY_KEY]: nextSpy,
              [SPY_STATE_KEY]: nextState,
            });

          });

          const upload = await flushSpy();
          scheduleSpy().catch(() => {});

          sendResponse(upload.rejected?.includes(id) ? { ok: false, error: upload.error } : { ok: true, id });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
    case "FBW_SPY_REMOVE": {
      (async () => {
        try {
          const id = msg.id;
          if (!id) {
            sendResponse({ ok: false, error: "missing_id" });
            return;
          }

          const now = Date.now();
          await mutateSpy(async () => {
            const r = await chrome.storage.local.get([SPY_QUEUE_KEY, SPY_KEY, SPY_STATE_KEY]);
            const queue = r[SPY_QUEUE_KEY] || emptySpyQueue();
            const spy = r[SPY_KEY] || { profiles: {} };
            const state = r[SPY_STATE_KEY] || emptySpyState(now);

            const split = id.indexOf(":");
            const platform = id.slice(0, split);
            const key = id.slice(split + 1);
            let nextQueue = queueOp(queue, "remove", { id, platform, key }, now);

            // Clean pending snapshots, errors and profile patches for this id
            if (nextQueue.snapshots) {
              const cleanedSnaps = { ...nextQueue.snapshots };
              for (const k of Object.keys(cleanedSnaps)) {
                if (k.startsWith(`${id}|`)) delete cleanedSnaps[k];
              }
              nextQueue = { ...nextQueue, snapshots: cleanedSnaps };
            }
            if (nextQueue.errors?.[id]) {
              const cleanedErrors = { ...nextQueue.errors };
              delete cleanedErrors[id];
              nextQueue = { ...nextQueue, errors: cleanedErrors };
            }
            if (nextQueue.profiles?.[id]) {
              const cleanedProfiles = { ...nextQueue.profiles };
              delete cleanedProfiles[id];
              nextQueue = { ...nextQueue, profiles: cleanedProfiles };
            }

            const nextProfiles = { ...(spy.profiles || {}) };
            delete nextProfiles[id];
            const nextSpy = {
              ...spy,
              profiles: nextProfiles,
            };

            const nextAttempts = { ...(state.attempts || {}) };
            delete nextAttempts[id];
            const nextState = {
              ...state,
              attempts: nextAttempts,
              measuring: state.measuring?.id === id ? null : state.measuring,
            };

            await chrome.storage.local.set({
              [SPY_QUEUE_KEY]: nextQueue,
              [SPY_KEY]: nextSpy,
              [SPY_STATE_KEY]: nextState,
            });

          });

          const upload = await flushSpy();
          scheduleSpy().catch(() => {});

          sendResponse(upload.rejected?.includes(id) ? { ok: false, error: upload.error } : { ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
    case "FBW_SPY_MEASURE_ONE": {
      (async () => {
        try {
          const id = msg.id;
          if (!id) {
            sendResponse({ ok: false, error: "missing_id" });
            return;
          }
          const r = await chrome.storage.local.get(SPY_KEY);
          const spy = r[SPY_KEY] || { profiles: {} };
          const profile = spy.profiles?.[id];
          if (!profile || profile.removedAt != null) {
            sendResponse({ ok: false, error: "not_found" });
            return;
          }

          if (profile.platform === "facebook") {
            const res = await measureFbProfile(profile, "visit", fetch, { force: true });
            sendResponse(res);
          } else {
            sendResponse({ ok: false, code: "passive_only", error: "No Instagram, abra o perfil para medir pela captura passiva." });
          }
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
    case "FBW_SPY_REFRESH_LIST": {
      (async () => {
        try {
          const settings = await readSyncSettings();
          if (!isSyncConfigured(settings)) {
            sendResponse({ ok: false, error: "acervo não configurado" });
            return;
          }
          const res = await getSpyProfiles(settings);
          const nextSpy = await mutateSpy(async () => {
            const r = await chrome.storage.local.get([SPY_KEY, SPY_QUEUE_KEY]);
            const currentSpy = r[SPY_KEY] || { profiles: {} };
            const queue = r[SPY_QUEUE_KEY] || emptySpyQueue();
            const nextSpy = mergeList(currentSpy, res?.profiles || [], queue.ops || []);
            await chrome.storage.local.set({ [SPY_KEY]: nextSpy });
            return nextSpy;
          });

          scheduleSpy().catch(() => {});
          sendResponse({ ok: true, count: Object.keys(nextSpy.profiles || {}).length });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
    case "FBW_SPY_RUN": {
      (async () => {
        try {
          const res = await spyTick({ manual: true });
          sendResponse(res);
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
    case "FBW_SAVED_REMOVE": {
      removeSaved(msg.ids ?? msg.id)
        .then((removed) => sendResponse({ ok: true, removed }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    // content → bg: an arbitrary JSON payload → file on disk (comment scrapes).
    // The SW has no URL.createObjectURL, so route through jsonDataUrl
    // (TextEncoder → base64 data URL, emoji-safe).
    case "FBW_DL_JSON": {
      // The download must be AWAITED. Un-awaited, a bad filename or data URL
      // rejected unobserved and the sender still got {ok:true} — the exact reason a
      // failed comment export looked like a successful one.
      (async () => {
        try {
          await chrome.downloads.download({
            url: jsonDataUrl(msg.data),
            filename: resolveDownloadPath(msg, `export-${Date.now()}.json`),
            saveAs: false,
            conflictAction: "uniquify",
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true; // async responder
    }
    // content → bg → offscreen: niche-relevance (+ spam) cosine for a post.
    // Fails open (score 1, spam 0) so a model hiccup never blocks the warmer.
    case "FBW_RELEVANCE": {
      (async () => {
        try {
          await ensureOffscreen();
          const res = await callOffscreen({
            action: "relevanceScore",
            keyword: msg.keyword,
            text: msg.text,
            spam: msg.spam,
          });
          sendResponse(
            res?.success
              ? { score: res.score, spam: res.spam }
              : { score: 1, spam: 0, error: res?.error },
          );
        } catch (e) {
          sendResponse({ score: 1, spam: 0, error: e.message });
        }
      })();
      return true; // async
    }
    // panel → bg: download IG media. video = direct URL; image = fetched with our
    // host permissions (bypasses page CORS) and saved from a blob: URL minted in
    // the offscreen document, TikTok excepted. Carousels arrive one msg/child.
    case "FBW_DL_MEDIA": {
      (async () => {
        try {
          // TikTok media (video or thumbnail) needs the Referer header injected.
          if (isTiktokCdn(msg.url)) await ensureTiktokReferer();
          const filename = resolveDownloadPath(msg, `media-${Date.now()}`);
          if (msg.kind === "video") {
            // A TikTok video CANNOT be fetched by chrome.downloads: that request
            // is browser-initiated, so our DNR rule never sees it, the CDN
            // answers 403 with an HTML error body, and Chrome saves that body
            // under a .html name. An extension-page fetch does carry the header,
            // so mint a blob there and download the blob instead.
            //
            // Everything else keeps the direct download on purpose: it streams to
            // disk, where the blob route would hold the whole file in memory
            // first — fine for a 12 MB TikTok clip, not for a long FB video.
            if (isTiktokCdn(msg.url)) {
              if (await downloadViaOffscreen(msg, filename)) {
                sendResponse({ ok: true });
                return;
              }
              // No offscreen document (or it failed): same bytes, via the worker.
              await downloadFetchedBytes(msg, filename, "video/mp4");
              sendResponse({ ok: true });
              return;
            }
            const id = await chrome.downloads.download({ url: msg.url, filename });
            await waitForDownload(id);
            sendResponse({ ok: true });
            return;
          }
          if (await downloadViaOffscreen(msg, filename)) {
            sendResponse({ ok: true });
            return;
          }
          await downloadFetchedBytes(msg, filename, "image/jpeg");
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
    default:
      return false;
  }
});

export { scheduleSpy, flushSpy, spyTick, measureFbProfile, advanceReelsJob }; // test seam

