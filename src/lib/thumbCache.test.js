import { describe, it, expect, vi } from "vitest";
import {
  bytesToBase64,
  isDataThumb,
  isThumbExpired,
  thumbExpiry,
  toDurableThumb,
} from "./thumbCache.js";

// A 1x1 canvas stand-in: the real one needs OffscreenCanvas, which node has not.
function fakeCanvas(recorded) {
  return (w, h) => {
    recorded.push([w, h]);
    return {
      getContext: () => ({ drawImage() {} }),
      convertToBlob: async ({ type }) => ({
        type,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    };
  };
}
const okFetch = (bytes = 10) =>
  vi.fn(async () => ({ ok: true, blob: async () => ({ size: bytes }) }));

describe("thumbExpiry", () => {
  it("reads the fbcdn/cdninstagram `oe` stamp as hex seconds", () => {
    // 0x6AA3406C === 1789083756 === 2026-09-10T23:42:36Z (decoded from a real URL)
    expect(thumbExpiry("https://scontent.fbcdn.net/v/t15.x/a.jpg?oh=00_x&oe=6AA3406C")).toBe(1789083756);
  });

  it("reads the tiktokcdn `x-expires` stamp as decimal seconds", () => {
    expect(thumbExpiry("https://p16-common-sign.tiktokcdn.com/x~tplv.image?x-expires=1787104800&x-signature=a")).toBe(1787104800);
  });

  it("returns null for an unsigned Pinterest URL and for a data: thumb", () => {
    expect(thumbExpiry("https://i.pinimg.com/236x/86/30/a0/8630a02b.jpg")).toBeNull();
    expect(thumbExpiry("data:image/webp;base64,AAA")).toBeNull();
    expect(thumbExpiry(null)).toBeNull();
  });

  it("ignores a junk stamp instead of reading it as epoch 0", () => {
    expect(thumbExpiry("https://scontent.fbcdn.net/a.jpg?oe=zzz")).toBeNull();
    expect(thumbExpiry("https://p16.tiktokcdn.com/a.jpg?x-expires=soon")).toBeNull();
  });
});

describe("isThumbExpired", () => {
  const url = "https://scontent.fbcdn.net/v/t15.x/a.jpg?oe=6AA3406C"; // 1789083756s
  it("is true once the stamp has passed", () => {
    expect(isThumbExpired(url, 1789083756 * 1000 + 1)).toBe(true);
  });
  it("is false while it is still valid", () => {
    expect(isThumbExpired(url, 1789083756 * 1000 - 60_000)).toBe(false);
  });
  it("never calls an unsigned or data: thumb expired", () => {
    expect(isThumbExpired("https://i.pinimg.com/a.jpg", Date.now())).toBe(false);
    expect(isThumbExpired("data:image/webp;base64,AAA", Date.now())).toBe(false);
  });
});

describe("toDurableThumb", () => {
  it("passes a data: URL through untouched — re-encoding it would only lose quality", async () => {
    const fetchImpl = vi.fn();
    expect(await toDurableThumb("data:image/jpeg;base64,AAA", { fetchImpl })).toBe("data:image/jpeg;base64,AAA");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-encodes a remote thumbnail into a small data: URL", async () => {
    const sizes = [];
    const out = await toDurableThumb("https://cdn/x.jpg", {
      fetchImpl: okFetch(),
      decode: async () => ({ width: 1080, height: 1920 }),
      canvas: fakeCanvas(sizes),
    });
    expect(out).toBe("data:image/webp;base64," + bytesToBase64(new Uint8Array([1, 2, 3])));
    expect(sizes).toEqual([[180, 320]]); // width clamped, aspect kept
  });

  it("never upscales a thumbnail that is already smaller than the target", async () => {
    const sizes = [];
    await toDurableThumb("https://cdn/x.jpg", {
      fetchImpl: okFetch(),
      decode: async () => ({ width: 120, height: 120 }),
      canvas: fakeCanvas(sizes),
    });
    expect(sizes).toEqual([[120, 120]]);
  });

  it("throws on the dead link this module exists for", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }));
    await expect(toDurableThumb("https://cdn/x.jpg", { fetchImpl })).rejects.toThrow(/403/);
  });

  it("throws on an empty body rather than storing a 0-byte thumbnail", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, blob: async () => ({ size: 0 }) }));
    await expect(toDurableThumb("https://cdn/x.jpg", { fetchImpl })).rejects.toThrow(/vazia/);
  });

  it("isDataThumb only accepts a data: URL", () => {
    expect(isDataThumb("data:image/webp;base64,AA")).toBe(true);
    expect(isDataThumb("https://cdn/x.jpg")).toBe(false);
    expect(isDataThumb(null)).toBe(false);
  });
});
