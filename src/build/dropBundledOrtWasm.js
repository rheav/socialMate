// The ONNX workers set `wasmPaths` to the extension's assets/ folder, so ORT
// loads the unhashed copy shipped from public/assets. Vite still emits a second,
// hashed copy for ORT's `new URL(..., import.meta.url)` fallback, which is never
// fetched: 21.6 MB of dead weight in every build. Drop it at bundle time.
const HASHED_ORT_WASM = /(^|\/)ort-wasm-simd-threaded\.jsep-[\w-]+\.wasm$/;

export function dropBundledOrtWasm() {
  return {
    name: "drop-bundled-ort-wasm",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const file of Object.keys(bundle)) {
        if (HASHED_ORT_WASM.test(file)) delete bundle[file];
      }
    },
  };
}
