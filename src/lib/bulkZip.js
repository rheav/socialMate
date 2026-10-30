// The TikTok panel's "baixar tudo": one ZIP, one file per message. The archive lives
// in the offscreen document (lib/zipJobs.js) and the run lives here, in the panel,
// so walking around TikTok meanwhile does not touch it. Module state, not component
// state: switching tools unmounts the tool, and the run must not go with it.
import { useSyncExternalStore } from "react";
import { requireOk } from "./bg.js";
import { bulkDownload } from "./shared/bulkDownload.js";
import { ttExt, ttMediaList } from "./shared/ttItems.js";
import { baseNameFor } from "./ttMedia.js";

const IDLE = { key: null, running: false, label: null, error: null };
let state = IDLE;
let stop = false;
const listeners = new Set();
// Reels already inside a saved ZIP, so the next run picks up the rest.
const zipped = new Set();

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach((f) => f());
}

export function useBulkZip() {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, () => state);
}

/** A second call with the same `key` stops the run and saves what it has. */
export async function startBulkZip(key, records, zipName, send = requireOk) {
  if (state.running) {
    if (state.key === key) { stop = true; set({ label: "Parando…" }); }
    return;
  }
  stop = false;
  const list = records.filter((r) => !zipped.has(r.id));
  const jobId = crypto.randomUUID();
  const added = [];
  set({ key, running: true, label: `0/${list.length}`, error: null });
  const { done, failed, error } = await bulkDownload(list, async (rec) => {
    const media = ttMediaList(rec);
    if (!media.length) throw new Error("sem mídia para baixar");
    for (const [i, m] of media.entries()) {
      const filename = baseNameFor(rec, ttExt(m.url, m.kind), media.length > 1 ? i + 1 : undefined);
      await send({ type: "FBW_ZIP_ADD", jobId, zipName, url: m.url, filename });
    }
    added.push(rec.id);
  }, () => stop, (n) => { if (!stop) set({ label: `${n}/${list.length}` }); });
  set({ label: "ZIP…" });
  try {
    await send({ type: "FBW_ZIP_FINISH", jobId, zipName });
    added.forEach((id) => zipped.add(id)); // only now: a ZIP that failed must not cost its reels
    set({ running: false, label: `${stop ? "Parado:" : "✓"} ${done}/${list.length}`, error: failed ? `${failed} falharam: ${error}` : null });
  } catch (e) {
    set({ running: false, label: "Falhou", error: e.message });
  }
}
