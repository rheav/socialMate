// "Fontes de look" in ugc-factory (~/Code/apps/ugc-factory, /flow): the worker fetches
// the photo the page showed and posts it to the app's library, POST /api/flow/sources.
// The page never talks to the app; only this worker does, with the `x-ugc-fontes`
// header the app requires (a header forces a CORS preflight, so no web page can post
// there). The app keeps the file byte for byte and dedupes by its SHA-256.

export const FONTES_BASE = "http://127.0.0.1:3210"; // ugc-factory's production port
/** Storage override of the address: the app moved ports, or a probe server. */
export const FONTES_BASE_KEY = "fbw_fontes_base";
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

/**
 * `msg`: `{ url, pageUrl?, origin? }` from the content script.
 * Resolves `{ ok: true, duplicate }` or `{ ok: false, error: "url" | "fetch" | "app" | "server", message? }`,
 * where "app" means nothing answered on the address (the app is closed) or a build without the Fontes (404).
 */
export async function sendToFontes(msg, { base = FONTES_BASE, prepare, fetchImpl = fetch, toJpeg = reencodeJpeg } = {}) {
  const url = typeof msg?.url === "string" && /^https:\/\//i.test(msg.url) ? msg.url : null;
  if (!url) return { ok: false, error: "url" };
  if (prepare) await prepare(url);
  const res = await fetchImpl(url).catch(() => null);
  if (!res || !res.ok) return { ok: false, error: "fetch" };
  let blob = await res.blob();
  const type = (blob.type || "").split(";")[0].trim().toLowerCase();
  // The app takes JPG, PNG or WebP as they are; anything else (AVIF…) becomes a JPEG here.
  if (EXT[type]) { if (type !== blob.type) blob = new Blob([blob], { type }); } else blob = await toJpeg(blob);
  const form = new FormData();
  form.append("files", blob, `${msg.origin || "foto"}-${Date.now()}${EXT[blob.type] || ".jpg"}`);
  if (msg.origin) form.set("origin", String(msg.origin).slice(0, 40));
  if (msg.pageUrl) form.set("url", String(msg.pageUrl).slice(0, 500));
  const out = await fetchImpl(`${base}/api/flow/sources`, { method: "POST", body: form, headers: { "x-ugc-fontes": "1" } }).catch(() => null);
  if (!out) return { ok: false, error: "app" };
  if (!out.ok) {
    const body = await out.json().catch(() => null);
    return { ok: false, error: out.status === 404 ? "app" : "server", message: body?.error?.message ?? null };
  }
  const rows = await out.json().catch(() => []);
  return { ok: true, duplicate: Boolean(rows?.[0]?.duplicate) };
}

async function reencodeJpeg(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
}
