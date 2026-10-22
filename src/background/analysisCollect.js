// Preparing one top post for the Hub's analysis (T8): the extension is the only
// part of the system with an Instagram session, so it opens the post in a tab of
// its own, reads the full caption, fetches the video, has it transcribed when
// the Acervo has no transcript, and files all of it with the Hub under the
// task's lease. Comments are not read for the analysis: their count is a number
// the Hub already has. (The comment sweep below serves the Instagram Scraper
// destinations, not the analysis.)
//
// Instagram is touched the way the Spy touches it: one background tab, one post
// at a time, 20–40 s apart, never while a Spy batch is running, and a login wall
// or a rate limit seen on this tab pauses Instagram for the Spy too (the same
// 12-hour pause). None of it counts as a daily Spy reading.
//
// What could not be collected is reported as missing, never guessed: a page that
// shows another post contributes nothing, an expired video link gets one fresh
// look, a video past the limits is reported too large. The job's state is
// persisted so a worker restart closes the tab it left behind.

import { downloadLimited, fetchEmbedVideo, isInstagramCdn, pickVideoVariant } from "../lib/analysisMedia.js";
import { igCodeFromPk } from "../lib/shared/igCode.js";
import { IG_COMMENT_EXPAND_LIMITS } from "../lib/shared/igCommentExpand.js";

export const ANALYSIS_COLLECT_KEY = "fbw_analysis_collect"; // { taskId, tabId, code, startedAt, nextAt }
export const ANALYSIS_MARKER = "#socialmate-analysis";

export const COLLECT_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  maxDurationS: 600,
  gapMs: [20_000, 40_000],
  busyWaitMs: 6 * 60_000,
  busyPollMs: 15_000,
  readyMs: 20_000,
  downloadMs: 5 * 60_000,
  /** Posts per comment sweep. */
  sweepMax: 15,
};

const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LOGIN_WALL = /instagram\.com\/(accounts\/login|challenge|checkpoint)/;

const idle = (nextAt = 0) => ({ taskId: null, tabId: null, code: null, startedAt: null, nextAt });

/**
 * @param {object} deps
 * @param {object} deps.chrome  tabs + storage.local
 * @param {() => Promise<{url,token}|null>} deps.hub  the Acervo the extension syncs to
 * @param {{ blocked(): Promise<string|null>, busy(): Promise<boolean>, pause(code): Promise<void>, serialize(work): Promise }} deps.instagram
 *   the Spy's shared Instagram state (see background/spy.js)
 * @param {(req) => Promise<{status,text?,chunks?,language?,source?}|null>} deps.transcribe  the extension's Whisper job
 */
export function createAnalysisCollect({
  chrome,
  fetchImpl = fetch,
  hub,
  instagram,
  transcribe,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  limits = {},
}) {
  const L = { ...COLLECT_LIMITS, ...limits };
  // Jobs in flight: a Hub job, or one post of a comment sweep. Their tab phases
  // never overlap (instagram.serialize); a sweep also yields to Hub jobs.
  const jobs = new Set(); // { taskId, tabId, code, stop, cancelled, sweep? }
  let sweep = null; // { running, total, done, current, stopReason, cancel }

  async function load() {
    const r = await chrome.storage.local.get(ANALYSIS_COLLECT_KEY);
    return { ...idle(), ...(r[ANALYSIS_COLLECT_KEY] || {}) };
  }
  async function save(patch) {
    const next = { ...(await load()), ...patch };
    await chrome.storage.local.set({ [ANALYSIS_COLLECT_KEY]: next });
    return next;
  }

  /** Close a tab only if it is still ours: our marker, a login wall, or our post never shown to the user. */
  async function closeOwnTab(tabId, code) {
    if (tabId == null) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab?.url || "";
      let ourPost = false;
      try {
        const u = new URL(url);
        ourPost = !!code && !tab.active && /(^|\.)instagram\.com$/.test(u.hostname) && new RegExp(`^/(p|reel|reels)/${code}/`).test(u.pathname);
      } catch {
        /* not a URL */
      }
      if (url.endsWith(ANALYSIS_MARKER) || LOGIN_WALL.test(url) || ourPost) await chrome.tabs.remove(tabId);
    } catch {
      /* already closed */
    }
  }

  /** Sleep in steps, so a cancel is noticed within a few seconds. */
  async function wait(ms, job) {
    const end = now() + ms;
    while (!job.cancelled && now() < end) await sleep(Math.min(5_000, end - now()));
  }

  async function ask(tabId, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      return null;
    }
  }

  async function whenReady(job) {
    const end = now() + L.readyMs;
    while (now() < end && !job.cancelled && !job.stop) {
      const pong = await ask(job.tabId, { type: "FBW_PING" });
      if (pong?.ok) return true;
      await sleep(1_000);
    }
    return false;
  }

  /** The page's answer for this post, or null when the page could not say. */
  async function readPage(job, p, comments) {
    job.live?.({ phase: "opening" });
    if (!(await whenReady(job))) return null;
    if (comments) job.live?.({ phase: "comments", detail: "até 200 comentários, 20 cliques ou 90 s" });
    const res = await ask(job.tabId, {
      type: "FBW_ANALYSIS_COLLECT",
      code: job.code,
      mediaPk: p.mediaPk || null,
      comments,
      limits: IG_COMMENT_EXPAND_LIMITS,
    });
    return res?.ok ? res : null;
  }

  // The post's public embed page, read once per job: the fallback when the post's
  // own page handed no usable video link (see igEmbedVideo).
  async function embedOnce(job) {
    if (job.embed === undefined) job.embed = await fetchEmbedVideo(job.code, fetchImpl);
    return job.embed;
  }

  async function fetchVideo(job, p, page) {
    if (page.durationS != null && page.durationS > L.maxDurationS) return { state: "too_large" };
    let variant = pickVideoVariant(page.variants);
    if (!variant) {
      const embed = await embedOnce(job);
      if (embed?.durationS != null && embed.durationS > L.maxDurationS) return { state: "too_large" };
      variant = embed;
    }
    if (!variant) return { state: "unavailable", why: "no_link" };
    const size = variant.w && variant.h ? `${variant.w}×${variant.h}` : null;
    job.live?.({ phase: "video_download", detail: variant === job.embed ? [size, "embed"].filter(Boolean).join(" · ") : size });
    let got = await downloadLimited(variant.url, { maxBytes: L.maxBytes, fetchImpl, timeoutMs: L.downloadMs });
    if (!got.ok && got.code === "url_expired" && !job.cancelled && !job.stop) {
      // One fresh look: the page hands out newly signed links.
      await chrome.tabs.reload(job.tabId);
      const again = await readPage(job, p, false);
      variant = (again ? pickVideoVariant(again.variants) : null) || (variant === job.embed ? null : await embedOnce(job));
      got = variant ? await downloadLimited(variant.url, { maxBytes: L.maxBytes, fetchImpl, timeoutMs: L.downloadMs }) : got;
    }
    if (got.ok) return { state: "available", variant, data: got.data, sha256: got.sha256 };
    if (got.code === "media_too_large") return { state: "too_large" };
    if (got.code === "url_expired") return { state: "expired" };
    if (got.code === "rate_limited") job.stop = job.stop || "rate_limited";
    return { state: "unavailable", why: got.code || "download_failed" };
  }

  /** The Instagram part: own tab, page read, video bytes. Closed whatever happens. */
  async function collectInTab(job, p) {
    const tab = await chrome.tabs.create({ url: `https://www.instagram.com/p/${job.code}/${ANALYSIS_MARKER}`, active: false });
    job.tabId = tab.id;
    await save({ taskId: job.taskId, tabId: tab.id, code: job.code, startedAt: now() });
    try {
      // Only the comment sweep asks for the thread; the Hub's jobs never do.
      const page = await readPage(job, p, !!p.needs?.comments);
      if (job.cancelled || job.stop || !page) return { page };
      const video = p.needs?.video && p.assetId ? await fetchVideo(job, p, page) : null;
      return { page, video };
    } finally {
      await closeOwnTab(job.tabId, job.code);
      await save({ taskId: null, tabId: null, code: null, startedAt: null });
    }
  }

  const hubHeaders = (settings, job, extra = {}) => ({ "X-Sync-Token": settings.token, "X-Analysis-Lease": job.leaseToken, ...extra });

  async function upload(settings, job, assetId, video) {
    const url = `${settings.url.replace(/\/+$/, "")}/api/sync/analysis/assets/${encodeURIComponent(assetId)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: "PUT",
          headers: hubHeaders(settings, job, { "X-Content-SHA256": video.sha256, "Content-Type": "video/mp4" }),
          body: video.data,
        });
        if (res.ok) return "available";
        if (res.status === 413) return "too_large";
        if (res.status === 401 || res.status === 403) return "lease_lost";
        if (res.status < 500 && res.status !== 408) return "missing";
      } catch {
        /* a lost response: the same bytes again are accepted */
      }
    }
    return "missing";
  }

  async function fileEvidence(settings, job, body) {
    const url = `${settings.url.replace(/\/+$/, "")}/api/sync/analysis/evidence`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: hubHeaders(settings, job, { "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const out = await res.json();
          return typeof out?.evidenceHash === "string" ? { ok: true, hash: out.evidenceHash } : { ok: false, code: "evidence_rejected" };
        }
        if (res.status === 401) return { ok: false, code: "hub_unauthorized" };
        if (res.status === 403) return { ok: false, code: "lease_lost" };
        if (res.status < 500) return { ok: false, code: "evidence_rejected" };
      } catch {
        /* retried once */
      }
    }
    return { ok: false, code: "hub_unreachable" };
  }

  /**
   * Before opening Instagram: not while it is paused, not during a Spy batch
   * (waits up to six minutes), and 20–40 s after the previous post. → null to
   * go ahead, or why not.
   */
  async function gate(job) {
    if (await instagram.blocked()) return "instagram_paused";
    const waitUntil = now() + L.busyWaitMs;
    while (await instagram.busy()) {
      if (job.cancelled) return "cancelled";
      if (now() >= waitUntil) return "instagram_busy";
      job.live?.({ phase: "waiting_spy" });
      await wait(L.busyPollMs, job);
    }
    const { nextAt } = await load();
    if (nextAt > now()) {
      job.live?.({ phase: "waiting_gap", detail: `${Math.round((nextAt - now()) / 1000)} s` });
      await wait(nextAt - now(), job);
    }
    return job.cancelled ? "cancelled" : null;
  }

  async function spaceNext() {
    const gap = L.gapMs[0] + Math.round(random() * (L.gapMs[1] - L.gapMs[0]));
    await save({ nextAt: now() + gap });
  }

  /**
   * Prepare one post. → { ok: true, result: { evidenceHash } } or { ok: false, code }.
   * `progress(code)` records a milestone in the Hub's log; `live(patch)` says
   * what is happening right now (the panel's "Agora").
   */
  async function preparePost(task, { progress = () => {}, live = () => {} } = {}) {
    const p = task?.payload || {};
    const code = p.code || (p.mediaPk && /^\d{1,25}$/.test(String(p.mediaPk)) ? igCodeFromPk(String(p.mediaPk)) : null);
    if (!task?.taskId || !task.leaseToken || !code || !CODE_RE.test(code)) return { ok: false, code: "bad_job" };
    const settings = await hub();
    if (!settings?.url || !settings?.token) return { ok: false, code: "hub_not_configured" };

    const job = { taskId: task.taskId, leaseToken: task.leaseToken, code, tabId: null, stop: null, cancelled: false, live };
    jobs.add(job);
    let touchedInstagram = false;
    try {
      const touchesInstagram = !!(p.needs?.captionFull || (p.needs?.video && p.assetId));
      let inTab = { page: null, video: null };
      if (touchesInstagram) {
        const blocked = await gate(job);
        if (blocked) return { ok: false, code: blocked };
        touchedInstagram = true;
        inTab = await instagram.serialize(() => collectInTab(job, p));
      }
      if (job.cancelled) return { ok: false, code: "cancelled" };
      if (job.stop) {
        await instagram.pause(job.stop);
        return { ok: false, code: job.stop };
      }

      const page = inTab.page;
      if (touchesInstagram) progress(page ? "collect_page_read" : "collect_page_missing");

      // Video: a staged copy, the bytes just fetched, or why there is none.
      let video = { state: "missing", assetId: null, width: null, height: null };
      if (p.reuseAssetId) video = { state: "available", assetId: p.reuseAssetId, width: null, height: null };
      else if (inTab.video?.state === "available") {
        const v = inTab.video;
        live({ phase: "video_upload", detail: `${(v.data.byteLength / 1024 ** 2).toFixed(1).replace(".", ",")} MB` });
        const state = await upload(settings, job, p.assetId, v);
        if (state === "lease_lost") return { ok: false, code: "lease_lost" };
        video = { state, assetId: state === "available" ? p.assetId : null, width: v.variant.w, height: v.variant.h };
        if (state === "available") progress("collect_video_uploaded");
      } else if (inTab.video) {
        video = { state: inTab.video.state, assetId: null, width: null, height: null };
        progress("collect_video_missing", [inTab.video.state, inTab.video.why].filter(Boolean).join(": "));
      }

      // Transcript: only when the Acervo has none, and only from this post's own video.
      let transcript;
      if (p.needs?.transcript && page) {
        const smallest =
          [...(page.variants || [])]
            .filter((v) => isInstagramCdn(v.url))
            .sort((a, b) => (a.w || 0) * (a.h || 0) - (b.w || 0) * (b.h || 0))[0] ||
          (await embedOnce(job));
        if (smallest && !job.cancelled) {
          live({ phase: "transcribing", detail: page.durationS ? `vídeo de ${Math.round(page.durationS)} s` : null });
          // The post's author, picture and numbers ride along, so its Library card is complete.
          const t = await transcribe({ code, pk: page.pk || p.mediaPk, mediaUrl: smallest.url, durationS: page.durationS ?? null, caption: page.caption?.text ?? null, meta: page.meta ?? null }).catch(() => null);
          transcript =
            t?.status === "done"
              ? { status: "done", text: t.text ?? "", chunks: t.chunks ?? [], language: t.language ?? null, source: t.source ?? "whisper" }
              : { status: "failed" };
          progress(transcript.status === "done" ? "collect_transcribed" : "collect_transcript_failed");
        }
      }
      if (job.cancelled) return { ok: false, code: "cancelled" };

      const body = { taskId: job.taskId, video, observedAt: now() };
      if (page) {
        body.caption = { text: page.caption?.text ?? null, full: !!page.caption?.full };
        body.authors = page.authors || [];
      }
      if (transcript) body.transcript = transcript;
      live({ phase: "filing" });
      const filed = await fileEvidence(settings, job, body);
      return filed.ok ? { ok: true, result: { evidenceHash: filed.hash } } : { ok: false, code: filed.code };
    } finally {
      jobs.delete(job);
      if (touchedInstagram) await spaceNext();
    }
  }

  /**
   * Open each listed post in a tab of our own and read its whole comment thread
   * under the usual budget — the old bridge's "collect the profile's comments".
   * The comments flow out the way every capture does (panel, Instagram Scraper
   * destinations). One sweep at a time, at most `sweepMax` posts, 20–40 s
   * apart, yielding to Hub jobs; a login wall or rate limit stops it and pauses
   * Instagram for the Spy too. → { ok, done, total, stopReason }
   */
  async function sweepComments(codes) {
    if (sweep?.running) return { ok: false, code: "busy" };
    const list = [...new Set((Array.isArray(codes) ? codes : []).filter((c) => typeof c === "string" && CODE_RE.test(c)))].slice(0, L.sweepMax);
    const run = { running: true, total: list.length, done: 0, current: null, stopReason: null, cancel: false };
    sweep = run;
    try {
      for (const code of list) {
        if (run.cancel) {
          run.stopReason = "cancelled";
          break;
        }
        // A Hub job comes first: wait for it between posts.
        while ([...jobs].some((j) => !j.sweep)) await sleep(5_000);
        const job = { taskId: `sweep:${code}`, code, tabId: null, stop: null, cancelled: false, sweep: true };
        jobs.add(job);
        run.current = code;
        try {
          const blocked = await gate(job);
          if (blocked) {
            run.stopReason = blocked;
            break;
          }
          await instagram.serialize(() => collectInTab(job, { needs: { comments: true }, mediaPk: null }));
          await spaceNext();
        } finally {
          jobs.delete(job);
        }
        if (job.stop) {
          await instagram.pause(job.stop);
          run.stopReason = job.stop;
          break;
        }
        run.done += 1;
      }
      return { ok: true, done: run.done, total: run.total, stopReason: run.stopReason };
    } finally {
      run.running = false;
      run.current = null;
    }
  }

  function stopSweep() {
    if (!sweep?.running) return false;
    sweep.cancel = true;
    for (const j of jobs) if (j.sweep) j.cancelled = true;
    return true;
  }

  /** The Hub cancelled the task: stop it and close the tab it opened. */
  async function cancelPrepare(taskId) {
    const job = [...jobs].find((j) => j.taskId === taskId && !j.sweep);
    if (!job) return false;
    job.cancelled = true;
    if (job.tabId != null) {
      await ask(job.tabId, { type: "FBW_ANALYSIS_CANCEL" });
      await closeOwnTab(job.tabId, job.code);
    }
    return true;
  }

  /** On worker start: a job in flight died with the old worker. Close its tab, forget it. */
  async function recover() {
    const state = await load();
    if (!state.taskId && state.tabId == null) return;
    await closeOwnTab(state.tabId, state.code);
    await save({ ...idle(state.nextAt) });
  }

  /** Responses on Instagram (webRequest): 401/403 → login, 429 → rate limit, on our tab only. */
  function onResponse({ tabId, statusCode, url }) {
    const job = [...jobs].find((j) => j.tabId != null && j.tabId === tabId);
    if (!job || ![401, 403, 429].includes(statusCode)) return;
    try {
      if (!/(^|\.)instagram\.com$/.test(new URL(url).hostname)) return;
    } catch {
      return;
    }
    job.stop = job.stop || (statusCode === 429 ? "rate_limited" : "login_required");
  }

  /** Navigations of our tab: a login wall or a challenge stops the job. */
  function onNavigation(tabId, url) {
    const job = [...jobs].find((j) => j.tabId != null && j.tabId === tabId);
    if (job && LOGIN_WALL.test(url || "")) job.stop = job.stop || "login_required";
  }

  return {
    preparePost,
    cancelPrepare,
    recover,
    onResponse,
    onNavigation,
    sweepComments,
    stopSweep,
    sweepStatus: () => (sweep ? { running: sweep.running, total: sweep.total, done: sweep.done, current: sweep.current, stopReason: sweep.stopReason } : null),
    status: () => [...jobs].map((j) => ({ taskId: j.taskId })),
  };
}
