// Whisper inference worker. Runs the Transformers.js ASR pipeline on its OWN thread
// so the heavy (synchronous) WASM compute never blocks the shared extension main
// thread (offscreen doc + side panel). Single-threaded ONNX, no proxy → spawns no
// nested blob workers (which MV3 CSP forbids).
//
// `chrome.*` isn't available in a plain worker, so the offscreen page passes the
// extension-resolved URLs (models / assets / model) in a one-time "config" message.

import { env, pipeline } from "@huggingface/transformers";

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

async function getPipeline() {
  if (pipe) return pipe;
  if (loading) return loading;
  loading = pipeline("automatic-speech-recognition", MODEL, {
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
    local_files_only: true,
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
    try {
      const p = await getPipeline();
      const opts = {
        task: "transcribe",
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        repetition_penalty: 1.1,
      };
      // Only the quick relevance path passes a language (skips auto-detect for
      // speed). Full transcripts pass none → Whisper auto-detects = best quality.
      if (language) opts.language = language;
      const result = await p(audio, opts);
      self.postMessage({ id, ok: true, result });
    } catch (err) {
      self.postMessage({ id, ok: false, error: err.message });
    }
  }
};
