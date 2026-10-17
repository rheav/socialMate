// The video file of a top post, for the Hub's analysis: which of Instagram's
// renditions to fetch, and fetching it under a size cap with its sha256.
//
// The extension is the only part of the system with an Instagram session, so it
// fetches the MP4 from the CDN and hands the bytes to the Hub (PUT, T7). The
// Hub checks the same hash and the MP4 header again; this side stops early so a
// 2 GB file or a login page is never read whole.

const CDN_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

/** An https URL on Instagram's / Facebook's CDN. */
export function isInstagramCdn(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && CDN_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The rendition to analyse: the smallest that is at least 720p (shorter side
 * 720 px, enough for 768 px frames), else the largest there is. Off-CDN URLs
 * are ignored; a list without sizes still yields one, sizes unknown.
 */
export function pickVideoVariant(variants) {
  const usable = (Array.isArray(variants) ? variants : []).filter((v) => v && isInstagramCdn(v.url));
  if (!usable.length) return null;
  const sized = usable
    .map((v) => ({ w: Number(v.w) || null, h: Number(v.h) || null, url: v.url }))
    .filter((v) => v.w && v.h);
  if (!sized.length) return { w: null, h: null, url: usable[0].url };
  const area = (v) => v.w * v.h;
  const hd = sized.filter((v) => Math.min(v.w, v.h) >= 720).sort((a, b) => area(a) - area(b));
  if (hd.length) return hd[0];
  return sized.sort((a, b) => area(b) - area(a))[0];
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch `url` into memory, stopping past `maxBytes` (announced or not).
 * → { ok: true, data: Uint8Array, bytes, sha256, contentType }
 * | { ok: false, code } with code one of bad_host, url_expired (403/410: the
 *   signed link aged), rate_limited (429), not_mp4, media_too_large, timeout,
 *   network, download_failed.
 */
export async function downloadLimited(url, { maxBytes, fetchImpl = fetch, timeoutMs = 5 * 60_000, signal } = {}) {
  if (!isInstagramCdn(url)) return { ok: false, code: "bad_host" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  const onAbort = () => ctrl.abort("cancelled");
  signal?.addEventListener?.("abort", onAbort);
  let reader = null;
  try {
    const res = await fetchImpl(url, { credentials: "omit", cache: "no-store", signal: ctrl.signal });
    if (res.status === 403 || res.status === 410) return { ok: false, code: "url_expired" };
    if (res.status === 429) return { ok: false, code: "rate_limited" };
    if (!res.ok) return { ok: false, code: "download_failed" };
    const announced = Number(res.headers.get("content-length"));
    if (Number.isFinite(announced) && announced > maxBytes) return { ok: false, code: "media_too_large" };
    reader = res.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, code: "media_too_large" };
      }
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.byteLength;
    }
    if (bytes >= 12 && String.fromCharCode(...data.subarray(4, 8)) !== "ftyp") return { ok: false, code: "not_mp4" };
    return { ok: true, data, bytes, sha256: await sha256Hex(data), contentType: res.headers.get("content-type") };
  } catch {
    if (ctrl.signal.aborted) return { ok: false, code: ctrl.signal.reason === "cancelled" ? "cancelled" : "timeout" };
    return { ok: false, code: "network" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}
