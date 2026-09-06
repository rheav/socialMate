import { encodeWav } from '../lib/dsp/wav.js';

const cancelledError = () => new Error('extração cancelada');
function check(signal) { if (signal.aborted) throw cancelledError(); }

// decodeAudioData/startRendering cannot be interrupted. Release the job promptly,
// and ignore their eventual result; they must never restart inference after abort.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelledError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function decodeStereo(url, signal, progress) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Vídeo indisponível (HTTP ${res.status}) — recarregue a página.`);
  const size = Number(res.headers.get('content-length'));
  let bytes;
  if (res.body && size > 0) {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      progress('fetch', Math.min(5, Math.round(5 * loaded / size)));
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const part of chunks) { out.set(part, at); at += part.length; }
    bytes = out.buffer;
  } else bytes = await res.arrayBuffer();
  check(signal);
  progress('decode', 6);
  const ctx = new AudioContext({ sampleRate: 44100 });
  try {
    const decoded = await abortable(ctx.decodeAudioData(bytes), signal);
    check(signal);
    const len = Math.ceil(decoded.duration * 44100);
    if (!len) throw new Error('O vídeo não contém áudio.');
    const offline = new OfflineAudioContext(2, len, 44100);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await abortable(offline.startRendering(), signal);
    check(signal);
    return [new Float32Array(rendered.getChannelData(0)), new Float32Array(rendered.getChannelData(1))];
  } finally { ctx.close().catch(() => {}); }
}

export function createVoiceSeparator({ getFfmpeg, queueFfmpeg, resetFfmpeg, registerBlob }) {
  let worker = null;
  let pending = null;
  let active = null;
  let seq = 0;

  const stopWorker = (error = 'extração cancelada') => {
    worker?.terminate();
    worker = null;
    if (pending) { const p = pending; pending = null; p.reject(new Error(error)); }
  };
  function infer(channels, progress) {
    if (!worker) {
      worker = new Worker(new URL('./separate.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (!pending || pending.id !== data?.id) return;
        if (data.type === 'progress') { pending.progress(data.phase, data.pct, data.backend); return; }
        const p = pending;
        pending = null;
        if (data.ok) p.resolve(data.channels);
        else { stopWorker(); p.reject(new Error(data.error || 'Falha ao separar voz.')); }
      };
      worker.onerror = (e) => stopWorker(e.message || 'O worker de voz falhou.');
      worker.onmessageerror = () => stopWorker('Resposta inválida do worker de voz.');
    }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending = { id, resolve, reject, progress };
      try {
        worker.postMessage({ id, channels, paths: {
          assets: chrome.runtime.getURL('assets/'),
          model: chrome.runtime.getURL('models/mdx/UVR-MDX-NET-Voc_FT.onnx'),
        } }, channels.map(c => c.buffer));
      } catch (e) { stopWorker(e.message); }
    });
  }

  async function run(msg) {
    if (active) throw new Error('Já existe uma extração em andamento.');
    const current = { jobId: msg.jobId, controller: new AbortController(), fm: null, phase: 'fetch', pct: 0 };
    active = current;
    const signal = current.controller.signal;
    const progress = (phase = current.phase, pct = current.pct, backend = current.backend) => {
      if (signal.aborted) return;
      current.phase = phase;
      current.pct = Math.max(current.pct, pct || 0);
      current.backend = backend;
      chrome.runtime.sendMessage({ type: 'FBW_VOICE_PROGRESS', jobId: msg.jobId, videoId: msg.videoId,
        phase, pct: current.pct, backend }).catch(() => {});
    };
    // Also keeps the MV3 service worker awake while a single chunk computes.
    const heartbeat = setInterval(() => progress(), 15000);
    // The offscreen watchdog also works if the background is restarted.
    const watchdog = setTimeout(() => abort(msg.jobId), 15 * 60 * 1000);
    try {
      progress();
      const channels = await decodeStereo(msg.audioUrl, signal, progress);
      check(signal);
      const vocals = await infer(channels, progress);
      check(signal);
      progress('encode', 93);
      const out = await abortable(queueFfmpeg(async () => {
        check(signal);
        const fm = await getFfmpeg();
        check(signal);
        current.fm = fm;
        const prefix = `voice-${++seq}`;
        const wavFile = `${prefix}.wav`, mp3File = `${prefix}.mp3`;
        try {
          await fm.writeFile(wavFile, encodeWav(vocals, 44100));
          check(signal);
          const code = await fm.exec(['-i', wavFile, '-codec:a', 'libmp3lame', '-q:a', '2', mp3File]);
          check(signal);
          if (code !== 0) throw new Error('Falha ao codificar o MP3.');
          return await fm.readFile(mp3File);
        } finally {
          current.fm = null;
          // terminate() on abort already discards this filesystem.
          if (!signal.aborted) {
            await fm.deleteFile(wavFile).catch(() => {});
            await fm.deleteFile(mp3File).catch(() => {});
          }
        }
      }), signal);
      check(signal);
      progress('encode', 98);
      return { blobUrl: registerBlob(new Blob([out], { type: 'audio/mpeg' })), filename: msg.filename };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(watchdog);
      if (active === current) active = null;
    }
  }

  function abort(jobId) {
    if (!active || active.jobId !== jobId) return;
    active.controller.abort();
    stopWorker();
    // FFmpeg is exclusively held by queueFfmpeg; never terminate someone else's mux.
    if (active.fm) resetFfmpeg(active.fm);
  }
  return { run, abort, release: () => { if (!active) stopWorker('offscreen released'); }, busy: () => !!active };
}
