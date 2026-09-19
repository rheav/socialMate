// The job-lifecycle rules for transcription, kept pure so each one gets a test:
// how long a Whisper job may take, what an orphaned record looks like, and how a
// finished transcript reaches the Library copy of the same post.

// A record is IN FLIGHT while one of these is its status. "queued" means waiting
// behind another Whisper job (the background runs them one at a time); "running"
// means the job owns the worker.
export const TX_ACTIVE_STATUSES = ["queued", "running"];

export function isActiveTxStatus(status) {
  return TX_ACTIVE_STATUSES.includes(status);
}

// ---- deadlines --------------------------------------------------------------
// The old limit was a flat 3 minutes for every video. whisper-base does 190 s of
// audio in ~27 s on the M3 Pro, so a long video on a slower machine (or behind a
// cold model load) timed out while still making progress. Two limits instead:
//
//   * stall — no progress message for this long means the job is stuck, whatever
//     the video's length. The offscreen document reports at least once per 30 s
//     Whisper window, and a window never takes anywhere near this.
//   * hard — a ceiling scaled by the duration when the caller knows it, generous
//     when it doesn't; the stall limit is what catches a real hang early.
export const TX_STALL_MS = 120_000;
const MIN_DEADLINE_S = 180;
const MAX_DEADLINE_S = 3600;
const UNKNOWN_DEADLINE_S = 1800;

export function txDeadlineMs(durationS) {
  const d = Number(durationS);
  if (!Number.isFinite(d) || d <= 0) return UNKNOWN_DEADLINE_S * 1000;
  const s = 120 + 1.5 * d;
  return Math.round(Math.min(MAX_DEADLINE_S, Math.max(MIN_DEADLINE_S, s)) * 1000);
}

/** "3 min" / "45 min" — what the timeout error says it waited. */
export function fmtDeadline(ms) {
  return `${Math.round(ms / 60000)} min`;
}

// ---- orphans ----------------------------------------------------------------
// A job lives in the service worker's memory. An extension reload, a browser
// quit or a worker restart mid-job loses it, and the record it had marked
// "running" stayed that way forever — a card under "transcrevendo…" with nothing
// behind it, synced to the hub as such.
//
// Only records last written BEFORE this worker booted are touched: a job started
// after boot (including the page's instant card, which can be the very message
// that woke the worker) is alive.
export const TX_INTERRUPTED_ERROR =
  "transcrição interrompida (extensão recarregada ou navegador fechado) — tente de novo";

export function orphanedTranscriptIds(map, bootAt) {
  const out = [];
  for (const [id, rec] of Object.entries(map || {})) {
    if (!rec || !isActiveTxStatus(rec.status)) continue;
    if ((rec.updatedAt || 0) < bootAt) out.push(id);
  }
  return out;
}

// ---- the Library copy -------------------------------------------------------
// Starring a transcript copies the record into fbw_saved as it is at that moment.
// Starred mid-job, that copy said "running" forever, because nothing carried the
// result over. These are the fields that belong to the TRANSCRIPT (not to the
// post), so they are what a finished job refreshes on the saved copy.
const TRANSCRIPT_FIELDS = ["status", "text", "chunks", "language", "languageAuto", "repetitionPenalty", "error", "source"];

export function savedTranscriptPatch(transcript) {
  const out = {};
  if (!transcript) return out;
  for (const k of TRANSCRIPT_FIELDS) if (k in transcript) out[k] = transcript[k];
  return out;
}

// ---- Whisper output ---------------------------------------------------------
// Whisper's chunk text starts with a space (" Hello there."), and the text used
// to be those chunks joined with another one — every Whisper transcript on the
// hub had double spaces. Trim each chunk, join with one.
//
// Hallucination guards, both cheap:
//   * inside one chunk: a trigram repeated 4+ times (the original guard);
//   * across chunks: the same line back to back. Real speech repeats a line
//     twice ("Yeah. Yeah."); Whisper's loop on silence or music repeats it for
//     dozens of chunks, which the per-chunk guard never saw because each chunk is
//     only ~5 words. A run is kept up to MAX_REPEAT, the rest dropped.
const MAX_REPEAT = 2;

const lineKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function loopsInside(text) {
  const words = text.split(/\s+/);
  if (words.length <= 10) return false;
  const tri = {};
  for (let i = 0; i <= words.length - 3; i++) {
    const k = words.slice(i, i + 3).join(" ").toLowerCase();
    tri[k] = (tri[k] || 0) + 1;
    if (tri[k] >= 4) return true;
  }
  return false;
}

export function cleanChunks(result) {
  if (result?.chunks?.length) {
    const chunks = [];
    let lastKey = null;
    let run = 0;
    for (const c of result.chunks) {
      const text = String(c?.text || "").replace(/\s+/g, " ").trim();
      if (!text || loopsInside(text)) continue;
      const key = lineKey(text);
      run = key && key === lastKey ? run + 1 : 1;
      lastKey = key;
      if (run > MAX_REPEAT) continue;
      chunks.push({ text, timestamp: c.timestamp });
    }
    return { text: chunks.map((c) => c.text).join(" "), chunks };
  }
  if (typeof result === "string") return { text: tidyTranscriptText(result), chunks: [] };
  if (result?.text) return { text: tidyTranscriptText(result.text), chunks: [] };
  return { text: "", chunks: [] };
}

/** Collapse runs of spaces — for records written before cleanChunks trimmed. */
export function tidyTranscriptText(text) {
  return String(text || "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** A record's status as the grid tools' Transcribe button reads it: queued jobs
 *  spin like running ones (the button only knows running / done / error). */
export function txButtonState(status) {
  return isActiveTxStatus(status) ? "running" : status;
}
