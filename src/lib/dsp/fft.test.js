import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { MixedRadixFFT } from "./fft.js";

const fixture = (name) => {
  const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

describe("MixedRadixFFT", () => {
  test("matches torch.fft for the model's non-power-of-two transform", () => {
    const input = fixture("fft-input.f32");
    const expected = fixture("fft-expected.f32");
    const real = new Float64Array(7680);
    const imag = new Float64Array(7680);
    for (let i = 0; i < 7680; i += 1) {
      real[i] = input[i * 2];
      imag[i] = input[i * 2 + 1];
    }

    const fft = new MixedRadixFFT(7680);
    const [actualReal, actualImag] = fft.forward(real, imag);

    for (let i = 0; i < 7680; i += 1) {
      expect(actualReal[i]).toBeCloseTo(expected[i * 2], 4);
      expect(actualImag[i]).toBeCloseTo(expected[i * 2 + 1], 4);
    }
  });

  test("inverse restores complex input", () => {
    const input = fixture("fft-input.f32");
    const real = Float64Array.from({ length: 7680 }, (_, i) => input[i * 2]);
    const imag = Float64Array.from({ length: 7680 }, (_, i) => input[i * 2 + 1]);
    const fft = new MixedRadixFFT(7680);

    const [frequencyReal, frequencyImag] = fft.forward(real, imag);
    const [actualReal, actualImag] = fft.inverse(frequencyReal, frequencyImag);

    for (let i = 0; i < 7680; i += 1) {
      expect(actualReal[i]).toBeCloseTo(real[i], 8);
      expect(actualImag[i]).toBeCloseTo(imag[i], 8);
    }
  });
});
