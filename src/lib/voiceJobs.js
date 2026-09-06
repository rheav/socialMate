import { downloadPath } from './downloadPath.js';

export const VOICE_TIMEOUT_MS = 15 * 60 * 1000;

// The start request replies immediately. Progress and completion are separate
// messages, so a minutes-long inference never holds an MV3 response channel open.
export function createVoiceJobs({ ensureOffscreen, callOffscreen, notifyTab, download, trackDownload, release }) {
  let active = null;
  const snapshot = (job) => ({ jobId: job.jobId, videoId: job.videoId, phase: job.phase, pct: job.pct });
  const send = (job, patch) => notifyTab(job.tabId, { type: 'FBW_VOICE_STATUS', ...snapshot(job), ...patch });
  const clear = (job) => {
    clearTimeout(job.timer);
    if (active === job) active = null;
  };
  const fail = (job, error, cancelled = false) => {
    clear(job);
    send(job, { success: false, phase: cancelled ? 'cancelled' : 'error', error });
  };

  async function start(msg, tabId) {
    if (active) throw new Error('Já existe uma extração em andamento — cancele ou aguarde terminar.');
    if (!msg.jobId || !msg.videoId || !msg.mediaUrl || tabId == null)
      throw new Error('Vídeo indisponível para extrair voz.');
    const url = new URL(msg.mediaUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL de vídeo inválida.');
    const job = { jobId: String(msg.jobId), videoId: String(msg.videoId), tabId, phase: 'fetch', pct: 0, dispatched: false };
    // The content script already uses baseNameFor; only this layer owns folders.
    job.filename = String(msg.filename || `ig-${job.videoId}-voz.mp3`).replace(/\.mp3$/i, '') + '.mp3';
    active = job;
    send(job, {});
    job.timer = setTimeout(() => {
      if (active !== job) return;
      job.cancelled = true;
      if (job.dispatched) callOffscreen({ action: 'abortSeparation', jobId: job.jobId }).catch(() => {});
      fail(job, 'extração expirou (15 min) — tente um vídeo mais curto');
    }, VOICE_TIMEOUT_MS);
    try {
      await ensureOffscreen();
      if (job.cancelled) throw new Error('extração cancelada');
      job.dispatched = true;
      const res = await callOffscreen({ action: 'separateVocals', jobId: job.jobId, videoId: job.videoId, audioUrl: url.href, filename: job.filename });
      if (job.cancelled) throw new Error('extração cancelada');
      if (!res?.success) throw new Error(res?.error || 'Não foi possível iniciar a extração.');
      return { started: true, jobId: job.jobId };
    } catch (e) {
      if (active === job) fail(job, e.message, !!job.cancelled);
      throw e;
    }
  }

  async function cancel(jobId, tabId) {
    const job = active;
    if (!job || job.jobId !== jobId) return { ok: true };
    if (job.tabId !== tabId) throw new Error('A extração pertence a outra aba.');
    if (job.phase === 'download') throw new Error('O download já foi iniciado.');
    job.cancelled = true;
    fail(job, 'extração cancelada', true);
    if (job.dispatched) await callOffscreen({ action: 'abortSeparation', jobId }).catch(() => {});
    return { ok: true };
  }

  function progress(msg) {
    const job = active;
    if (!job || msg.jobId !== job.jobId || job.phase === 'download') return;
    if (Number.isFinite(msg.pct)) job.pct = Math.max(job.pct, Math.min(99, Math.max(0, msg.pct)));
    job.phase = msg.phase || job.phase;
    send(job, { backend: msg.backend });
  }

  async function complete(msg) {
    const job = active;
    if (!job || msg.jobId !== job.jobId || job.phase === 'download') {
      if (msg.blobUrl && (!job || msg.jobId !== job.jobId)) await release(msg.blobUrl).catch(() => {});
      return;
    }
    clearTimeout(job.timer);
    if (!msg.success || !msg.blobUrl) {
      fail(job, msg.error || 'Falha ao extrair voz.', !!msg.cancelled);
      return;
    }
    job.phase = 'download';
    job.pct = 99;
    send(job, {});
    try {
      const id = await download({ url: msg.blobUrl, filename: downloadPath(null, job.filename) });
      trackDownload(id, msg.blobUrl);
      clear(job);
      send(job, { phase: 'done', pct: 100, success: true });
    } catch (e) {
      await release(msg.blobUrl).catch(() => {});
      fail(job, e.message);
    }
  }

  return { start, cancel, progress, complete, status: (tabId) => active?.tabId === tabId ? snapshot(active) : null };
}
