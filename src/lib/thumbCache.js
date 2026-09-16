// Thumbnails that outlive the CDN link they came from.
//
// Every platform here hands out a SIGNED, EXPIRING image URL:
//
//   * fbcdn / cdninstagram — `oe=<hex seconds>` + `oh=<signature>`, measured TTL
//     of a few days;
//   * tiktokcdn — `x-expires=<seconds>` + `x-signature=`, measured TTL ~48h.
//
// Stored as-is, a Library/Arquivo card looks right for two days and then turns
// into a broken-image icon forever: the record is fine, the LINK died. Facebook's
// transcription rail never had the bug because it canvases a frame off the
// playing <video> and stores a `data:` URL (see content/transcription/inject.js);
// this module gives every other write site the same durability.
//
// The bytes are re-encoded small on the way in — a card renders ~250px wide, so
// 180px WebP (~4-8KB) is both sharper than the old 90px JPEGs and smaller than
// the 14KB JPEGs the FB path writes today. That matters: both stores are ONE map
// in chrome.storage.local, re-serialized on every write.
//
// Service-worker safe: no document, no URL.createObjectURL. `createImageBitmap`
// and `OffscreenCanvas` both exist in a worker.

export const THUMB_WIDTH = 180;
export const THUMB_TYPE = "image/webp";
export const THUMB_QUALITY = 0.72;
const FETCH_TIMEOUT_MS = 8000;

// Bytes -> base64, chunked to keep String.fromCharCode off the argument-count
// limit. Shared with the JSON exporter in the background (it was written out
// twice before this module existed).
export function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function isDataThumb(url) {
  return typeof url === "string" && url.startsWith("data:");
}

/**
 * When the signed URL stops working, in epoch SECONDS — or null when the URL
 * carries no expiry (i.pinimg.com is unsigned and permanent; a `data:` URL has
 * nothing to expire).
 *
 * Read from the URL itself rather than from a guessed TTL: the value IS the
 * contract, and it is what lets the panel count the dead cards without firing a
 * single request.
 */
export function thumbExpiry(url) {
  if (!url || isDataThumb(url)) return null;
  let q;
  try {
    q = new URL(String(url)).searchParams;
  } catch {
    return null;
  }
  const oe = q.get("oe"); // fbcdn / cdninstagram — hex seconds
  if (oe && /^[0-9a-f]+$/i.test(oe)) {
    const t = parseInt(oe, 16);
    if (Number.isFinite(t) && t > 0) return t;
  }
  const x = q.get("x-expires"); // tiktokcdn — decimal seconds
  if (x && /^\d+$/.test(x)) {
    const t = parseInt(x, 10);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}

// True only when the URL says so. An unsigned URL (Pinterest) and a `data:` URL
// are never "expired" — a 404 on those is a deleted post, not a dead link.
export function isThumbExpired(url, now = Date.now()) {
  const exp = thumbExpiry(url);
  return exp != null && exp * 1000 <= now;
}

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

/**
 * Fetch a remote thumbnail and return it as a small `data:` URL.
 *
 * A `data:` URL in, the same string out — re-encoding one would only lose
 * quality. Throws on a dead link (403/404 is exactly the case this module
 * exists for); callers decide whether to keep the old URL or recover a fresh
 * one. The decode/encode pair is injectable so the unit tests don't need a
 * canvas.
 */
export async function toDurableThumb(url, opts = {}) {
  const {
    fetchImpl = fetch,
    width = THUMB_WIDTH,
    type = THUMB_TYPE,
    quality = THUMB_QUALITY,
    decode = (blob) => createImageBitmap(blob),
    canvas = (w, h) => new OffscreenCanvas(w, h),
  } = opts;
  if (!url) return null;
  if (isDataThumb(url)) return url;

  const { signal, done } = withTimeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  let blob;
  try {
    const r = await fetchImpl(url, { signal, credentials: "omit" });
    if (!r.ok) throw new Error(`miniatura HTTP ${r.status}`);
    blob = await r.blob();
  } finally {
    done();
  }
  if (!blob || !blob.size) throw new Error("miniatura vazia");

  const bmp = await decode(blob);
  // Never upscale: a 120px source re-encoded at 180 is the same picture with more
  // bytes. Math.min keeps the small ones small.
  const w = Math.max(1, Math.min(width, bmp.width || width));
  const h = Math.max(1, Math.round(w * ((bmp.height || 1) / (bmp.width || 1))));
  const cv = canvas(w, h);
  cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const out = await cv.convertToBlob({ type, quality });
  const bytes = new Uint8Array(await out.arrayBuffer());
  return `data:${out.type || type};base64,${bytesToBase64(bytes)}`;
}
