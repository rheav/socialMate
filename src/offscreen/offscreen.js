// Offscreen engine — local Whisper transcription + ffmpeg muxing for FB videos,
// plus local niche-relevance embeddings (MiniLM) for the warmer's like-gate.
//
// Runs in an offscreen document (has DOM/AudioContext/WASM/Workers that a service
// worker lacks). The background SW hands us fbcdn track URLs (already resolved);
// because *.fbcdn.net is in host_permissions, fetches here bypass CORS.

import { get as idbGet, set as idbSet } from "idb-keyval";

// Whisper runs in a dedicated module worker (transcribe.worker.js) so its heavy WASM
// compute stays OFF the shared extension main thread — otherwise it freezes the side
// panel (same-origin extension page, same renderer thread). chrome.* isn't available
// inside the worker, so we pass the extension-resolved paths in a one-time config.
let txWorker = null;
let txMsgId = 0;
const txPending = new Map();

function getTxWorker() {
  if (txWorker) return txWorker;
  txWorker = new Worker(new URL("./transcribe.worker.js", import.meta.url), { type: "module" });
  txWorker.onmessage = (e) => {
    const { id, ...rest } = e.data || {};
    const resolve = txPending.get(id);
    if (resolve) { txPending.delete(id); resolve(rest); }
  };
  // Register a resolver for the config reply. Without one a {ok:false} config
  // (a bad model path, a missing wasm) was dropped on the floor and the first real
  // job failed later with an unrelated pipeline error.
  const cfgId = ++txMsgId;
  txPending.set(cfgId, (res) => {
    if (res && res.ok === false)
      console.error("[fbw] offscreen: worker de transcrição não configurou:", res.error);
  });
  txWorker.postMessage({
    id: cfgId,
    type: "config",
    paths: {
      models: chrome.runtime.getURL("models/"),
      assets: chrome.runtime.getURL("assets/"),
      model: chrome.runtime.getURL("models/Xenova/whisper-base"),
    },
  });
  return txWorker;
}

// language (optional) skips Whisper's auto-detect pass — used ONLY on the quick
// relevance path. The full transcript passes no language (auto-detect = best quality).
function workerTranscribe(audio, language) {
  const w = getTxWorker();
  const id = ++txMsgId;
  return new Promise((resolve) => {
    txPending.set(id, resolve);
    w.postMessage({ id, type: "transcribe", audio, language }, [audio.buffer]); // transfer the PCM
  });
}

/** Fetch a media URL and decode to 16 kHz mono Float32 PCM. maxSeconds caps the
 *  rendered length; maxBytes (quick path) fetches only a prefix via HTTP Range so
 *  a 12 s relevance transcript doesn't pull a whole multi-minute audio file. A
 *  truncated prefix that won't decode transparently falls back to the full file. */
async function fetchAudioPCM(url, maxSeconds, maxBytes) {
  let arrayBuffer;
  if (maxBytes) {
    const r = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
    if (!r.ok && r.status !== 206) throw new Error(`Fetch audio failed: ${r.status}`);
    arrayBuffer = await r.arrayBuffer();
  } else {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Fetch audio failed: ${r.status}`);
    arrayBuffer = await r.arrayBuffer();
  }
  const ctx = new AudioContext();
  try {
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(arrayBuffer);
    } catch (e) {
      if (!maxBytes) throw e; // a full fetch that won't decode is a real error
      const full = await fetch(url); // partial prefix truncated mid-fragment → full
      if (!full.ok) throw e;
      decoded = await ctx.decodeAudioData(await full.arrayBuffer());
    }
    const sampleRate = 16000;
    const fullLen = Math.ceil(decoded.duration * sampleRate);
    const len = maxSeconds ? Math.min(fullLen, Math.ceil(maxSeconds * sampleRate)) : fullLen;
    const off = new OfflineAudioContext(1, len, sampleRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    ctx.close().catch(() => {});
  }
}

function cleanChunks(result) {
  if (result?.chunks?.length) {
    const chunks = result.chunks
      .map((c) => ({ text: c.text, timestamp: c.timestamp }))
      .filter((c) => {
        const text = (c.text || "").trim();
        if (!text) return false;
        const words = text.split(/\s+/);
        if (words.length > 10) {
          const tri = {};
          for (let i = 0; i <= words.length - 3; i++) {
            const k = words.slice(i, i + 3).join(" ").toLowerCase();
            tri[k] = (tri[k] || 0) + 1;
            if (tri[k] >= 4) return false; // hallucination
          }
        }
        return true;
      });
    return { text: chunks.map((c) => c.text).join(" ").trim(), chunks };
  }
  if (typeof result === "string") return { text: result, chunks: [] };
  if (result?.text) return { text: result.text, chunks: [] };
  return { text: "", chunks: [] };
}

async function transcribeFromAudioUrl(audioUrl) {
  const audio = await fetchAudioPCM(audioUrl); // decode on the offscreen main thread (brief)
  const res = await workerTranscribe(audio);   // heavy inference on the worker thread
  if (!res.ok) throw new Error(res.error || "Transcription failed");
  return cleanChunks(res.result);
}

// ============================================================================
// NICHE RELEVANCE — local MiniLM sentence embeddings + cosine similarity.
// The warmer asks "how related is this post to my keyword?" before liking. We
// embed the keyword once (in-memory cache) and each post caption (IndexedDB cache,
// keyed by a content hash so re-scrolling the same post costs nothing).
// ============================================================================
let relWorker = null;
const relPending = new Map();
function getRelWorker() {
  if (relWorker) return relWorker;
  relWorker = new Worker(new URL("./relevance.worker.js", import.meta.url), { type: "module" });
  relWorker.onmessage = (e) => {
    const { id, ...rest } = e.data || {};
    const resolve = relPending.get(id);
    if (resolve) { relPending.delete(id); resolve(rest); }
  };
  // Register a resolver for the config reply. Without one a {ok:false} config
  // (a bad model path, a missing wasm) was dropped on the floor and the first real
  // job failed later with an unrelated pipeline error.
  const cfgId = ++txMsgId;
  relPending.set(cfgId, (res) => {
    if (res && res.ok === false)
      console.error("[fbw] offscreen: worker de relevância não configurou:", res.error);
  });
  relWorker.postMessage({
    id: cfgId,
    type: "config",
    paths: {
      models: chrome.runtime.getURL("models/"),
      assets: chrome.runtime.getURL("assets/"),
      model: chrome.runtime.getURL("models/Xenova/all-MiniLM-L6-v2"),
    },
  });
  return relWorker;
}
function workerEmbed(texts) {
  const w = getRelWorker();
  const id = ++txMsgId;
  return new Promise((resolve) => { relPending.set(id, resolve); w.postMessage({ id, type: "embed", texts }); });
}
async function embedOne(text) {
  const res = await workerEmbed([text]);
  if (!res.ok) throw new Error(res.error || "Embedding failed");
  return res.vectors[0];
}

const keywordVecCache = new Map(); // keyword -> Float vector (in-memory)
async function keywordVec(keyword) {
  const k = keyword.trim().toLowerCase();
  if (keywordVecCache.has(k)) return keywordVecCache.get(k);
  const v = await embedOne(k);
  keywordVecCache.set(k, v);
  return v;
}
function hashText(s) {
  // djb2 — cheap, collision-tolerant cache key for post captions.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "emb:" + (h >>> 0).toString(36) + ":" + s.length;
}
async function postVec(text) {
  const key = hashText(text);
  const cached = await idbGet(key).catch(() => null);
  if (cached) return cached;
  const v = await embedOne(text.slice(0, 512)); // cap caption length for speed
  idbSet(key, v).catch(() => {});
  return v;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Returns cosine similarity in [-1,1] (vectors are L2-normalized → dot product).
async function relevanceScore(keyword, text) {
  const t = (text || "").trim();
  if (!keyword || !keyword.trim() || t.length < 3) return 1; // nothing to judge → don't block
  const [kv, pv] = await Promise.all([keywordVec(keyword), postVec(t)]);
  return dot(kv, pv);
}

// ---- spam / scam guard (cosine to a fixed set of scam-anchor phrases) ----
const SPAM_ANCHORS = [
  "free giveaway dm me to claim your prize winner",
  "invest in bitcoin crypto forex guaranteed daily profit",
  "click the link in my bio to buy now limited offer",
  "make money fast work from home easy passive income",
  "whatsapp or telegram me for private paid reading",
  "follow like and share to win comment done amen",
];
let spamVecs = null;
async function getSpamVecs() {
  if (spamVecs) return spamVecs;
  const res = await workerEmbed(SPAM_ANCHORS);
  if (!res.ok) throw new Error(res.error || "spam anchors embed failed");
  spamVecs = res.vectors;
  return spamVecs;
}
// Max cosine of the post against any spam anchor (higher = more spam-like).
async function spamScore(text) {
  const t = (text || "").trim();
  if (t.length < 8) return 0;
  const [pv, anchors] = await Promise.all([postVec(t), getSpamVecs()]);
  let max = 0;
  for (const a of anchors) { const s = dot(pv, a); if (s > max) max = s; }
  return max;
}

// ---- ffmpeg mux (lazy) ----
let ffmpeg = null;
async function getFfmpeg() {
  if (ffmpeg) return ffmpeg;
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm"),
  });
  return ffmpeg;
}

async function muxDownload(videoUrl, audioUrl, videoId) {
  // fbcdn track URLs are signed and expire. Unchecked, a 403 fed an HTML error
  // page into ffmpeg, which then produced either a garbage MP4 or an error that
  // said nothing about the real cause.
  const grab = async (url, what) => {
    const r = await fetch(url);
    if (!r.ok)
      throw new Error(
        `faixa de ${what} indisponível (HTTP ${r.status}) — o link do fbcdn expirou, recarregue a página`,
      );
    return r.arrayBuffer();
  };
  const [vBuf, aBuf] = await Promise.all([
    grab(videoUrl, "vídeo"),
    grab(audioUrl, "áudio"),
  ]);
  const fm = await getFfmpeg();
  await fm.writeFile("v.mp4", new Uint8Array(vBuf));
  await fm.writeFile("a.mp4", new Uint8Array(aBuf));
  // H.264 + AAC → MP4 by stream copy (no re-encode). +faststart moves the moov
  // atom to the front so the file plays/streams before it's fully loaded.
  await fm.exec([
    "-i", "v.mp4", "-i", "a.mp4",
    "-c", "copy", "-movflags", "+faststart", "out.mp4",
  ]);
  const out = await fm.readFile("out.mp4");
  await fm.deleteFile("v.mp4").catch(() => {});
  await fm.deleteFile("a.mp4").catch(() => {});
  await fm.deleteFile("out.mp4").catch(() => {});
  // Hand the SW a blob URL (not a base64 data URL — that inflates ~33% and builds
  // a huge string in memory). The SW can't mint object URLs, so we do it here; it
  // stays valid for chrome.downloads as long as this offscreen doc is alive.
  // The Blob is a whole video (can be 100 MB+). chrome.downloads consumes it almost
  // immediately, but the URL kept it alive for a fixed 5 minutes. Track it so the
  // idle release (~45s after the last job) revokes it; the 5-min timer stays only as
  // a fallback for the case where no idle release happens.
  const blobUrl = URL.createObjectURL(new Blob([out], { type: "video/mp4" }));
  liveBlobUrls.add(blobUrl);
  setTimeout(() => { URL.revokeObjectURL(blobUrl); liveBlobUrls.delete(blobUrl); }, 5 * 60 * 1000);
  // A BARE file name on purpose: this document muxes bytes, it does not decide
  // where downloads live. background.js files it under social-mate/ via
  // downloadPath() — one owner for paths, no second convention here.
  return { blobUrl, filename: `fb-${videoId}.mp4` };
}

// Same trick for a plain media fetch. The SW used to buffer a saved photo as a
// base64 data: URL — the bytes, the binary string and the base64 string all
// resident at once, roughly 3x the file, per photo — because it has no
// URL.createObjectURL. Doing the fetch here costs one copy. Bookkeeping is
// muxDownload's: tracked in liveBlobUrls, revoked by the idle release, with the
// 5-minute timer as the backstop. fallbackUrl mirrors the worker path this
// replaces (a second candidate for a CDN link that 403s).
// A blob URL handed to chrome.downloads stays PINNED until that download reports it
// is finished. Without the pin, the 45s idle release revokes every live blob — and it
// does so BEFORE telling the worker it is going idle, so no service-worker-side guard
// can protect a write that is still in flight. Reachable with "ask where to save each
// file" enabled: leave the dialog open past the idle window and the file dies.
const pinnedBlobUrls = new Set();

function unpinBlobUrl(blobUrl) {
  pinnedBlobUrls.delete(blobUrl);
  if (liveBlobUrls.delete(blobUrl)) URL.revokeObjectURL(blobUrl);
}

async function fetchToBlobUrl(url, fallbackUrl) {
  let r = await fetch(url).catch(() => null);
  if ((!r || !r.ok) && fallbackUrl) r = await fetch(fallbackUrl).catch(() => null);
  if (!r || !r.ok) throw new Error("fetch failed " + (r ? r.status : "network"));
  const blobUrl = URL.createObjectURL(await r.blob());
  liveBlobUrls.add(blobUrl);
  pinnedBlobUrls.add(blobUrl);
  // Backstop: a download that never reports back (worker torn down mid-write) must
  // not pin the runtimes forever.
  setTimeout(() => unpinBlobUrl(blobUrl), 5 * 60 * 1000);
  return { blobUrl };
}

// ---- idle release ----------------------------------------------------------
// Whisper (~76 MB model), MiniLM (~23 MB) and ffmpeg (31 MB wasm, heap grown to the
// largest video ever muxed) were previously loaded once and held for the whole
// browser session — several hundred MB resident with no work in flight, because
// nothing ever terminated the workers or closed this document.
//
// Now: count in-flight jobs; when the count returns to 0 and stays there for
// IDLE_MS, terminate everything and ask the SW to close the document. WASM heaps
// only shrink by being thrown away, so this is the only way to give the memory
// back. The next job re-creates the document and reloads the model (~1–2 s), which
// is a fine trade for not holding 300 MB idle.
const IDLE_MS = 45000;
const liveBlobUrls = new Set();
let inFlight = 0;
let idleTimer = null;

function releaseRuntimes() {
  if (inFlight > 0) return;
  // Defer while a download still holds one of our blob URLs — releasing revokes it.
  if (pinnedBlobUrls.size > 0) return scheduleIdleRelease();
  try { txWorker?.terminate(); } catch { /* ignore */ }
  try { relWorker?.terminate(); } catch { /* ignore */ }
  try { ffmpeg?.terminate?.(); } catch { /* ignore */ }
  txWorker = null;
  relWorker = null;
  ffmpeg = null;
  // Pending resolvers can never settle once their worker is gone — settle them so
  // no caller hangs, then drop the closures.
  for (const resolve of txPending.values()) resolve({ success: false, error: "offscreen released" });
  for (const resolve of relPending.values()) resolve({ success: false, error: "offscreen released" });
  txPending.clear();
  relPending.clear();
  keywordVecCache.clear();
  for (const u of liveBlobUrls) URL.revokeObjectURL(u);
  liveBlobUrls.clear();
  // The SW owns the document's lifetime; it closes us (and resets its own flag).
  chrome.runtime.sendMessage({ type: "FBW_OFFSCREEN_IDLE" }).catch(() => {});
}

function scheduleIdleRelease() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(releaseRuntimes, IDLE_MS);
}

// Wrap a job so the in-flight count (and therefore the idle timer) is always correct,
// even when the job throws.
async function job(sendResponse, run) {
  inFlight += 1;
  clearTimeout(idleTimer);
  try {
    sendResponse({ success: true, ...(await run()) });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  } finally {
    inFlight -= 1;
    if (inFlight === 0) scheduleIdleRelease();
  }
}

// ---- message handler ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  if (msg.action === "transcribeFromAudioUrl") {
    job(sendResponse, () => transcribeFromAudioUrl(msg.audioUrl));
    return true;
  }

  if (msg.action === "relevanceScore") {
    job(sendResponse, async () => ({
      score: await relevanceScore(msg.keyword, msg.text),
      spam: msg.spam ? await spamScore(msg.text) : 0,
    }));
    return true;
  }

  // The background sends this when its 3-minute race times out. Terminating the
  // worker is the only way to stop Whisper mid-inference; the next job lazily
  // spawns a fresh one. Without it the zombie job kept a core busy and held
  // inFlight above zero, blocking the idle release for minutes.
  if (msg.action === "abortTranscription") {
    try {
      if (txWorker) {
        txWorker.terminate();
        txWorker = null;
        for (const [id, resolve] of txPending)
          resolve({ ok: false, error: "transcrição cancelada" });
        txPending.clear();
      }
    } catch {}
    // Do NOT touch inFlight here. Settling the pending resolvers above lets the
    // aborted job's own job() wrapper run its finally and decrement exactly once —
    // zeroing it would drive the counter negative, and `inFlight === 0` would then
    // never be true again, blocking the idle release forever.
    sendResponse({ success: true });
    return true;
  }
  if (msg.action === "muxDownload") {
    job(sendResponse, () => muxDownload(msg.videoUrl, msg.audioUrl, msg.videoId));
    return true;
  }
  if (msg.action === "fetchToBlobUrl") {
    job(sendResponse, () => fetchToBlobUrl(msg.url, msg.fallbackUrl));
    return true;
  }
  // The SW asks for this once its download has left in_progress, so a bulk photo
  // save doesn't pile every image up here until the idle release. Deliberately not
  // a job(): it is bookkeeping for a job that already finished, and restarting the
  // idle timer would keep the runtimes resident for nothing.
  if (msg.action === "revokeBlobUrl") {
    unpinBlobUrl(msg.blobUrl);
    sendResponse({ success: true });
    return true;
  }

  return false;
});
