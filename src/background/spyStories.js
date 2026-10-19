// The stories pass (service-worker side). For every tracked Instagram profile:
// fetch the stories page with the session (no tab, no click, so nothing is
// marked as seen), reduce the new items, and send each one to the hub —
// metadata first, then the poster, then the whole media, one story in memory
// at a time. Passes run by slot (lib/spyStories.js) and on the hub's
// "Coletar stories" command. Every outside call comes through `deps`, so the
// tests drive it without a browser.
//
// Design: ~/Code/apps/socialmate-hub/docs/superpowers/specs/2026-10-19-stories-swipe-file-design.md §7, §14

import { parseReelsMediaJson, parseStoriesHtml, reduceStory } from "../lib/spyStories.js";

export const IG_APP_ID = "936619743392459";
const PAGE_TIMEOUT_MS = 30_000;

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

  return { readProfile };
}
