// The stories pass (service-worker side). For every tracked Instagram profile:
// fetch the stories page with the session (no tab, no click, so nothing is
// marked as seen), reduce the new items, and send each one to the hub —
// metadata first, then the poster, then the whole media, one story in memory
// at a time. Passes run by slot (lib/spyStories.js) and on the hub's
// "Coletar stories" command. Every outside call comes through `deps`, so the
// tests drive it without a browser.
//
// Design: ~/Code/apps/socialmate-hub/docs/superpowers/specs/2026-10-19-stories-swipe-file-design.md §7, §14

import { emptyStoriesState, parseReelsMediaJson, parseStoriesHtml, passDue, queueStory, reduceStory, slotJitterMs, storySlots } from "../lib/spyStories.js";
import { SPY_KEY, SPY_QUEUE_KEY, SPY_STATE_KEY, emptySpyQueue, queueReading } from "../lib/spyStore.js";
import { isSyncConfigured, putStoryMedia } from "../lib/syncClient.js";

export const IG_APP_ID = "936619743392459";
/** The pass's own alarm: the next slot's start plus its jitter. */
export const STORIES_ALARM = "fbw-spy-stories";
const PAGE_TIMEOUT_MS = 30_000;
// Between profiles, like the reels readings: 20–40 s. A step is a timer and
// the job is persisted, so a worker that stops between steps resumes from the
// Spy's minute tick (spyTick → tick()).
const STEP_MIN_MS = 20_000;
const STEP_SPREAD_MS = 20_001;
const DEFAULT_SETTINGS = { passesPerDay: 2, keepDays: 7 };
const DAY_MS = 86_400_000;
// The hub refuses bigger files; a failed media is tried again on the next
// passes, until the CDN link is surely gone (~1.5 days for a video).
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const PENDING_MAX_TRIES = 3;
const PENDING_MAX_AGE_MS = 30 * 3_600_000;

const clock = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetchImpl
 * @param {{get,set}} deps.storage           chrome.storage.local
 * @param {() => Promise<object>} deps.readSyncSettings
 * @param {(platform, tone, text) => Promise} deps.logSpy   the Spy panel's history, plain language
 * @param {(platform, code, profileId, reading) => Promise} deps.blockPlatform
 * @param {(now) => boolean} deps.isBlockedNow  Instagram paused by an earlier 429/login
 * @param {(work) => Promise} deps.serialize    the Spy's Instagram serialization (one thing at a time)
 * @param {() => Promise} deps.flush            spy.js flushSpy: sends the queue, answers the hub's reply
 * @param {(url) => Promise<Blob>} deps.makePoster
 * @param {() => number} [deps.random]
 * @param {() => number} [deps.now]
 */
export function createStoriesPass(deps) {
  const { fetchImpl } = deps;

  function outcomeOf(r) {
    if (r.status === 401 || r.status === 403) return "login_required";
    if (r.status === 429) return "rate_limited";
    if (/\/accounts\/login|\/challenge\/|\/checkpoint\//.test(String(r.url || ""))) return "login_required";
    if (!r.ok) return "network";
    return null;
  }

  async function fetchPage(key) {
    const r = await fetchImpl(`https://www.instagram.com/stories/${encodeURIComponent(key)}/`, {
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout?.(PAGE_TIMEOUT_MS),
    });
    const error = outcomeOf(r);
    if (error) return { error };
    return { html: await r.text() };
  }

  async function fetchReelsApi(userId) {
    const r = await fetchImpl(`https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`, {
      credentials: "include",
      headers: { accept: "application/json", "x-ig-app-id": IG_APP_ID },
      signal: AbortSignal.timeout?.(PAGE_TIMEOUT_MS),
    });
    const error = outcomeOf(r);
    if (error) return { error };
    let json = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    return { reel: parseReelsMediaJson(json, userId) };
  }

  /**
   * One profile's stories now: the page, then the API when the page carries no
   * reel. Items the hub already has (`storyPks`) are dropped here, before any
   * CDN fetch. `{ ok: true, items: [] }` means no story right now.
   */
  async function readProfile(profile, settings) {
    void settings;
    let reel;
    try {
      const page = await fetchPage(profile.key);
      if (page.error) return { ok: false, error: page.error };
      reel = parseStoriesHtml(page.html);
      if (!reel && profile.userId) {
        const api = await fetchReelsApi(profile.userId);
        if (api.error) return { ok: false, error: api.error };
        reel = api.reel;
      }
    } catch {
      return { ok: false, error: "network" };
    }
    if (!reel) return { ok: false, error: "no_reel" };
    const known = new Set(profile.storyPks || []);
    const items = [];
    for (const item of reel.items) {
      const reduced = reduceStory(item, reel.reelId);
      if (reduced && !known.has(reduced.input.id)) items.push(reduced);
    }
    return { ok: true, items, reelId: reel.reelId };
  }

  // ---- the pass: a persisted job, one profile per step ----

  const now = () => (deps.now ? deps.now() : Date.now());
  const random = deps.random ?? Math.random;
  const log = (tone, text) => deps.logSpy("instagram", tone, text);
  // Callbacks of the pass in progress (the hub's command): memory only, so a
  // worker restart loses them; the pass itself goes on and the hub still gets
  // the next progress message or times out.
  let listeners = { report: null, onDone: null };
  let stepTimer = null;

  async function readAll() {
    const r = await deps.storage.get([SPY_KEY, SPY_STATE_KEY, SPY_QUEUE_KEY]);
    const state = r[SPY_STATE_KEY] || { day: "" };
    return {
      spy: r[SPY_KEY] || { profiles: {} },
      state: { ...state, stories: { ...emptyStoriesState(), ...(state.stories || {}) }, storiesSettings: { ...DEFAULT_SETTINGS, ...(state.storiesSettings || {}) } },
      queue: r[SPY_QUEUE_KEY] || emptySpyQueue(),
    };
  }
  async function writeStories(stories) {
    const r = await deps.storage.get(SPY_STATE_KEY);
    const state = r[SPY_STATE_KEY] || { day: "" };
    await deps.storage.set({ [SPY_STATE_KEY]: { ...state, stories } });
  }
  const trackedProfiles = (spy, ids) => Object.values(spy.profiles || {})
    .filter((p) => p && p.platform === "instagram" && p.removedAt == null && p.trackStories && (!ids || ids.includes(p.id)));

  function armAlarm(when) {
    deps.alarms?.create?.(STORIES_ALARM, { when });
  }
  function armStep(at) {
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      stepTimer = null;
      step().catch(() => {});
    }, Math.max(0, at - now()));
    // The timer dies with the worker; the alarm wakes it for the same step.
    armAlarm(at);
  }

  const localDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  /**
   * When the next automatic pass is due: this slot's moment when it is still
   * ahead and the slot has not run, else the next slot's start plus a jitter
   * drawn now and kept in `stories.jitter` (the caller persists `stories`).
   */
  function nextDueAt(stories, passesPerDay, at) {
    const due = passDue(stories, passesPerDay, at, random);
    if (due) return due.at;
    const slot = storySlots(passesPerDay, at);
    const day = localDay(at);
    const ran = stories.daily.day === day && stories.daily.passes.some((p) => p.slot === slot.index);
    const thisAt = slot.startsAt + (stories.jitter[`${day}:${slot.index}`] ?? 0);
    if (!ran && thisAt > at) return thisAt;
    // The next slot starts where this one ends (tomorrow's first after the last).
    const n = Math.max(1, Math.min(4, Math.round(passesPerDay) || 1));
    const nextKey = `${localDay(slot.endsAt)}:${(slot.index + 1) % n}`;
    if (!Number.isFinite(stories.jitter[nextKey])) stories.jitter[nextKey] = slotJitterMs(random);
    return slot.endsAt + stories.jitter[nextKey];
  }

  /**
   * Start a pass now: `source` "pass" (a slot) or "manual" (the hub's button).
   * Only the first profile is read here; the rest follow by timer.
   */
  async function runPass({ source, slot = null, profileIds = null, report = null, onDone = null } = {}) {
    const { spy, state } = await readAll();
    if (state.stories.job) return { ok: false, error: "busy" };
    const profiles = trackedProfiles(spy, profileIds);
    if (!profiles.length) return { ok: false, error: "nothing_tracked" };
    const at = now();
    const job = { source, slot, profileIds: profiles.map((p) => p.id), index: 0, added: 0, failed: 0, startedAt: at, nextAt: at };
    await writeStories({ ...state.stories, job });
    listeners = { report, onDone };
    const passes = state.storiesSettings.passesPerDay;
    await log("info", source === "manual"
      ? `Stories: coleta pedida pelo hub · ${plural(profiles.length, "conta", "contas")}`
      : `Stories: passada ${(slot ?? 0) + 1} de ${passes} · ${plural(profiles.length, "conta", "contas")}`);
    // What the last passes could not send goes first; the CDN links are short-lived.
    if ((state.stories.pendingMedia || []).length) {
      const settings = await deps.readSyncSettings();
      const retried = await retryPending(settings);
      if (retried.sent) await log("ok", `Stories: ${plural(retried.sent, "mídia que faltava foi enviada", "mídias que faltavam foram enviadas")}`);
    }
    await step();
    return { ok: true, started: true, total: profiles.length };
  }

  /** One profile of the job in progress, then the next step or the end. */
  function step() {
    return deps.serialize(async () => {
      const settings = await deps.readSyncSettings();
      const { spy, state } = await readAll();
      const job = state.stories.job;
      if (!job) return;
      if (job.nextAt > now()) { armStep(job.nextAt); return; }
      const profile = spy.profiles?.[job.profileIds[job.index]];
      let added = 0;
      let failed = 0;
      if (profile && profile.removedAt == null && profile.trackStories) {
        const source = job.source === "manual" ? "manual" : "pass";
        const read = await readProfile(profile, settings);
        if (!read.ok && (read.error === "login_required" || read.error === "rate_limited")) {
          await deps.blockPlatform("instagram", read.error, profile.id, { kind: "stories", source });
          await log("warn", read.error === "rate_limited"
            ? "Stories: parou, o Instagram limitou a leitura · tenta de novo na próxima passada"
            : "Stories: parou, o Instagram pediu login · abra o Instagram no Chrome");
          await finish(job, { error: read.error });
          return;
        }
        if (read.ok) {
          for (const item of read.items) {
            const out = await (deps.sendStory ?? sendStory)(item, profile.id, settings);
            if (out === "sent") added += 1;
            else failed += 1;
          }
          await log(read.items.length ? "ok" : "info", read.items.length
            ? `Stories de @${profile.key}: +${added}${failed ? ` · ${plural(failed, "falha", "falhas")}` : ""}`
            : `Stories de @${profile.key}: sem story agora`);
        } else {
          failed += 1;
          await log("warn", read.error === "no_reel"
            ? `Stories de @${profile.key}: a página não trouxe os stories`
            : `Stories de @${profile.key}: a leitura falhou (${read.error})`);
        }
        const reading = { profileId: profile.id, at: now(), kind: "stories", source, ok: read.ok, ...(read.ok ? {} : { error: read.error }), reelsAdded: added };
        const r = await deps.storage.get(SPY_QUEUE_KEY);
        await deps.storage.set({ [SPY_QUEUE_KEY]: queueReading(r[SPY_QUEUE_KEY] || emptySpyQueue(), reading) });
        await deps.flush();
      }
      const next = { ...job, index: job.index + 1, added: job.added + added, failed: job.failed + failed };
      listeners.report?.({ done: next.index, total: next.profileIds.length, added: next.added, failed: next.failed, current: profile?.key ?? null });
      if (next.index >= next.profileIds.length) { await finish(next); return; }
      next.nextAt = now() + STEP_MIN_MS + Math.floor(random() * STEP_SPREAD_MS);
      const latest = await readAll();
      await writeStories({ ...latest.state.stories, job: next });
      armStep(next.nextAt);
    });
  }

  async function finish(job, { error = null } = {}) {
    const { state } = await readAll();
    const at = now();
    const stories = { ...state.stories, job: null };
    if (job.source === "pass" && !error) {
      const day = localDay(at);
      const passes = stories.daily.day === day ? stories.daily.passes : [];
      stories.daily = { day, passes: [...passes, { slot: job.slot, at, profiles: job.profileIds.length, added: job.added, failed: job.failed }] };
    }
    const nextAt = nextDueAt(stories, state.storiesSettings.passesPerDay, at); // may draw the next slot's jitter
    await writeStories(stories);
    if (!error) {
      await log(job.failed ? "warn" : "ok",
        `Stories: ${plural(job.profileIds.length, "conta", "contas")}, ${job.added} novos, ${plural(job.failed, "falha", "falhas")} · próxima passada às ${clock(nextAt)}`);
    }
    armAlarm(nextAt);
    const done = listeners.onDone;
    listeners = { report: null, onDone: null };
    done?.({ ok: !error, added: job.added, failed: job.failed, ...(error ? { error } : {}) });
  }

  /** The minute tick and the alarm: resume a job, or start the slot's pass when due. */
  async function tick() {
    const settings = await deps.readSyncSettings();
    if (!isSyncConfigured(settings)) return { ran: false, reason: "acervo" };
    const { spy, state } = await readAll();
    const at = now();
    if (state.stories.job) {
      if (state.stories.job.nextAt <= at) { await step(); return { ran: true }; }
      armStep(state.stories.job.nextAt);
      return { ran: false, reason: "running" };
    }
    if (!trackedProfiles(spy).length) return { ran: false, reason: "nothing_tracked" };
    if (await deps.isBlockedNow(at)) { armAlarm(at + 3_600_000); return { ran: false, reason: "blocked" }; }
    const passes = state.storiesSettings.passesPerDay;
    const due = passDue(state.stories, passes, at, random);
    await writeStories(state.stories); // keeps the jitter drawn for this slot
    if (!due) {
      armAlarm(nextDueAt(state.stories, passes, at));
      await writeStories(state.stories);
      return { ran: false, reason: "not_due" };
    }
    const out = await runPass({ source: "pass", slot: due.index });
    return out.ok ? { ran: true } : { ran: false, reason: out.error };
  }

  // ---- one story: metadata, poster, media, one in memory at a time ----

  const handleOf = (profileId) => `@${String(profileId).split(":")[1] || profileId}`;

  /**
   * The poster, then the media, for one story whose metadata the hub already
   * has. "sent" | "skipped" (too big, or nothing to send) | "failed" (network,
   * CDN gone, hub not ready: try again later).
   */
  async function uploadMedia(entry, settings) {
    if (!entry.media) return "skipped";
    try {
      const poster = entry.cover ? await deps.makePoster(entry.cover) : null;
      if (poster) {
        const p = await putStoryMedia(settings, entry.id, "poster", poster, "image/webp", deps.fetchImpl);
        if (!p.ok) throw new Error(`hub ${p.status}`);
      }
      const r = await deps.fetchImpl(entry.media.url, { credentials: "omit", signal: AbortSignal.timeout?.(PAGE_TIMEOUT_MS * 4) });
      if (!r.ok) throw new Error(`cdn ${r.status}`);
      const blob = await r.blob();
      if (blob.size > MEDIA_MAX_BYTES) {
        await log("warn", `Stories de ${handleOf(entry.profileId)}: um story acima de 25 MB foi pulado`);
        return "skipped";
      }
      const m = await putStoryMedia(settings, entry.id, "media", blob, entry.media.mime, deps.fetchImpl);
      if (!m.ok) throw new Error(`hub ${m.status}`);
      return "sent";
    } catch {
      return "failed";
    }
  }

  async function savePending(update) {
    const { state } = await readAll();
    await writeStories({ ...state.stories, pendingMedia: update(state.stories.pendingMedia || []) });
  }

  /**
   * One new story: its metadata goes in the Spy's batch (and is flushed, so the
   * hub has the row), then the poster and the media. A media that could not
   * be sent waits in `pendingMedia` for the next pass.
   */
  async function sendStory(reduced, profileId, settings) {
    const { input, cover, media } = reduced;
    const r = await deps.storage.get(SPY_QUEUE_KEY);
    await deps.storage.set({ [SPY_QUEUE_KEY]: queueStory(r[SPY_QUEUE_KEY] || emptySpyQueue(), profileId, input) });
    await deps.flush();
    const entry = { id: input.id, profileId, cover, media, tries: 0, firstAt: now() };
    const out = await uploadMedia(entry, settings);
    if (out !== "failed") return out;
    await savePending((list) => [...list.filter((p) => p.id !== entry.id), { ...entry, tries: 1 }]);
    return "pending";
  }

  /** The medias left behind: tried again up to 3 times within 30 h, then dropped (the hub prunes the row). */
  async function retryPending(settings) {
    const { state } = await readAll();
    const at = now();
    let sent = 0;
    let dropped = 0;
    const left = [];
    for (const entry of state.stories.pendingMedia || []) {
      if ((entry.tries || 0) >= PENDING_MAX_TRIES || at - (entry.firstAt || at) > PENDING_MAX_AGE_MS) { dropped += 1; continue; }
      const out = await uploadMedia(entry, settings);
      if (out === "sent") sent += 1;
      else if (out === "skipped") dropped += 1;
      else left.push({ ...entry, tries: (entry.tries || 0) + 1 });
    }
    await savePending(() => left);
    return { sent, dropped };
  }

  /**
   * The hub's "Coletar stories" (relay command `stories.collect`): a manual
   * pass over the given profiles, reported profile by profile, then the result.
   */
  async function onCommand(msg, reply) {
    const settings = await deps.readSyncSettings();
    if (!isSyncConfigured(settings)) { reply.result(false, { error: "acervo não configurado" }); return; }
    if (await deps.isBlockedNow(now())) { reply.result(false, { error: "rate_limited" }); return; }
    const profileIds = Array.isArray(msg?.profileIds) && msg.profileIds.length ? msg.profileIds.map(String) : null;
    const out = await runPass({
      source: "manual",
      profileIds,
      report: (progress) => reply.progress(progress),
      onDone: (done) => reply.result(done.ok, { added: done.added, failed: done.failed, ...(done.error ? { error: done.error } : {}) }),
    });
    if (!out.ok) reply.result(false, { error: out.error });
  }

  return { readProfile, runPass, tick, step, sendStory, retryPending, onCommand, status: () => ({ stepArmed: !!stepTimer }) };
}
