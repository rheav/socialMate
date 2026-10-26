// Batching and retry rules for uploads, shared by the hub client (syncClient.js)
// and the PUBLIC build's in-process hub (hub-local/client.js). Pure, so the rules
// that decide whether a sync of 300 records works or 413s are unit tested.

// The server accepts 20MB per batch. 4MB keeps a batch far from that ceiling even
// when every record in it is a long transcript with a thumbnail, and keeps one
// failed request cheap to retry.
const MAX_BATCH_BYTES = 4_000_000;
const MAX_BATCH_ITEMS = 25;

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
