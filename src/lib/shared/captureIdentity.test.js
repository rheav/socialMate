import { describe, it, expect } from "vitest";
import { sameCapture } from "./captureIdentity.js";

// Measured on facebook.com/reel/… (2026-08-01, 1330 rAF samples): after a reel
// change the URL carries the NEW reel id for ~150-175 ms while the mounted card
// — author, caption, counts — is still the PREVIOUS reel's. A scrape taken in
// that window files one reel's numbers under another reel's id. Two scrapes that
// disagree mean the page is mid-swap; only a stable pair may be trusted.
describe("sameCapture", () => {
  const a = { videoId: "111", author: { name: "Astra Vale" }, caption: "#auralytrend #USA" };

  it("accepts two identical scrapes", () => {
    expect(sameCapture(a, { ...a })).toBe(true);
  });

  it("rejects the reel-swap window: same new id, previous card still mounted", () => {
    expect(sameCapture(a, { ...a, author: { name: "Soma Chhaya" }, caption: "outro" })).toBe(false);
  });

  it("rejects a scrape whose id changed under it", () => {
    expect(sameCapture(a, { ...a, videoId: "222" })).toBe(false);
  });

  it("ignores a caption that only grew its truncation tail", () => {
    // "… Ver mais" collapses/expands as FB hydrates; the post is the same post.
    const grown = { ...a, caption: a.caption + " and a lot more text arriving late" };
    expect(sameCapture({ ...a, caption: "#auralytrend #USA" }, grown)).toBe(true);
  });

  it("treats a missing scrape as unstable", () => {
    expect(sameCapture(null, a)).toBe(false);
    expect(sameCapture(a, null)).toBe(false);
  });
});
