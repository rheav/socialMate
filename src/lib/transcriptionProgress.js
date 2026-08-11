// Turning "where is this transcription" into one number.
//
// A job has four phases, in the order they actually happen:
//
//   fetch   the audio download — real bytes, when the response declares a length
//   decode  decodeAudioData + the 16 kHz resample — no progress API, one step
//   model   the Whisper weights read into the worker — real bytes, and ONLY on the
//           job that builds the pipeline; every later job reuses it and skips this
//   infer   the 30 s windows — real: the count is known from the PCM length before
//           the first one runs, and the Whisper streamer reports position inside
//           the window currently running
//
// The order matters as much as the weights: the worker only loads the model when
// the transcribe message reaches it, which is AFTER the audio was fetched and
// decoded — a live run reported `34:decode` before `12:model`. Ordering the phases
// this way makes that stream naturally monotonic (advanceTxProgress still guards
// it, because model bytes are reported per file and restart at zero each time).
//
// The weights are wall-clock guesses; the ratio inside each phase is not. A second
// job skips the model phase and simply jumps 24 → 34.
export const TX_PHASES = {
  fetch: [0, 18],
  decode: [18, 24],
  model: [24, 34],
  infer: [34, 100],
};

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

// Whisper reads 16 kHz mono in 30 s windows that overlap by `stride` on each side,
// so every window after the first advances the audio by chunk - 2*stride seconds.
// This is the number the inference bar divides by, and it is known from the decoded
// PCM before a single window has run — which is what makes that bar real.
export const TX_SAMPLE_RATE = 16000;
export const TX_CHUNK_S = 30;
export const TX_STRIDE_S = 5;
export function whisperWindowCount(sampleCount, chunkS = TX_CHUNK_S, strideS = TX_STRIDE_S) {
  const seconds = (Number(sampleCount) || 0) / TX_SAMPLE_RATE;
  if (!(seconds > chunkS)) return 1;
  return Math.ceil((seconds - chunkS) / (chunkS - 2 * strideS)) + 1;
}

/** Overall percent (0-100, integer) for `ratio` (0-1) through `phase`. */
export function txProgressPercent(phase, ratio) {
  const span = TX_PHASES[phase];
  if (!span) return null;
  const [from, to] = span;
  return Math.round(from + (to - from) * clamp01(ratio));
}

/**
 * How far inference has got: whole windows already finished, plus the position
 * inside the one running. `within` is the streamer's timestamp mapped to 0-1.
 */
export function whisperInferRatio(windows, done, within) {
  const total = Math.max(1, Math.floor(windows) || 1);
  const finished = Math.max(0, Math.min(total, Math.floor(done) || 0));
  // The window in flight only counts while there IS one — at done === total the
  // job is over and a stray `within` must not push the bar past 100.
  const partial = finished >= total ? 0 : clamp01(within);
  return (finished + partial) / total;
}

/**
 * The bar only ever moves forward.
 *
 * Phases genuinely go backwards at their seams — the model phase reports per FILE,
 * so a second file restarts its own bytes at zero — and a bar that jumps back reads
 * as a bug even when the underlying number is right.
 */
export function advanceTxProgress(prev, next) {
  if (!Number.isFinite(next)) return prev ?? 0;
  return Math.max(prev ?? 0, Math.max(0, Math.min(100, next)));
}
