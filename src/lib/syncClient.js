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

// The pure batching/retry rules live in syncBatch.js (the local hub uses them too).
export { backoffDelay, batchRecords, isRetryable } from "./syncBatch.js";

export const DEFAULT_SYNC_URL = "https://socialmate.rheav.dev";
export const SYNC_HEADER = "X-Sync-Token";

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

// A deadline long enough for a 4MB batch on a slow uplink. Without one, a hung
// connection keeps the "busy" flag set and the queue never drains.
const REQUEST_TIMEOUT_MS = 120_000;

async function send(url, token, path, init, fetchImpl) {
  const r = await fetchImpl(`${url}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

/** Fetch spy profiles tracked on the hub. */
export function getSpyProfiles(settings, fetchImpl = fetch) {
  const s = syncSettings(settings);
  return send(s.url, s.token, "/api/sync/spy/profiles", { method: "GET" }, fetchImpl);
}

/**
 * A story's media or poster, raw bytes, after its metadata went in a batch. The
 * hub answers `{ id, bytes, ready }`; 404 means the metadata is not there yet.
 * Unlike the JSON helpers this never throws on an HTTP error: the caller sorts
 * a 404 (retry later) from the rest.
 */
export async function putStoryMedia(settings, id, kind, body, mime, fetchImpl = fetch) {
  const s = syncSettings(settings);
  const r = await fetchImpl(`${s.url.replace(/\/+$/, "")}/api/sync/spy/stories/${encodeURIComponent(id)}/${kind}`, {
    method: "PUT",
    headers: { [SYNC_HEADER]: s.token, "Content-Type": mime },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { ok: r.ok, status: r.status, json };
}

/** Push a batch of spy operations, metadata, snapshots, and errors. */
export function postSpy(settings, body, fetchImpl = fetch) {
  const s = syncSettings(settings);
  return send(
    s.url,
    s.token,
    "/api/sync/spy",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    fetchImpl,
  );
}

