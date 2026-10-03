import { describe, expect, it } from "vitest";
import { dropBundledOrtWasm } from "./dropBundledOrtWasm.js";

describe("dropBundledOrtWasm", () => {
  it("removes only the hashed ONNX Runtime wasm that Vite emits", () => {
    const bundle = {
      "assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm": {},
      "assets/ort-wasm-simd-threaded.jsep.wasm": {},
      "assets/transcribe.worker-BaixEgNF.js": {},
    };
    dropBundledOrtWasm().generateBundle({}, bundle);
    expect(Object.keys(bundle)).toEqual([
      "assets/ort-wasm-simd-threaded.jsep.wasm",
      "assets/transcribe.worker-BaixEgNF.js",
    ]);
  });
});
