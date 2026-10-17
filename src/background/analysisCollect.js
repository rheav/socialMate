// Preparing one top post for the Hub's analysis (T8): the extension is the only
// part of the system with an Instagram session, so it opens the post in a tab of
// its own, reads the full caption and the comment thread (under a budget),
// fetches the video, has it transcribed when the Acervo has no transcript, and
// files all of it with the Hub under the task's lease.
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

import { downloadLimited, isInstagramCdn, pickVideoVariant } from "../lib/analysisMedia.js";
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
};

const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LOGIN_WALL = /instagram\.com\/(accounts\/login|challenge|checkpoint)/;
const COMMENTS_MAX = 400;

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
  let current = null; // { taskId, tabId, code, stop, cancelled, abort }

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
    if (!(await whenReady(job))) return null;
    const res = await ask(job.tabId, {
      type: "FBW_ANALYSIS_COLLECT",
      code: job.code,
      mediaPk: p.mediaPk || null,
      comments,
      limits: IG_COMMENT_EXPAND_LIMITS,
    });
    return res?.ok ? res : null;
  }

  async function fetchVideo(job, p, page) {
    if (page.durationS != null && page.durationS > L.maxDurationS) return { state: "too_large" };
    let variant = pickVideoVariant(page.variants);
    if (!variant) return { state: "unavailable" };
    let got = await downloadLimited(variant.url, { maxBytes: L.maxBytes, fetchImpl, timeoutMs: L.downloadMs });
    if (!got.ok && got.code === "url_expired" && !job.cancelled && !job.stop) {
      // One fresh look: the page hands out newly signed links.
      await chrome.tabs.reload(job.tabId);
      const again = await readPage(job, p, false);
      variant = again ? pickVideoVariant(again.variants) : null;
      got = variant ? await downloadLimited(variant.url, { maxBytes: L.maxBytes, fetchImpl, timeoutMs: L.downloadMs }) : got;
    }
    if (got.ok) return { state: "available", variant, data: got.data, sha256: got.sha256 };
    if (got.code === "media_too_large") return { state: "too_large" };
    if (got.code === "url_expired") return { state: "expired" };
    if (got.code === "rate_limited") job.stop = job.stop || "rate_limited";
    return { state: "unavailable" };
  }

  /** The Instagram part: own tab, page read, video bytes. Closed whatever happens. */
  async function collectInTab(job, p) {
    const tab = await chrome.tabs.create({ url: `https://www.instagram.com/p/${job.code}/${ANALYSIS_MARKER}`, active: false });
    job.tabId = tab.id;
    await save({ taskId: job.taskId, tabId: tab.id, code: job.code, startedAt: now() });
    try {
      const page = await readPage(job, p, !!p.needs?.comments);
      if (job.cancelled || job.stop || !page) return { page };
      const video = p.needs?.video && p.assetId ? await fetchVideo(job, p, page) : null;
      return { page, video };
    } finally {
      await closeOwnTab(job.tabId, job.code);
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

  const commentOf = (c) => ({
    id: String(c.cid ?? ""),
    parentId: c.parent != null ? String(c.parent) : null,
    author: c.username ?? null,
    text: c.text ?? "",
    likes: c.digg_count ?? null,
    createdAt: c.create_time ?? null,
  });

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
   * Prepare one post. → { ok: true, result: { evidenceHash } } or { ok: false, code }.
   * `progress(code)` reports a step to the Hub's log.
   */
  async function preparePost(task, { progress = () => {} } = {}) {
    const p = task?.payload || {};
    const code = p.code || (p.mediaPk && /^\d{1,25}$/.test(String(p.mediaPk)) ? igCodeFromPk(String(p.mediaPk)) : null);
    if (!task?.taskId || !task.leaseToken || !code || !CODE_RE.test(code)) return { ok: false, code: "bad_job" };
    const settings = await hub();
    if (!settings?.url || !settings?.token) return { ok: false, code: "hub_not_configured" };

    const job = { taskId: task.taskId, leaseToken: task.leaseToken, code, tabId: null, stop: null, cancelled: false };
    current = job;
    let touchedInstagram = false;
    try {
      const touchesInstagram = !!(p.needs?.comments || p.needs?.captionFull || (p.needs?.video && p.assetId));
      let inTab = { page: null, video: null };
      if (touchesInstagram) {
        if (await instagram.blocked()) return { ok: false, code: "instagram_paused" };
        const waitUntil = now() + L.busyWaitMs;
        while (await instagram.busy()) {
          if (job.cancelled) return { ok: false, code: "cancelled" };
          if (now() >= waitUntil) return { ok: false, code: "instagram_busy" };
          await wait(L.busyPollMs, job);
        }
        const { nextAt } = await load();
        if (nextAt > now()) await wait(nextAt - now(), job);
        if (job.cancelled) return { ok: false, code: "cancelled" };
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
        const state = await upload(settings, job, p.assetId, v);
        if (state === "lease_lost") return { ok: false, code: "lease_lost" };
        video = { state, assetId: state === "available" ? p.assetId : null, width: v.variant.w, height: v.variant.h };
        if (state === "available") progress("collect_video_uploaded");
      } else if (inTab.video) video = { state: inTab.video.state, assetId: null, width: null, height: null };

      // Transcript: only when the Acervo has none, and only from this post's own video.
      let transcript;
      if (p.needs?.transcript && page) {
        const smallest = [...(page.variants || [])]
          .filter((v) => isInstagramCdn(v.url))
          .sort((a, b) => (a.w || 0) * (a.h || 0) - (b.w || 0) * (b.h || 0))[0];
        if (smallest && !job.cancelled) {
          const t = await transcribe({ code, pk: page.pk || p.mediaPk, mediaUrl: smallest.url, durationS: page.durationS ?? null, caption: page.caption?.text ?? null }).catch(() => null);
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
        if (page.comments) {
          body.comments = {
            items: page.comments.items.slice(-COMMENTS_MAX).map(commentOf),
            reportedTotal: page.comments.reportedTotal ?? p.reportedComments ?? null,
            stopReason: page.comments.stopReason ?? null,
            order: page.comments.order ?? null,
          };
        }
      }
      if (transcript) body.transcript = transcript;
      const filed = await fileEvidence(settings, job, body);
      return filed.ok ? { ok: true, result: { evidenceHash: filed.hash } } : { ok: false, code: filed.code };
    } finally {
      if (current === job) current = null;
      const gap = L.gapMs[0] + Math.round(random() * (L.gapMs[1] - L.gapMs[0]));
      await save({ ...idle(), ...(touchedInstagram ? { nextAt: now() + gap } : {}) });
    }
  }

  /** The Hub cancelled the task: stop it and close the tab it opened. */
  async function cancelPrepare(taskId) {
    const job = current;
    if (!job || job.taskId !== taskId) return false;
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
    const job = current;
    if (!job || tabId !== job.tabId || ![401, 403, 429].includes(statusCode)) return;
    try {
      if (!/(^|\.)instagram\.com$/.test(new URL(url).hostname)) return;
    } catch {
      return;
    }
    job.stop = job.stop || (statusCode === 429 ? "rate_limited" : "login_required");
  }

  /** Navigations of our tab: a login wall or a challenge stops the job. */
  function onNavigation(tabId, url) {
    const job = current;
    if (job && tabId === job.tabId && LOGIN_WALL.test(url || "")) job.stop = job.stop || "login_required";
  }

  return { preparePost, cancelPrepare, recover, onResponse, onNavigation, status: () => (current ? { taskId: current.taskId } : null) };
}
