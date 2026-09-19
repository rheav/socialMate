// Is this card's record a transcription that is still running?
//
// Library cards and Transcript cards are the same component over two stores with
// two different meanings for "no text":
//
//   * fbw_transcripts — every record exists BECAUSE a job created it, so no text
//     means the job has not finished. `status` is "running" from the moment the
//     job starts, but records written before it existed carry none; treat those
//     as running too, which is what the panel always did.
//   * fbw_saved — a post saved off a grid has no text for the plain reason that
//     nobody asked for one. It carries no `status` at all. Only an entry starred
//     out of the Transcripts tab is a job, and that one brought its status along.
//
// Reading "no text" as "running" across both is what put every saved Instagram
// post under a permanent "transcrevendo…" with no job behind it.
//
// An explicit in-flight status wins over the text: a RE-RUN of a finished
// transcript keeps the old text on screen while the new job works, and the card
// has to show that job instead of pretending nothing is happening. And "done"
// with no text is a finished job that heard no speech — not one still running.
import { isActiveTxStatus } from "./transcriptJobs.js";

export function isTranscribing(record, store) {
  if (!record) return false;
  if (isActiveTxStatus(record.status)) return true;
  if (record.text || store === "saved") return false;
  return record.status !== "error" && record.status !== "done";
}

/** A job that finished and heard nothing — silence, music, or a failed decode. */
export function heardNoSpeech(record) {
  return !!record && record.status === "done" && !record.text;
}
