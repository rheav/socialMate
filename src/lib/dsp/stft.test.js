import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import metadata from "./fixtures/metadata.json";
import { CHUNK_SIZE, DIM_F, DIM_T, istft, stft } from "./stft.js";

const fixture = (name) => {
  const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

function fixtureWave(length, peak = 0.72) {
  const channels = [new Float32Array(length), new Float32Array(length)];
  let max = 0;
  for (let i = 0; i < length; i += 1) {
    channels[0][i] = 0.48 * Math.sin((2 * Math.PI * 437 * i) / 44100)
      + 0.17 * Math.cos((2 * Math.PI * 7331 * i) / 44100)
      + 0.07 * Math.sin((2 * Math.PI * 19000 * i) / 44100);
    channels[1][i] = 0.36 * Math.cos((2 * Math.PI * 911 * i) / 44100)
      - 0.21 * Math.sin((2 * Math.PI * 12003 * i) / 44100)
      + 0.05 * Math.cos((2 * Math.PI * 43 * i) / 44100);
    max = Math.max(max, Math.abs(channels[0][i]), Math.abs(channels[1][i]));
  }
  const gain = Math.fround(peak / max);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) channel[i] = Math.fround(channel[i] * gain);
  }
  return channels;
}

function expectArraysClose(actual, expected, absolute = 1e-4, relative = 2e-4) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    const tolerance = absolute + relative * Math.abs(expected[i]);
    if (Math.abs(actual[i] - expected[i]) > tolerance) {
      throw new Error(`index ${i}: got ${actual[i]}, expected ${expected[i]} (tol ${tolerance})`);
    }
  }
}

describe("MDX STFT", () => {
  test("matches canonical probes and keeps L.real, L.imag, R.real, R.imag order", () => {
    const actual = stft(fixtureWave(CHUNK_SIZE));
    const probes = fixture("stft-probes.f32");
    expect(actual).toBeInstanceOf(Float32Array);
    expect(actual.length).toBe(4 * DIM_F * DIM_T);

    let probe = 0;
    for (const channel of metadata.probe_channels) {
      for (const bin of metadata.probe_bins) {
        for (const frame of metadata.probe_frames) {
          const index = (channel * DIM_F + bin) * DIM_T + frame;
          const tolerance = 1e-4 + 2e-4 * Math.abs(probes[probe]);
          expect(Math.abs(actual[index] - probes[probe])).toBeLessThanOrEqual(tolerance);
          probe += 1;
        }
      }
    }

    expect(Math.abs(actual[0])).toBeGreaterThan(1e-3);
    expect(Math.abs(actual[DIM_T])).toBeGreaterThan(1e-3);
    expect(Math.abs(actual[DIM_T * 2])).toBeGreaterThan(1e-3);
  });

  test("cropped inverse matches torch and is not an arbitrary-waveform identity", () => {
    const channels = fixtureWave(CHUNK_SIZE);
    const restored = istft(stft(channels));
    const expected = fixture("cropped-istft.f32");

    expect(restored).toHaveLength(2);
    expectArraysClose(restored[0], expected.subarray(0, CHUNK_SIZE));
    expectArraysClose(restored[1], expected.subarray(CHUNK_SIZE));

    let maxDifference = 0;
    for (let i = 0; i < CHUNK_SIZE; i += 1) {
      maxDifference = Math.max(maxDifference, Math.abs(restored[0][i] - channels[0][i]));
    }
    expect(maxDifference).toBeGreaterThan(0.01);
  });
});
