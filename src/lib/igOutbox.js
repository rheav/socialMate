// Outbox for the Instagram Scraper backends.
//
// Every captured post, comment and finished transcript becomes an event with a
// stable id. An event is owed separately to each destination that was enabled
// when it was captured, and leaves a destination's list only when THAT
// destination confirms it (`acceptedIds`). The old bridge deleted a batch as
// soon as any backend answered, so a down production server silently lost what
// the local one received; here one destination's success never touches the
// other's debt.
//
// Storage (both persisted, because an MV3 worker dies at 30 s idle):
//   fbw_ig_outbox          { v, events: {id: event}, dest: {destId: {id: {tries, code?}}},
//                            recent: {destId: [confirmed ids, newest last]} }
//   fbw_ig_delivery_state  { destId: {running, lastOkAt, lastSent, error, errorAt,
//                            pending, rejected, full, fullAt, authFailed} }
//
// Pure apart from the injected storage/fetch, so the delivery rules are tested
// without a browser or a server.

import { serialQueue } from "./serialQueue.js";

export const IG_OUTBOX_KEY = "fbw_ig_outbox";
export const IG_DELIVERY_KEY = "fbw_ig_delivery_state";
// Past this many unconfirmed events a destination takes no new ones (with a
// warning) instead of growing without bound or dropping what it owes.
export const IG_PENDING_LIMIT = 1500;
// `post_unknown` means the comment/transcript reached the backend before its
// post; it is worth a few more tries, not an endless loop.
const POST_UNKNOWN_TRIES = 5;
const MAX_BATCH_ITEMS = 200;
const MAX_BATCH_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KIND_ORDER = { post: 0, comment: 1, transcript: 2 };

// Ids each destination confirmed lately. The bridge replays every record it
// holds after a reload; without this each replay would re-send them all.
const RECENT_PER_DEST = 3000;

function emptyOutbox() {
  return { v: 1, events: {}, dest: {}, recent: {} };
}

function sendable(entry) {
  if (!entry.code) return true;
  return entry.code === "post_unknown" && (entry.tries || 0) < POST_UNKNOWN_TRIES;
}

function countFor(destMap = {}) {
  let pending = 0;
  let rejected = 0;
  for (const entry of Object.values(destMap)) {
    if (sendable(entry)) pending += 1;
    else rejected += 1;
  }
  return { pending, rejected };
}

/** Drop event bodies no destination owes any more. */
function collect(box) {
  const owed = new Set();
  for (const map of Object.values(box.dest)) for (const id of Object.keys(map)) owed.add(id);
  for (const id of Object.keys(box.events)) if (!owed.has(id)) delete box.events[id];
}

/**
 * @param {object} deps
 * @param {{get(key): Promise<object>, set(obj): Promise<void>}} deps.storage
 * @param {(id: string) => Promise<{id,url,token}|null>} deps.destination
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 */
export function createIgOutbox({ storage, destination, fetchImpl = fetch, now = Date.now }) {
  const serial = serialQueue();
  const flushing = new Set();

  async function readBox() {
    const r = await storage.get(IG_OUTBOX_KEY);
    const box = r[IG_OUTBOX_KEY];
    return box && box.v === 1 ? box : emptyOutbox();
  }

  async function patchState(destId, patch) {
    const r = await storage.get(IG_DELIVERY_KEY);
    const all = r[IG_DELIVERY_KEY] || {};
    all[destId] = { ...(all[destId] || {}), ...patch };
    await storage.set({ [IG_DELIVERY_KEY]: all });
  }

  function enqueue(events, destinationIds) {
    return serial(async () => {
      const box = await readBox();
      const full = new Set();
      let added = 0;
      for (const event of events || []) {
        if (!event?.eventId) continue;
        let owedSomewhere = false;
        for (const destId of destinationIds || []) {
          const map = (box.dest[destId] ||= {});
          if (map[event.eventId]) {
            owedSomewhere = true;
            continue;
          }
          if ((box.recent?.[destId] || []).includes(event.eventId)) continue;
          if (countFor(map).pending >= IG_PENDING_LIMIT) {
            full.add(destId);
            continue;
          }
          map[event.eventId] = { tries: 0 };
          owedSomewhere = true;
          added += 1;
        }
        if (owedSomewhere) box.events[event.eventId] = event;
      }
      await storage.set({ [IG_OUTBOX_KEY]: box });
      for (const destId of destinationIds || []) {
        const c = countFor(box.dest[destId]);
        const isFull = full.has(destId) || c.pending >= IG_PENDING_LIMIT;
        await patchState(destId, { ...c, full: isFull, ...(isFull ? { fullAt: now() } : {}) });
      }
      return { added, full: [...full] };
    });
  }

  /** Next request's events for one destination: posts first, size-bounded. */
  async function nextBatch(destId) {
    const box = await readBox();
    const map = box.dest[destId] || {};
    const events = Object.keys(map)
      .filter((id) => sendable(map[id]) && box.events[id])
      .map((id, i) => ({ event: box.events[id], i }))
      .sort((a, b) => (KIND_ORDER[a.event.kind] ?? 9) - (KIND_ORDER[b.event.kind] ?? 9) || a.i - b.i)
      .map((x) => x.event);
    const batch = [];
    let bytes = 0;
    for (const event of events) {
      const size = JSON.stringify(event).length;
      if (batch.length && (batch.length >= MAX_BATCH_ITEMS || bytes + size > MAX_BATCH_BYTES)) break;
      batch.push(event);
      bytes += size;
    }
    return batch;
  }

  function settle(destId, sentIds, result) {
    return serial(async () => {
      const box = await readBox();
      const map = (box.dest[destId] ||= {});
      const sent = new Set(sentIds);
      let confirmed = 0;
      const recent = ((box.recent ||= {})[destId] ||= []);
      for (const id of result.acceptedIds || []) {
        if (!sent.has(id) || !map[id]) continue;
        delete map[id];
        recent.push(id);
        confirmed += 1;
      }
      if (recent.length > RECENT_PER_DEST) recent.splice(0, recent.length - RECENT_PER_DEST);
      for (const r of result.rejected || []) {
        if (!sent.has(r?.eventId) || !map[r.eventId]) continue;
        map[r.eventId] = { tries: (map[r.eventId].tries || 0) + 1, code: String(r.code || "rejected") };
      }
      collect(box);
      await storage.set({ [IG_OUTBOX_KEY]: box });
      return { confirmed, counts: countFor(map) };
    });
  }

  async function post(dest, batch) {
    const body = {
      schemaVersion: 1,
      batchId: `${dest.id}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
      items: batch,
    };
    let r;
    try {
      r = await fetchImpl(`${dest.url}/ingest/socialmate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${dest.token}` },
        body: JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
      });
    } catch (e) {
      return { ok: false, status: 0, error: "sem conexão" };
    }
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    let json;
    try {
      json = await r.json();
    } catch {
      return { ok: false, status: r.status, error: "resposta inválida" };
    }
    if (!Array.isArray(json?.acceptedIds)) return { ok: false, status: r.status, error: "resposta sem acceptedIds" };
    return { ok: true, result: json };
  }

  /**
   * Send everything one destination is owed, in batches, until it is drained or
   * a request fails. One flush per destination at a time.
   */
  async function flush(destId) {
    if (flushing.has(destId)) return { ok: true, skipped: "busy" };
    flushing.add(destId);
    try {
      const dest = await destination(destId);
      if (!dest) return { ok: false, retryable: false, error: "destino não configurado" };
      let sent = 0;
      let rounds = 0;
      await patchState(destId, { running: true });
      while (rounds++ < 50) {
        const batch = await nextBatch(destId);
        if (!batch.length) break;
        const res = await post(dest, batch);
        if (!res.ok) {
          const authFailed = res.status === 401 || res.status === 403;
          const retryable = !res.status || res.status === 408 || res.status === 429 || res.status >= 500;
          const c = countFor((await readBox()).dest[destId]);
          await patchState(destId, { running: false, error: res.error, errorAt: now(), authFailed, ...c });
          return { ok: false, retryable, authFailed, error: res.error, sent };
        }
        const { confirmed } = await settle(
          destId,
          batch.map((e) => e.eventId),
          res.result,
        );
        sent += confirmed;
        // A 200 that confirmed and refused nothing would loop forever.
        if (!confirmed && !(res.result.rejected || []).length) {
          await patchState(destId, { running: false, error: "nenhum evento confirmado", errorAt: now() });
          return { ok: false, retryable: true, error: "nenhum evento confirmado", sent };
        }
      }
      const c = countFor((await readBox()).dest[destId]);
      await patchState(destId, {
        running: false,
        lastOkAt: now(),
        lastSent: sent,
        error: null,
        authFailed: false,
        full: c.pending >= IG_PENDING_LIMIT,
        ...c,
      });
      return { ok: true, sent };
    } finally {
      flushing.delete(destId);
    }
  }

  async function counts() {
    const box = await readBox();
    const out = {};
    for (const [destId, map] of Object.entries(box.dest)) out[destId] = countFor(map);
    return out;
  }

  async function rejected(destId) {
    const box = await readBox();
    const map = box.dest[destId] || {};
    return Object.entries(map)
      .filter(([, entry]) => !sendable(entry))
      .map(([eventId, entry]) => ({ eventId, code: entry.code, kind: box.events[eventId]?.kind || null }));
  }

  return { enqueue, flush, counts, rejected };
}
