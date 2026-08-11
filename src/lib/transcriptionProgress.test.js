import { describe, it, expect } from "vitest";
import {
  TX_PHASES,
  txProgressPercent,
  whisperInferRatio,
  advanceTxProgress,
  whisperWindowCount,
} from "./transcriptionProgress.js";

describe("transcription progress", () => {
  it("maps a phase ratio onto the overall bar", () => {
    expect(txProgressPercent("fetch", 0)).toBe(0);
    expect(txProgressPercent("fetch", 0.5)).toBe(9);
    expect(txProgressPercent("decode", 1)).toBe(24);
    expect(txProgressPercent("model", 1)).toBe(34);
    expect(txProgressPercent("infer", 0)).toBe(34);
    expect(txProgressPercent("infer", 1)).toBe(100);
    // Out-of-range and garbage ratios stay inside the phase's own span.
    expect(txProgressPercent("infer", 2)).toBe(100);
    expect(txProgressPercent("infer", -1)).toBe(34);
    expect(txProgressPercent("infer", NaN)).toBe(34);
    expect(txProgressPercent("nonsense", 0.5)).toBe(null);
    expect(TX_PHASES.infer[1]).toBe(100);
  });

  it("counts finished windows plus the position inside the running one", () => {
    expect(whisperInferRatio(4, 0, 0)).toBe(0);
    expect(whisperInferRatio(4, 1, 0)).toBe(0.25);
    expect(whisperInferRatio(4, 1, 0.5)).toBe(0.375);
    expect(whisperInferRatio(4, 4, 0)).toBe(1);
    // The last window is finished — a late timestamp must not push past 100%.
    expect(whisperInferRatio(4, 4, 0.9)).toBe(1);
    expect(whisperInferRatio(0, 0, 0)).toBe(0); // a bad count still divides by 1
    expect(whisperInferRatio(2, 9, 0)).toBe(1); // and never exceeds the total
  });

  it("never moves the bar backwards", () => {
    expect(advanceTxProgress(undefined, 10)).toBe(10);
    expect(advanceTxProgress(40, 26)).toBe(40); // the model phase restarts per file
    expect(advanceTxProgress(40, 55)).toBe(55);
    expect(advanceTxProgress(40, NaN)).toBe(40);
    expect(advanceTxProgress(40, 999)).toBe(100);
  });
});

// The window count is what makes inference progress REAL rather than a guess: it
// is known from the decoded PCM before the first window runs.
describe("whisper window count", () => {
  const sec = (s) => s * 16000;
  it("counts the 30 s windows an audio buffer will be split into", () => {
    expect(whisperWindowCount(sec(5))).toBe(1);
    expect(whisperWindowCount(sec(30))).toBe(1);
    expect(whisperWindowCount(sec(31))).toBe(2); // 30 + one 20 s jump
    expect(whisperWindowCount(sec(50))).toBe(2);
    expect(whisperWindowCount(sec(51))).toBe(3);
    expect(whisperWindowCount(sec(130))).toBe(6);
    expect(whisperWindowCount(0)).toBe(1);
  });
});
