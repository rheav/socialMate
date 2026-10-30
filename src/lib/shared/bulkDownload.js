// The loop behind every "baixar tudo". INLINED into content scripts — see
// src/lib/shared/README.md before editing (no imports allowed in this file).

/**
 * One item at a time, in list order: `save` resolves when the item is stored, so
 * the list paces itself. One failure skips one item. `stopped` is read before each.
 */
export async function bulkDownload(list, save, stopped, onStep) {
  let done = 0, failed = 0, error = null;
  for (const item of list) {
    if (stopped()) break;
    onStep(done + failed + 1);
    try { await save(item); done++; } catch (e) { failed++; error = e.message; }
  }
  return { done, failed, error };
}
