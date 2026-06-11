/*
 * fbMassDownloader - engine bridge (MAIN world)
 *
 * Sits on top of the reused core (prehook.js + proxy.js) and exposes a small,
 * clean message API to our own UI (content/loader.js, ISOLATED world) over
 * window.postMessage. Responsibilities:
 *   - turn captured representations into a clean video list
 *   - byte-range download of video/audio tracks (same approach as the original)
 *   - merge video+audio with ffmpeg (reuses vendors.js FFmpeg + copied core)
 *   - save the resulting file
 *
 * No Facebook-internal extraction logic lives here; that is all in proxy.js.
 */
(function () {
  "use strict";

  const FBMD = (window.__FBMD = window.__FBMD || {});
  const TO_UI = "FBMD-ENGINE";
  const FROM_UI = "FBMD-UI";
  const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB range chunks

  /* ----------------------------- messaging ------------------------------ */
  function send(type, data) {
    window.postMessage(Object.assign({ source: TO_UI, type }, data), "*");
  }
  function log(message) {
    send("log", { message });
  }

  /* --------------------------- video list model ------------------------- */
  function pickVideo(reps) {
    return reps
      .filter((r) => (r.mime_type || "").indexOf("video") > -1)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  }
  function pickAudio(reps) {
    return reps
      .filter((r) => (r.mime_type || "").indexOf("audio") > -1)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  }

  function toClientVideo(entry) {
    const video = pickVideo(entry.representations);
    const audio = pickAudio(entry.representations);
    const height = video && (video.height || 0);
    return {
      id: entry.id,
      label: height ? `Video ${entry.id} - ${height}p` : `Video ${entry.id}`,
      width: video ? video.width || 0 : 0,
      height: height || 0,
      hasAudio: !!audio,
      capturedAt: entry.capturedAt,
    };
  }

  function buildList() {
    const out = [];
    for (const entry of FBMD.videos.values()) {
      if (pickVideo(entry.representations)) out.push(toClientVideo(entry));
    }
    out.sort((a, b) => b.capturedAt - a.capturedAt);
    return out;
  }

  function pushList() {
    send("videos", { payload: buildList() });
  }

  FBMD.onVideosChanged(pushList);

  /* ------------------------------ download ------------------------------ */
  function getBase() {
    const b = document.documentElement.getAttribute("data-fbmd-base");
    if (!b)
      throw new Error("Extension base URL unavailable (loader not ready)");
    return b;
  }

  async function getSize(url) {
    try {
      const r = await fetch(url, { method: "HEAD", credentials: "include" });
      const len = r.headers.get("content-length");
      if (len) return parseInt(len, 10);
    } catch (e) {
      /* fall through to range probe */
    }
    const r = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      credentials: "include",
    });
    const cr = r.headers.get("content-range");
    if (cr && cr.indexOf("/") > -1) return parseInt(cr.split("/")[1], 10);
    const full = await (await fetch(url, { credentials: "include" })).blob();
    return full.size;
  }

  async function downloadTrack(url, mime, onProgress) {
    const total = await getSize(url);
    const parts = [];
    let loaded = 0;
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, total - 1);
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials: "include",
      });
      const buf = await res.arrayBuffer();
      parts.push(buf);
      loaded += buf.byteLength;
      onProgress(total ? loaded / total : 0);
    }
    return new Blob(parts, { type: mime || "application/octet-stream" });
  }

  /* ------------------------------- ffmpeg ------------------------------- */
  function waitFor(getter, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        let val;
        try {
          val = getter();
        } catch (e) {
          val = undefined;
        }
        if (val) return resolve(val);
        if (Date.now() - t0 > timeoutMs)
          return reject(
            new Error("Timed out waiting for vendors bundle (ffmpeg)"),
          );
        setTimeout(poll, 150);
      })();
    });
  }

  let ffmpegPromise = null;
  function loadFFmpeg() {
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = (async () => {
      // vendors.js initialises async (after FB's requireLazy/react), so poll.
      const mod = await waitFor(() => {
        const vend = window.bulk_videos_downloader_for_facebook_vendors;
        return vend && vend._ && vend._["@ffmpeg/ffmpeg"];
      }, 20000);
      const FFmpeg = mod && (mod.FFmpeg || (mod.default && mod.default.FFmpeg));
      if (!FFmpeg)
        throw new Error("FFmpeg library not found in vendors bundle");
      const base = getBase();
      const ff = new FFmpeg();
      await ff.load({
        coreURL: base + "ffmpeg/ffmpeg-core.js",
        wasmURL: base + "ffmpeg/ffmpeg-core.wasm",
      });
      return ff;
    })();
    return ffmpegPromise;
  }

  async function mergeAV(videoBlob, audioBlob) {
    const ff = await loadFFmpeg();
    await ff.writeFile("v.mp4", new Uint8Array(await videoBlob.arrayBuffer()));
    await ff.writeFile("a.mp4", new Uint8Array(await audioBlob.arrayBuffer()));
    await ff.exec(["-i", "v.mp4", "-i", "a.mp4", "-c", "copy", "out.mp4"]);
    const data = await ff.readFile("out.mp4");
    return new Blob([data.buffer], { type: "video/mp4" });
  }

  /* -------------------------------- save -------------------------------- */
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------------------------- orchestration --------------------------- */
  async function processOne(id, mode) {
    const entry = FBMD.videos.get(String(id));
    if (!entry) throw new Error("Video no longer available: " + id);
    const video = pickVideo(entry.representations);
    const audio = pickAudio(entry.representations);
    const height = (video && video.height) || 0;
    const base = `fb-video-${id}${height ? "-" + height + "p" : ""}`;

    if (mode === "audio") {
      if (!audio) throw new Error("No audio track for " + id);
      send("progress", { id, stage: "Downloading audio", pct: 0 });
      const ab = await downloadTrack(audio.base_url, audio.mime_type, (p) =>
        send("progress", { id, stage: "Downloading audio", pct: p }),
      );
      saveBlob(ab, base + ".m4a");
      return base + ".m4a";
    }

    send("progress", { id, stage: "Downloading video", pct: 0 });
    const vb = await downloadTrack(video.base_url, video.mime_type, (p) =>
      send("progress", {
        id,
        stage: "Downloading video",
        pct: p * (audio && mode === "highest" ? 0.6 : 1),
      }),
    );

    if (mode === "video" || !audio) {
      saveBlob(vb, base + ".mp4");
      return base + ".mp4";
    }

    // highest: download audio + merge
    send("progress", { id, stage: "Downloading audio", pct: 0.6 });
    const ab = await downloadTrack(audio.base_url, audio.mime_type, (p) =>
      send("progress", { id, stage: "Downloading audio", pct: 0.6 + p * 0.3 }),
    );
    send("progress", { id, stage: "Merging audio + video", pct: 0.92 });
    const merged = await mergeAV(vb, ab);
    saveBlob(merged, base + ".mp4");
    return base + ".mp4";
  }

  let running = false;
  async function runQueue(ids, mode) {
    if (running) {
      log("A download batch is already running.");
      return;
    }
    running = true;
    send("batch", { state: "start", total: ids.length });
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        const filename = await processOne(id, mode);
        send("done", { id, filename, index: i + 1, total: ids.length });
      } catch (e) {
        send("error", { id, message: String((e && e.message) || e) });
      }
    }
    send("batch", { state: "end", total: ids.length });
    running = false;
  }

  /* ----------------------------- UI commands ---------------------------- */
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.source !== FROM_UI) return;
    if (d.type === "getVideos") {
      pushList();
    } else if (d.type === "download") {
      runQueue(d.ids || [], d.mode || "highest");
    }
  });

  // Announce readiness so the UI can request the current list.
  send("ready", {});
  log("engine bridge ready");
})();
