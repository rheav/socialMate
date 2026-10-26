// The PUBLIC build's stand-in for lib/syncClient.js: the same names the Spy code
// imports, answered in process by the local hub (router.ts) instead of over
// HTTP. Same return shapes and error semantics: a JSON call throws an Error with
// `status` on a non-2xx answer (no status = retryable, like a network error);
// putStoryMedia never throws on an answer and returns { ok, status, json }.

import { localHub } from "./hub.js";

export { SYNC_KEY, isSyncConfigured, isSyncReady, syncSettings } from "./settings.js";
export { backoffDelay, batchRecords, isRetryable } from "../lib/syncBatch.js";

async function call(method, path, body) {
  const res = await (await localHub()).handle(method, path, body);
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`local hub ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json;
}

/** The tracked profiles, as the hub's GET /api/sync/spy/profiles answers. */
export function getSpyProfiles() {
  return call("GET", "/local/sync/spy/profiles");
}

/** One batch of spy operations, metadata, snapshots, readings… (the hub's POST /api/sync/spy). */
export function postSpy(_settings, body) {
  return call("POST", "/local/sync/spy", body);
}

/** A story's media or poster bytes, after its metadata went in a batch. */
export async function putStoryMedia(_settings, id, kind, body, mime) {
  const res = await (await localHub()).handle("PUT", `/local/sync/spy/stories/${encodeURIComponent(id)}/${kind}`, { blob: body, contentType: mime });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json: res.json ?? null };
}
