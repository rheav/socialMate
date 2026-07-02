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
  txWorker.postMessage({
    id: ++txMsgId,
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
  relWorker.postMessage({
    id: ++txMsgId,
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

// ---- quick partial transcript (relevance signal for video posts) ----
const quickTxCache = new Map(); // videoId -> text (in-memory)
async function quickTranscribe(audioUrl, maxSeconds, videoId, lang) {
  if (videoId && quickTxCache.has(videoId)) return quickTxCache.get(videoId);
  const idbKey = "qtx:" + (videoId || hashText(audioUrl));
  const cached = await idbGet(idbKey).catch(() => null);
  if (cached != null) { if (videoId) quickTxCache.set(videoId, cached); return cached; }
  // Range-fetch a ~512 KB prefix (covers 12 s even at high audio bitrates) instead
  // of the whole file; fetchAudioPCM falls back to the full file if it won't decode.
  let pcm = await fetchAudioPCM(audioUrl, maxSeconds, 512 * 1024);
  const res = await workerTranscribe(pcm, lang);
  const text = res.ok ? cleanChunks(res.result).text : "";
  if (text) { idbSet(idbKey, text).catch(() => {}); if (videoId) quickTxCache.set(videoId, text); }
  return text;
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
  const [vBuf, aBuf] = await Promise.all([
    fetch(videoUrl).then((r) => r.arrayBuffer()),
    fetch(audioUrl).then((r) => r.arrayBuffer()),
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
  const blobUrl = URL.createObjectURL(new Blob([out], { type: "video/mp4" }));
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
  return { blobUrl, filename: `fb-${videoId}.mp4` };
}

// ---- message handler ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  if (msg.action === "transcribeFromAudioUrl") {
    (async () => {
      try {
        const { text, chunks } = await transcribeFromAudioUrl(msg.audioUrl);
        sendResponse({ success: true, text, chunks });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "relevanceScore") {
    (async () => {
      try {
        const score = await relevanceScore(msg.keyword, msg.text);
        const spam = msg.spam ? await spamScore(msg.text) : 0;
        sendResponse({ success: true, score, spam });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "quickTranscribe") {
    (async () => {
      try {
        const text = await quickTranscribe(msg.audioUrl, msg.maxSeconds || 12, msg.videoId, msg.lang);
        sendResponse({ success: true, text });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "muxDownload") {
    (async () => {
      try {
        const { blobUrl, filename } = await muxDownload(msg.videoUrl, msg.audioUrl, msg.videoId);
        sendResponse({ success: true, blobUrl, filename });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});
