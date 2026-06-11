// Offscreen engine — local Whisper transcription + ffmpeg muxing for FB videos.
//
// Runs in an offscreen document (has DOM/AudioContext/WASM/Workers that a service
// worker lacks). The background SW hands us fbcdn track URLs (already resolved);
// because *.fbcdn.net is in host_permissions, fetches here bypass CORS.

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

function workerTranscribe(audio) {
  const w = getTxWorker();
  const id = ++txMsgId;
  return new Promise((resolve) => {
    txPending.set(id, resolve);
    w.postMessage({ id, type: "transcribe", audio }, [audio.buffer]); // transfer the PCM
  });
}

/** Fetch a media URL and decode to 16 kHz mono Float32 PCM. */
async function fetchAudioPCM(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fetch audio failed: ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const sampleRate = 16000;
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * sampleRate), sampleRate);
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
  await fm.exec(["-i", "v.mp4", "-i", "a.mp4", "-c", "copy", "out.mkv"]);
  const out = await fm.readFile("out.mkv");
  await fm.deleteFile("v.mp4").catch(() => {});
  await fm.deleteFile("a.mp4").catch(() => {});
  await fm.deleteFile("out.mkv").catch(() => {});
  // SW can't receive a Blob; return a data URL.
  const bytes = new Uint8Array(out);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  return { dataUrl: `data:video/x-matroska;base64,${btoa(binary)}`, filename: `fb-${videoId}.mkv` };
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

  if (msg.action === "muxDownload") {
    (async () => {
      try {
        const { dataUrl, filename } = await muxDownload(msg.videoUrl, msg.audioUrl, msg.videoId);
        sendResponse({ success: true, dataUrl, filename });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});
