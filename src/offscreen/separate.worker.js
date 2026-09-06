// MDX runs on its own thread. Use the WebGPU entry explicitly: the root ORT
// bundle only registers the default backends. Assets and weights are local.
import * as ort from 'onnxruntime-web/webgpu';
import { separateVocals } from '../lib/dsp/demix.js';

let session = null;
let backend = null;
let modelUrl = null;
let running = false;

async function loadSession(forceWasm, report) {
  if (session && (!forceWasm || backend === 'wasm')) return session;
  if (session) { await session.release().catch(() => {}); session = null; }
  if (!forceWasm && navigator.gpu) {
    try {
      session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['webgpu', 'wasm'] });
      backend = 'webgpu';
    } catch (e) {
      console.warn('[fbw] MDX WebGPU indisponível; usando WASM:', e);
    }
  }
  if (!session) {
    session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
    backend = 'wasm';
  }
  report({ phase: 'model', pct: 12, backend });
  return session;
}

self.onmessage = async ({ data: msg }) => {
  const { id, paths, channels } = msg || {};
  if (running) { self.postMessage({ id, ok: false, error: 'Já existe uma extração em andamento.' }); return; }
  running = true;
  const report = (patch) => {
    try { self.postMessage({ id, type: 'progress', ...patch }); } catch { /* advisory */ }
  };
  try {
    ort.env.wasm.wasmPaths = paths.assets;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    modelUrl = paths.model;
    report({ phase: 'model', pct: 10 });
    await loadSession(false, report);
    const infer = async (spectrum) => {
      const input = new ort.Tensor('float32', spectrum, [1, 4, 3072, 256]);
      let output;
      try {
        try { output = await session.run({ input }); }
        catch (e) {
          if (backend === 'wasm') throw e;
          // Some adapters create the session but cannot execute one of the
          // shaders. Retry this chunk once on CPU; later chunks keep that session.
          await loadSession(true, report);
          output = await session.run({ input });
        }
        const tensor = output.output;
        const values = new Float32Array(await tensor.getData());
        for (const value of values) if (!Number.isFinite(value)) throw new Error('O modelo produziu áudio inválido.');
        return values;
      } finally {
        input.dispose();
        if (output) for (const tensor of Object.values(output)) tensor.dispose();
      }
    };
    const vocals = await separateVocals(channels, infer, (done, total) =>
      report({ phase: 'infer', pct: 12 + Math.round(80 * done / total), done, total, backend }));
    self.postMessage({ id, ok: true, channels: vocals, backend }, vocals.map(c => c.buffer));
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e || 'Falha ao separar voz.') });
  } finally { running = false; }
};
