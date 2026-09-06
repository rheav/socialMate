import { describe, expect, test } from "vitest";
import { encodeWav } from "./wav.js";

describe("encodeWav", () => {
  test("writes interleaved stereo PCM16 with a valid RIFF header", () => {
    const wav = encodeWav([
      Float32Array.of(-1, 0, 1),
      Float32Array.of(0.5, -0.5, 2),
    ], 8000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (offset, length) => String.fromCharCode(...wav.subarray(offset, offset + length));

    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(48);
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(12);
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([
      -32767, 16383, 0, -16383, 32767, 32767,
    ]);
  });

  test("rejects invalid channel layouts and sample rates", () => {
    expect(() => encodeWav([], 44100)).toThrow(/channel/i);
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 44100)).toThrow(/equal length/i);
    expect(() => encodeWav([new Float32Array(2)], 0)).toThrow(/sample rate/i);
  });
});
