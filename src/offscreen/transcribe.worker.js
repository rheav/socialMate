// Whisper inference worker. Runs the Transformers.js ASR pipeline on its OWN thread
// so the heavy (synchronous) WASM compute never blocks the shared extension main
// thread (offscreen doc + side panel). Single-threaded ONNX, no proxy → spawns no
// nested blob workers (which MV3 CSP forbids).
//
// `chrome.*` isn't available in a plain worker, so the offscreen page passes the
// extension-resolved URLs (models / assets / model) in a one-time "config" message.

import { env, pipeline, WhisperTextStreamer } from "@huggingface/transformers";
import { TX_CHUNK_S, TX_STRIDE_S, whisperWindowCount } from "@/lib/transcriptionProgress.js";

let pipe = null;
let loading = null;
let MODEL = null;

function configure(paths) {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  // Models are bundled in the extension (loaded from chrome-extension:// URLs).
  // The browser Cache API rejects that scheme ("Request scheme 'chrome-extension'
  // is unsupported"), so caching adds nothing but a noisy console error — off.
  env.useBrowserCache = false;
  env.localModelPath = paths.models;
  env.backends.onnx.wasm.wasmPaths = paths.assets;
  env.backends.onnx.wasm.numThreads = 1; // no nested pthread workers
  env.backends.onnx.wasm.proxy = false;
  MODEL = paths.model;
}

/** Everything a thrown value can tell us — some of what ONNX throws has no message. */
function describeError(err) {
  if (!err) return "erro desconhecido na transcrição";
  const msg = String(err.message || "").trim();
  if (msg) return msg;
  const stack = String(err.stack || "").split("\n")[0].trim();
  return stack || String(err.name || err) || "erro desconhecido na transcrição";
}

async function getPipeline(onProgress) {
  if (pipe) return pipe;
  if (loading) return loading;
  loading = pipeline("automatic-speech-recognition", MODEL, {
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
    local_files_only: true,
    // Only the job that actually BUILDS the pipeline sees these — every later job
    // gets the cached one and reports no model phase at all.
    progress_callback: onProgress,
  }).then((p) => { pipe = p; loading = null; return p; });
  return loading;
}

self.onmessage = async (e) => {
  const { id, type, paths, audio, language } = e.data || {};
  if (type === "config") {
    try { configure(paths); self.postMessage({ id, ok: true }); }
    catch (err) { self.postMessage({ id, ok: false, error: err.message }); }
    return;
  }
  if (type === "transcribe") {
    // Progress is ADVISORY: every emitter below is wrapped so a reporting failure
    // can never take the transcription with it.
    const report = (patch) => {
      try { self.postMessage({ id, type: "progress", ...patch }); } catch { /* ignore */ }
    };
    try {
      const p = await getPipeline((x) => {
        if (x && x.status === "progress" && x.total)
          report({ phase: "model", file: x.file, loaded: x.loaded, total: x.total });
      });
      const opts = {
        task: "transcribe",
        return_timestamps: true,
        chunk_length_s: TX_CHUNK_S,
        stride_length_s: TX_STRIDE_S,
        repetition_penalty: 1.1,
      };
      // Always pass "pt" or "en". Transformers.js currently defaults omitted
      // multilingual Whisper language to English instead of auto-detecting.
      if (language) opts.language = language;
      // Real inference progress, no library patching: the pipeline spreads its
      // kwargs into model.generate(), which honours `streamer`. The Whisper streamer
      // fires on each decoded timestamp (position INSIDE the current 30 s window)
      // and once per window when generation for it ends.
      //
      // In a try/catch of its own: a Transformers.js version that stops accepting a
      // streamer must cost us the progress bar, not the transcript.
      const windows = whisperWindowCount(audio.length);
      let done = 0;
      try {
        opts.streamer = new WhisperTextStreamer(p.tokenizer, {
          // TextStreamer's DEFAULT callback_function is console.log — silence it.
          callback_function: () => {},
          on_chunk_start: (t) =>
            report({ phase: "infer", windows, done, within: Math.max(0, Math.min(1, t / TX_CHUNK_S)) }),
          on_finalize: () => {
            done = Math.min(windows, done + 1);
            report({ phase: "infer", windows, done, within: 0 });
          },
        });
      } catch {
        /* no streamer → no inference progress; the job runs exactly as before */
      }
      const result = await p(audio, opts);
      self.postMessage({ id, ok: true, result });
    } catch (err) {
      // Not `err.message`: the ONNX runtime throws errors whose message is empty,
      // and the offscreen document then reported the useless "Transcription failed"
      // with nothing to debug from.
      self.postMessage({ id, ok: false, error: describeError(err) });
    }
  }
};
