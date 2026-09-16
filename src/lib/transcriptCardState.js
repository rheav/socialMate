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
export function isTranscribing(record, store) {
  if (!record || record.text) return false;
  if (store === "saved") return record.status === "running";
  return record.status !== "error";
}
