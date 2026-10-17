// Instagram research export: the worker side of the Instagram Scraper
// destinations (replaces the old "IG Market Research Bridge" extension).
//
// Captures are turned into events elsewhere (lib/igExportFormat.js, task T4) and
// handed to `enqueueIgEvents`. This module owns the outbox flushes, their
// retries and the presence beacon, and registers its chrome listeners exactly
// once per worker. Disabling a destination closes its socket and stops sending,
// but its unconfirmed events stay in the outbox.

import { IG_DESTINATIONS_KEY, enabledIgDestinations, igDestination } from "../lib/igDestinations.js";
import { IG_DELIVERY_KEY, createIgOutbox } from "../lib/igOutbox.js";
import { createIgPresence } from "../lib/igPresence.js";
import { backoffDelay } from "../lib/syncClient.js";
import { toIgExportEvents, transcriptEvent } from "../lib/igExportFormat.js";

export const IG_EXPORT_ALARM = "fbw-ig-export";
const FLUSH_DEBOUNCE_MS = 4000;
const MAX_CAPTURE_ITEMS = 1000;
const INSTAGRAM_PAGE = /^https:\/\/([a-z0-9-]+\.)*instagram\.com\//i;

const isRecordList = (v) =>
  Array.isArray(v) && v.length <= MAX_CAPTURE_ITEMS && v.every((x) => x && typeof x === "object" && !Array.isArray(x));

/**
 * FBW_IG_CAPTURE comes from the Instagram bridge. Only this extension's own
 * content script, in an Instagram tab, may feed the research outbox; anything
 * else (or a malformed payload) is ignored. Returns the capture or null.
 */
export function acceptIgCapture(msg, sender, runtimeId) {
  if (!sender || sender.id !== runtimeId) return null;
  if (!INSTAGRAM_PAGE.test(String(sender.tab?.url || ""))) return null;
  const posts = msg?.posts ?? [];
  const comments = msg?.comments ?? [];
  const postsByCode = msg?.postsByCode ?? {};
  if (!isRecordList(posts) || !isRecordList(comments)) return null;
  if (!postsByCode || typeof postsByCode !== "object" || Array.isArray(postsByCode)) return null;
  return { posts, comments, postsByCode };
}

/**
 * Factory so the wiring is testable with a chrome stub; background.js uses the
 * default instance below.
 */
export function createIgExport({ chrome: c, WebSocketImpl, fetchImpl, version = "" }) {
  const storage = {
    get: (key) => c.storage.local.get(key),
    set: (obj) => c.storage.local.set(obj),
  };

  async function settings() {
    const r = await c.storage.local.get(IG_DESTINATIONS_KEY);
    return r[IG_DESTINATIONS_KEY];
  }

  const outbox = createIgOutbox({
    storage,
    fetchImpl,
    destination: async (id) => igDestination(await settings(), id),
  });

  async function deliveryState() {
    const r = await c.storage.local.get(IG_DELIVERY_KEY);
    return r[IG_DELIVERY_KEY] || {};
  }

  const presence = createIgPresence({
    WebSocketImpl,
    version,
    ua: globalThis.navigator?.userAgent || "",
    destinations: async () => enabledIgDestinations(await settings()),
    stats: async (id) => {
      const st = (await deliveryState())[id] || {};
      return { queueLen: st.pending || 0, sent: st.totalSent || 0, failed: st.rejected || 0, lastError: st.error || "" };
    },
  });

  const timers = new Map(); // destId → timeout
  const attempts = new Map(); // destId → consecutive retryable failures

  function schedule(destId, delay = FLUSH_DEBOUNCE_MS) {
    clearTimeout(timers.get(destId));
    timers.set(
      destId,
      setTimeout(() => {
        timers.delete(destId);
        flushIgDestination(destId).catch(() => {});
      }, delay),
    );
  }

  async function flushIgDestination(destId) {
    const res = await outbox.flush(destId);
    if (res.skipped) return res;
    if (res.ok) {
      attempts.delete(destId);
      if (res.sent) {
        const st = (await deliveryState())[destId] || {};
        await addTotalSent(destId, (st.totalSent || 0) + res.sent);
      }
    } else if (res.retryable) {
      const n = attempts.get(destId) || 0;
      attempts.set(destId, n + 1);
      // The one-minute alarm is the backstop after these.
      if (n < 4) schedule(destId, backoffDelay(n));
    }
    return res;
  }

  async function addTotalSent(destId, totalSent) {
    const r = await c.storage.local.get(IG_DELIVERY_KEY);
    const all = r[IG_DELIVERY_KEY] || {};
    all[destId] = { ...(all[destId] || {}), totalSent };
    await c.storage.local.set({ [IG_DELIVERY_KEY]: all });
  }

  /** New capture events → every destination enabled right now. */
  async function enqueueIgEvents(events) {
    const targets = enabledIgDestinations(await settings());
    if (!targets.length || !events?.length) return { added: 0, full: [], destinations: [] };
    const res = await outbox.enqueue(
      events,
      targets.map((t) => t.id),
    );
    for (const t of targets) schedule(t.id);
    return { ...res, destinations: targets.map((t) => t.id) };
  }

  /** A validated bridge capture → events → outbox. */
  function enqueueCapture(capture, observedAt = Date.now()) {
    const events = toIgExportEvents(capture, { observedAt, postsByCode: capture.postsByCode });
    return enqueueIgEvents(events);
  }

  /** A finished Instagram transcript (fbw_transcripts record) → outbox. */
  function enqueueTranscript(record) {
    const ev = transcriptEvent(record);
    return ev ? enqueueIgEvents([ev]) : Promise.resolve({ added: 0, full: [], destinations: [] });
  }

  /** Alarm/wake path: beacon up, and every enabled destination drained. */
  async function tick() {
    await presence.ensure().catch(() => {});
    const state = await deliveryState();
    const counts = await outbox.counts();
    for (const t of enabledIgDestinations(await settings())) {
      if (state[t.id]?.authFailed) continue; // waits for a config change
      if ((counts[t.id]?.pending || 0) > 0) flushIgDestination(t.id).catch(() => {});
    }
  }

  async function onConfigChanged() {
    // A new token may fix a refused one: clear the pause, then retry.
    const r = await c.storage.local.get(IG_DELIVERY_KEY);
    const all = r[IG_DELIVERY_KEY] || {};
    for (const id of Object.keys(all)) all[id] = { ...all[id], authFailed: false };
    await c.storage.local.set({ [IG_DELIVERY_KEY]: all });
    const enabled = new Set(enabledIgDestinations(await settings()).map((t) => t.id));
    for (const [id, timer] of timers) {
      if (!enabled.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }
    attempts.clear();
    await tick();
  }

  let registered = false;
  function init() {
    if (registered) return;
    registered = true;
    c.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[IG_DESTINATIONS_KEY]) onConfigChanged().catch(() => {});
    });
    c.runtime.onStartup?.addListener(() => tick().catch(() => {}));
    c.alarms?.get?.(IG_EXPORT_ALARM)?.then?.((a) => {
      if (!a) c.alarms.create(IG_EXPORT_ALARM, { periodInMinutes: 1 });
    });
    tick().catch(() => {});
  }

  /** "Testar conexão": an empty batch checks address, token and backend version without storing anything. */
  async function testDestination(id) {
    const dest = igDestination(await settings(), id);
    if (!dest) return { ok: false, error: "endereço e token primeiro" };
    let r;
    try {
      r = await fetchImpl(`${dest.url}/ingest/socialmate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${dest.token}` },
        body: JSON.stringify({ schemaVersion: 1, batchId: `test-${Date.now()}`, items: [] }),
      });
    } catch {
      return { ok: false, error: "sem conexão" };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, error: "token recusado" };
    if (r.status === 404) return { ok: false, error: "o backend não tem /ingest/socialmate (versão antiga)" };
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  }

  async function status() {
    return {
      destinations: enabledIgDestinations(await settings()).map((t) => t.id),
      delivery: await deliveryState(),
      counts: await outbox.counts(),
      presence: presence.status(),
    };
  }

  return {
    init,
    tick,
    enqueueIgEvents,
    enqueueCapture,
    enqueueTranscript,
    flushIgDestination,
    ensureIgPresence: () => presence.ensure(),
    rejected: (id) => outbox.rejected(id),
    testDestination,
    status,
    onConfigChanged,
  };
}
