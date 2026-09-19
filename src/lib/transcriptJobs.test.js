import { describe, expect, it } from "vitest";
import {
  TX_INTERRUPTED_ERROR,
  cleanChunks,
  fmtDeadline,
  isActiveTxStatus,
  orphanedTranscriptIds,
  savedTranscriptPatch,
  tidyTranscriptText,
  txDeadlineMs,
} from "./transcriptJobs.js";

describe("transcription deadlines", () => {
  it("scales with the video's duration, within a floor and a ceiling", () => {
    expect(txDeadlineMs(30)).toBe(180_000); // floor: short clips still get 3 min
    expect(txDeadlineMs(600)).toBe((120 + 900) * 1000); // 10 min video → 17 min
    expect(txDeadlineMs(10 * 3600)).toBe(3_600_000); // ceiling: 1 h
  });

  it("is generous when the duration is unknown", () => {
    expect(txDeadlineMs(undefined)).toBe(1_800_000);
    expect(txDeadlineMs(null)).toBe(1_800_000);
    expect(txDeadlineMs(0)).toBe(1_800_000);
    expect(txDeadlineMs("abc")).toBe(1_800_000);
  });

  it("formats the wait for the error message", () => {
    expect(fmtDeadline(180_000)).toBe("3 min");
    expect(fmtDeadline(txDeadlineMs(600))).toBe("17 min");
  });
});

describe("orphaned transcript records", () => {
  const boot = 1_000_000;

  it("finds queued and running records last written before the worker booted", () => {
    const map = {
      a: { status: "running", updatedAt: boot - 5 },
      b: { status: "queued", updatedAt: boot - 5 },
      c: { status: "running", updatedAt: boot + 5 }, // started after boot: alive
      d: { status: "done", updatedAt: boot - 5 },
      e: { status: "error", updatedAt: boot - 5 },
      f: { status: "running" }, // no clock at all: older than anything
    };
    expect(orphanedTranscriptIds(map, boot).sort()).toEqual(["a", "b", "f"]);
  });

  it("tolerates an empty or missing store", () => {
    expect(orphanedTranscriptIds(undefined, boot)).toEqual([]);
    expect(orphanedTranscriptIds({ x: null }, boot)).toEqual([]);
  });

  it("says what happened in the error it files", () => {
    expect(TX_INTERRUPTED_ERROR).toMatch(/interrompida/);
  });

  it("knows which statuses are in flight", () => {
    expect(isActiveTxStatus("queued")).toBe(true);
    expect(isActiveTxStatus("running")).toBe(true);
    expect(isActiveTxStatus("done")).toBe(false);
    expect(isActiveTxStatus(undefined)).toBe(false);
  });
});

describe("the Library copy of a transcript", () => {
  it("carries only the transcript's own fields", () => {
    const patch = savedTranscriptPatch({
      videoId: "1",
      status: "done",
      text: "hi",
      chunks: [],
      language: "en",
      caption: "post caption",
      thumb: "data:",
    });
    expect(patch).toEqual({ status: "done", text: "hi", chunks: [], language: "en" });
  });

  it("returns nothing for a missing transcript", () => {
    expect(savedTranscriptPatch(null)).toEqual({});
  });
});

describe("cleaning Whisper output", () => {
  const ts = (i) => [i, i + 1];

  it("trims each chunk and joins with a single space", () => {
    const out = cleanChunks({
      chunks: [
        { text: " Hello there.", timestamp: ts(0) },
        { text: " How are you?", timestamp: ts(1) },
      ],
    });
    expect(out.text).toBe("Hello there. How are you?");
    expect(out.chunks.map((c) => c.text)).toEqual(["Hello there.", "How are you?"]);
    expect(out.chunks[1].timestamp).toEqual([1, 2]);
  });

  it("keeps a line said twice but drops Whisper's loop of it", () => {
    const loop = Array.from({ length: 6 }, (_, i) => ({ text: " Thank you.", timestamp: ts(i) }));
    const out = cleanChunks({ chunks: [{ text: " Start.", timestamp: ts(0) }, ...loop, { text: " End.", timestamp: ts(9) }] });
    expect(out.chunks.map((c) => c.text)).toEqual(["Start.", "Thank you.", "Thank you.", "End."]);
  });

  it("compares lines ignoring case and punctuation", () => {
    const out = cleanChunks({
      chunks: [
        { text: " Amen.", timestamp: ts(0) },
        { text: " amen", timestamp: ts(1) },
        { text: " AMEN!", timestamp: ts(2) },
      ],
    });
    expect(out.chunks).toHaveLength(2);
  });

  it("still drops a chunk that loops inside itself", () => {
    const text = " go go go go go go go go go go go go go";
    const out = cleanChunks({ chunks: [{ text, timestamp: ts(0) }, { text: " ok", timestamp: ts(1) }] });
    expect(out.chunks.map((c) => c.text)).toEqual(["ok"]);
  });

  it("handles results without chunks", () => {
    expect(cleanChunks("  a  b ")).toEqual({ text: "a b", chunks: [] });
    expect(cleanChunks({ text: " hi  there " })).toEqual({ text: "hi there", chunks: [] });
    expect(cleanChunks(null)).toEqual({ text: "", chunks: [] });
  });

  it("tidies old double-spaced text without touching line breaks", () => {
    expect(tidyTranscriptText("Hello.  How are you?   Fine.")).toBe("Hello. How are you? Fine.");
    expect(tidyTranscriptText("a\n\nb")).toBe("a\n\nb");
    expect(tidyTranscriptText(null)).toBe("");
  });
});
