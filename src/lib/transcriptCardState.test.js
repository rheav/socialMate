import { describe, it, expect } from "vitest";
import { isTranscribing } from "./transcriptCardState.js";

describe("isTranscribing", () => {
  it("is false for a post saved off a grid — it never started a job", () => {
    // Exactly what buildSavedEntry writes: no text, no status.
    const saved = { schema: 2, videoId: "DcjsUy8lfEX", platform: "instagram", caption: "…" };
    expect(isTranscribing(saved, "saved")).toBe(false);
  });

  it("is true for a starred transcript still running", () => {
    expect(isTranscribing({ videoId: "1", status: "running" }, "saved")).toBe(true);
  });

  it("is false once the transcript has text, in either store", () => {
    const done = { videoId: "1", status: "done", text: "olá" };
    expect(isTranscribing(done, "saved")).toBe(false);
    expect(isTranscribing(done, "transcripts")).toBe(false);
  });

  it("is true in the transcripts store while a job has no text yet", () => {
    expect(isTranscribing({ videoId: "1", status: "running" }, "transcripts")).toBe(true);
    // Records written before `status` existed: still a job, still running.
    expect(isTranscribing({ videoId: "1" }, "transcripts")).toBe(true);
  });

  it("is false for a failed job — the card shows the error instead", () => {
    expect(isTranscribing({ videoId: "1", status: "error", error: "x" }, "transcripts")).toBe(false);
  });

  it("tolerates a missing record", () => {
    expect(isTranscribing(null, "saved")).toBe(false);
    expect(isTranscribing(undefined, "transcripts")).toBe(false);
  });
});
