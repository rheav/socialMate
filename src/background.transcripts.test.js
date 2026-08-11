import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// ============================================================================
// The transcript store is a single storage.local MAP, and it has four writers:
// the job runner (running → done), the metadata backfill, the page's instant
// "running" card, and the Library's delete / clear-all. Each did its own
// get → mutate → set, which is a lost-update race — the same one the saved store
// was fixed for. Two jobs finishing near each other, or a card written while a
// transcript lands, and one write silently disappears.
//
// These drive the real background functions against a storage stub whose get/set
// actually take time, which is what makes the race observable at all.
// ============================================================================

const data = {};

function chromeStub() {
  const node = () => {
    const fn = () => Promise.resolve();
    return new Proxy(fn, {
      get(target, prop) {
        if (prop === "then") return undefined; // never look like a thenable
        if (!(prop in target)) target[prop] = node();
        return target[prop];
      },
      apply: () => Promise.resolve(),
    });
  };
  const stub = node();
  // A real map behind a slow, asynchronous get/set — a synchronous stub would
  // serialize the writers for free and hide the very bug under test.
  stub.storage.local.get = (key) =>
    new Promise((r) =>
      setTimeout(() => {
        const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
        const out = {};
        for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
        r(out);
      }, 5),
    );
  stub.storage.local.set = (obj) =>
    new Promise((r) =>
      setTimeout(() => {
        Object.assign(data, structuredClone(obj));
        r();
      }, 5),
    );
  return stub;
}

let putTranscript, removeTranscripts;

beforeAll(async () => {
  vi.stubGlobal("chrome", chromeStub());
  ({ putTranscript, removeTranscripts } = await import("./background.js"));
});
beforeEach(() => {
  for (const k of Object.keys(data)) delete data[k];
});

const transcripts = () => data.fbw_transcripts || {};

describe("transcript store writes", () => {
  it("keeps both records when two jobs write at the same time", async () => {
    await Promise.all([
      putTranscript("A", { status: "done", text: "alpha" }),
      putTranscript("B", { status: "done", text: "beta" }),
    ]);
    expect(transcripts().A?.text).toBe("alpha");
    expect(transcripts().B?.text).toBe("beta");
  });

  it("does not lose a finished transcript to a concurrent metadata patch", async () => {
    data.fbw_transcripts = { A: { videoId: "A", status: "running" } };
    await Promise.all([
      putTranscript("A", { status: "done", text: "the transcript" }),
      putTranscript("A", { counts: { like: "8,1 mil" } }),
    ]);
    expect(transcripts().A.text).toBe("the transcript");
    expect(transcripts().A.counts).toEqual({ like: "8,1 mil" });
  });

  // A patch's null normally means "I didn't see it", so it can never erase. The
  // caption path needs the opposite for ONE field: it knows the record's stored
  // language (from an earlier Whisper run) does not describe the subtitle track it
  // is about to save, and inheriting it would mislabel the transcript.
  it("lets a writer clear a field it must not inherit", async () => {
    data.fbw_transcripts = { A: { videoId: "A", language: "br", author: { name: "x" } } };
    await putTranscript("A", { source: "caption", language: null }, { clear: ["language"] });
    expect(transcripts().A.language).toBe(null);
    expect(transcripts().A.author).toEqual({ name: "x" }); // everything else untouched
  });

  it("still refuses to erase a field when no writer asked to clear it", async () => {
    data.fbw_transcripts = { A: { videoId: "A", language: "en", counts: { like: 3 } } };
    await putTranscript("A", { status: "done", language: null, counts: null });
    expect(transcripts().A.language).toBe("en");
    expect(transcripts().A.counts).toEqual({ like: 3 });
  });

  it("removes only the ids it was given", async () => {
    data.fbw_transcripts = { A: { videoId: "A" }, B: { videoId: "B" } };
    await removeTranscripts(["A"]);
    expect(Object.keys(transcripts())).toEqual(["B"]);
  });

  it("clears the whole store on request", async () => {
    data.fbw_transcripts = { A: { videoId: "A" }, B: { videoId: "B" } };
    await removeTranscripts({ all: true });
    expect(transcripts()).toEqual({});
  });

  it("does not drop a record written while a delete is in flight", async () => {
    data.fbw_transcripts = { A: { videoId: "A" }, B: { videoId: "B" } };
    await Promise.all([removeTranscripts(["A"]), putTranscript("C", { status: "running" })]);
    expect(Object.keys(transcripts()).sort()).toEqual(["B", "C"]);
  });
});
