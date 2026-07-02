// Niche-relevance worker. Runs the Transformers.js feature-extraction pipeline
// (Xenova/all-MiniLM-L6-v2) on its OWN thread so the embedding compute never blocks
// the offscreen main thread or the side panel. Same constraints as the Whisper
// worker: single-threaded ONNX, no proxy (MV3 CSP forbids nested blob workers),
// local model files only. `chrome.*` is unavailable here, so the offscreen page
// passes extension-resolved URLs in a one-time "config" message.

import { env, pipeline } from "@huggingface/transformers";

let pipe = null;
let loading = null;
let MODEL = null;

function configure(paths) {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  // Local (chrome-extension://) models → the browser Cache API rejects that
  // scheme, so caching only yields a noisy console error. Off.
  env.useBrowserCache = false;
  env.localModelPath = paths.models;
  env.backends.onnx.wasm.wasmPaths = paths.assets;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  MODEL = paths.model;
}

async function getPipeline() {
  if (pipe) return pipe;
  if (loading) return loading;
  loading = pipeline("feature-extraction", MODEL, {
    dtype: "q8",
    local_files_only: true,
  }).then((p) => { pipe = p; loading = null; return p; });
  return loading;
}

// Returns L2-normalized mean-pooled sentence embeddings (one per input string),
// as plain Arrays so they survive postMessage / JSON.
async function embed(texts) {
  const p = await getPipeline();
  const out = await p(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}

self.onmessage = async (e) => {
  const { id, type, paths, texts } = e.data || {};
  if (type === "config") {
    try { configure(paths); self.postMessage({ id, ok: true }); }
    catch (err) { self.postMessage({ id, ok: false, error: err.message }); }
    return;
  }
  if (type === "embed") {
    try {
      const vectors = await embed(texts);
      self.postMessage({ id, ok: true, vectors });
    } catch (err) {
      self.postMessage({ id, ok: false, error: err.message });
    }
  }
};
