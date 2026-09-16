// Pushing the Arquivo to the socialMate hub (see ~/Code/apps/socialmate-hub).
//
// WHY AT ALL: the two local stores are capped on purpose — 20 transcriptions and
// 300 Library records, each carrying a base64 thumbnail — so the extension drops
// its own history as it works. The hub keeps it: nothing there expires, "limpar
// tudo" here does not reach it, and a reinstall does not start from zero.
//
// The extension stays the source of truth. This is a one-way push; the hub never
// writes back, which is what keeps the two from needing conflict resolution.
//
// Everything here is pure except the two request helpers, so the batching rules
// (the part that decides whether a sync of 300 records works or 413s) are unit
// tested without a server.

export const SYNC_KEY = "fbw_sync"; // { enabled, url, token }
export const SYNC_STATE_KEY = "fbw_sync_state"; // { lastOkAt, lastError, running, ... }
export const SYNC_QUEUE_KEY = "fbw_sync_queue"; // { transcripts: {id:1}, saved: {id:1} }

export const DEFAULT_SYNC_URL = "https://socialmate.rheav.dev";
export const SYNC_HEADER = "X-Sync-Token";

// The server accepts 20MB per batch. 4MB keeps a batch far from that ceiling even
// when every record in it is a long transcript with a thumbnail, and keeps one
// failed request cheap to retry.
const MAX_BATCH_BYTES = 4_000_000;
const MAX_BATCH_ITEMS = 25;

export function syncSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: !!s.enabled,
    url: typeof s.url === "string" && s.url ? s.url.replace(/\/+$/, "") : DEFAULT_SYNC_URL,
    token: typeof s.token === "string" ? s.token : "",
  };
}

/**
 * Configured: there is somewhere to send and a way in. This is what a MANUAL
 * push needs — pressing "enviar ao acervo" is the user asking, and refusing it
 * because the automatic switch is off would be answering a question nobody asked.
 */
export function isSyncConfigured(settings) {
  const s = syncSettings(settings);
  return !!s.url && !!s.token;
}

/** Ready: configured AND allowed to send by itself. Only the queue drain uses this. */
export function isSyncReady(settings) {
  return isSyncConfigured(settings) && syncSettings(settings).enabled;
}

/**
 * Split records into request-sized batches.
 *
 * Both limits matter: 25 records of plain text is a small request, but 25 records
 * carrying 200KB thumbnails each is a 5MB one. Measuring the serialized size is
 * the only honest test. A single record over the limit still goes out alone —
 * refusing it would mean it could never sync at all.
 */
export function batchRecords(records, { maxBytes = MAX_BATCH_BYTES, maxItems = MAX_BATCH_ITEMS } = {}) {
  const out = [];
  let batch = [];
  let bytes = 0;
  for (const rec of records || []) {
    if (!rec) continue;
    const size = JSON.stringify(rec).length;
    if (batch.length && (batch.length >= maxItems || bytes + size > maxBytes)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(rec);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

/** Retry delay: 2s, 4s, 8s, 16s, capped at 30s. */
export function backoffDelay(attempt) {
  return Math.min(2000 * 2 ** Math.max(0, attempt), 30_000);
}

/**
 * A failure that another attempt could fix. A 401 (wrong token) or a 400 (bad
 * body) will fail identically forever — retrying those just burns the queue.
 */
export function isRetryable(status) {
  if (!status) return true; // network error / offline
  return status === 408 || status === 429 || status >= 500;
}

async function send(url, token, path, init, fetchImpl) {
  const r = await fetchImpl(`${url}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), [SYNC_HEADER]: token },
  });
  if (!r.ok) {
    const err = new Error(`sync HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** Config check for the settings screen: does this URL + token actually answer? */
export function pingSync(settings, fetchImpl = fetch) {
  const s = syncSettings(settings);
  return send(s.url, s.token, "/api/sync/ping", { method: "GET" }, fetchImpl);
}

/** One batch. `body` is { transcripts?: [...], saved?: [...] }. */
export function postSync(settings, body, fetchImpl = fetch) {
  const s = syncSettings(settings);
  return send(
    s.url,
    s.token,
    "/api/sync",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    fetchImpl,
  );
}
