import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import metadata from "./fixtures/metadata.json";
import { separateVocals } from "./demix.js";

const fixture = (name) => {
  const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

function fixtureWave(length, peak) {
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

function expectArraysClose(actual, expected, absolute = 2e-4, relative = 3e-4) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    const tolerance = absolute + relative * Math.abs(expected[i]);
    if (Math.abs(actual[i] - expected[i]) > tolerance) {
      throw new Error(`index ${i}: got ${actual[i]}, expected ${expected[i]} (tol ${tolerance})`);
    }
  }
}

const identityInference = async (spectrum) => {
  expect(spectrum).toBeInstanceOf(Float32Array);
  expect(spectrum).toHaveLength(4 * 3072 * 256);
  for (let channel = 0; channel < 4; channel += 1) {
    const offset = channel * 3072 * 256;
    for (let i = 0; i < 3 * 256; i += 1) expect(spectrum[offset + i]).toBe(0);
  }
  return spectrum;
};

describe("separateVocals", () => {
  test("matches canonical single-region outer Hann weighting", async () => {
    const progress = [];
    const actual = await separateVocals(
      fixtureWave(metadata.short_length, 0.62),
      identityInference,
      (done, total) => progress.push([done, total]),
    );
    const expected = fixture("demix-short.f32");

    expectArraysClose(actual[0], expected.subarray(0, metadata.short_length));
    expectArraysClose(actual[1], expected.subarray(metadata.short_length));
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  test("matches canonical overlap-add across multichunk seams", async () => {
    const actual = await separateVocals(
      fixtureWave(metadata.multi_length, 0.84),
      identityInference,
    );
    const expected = fixture("demix-multichunk.f32");

    expectArraysClose(actual[0], expected.subarray(0, metadata.multi_length));
    expectArraysClose(actual[1], expected.subarray(metadata.multi_length));
  });

  test("rejects malformed channel and inference results", async () => {
    await expect(separateVocals([new Float32Array(4)], identityInference)).rejects.toThrow(/stereo/i);
    await expect(separateVocals(
      [new Float32Array(4), new Float32Array(3)],
      identityInference,
    )).rejects.toThrow(/equal length/i);
    await expect(separateVocals(
      [new Float32Array(4), new Float32Array(4)],
      async () => new Float32Array(2),
    )).rejects.toThrow(/inference output/i);
  });
});
