// FB Research — background service worker.
//  1) open the side panel on toolbar click
//  2) reflect run state on the action badge (watches chrome.storage)
//  3) capture fbcdn video/audio track URLs (webRequest) + drive offscreen
//     Whisper transcription / ffmpeg download for FB feed videos.

import { parseFbcdnTrack, foldTrack, pickByWindow } from "./lib/fbcdn.js";
import { downloadPath, underDownloadRoot, SESSIONS } from "./lib/downloadPath.js";

const SESSION_KEY = "fbw_session";
const TRANSCRIPTS_KEY = "fbw_transcripts"; // storage.local map: videoId -> { status, text, chunks, error, updatedAt }
const NEED_RELOAD_KEY = "fbw_need_reload"; // panel hint: active FB tab has no live content script

// TikTok's video CDN 403s a hotlinked download (no Referer). fetch/downloads can't
// set Referer (forbidden header), so add it via a declarativeNetRequest session
// rule scoped to the TikTok video CDN hosts. Idempotent; installed lazily on the
// first TikTok download and harmless if the CDN doesn't actually require it.
const TT_REFERER_RULE_ID = 9101;
let ttRefererReady = false;
async function ensureTiktokReferer() {
  if (ttRefererReady || !chrome.declarativeNetRequest?.updateSessionRules) return;
  ttRefererReady = true;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [TT_REFERER_RULE_ID],
      addRules: [
        {
          id: TT_REFERER_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "referer", operation: "set", value: "https://www.tiktok.com/" },
              { header: "origin", operation: "set", value: "https://www.tiktok.com" },
            ],
          },
          condition: {
            requestDomains: ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "tiktok.com", "muscdn.com", "ibytedtos.com"],
            resourceTypes: ["media", "xmlhttprequest", "other", "image"],
          },
        },
      ],
    });
  } catch {
    ttRefererReady = false; // let a later download retry the install
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor)
    chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

// Map persisted session → badge.
//   halted        → red "!"
//   paused/break  → amber "II"
//   running       → azure processed count ("•" before first item)
//   idle/done     → cleared
function updateBadge(s) {
  if (s && s.haltReason) return setBadge("!", "#EF4444");
  if (!s || !s.isRunning) return setBadge("", "#3C7CFC");
  if (s.isPaused || s.isAutoBreak) return setBadge("II", "#F59E0B");
  const n = s.processed || 0;
  return setBadge(n > 0 ? (n > 999 ? "999+" : String(n)) : "•", "#3C7CFC");
}

function syncBadge() {
  chrome.storage.local.get(SESSION_KEY, (r) => updateBadge(r[SESSION_KEY]));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  syncBadge();
  reinjectContentScripts();
});

// Re-inject content scripts into already-open platform tabs after an extension
// reload/update — otherwise every open FB/IG/TT tab silently loses its engine
// ("Receiving end does not exist") until the tab is manually reloaded. All our
// content scripts carry an init guard, so double-injection is a no-op.
//
// `onlyTabId` narrows the sweep to a single tab. The panel's one-click recovery
// needs exactly this manifest → executeScript mapping, so it reuses this
// function instead of keeping a second copy that could drift — the `world`
// mapping especially: a MAIN-world script injected as ISOLATED runs happily and
// does nothing, which is the hardest possible bug to see.
async function reinjectContentScripts(onlyTabId = null) {
  let injected = 0;
  for (const cs of chrome.runtime.getManifest().content_scripts || []) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: cs.matches });
    } catch {
      continue;
    }
    for (const t of tabs) {
      if (onlyTabId != null && t.id !== onlyTabId) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          files: cs.js,
          world: cs.world === "MAIN" ? "MAIN" : "ISOLATED",
        });
        injected += 1;
      } catch {
        /* discarded/errored tabs — the panel's reload banner covers those */
      }
    }
  }
  return injected;
}

// ---- one-click recovery for a tab whose content scripts are gone ----
// Every content script answers FBW_PING, so a ping is the liveness test — the
// same test tabs.onActivated already uses to set fbw_need_reload.
function pingTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "FBW_PING" }).then(
    () => true,
    () => false,
  );
}
async function waitForPing(tabId, attempts, delayMs) {
  for (let i = 0; i < attempts; i += 1) {
    if (await pingTab(tabId)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// Cheapest repair first. Re-injection keeps the page exactly as the user left
// it — scroll position, the open reel, a half-typed comment — so it is tried
// before the blunt fallback. A reload is only needed for tabs executeScript
// cannot reach: one open since before the extension had its host permission, or
// one Chrome discarded. A reload re-runs the manifest's content scripts by
// itself, so afterwards we only wait for one of them to answer.
//
// WHY THE LADDER TAKES ITS STEPS AS AN ARGUMENT. Only the `alive` rung is
// reachable on demand in a real browser: Chrome heals the tab before the
// fallbacks can run — a discarded tab resurrects on the very first sendMessage,
// and an extension reload re-injects every content script from onInstalled. Three
// live attempts to force `inject`/`reload` all came back `alive`. So the rungs
// below it are covered by unit tests instead (src/background.test.js), which
// hand in fake steps. `steps` is the ONLY change from the previous shape; the
// order, the retry counts and every return value are byte-for-byte the same.
export async function reviveWith(steps, tabId) {
  if (tabId == null) return { ok: false, error: "nenhuma aba para reconectar" };
  if (await steps.ping(tabId)) return { ok: true, method: "alive" };
  try {
    await steps.reinject(tabId);
  } catch {
    /* fall through to the reload path */
  }
  if (await steps.waitForPing(tabId, 6, 250)) return { ok: true, method: "inject" };
  try {
    await steps.reload(tabId);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // ≤10s covers a cold facebook.com load on a slow connection.
  if (await steps.waitForPing(tabId, 20, 500)) return { ok: true, method: "reload" };
  return { ok: false, error: "a aba não respondeu depois de recarregar" };
}

const REVIVE_STEPS = {
  ping: (tabId) => pingTab(tabId),
  reinject: (tabId) => reinjectContentScripts(tabId),
  waitForPing: (tabId, attempts, delayMs) => waitForPing(tabId, attempts, delayMs),
  reload: (tabId) => chrome.tabs.reload(tabId),
};

function reviveTab(tabId) {
  return reviveWith(REVIVE_STEPS, tabId);
}

// Recovery succeeded → the stale-tab hint is provably wrong, so retire it. This
// is what lets the panel re-enable itself without being reopened: the panel and
// the Library both watch this key through storage.onChanged.
async function markTabHealthy() {
  try {
    await chrome.storage.local.set({ [NEED_RELOAD_KEY]: false });
  } catch {
    /* storage unavailable during teardown */
  }
}
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  syncBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SESSION_KEY]) updateBadge(changes[SESSION_KEY].newValue);
  if (changes[SAVED_KEY]) capSavedStore(changes[SAVED_KEY].newValue);
});

// `fbw_saved` is written from NINE places (three content scripts + six panel tools),
// none of which pruned — it was the only store in the extension that grew forever,
// and records can carry a base64 thumbnail (~10-20KB each). Capping it in every
// writer would mean nine copies of the same logic, so it's enforced here instead:
// one listener, one place, and no writer needs to know. Trims oldest-first by
// updatedAt. Writing back re-fires this listener, but by then we're at the cap so
// the guard below stops immediately (no loop).
const SAVED_KEY = "fbw_saved";
const SAVED_CAP = 300;
function capSavedStore(map) {
  if (!map || typeof map !== "object") return;
  const keys = Object.keys(map);
  if (keys.length <= SAVED_CAP) return;
  const kept = keys
    .sort((a, b) => (map[b]?.updatedAt || 0) - (map[a]?.updatedAt || 0))
    .slice(0, SAVED_CAP);
  const next = {};
  for (const k of kept) next[k] = map[k];
  chrome.storage.local.set({ [SAVED_KEY]: next });
}

// initial paint (SW may spin up mid-session)
syncBadge();

// ============================================================================
// VIDEO TRACK CAPTURE + TRANSCRIPTION / DOWNLOAD
// ============================================================================
//
// FB parses the feed AND fetches video segments off the main thread (worker),
// so a content script can't see media URLs. The background SW can: chrome.webRequest
// observes every tab request including worker-issued ones. We capture *.fbcdn.net
// .mp4 DASH track URLs, key them by video_id, and the currently-playing video is
// simply the one whose tracks were requested most recently (max lastSeen).

/** key -> { videoId, xpvId, durationS, audioUrl, videoUrl, videoBitrate, lastSeen }
 *  key = video_id when FB stamps one, else "xpv:<xpv_asset_id>" until aliased. */
const trackRegistry = new Map();
// xpv_asset_id -> video_id, learned from any track that carries BOTH ids. Lets us
// fold an orphaned (video_id:null) audio track into its real video record.
const xpvToVideoId = new Map();
const XPV_CAP = 600;

// The FB tab + video the panel is currently previewing (its in-view video).

function registryKeyFor(track) {
  if (track.videoId) return track.videoId;
  if (track.xpvId && xpvToVideoId.has(track.xpvId))
    return xpvToVideoId.get(track.xpvId);
  if (track.xpvId) return "xpv:" + track.xpvId;
  return null;
}

chrome.webRequest?.onBeforeRequest.addListener(
  (details) => {
    const track = parseFbcdnTrack(details.url);
    if (!track) return;
    // Learn the xpv->video_id alias and migrate any parked orphan audio record
    // into the real video_id record so a later resolve finds the full a/v pair.
    if (track.videoId && track.xpvId && !xpvToVideoId.has(track.xpvId)) {
      xpvToVideoId.set(track.xpvId, track.videoId);
      const orphan = trackRegistry.get("xpv:" + track.xpvId);
      if (orphan) {
        const dest = trackRegistry.get(track.videoId) || {
          videoId: track.videoId,
          xpvId: track.xpvId,
          durationS: orphan.durationS || 0,
          audioUrl: null,
          videoUrl: null,
          videoBitrate: 0,
          lastSeen: 0,
        };
        dest.audioUrl = dest.audioUrl || orphan.audioUrl;
        if (!dest.videoUrl && orphan.videoUrl) {
          dest.videoUrl = orphan.videoUrl;
          dest.videoBitrate = orphan.videoBitrate;
        }
        dest.lastSeen = Math.max(dest.lastSeen, orphan.lastSeen);
        trackRegistry.set(track.videoId, dest);
        trackRegistry.delete("xpv:" + track.xpvId);
      }
    }
    const key = registryKeyFor(track);
    if (!key) return;
    trackRegistry.set(key, foldTrack(trackRegistry.get(key), track, Date.now()));
    if (trackRegistry.size > TRACK_REGISTRY_CAP) pruneTrackRegistry();
    // The alias map can grow several times faster than the registry it's pruned
    // with (many xpv ids alias one video id), so cap it directly too.
    if (xpvToVideoId.size > XPV_CAP)
      for (const k of xpvToVideoId.keys()) {
        xpvToVideoId.delete(k);
        if (xpvToVideoId.size <= XPV_CAP) break;
      }
  },
  // Without `types` this fires for every image/avatar/sticker on Facebook —
  // thousands of dispatches a minute that only ever fail the .mp4 regex, and each
  // one keeps the MV3 service worker awake. Media/XHR only: same tracks, ~95%
  // fewer events.
  { urls: ["*://*.fbcdn.net/*"], types: ["media", "xmlhttprequest", "other"] },
);

// The registry only needs the handful of recently-played videos (a job resolves
// the most-recent match). Without a cap it grew for the whole warm session —
// every scrolled reel adds an entry. Prune the oldest by lastSeen back to CAP,
// and drop any now-dangling xpv→videoId aliases.
const TRACK_REGISTRY_CAP = 300;
function pruneTrackRegistry() {
  const keep = Array.from(trackRegistry.entries())
    .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
    .slice(0, TRACK_REGISTRY_CAP);
  trackRegistry.clear();
  const liveVideoIds = new Set();
  for (const [k, v] of keep) {
    trackRegistry.set(k, v);
    if (v.videoId) liveVideoIds.add(v.videoId);
  }
  for (const [xpv, vid] of xpvToVideoId)
    if (!liveVideoIds.has(vid)) xpvToVideoId.delete(xpv);
}

/** Most recently active (playing) video that has at least an audio track. */
function activeVideoId() {
  let best = null;
  for (const rec of trackRegistry.values()) {
    if (rec.audioUrl && (!best || rec.lastSeen > best.lastSeen)) best = rec;
  }
  return best ? best.videoId : null;
}

function resolveTracks(videoId, candidates, durationHint, primedAt) {
  // 1) Explicit id → ONLY that video's tracks. The content script only fills
  //    videoId when it's CONFIDENT (permalink/URL or a prior duration match) —
  //    a junk markup id here once collided with a real neighbour's id and
  //    transcribed the wrong video.
  if (videoId && trackRegistry.get(videoId)) return trackRegistry.get(videoId);
  // 2) Feed jobs (no trustworthy id anywhere in the post markup — proven
  //    live): prime-window attribution decides — the tracks fetched while the
  //    content script played THIS video. efg duration_s alone is NOT safe
  //    (FB stamps preview-cut durations on full videos); it only breaks ties.
  if (durationHint || primedAt)
    return pickByWindow(trackRegistry.values(), primedAt || 0, durationHint, 2);
  // 3) Candidate ids scraped from the post (FB buries the real video_id in the
  //    markup but not in a clean permalink). Intersect them with what we actually
  //    captured → deterministic match, no crossing to a prefetched neighbour.
  //    Prefer a record with both audio+video, then the most recently fetched.
  if (Array.isArray(candidates) && candidates.length) {
    let best = null;
    for (const id of candidates) {
      const rec = trackRegistry.get(String(id));
      if (!rec || !rec.audioUrl) continue;
      if (!best) {
        best = rec;
        continue;
      }
      const recComplete = !!(rec.audioUrl && rec.videoUrl);
      const bestComplete = !!(best.audioUrl && best.videoUrl);
      if (recComplete !== bestComplete) {
        if (recComplete) best = rec;
      } else if (rec.lastSeen > best.lastSeen) best = rec;
    }
    if (best) return best;
  }
  // 4) Explicit id was given but not captured yet → don't cross to another video.
  if (videoId) return null;
  // 5) No id at all (e.g. FB reels) → best-effort most-recently-active video.
  const id = activeVideoId();
  return id ? trackRegistry.get(id) : null;
}

// ---- transcript store (storage.local) ----
async function getTranscripts() {
  const r = await chrome.storage.local.get(TRANSCRIPTS_KEY);
  return r[TRANSCRIPTS_KEY] || {};
}
const TRANSCRIPTS_CAP = 20;
async function putTranscript(videoId, patch) {
  const all = await getTranscripts();
  all[videoId] = {
    ...(all[videoId] || {}),
    ...patch,
    videoId,
    updatedAt: Date.now(),
  };
  // Rolling history: keep the newest TRANSCRIPTS_CAP records. Thumbs make each
  // record 10-20KB, and the Library reads the whole map on every change.
  const ids = Object.keys(all);
  if (ids.length > TRANSCRIPTS_CAP) {
    ids.sort((a, b) => (all[b].updatedAt || 0) - (all[a].updatedAt || 0));
    for (const id of ids.slice(TRANSCRIPTS_CAP)) delete all[id];
  }
  await chrome.storage.local.set({ [TRANSCRIPTS_KEY]: all });
  return all[videoId];
}

// ---- offscreen document lifecycle ----
let offscreenReady = false;
let offscreenCreating = null;
const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

async function ensureOffscreen() {
  if (offscreenReady) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["DOM_SCRAPING"],
        justification:
          "Local Whisper transcription and ffmpeg muxing of FB videos.",
      });
    }
    offscreenReady = true;
  })();
  try {
    await offscreenCreating;
  } catch (e) {
    // "Only a single offscreen document" => already exists, treat as ready
    offscreenReady = true;
  } finally {
    offscreenCreating = null;
  }
}

/** Send a request to the offscreen document and await its response. */
function callOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

// ---- job runners ----
// Parse a WebVTT caption file → { text, chunks:[{timestamp:[start,end], text}] }.
// Mirrors the Whisper chunk shape so the Library's SRT/txt export just works.
function vttTime(t) {
  const m = String(t).trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  const [, h, mm, ss, ms] = m;
  return (+(h || 0)) * 3600 + +mm * 60 + +ss + +("0." + ms);
}
function parseWebVtt(raw) {
  const body = String(raw).replace(/^﻿/, "").replace(/\r/g, "");
  const chunks = [];
  for (const block of body.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const tl = lines.findIndex((l) => l.includes("-->"));
    if (tl < 0) continue;
    const [a, b] = lines[tl].split("-->");
    const text = lines
      .slice(tl + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "") // inline karaoke/style tags
      .replace(/\{[^}]+\}/g, "")
      .trim();
    if (text) chunks.push({ timestamp: [vttTime(a), vttTime(b)], text });
  }
  return { text: chunks.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim(), chunks };
}

async function runTranscription(videoId, tabId, meta = {}) {
  // Caption-first: if the platform already ships an ASR/subtitle track (TikTok
  // `subtitleInfos`), download and parse it instead of running Whisper — far
  // faster/cheaper. Whisper stays the fallback when no caption URL is present.
  if (meta.captionUrl) {
    const id = videoId;
    const { thumb, counts, author, caption, platform, sourceUrl } = meta;
    await putTranscript(id, {
      status: "running", error: null, source: "caption",
      ...(thumb ? { thumb } : {}), ...(counts ? { counts } : {}), ...(author ? { author } : {}),
      ...(caption ? { caption } : {}), ...(platform ? { platform } : {}), ...(sourceUrl ? { sourceUrl } : {}),
    });
    try {
      if (/tiktok|tiktokcdn|tiktokv|muscdn|ibytedtos/.test(meta.captionUrl)) await ensureTiktokReferer();
      const r = await fetch(meta.captionUrl);
      if (!r.ok) throw new Error("caption fetch failed " + r.status);
      const { text, chunks } = parseWebVtt(await r.text());
      if (!text) throw new Error("empty caption");
      const saved = await putTranscript(id, { status: "done", source: "caption", text, chunks });
      notifyTab(tabId, { type: "FBW_TRANSCRIBE_RESULT", videoId: id, success: true, text: saved.text, chunks: saved.chunks });
      return;
    } catch (e) {
      // Fall through to Whisper if we have media; else report the caption error.
      if (!meta.mediaUrl && !meta.candidates) {
        await putTranscript(id, { status: "error", error: e.message });
        notifyTab(tabId, { type: "FBW_TRANSCRIBE_RESULT", videoId: id, success: false, error: e.message });
        return;
      }
    }
  }
  // Audio source, cheapest first:
  //   1. a captured DASH audio-only track (small, fast to fetch+decode), then
  //   2. meta.mediaUrl — a progressive MP4 (Instagram always; Facebook when we
  //      read progressive_url off the page for a video we never saw on the wire).
  //      It carries video too, so decoding its audio is heavier — used only as a
  //      fallback so cached videos still transcribe.
  let audioUrl = null;
  let id = videoId;
  const tracks = resolveTracks(videoId, meta.candidates, meta.durationHint, meta.primedAt);
  if (tracks && tracks.audioUrl) {
    audioUrl = tracks.audioUrl;
    id = tracks.videoId;
  } else if (meta.mediaUrl) {
    audioUrl = meta.mediaUrl;
  }
  // TikTok audio comes off the same Referer-gated CDN as its video — install the
  // header rule so the offscreen fetch of the audio doesn't 403.
  if (meta.platform === "tiktok" || /tiktok|tiktokcdn|tiktokv|muscdn|ibytedtos/.test(audioUrl || "")) await ensureTiktokReferer();
  if (!audioUrl) {
    notifyTab(tabId, {
      type: "FBW_TRANSCRIBE_RESULT",
      videoId,
      success: false,
      error: "No audio captured yet — let the video play once, then retry.",
    });
    return;
  }
  if (!id) {
    notifyTab(tabId, {
      type: "FBW_TRANSCRIBE_RESULT",
      videoId,
      success: false,
      error: "Couldn't identify the video.",
    });
    return;
  }
  const { thumb, counts, author, caption, platform, sourceUrl } = meta;
  await putTranscript(id, {
    status: "running",
    error: null,
    ...(thumb ? { thumb } : {}),
    ...(counts ? { counts } : {}),
    ...(author ? { author } : {}),
    ...(caption ? { caption } : {}),
    ...(platform ? { platform } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  });
  try {
    await ensureOffscreen();
    const res = await Promise.race([
      callOffscreen({
        action: "transcribeFromAudioUrl",
        videoId: id,
        audioUrl,
      }),
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error("Transcription timed out (3 min) — try again")),
          180000,
        ),
      ),
    ]);
    if (!res?.success) throw new Error(res?.error || "Transcription failed");
    const saved = await putTranscript(id, {
      status: "done",
      text: res.text,
      chunks: res.chunks || [],
    });
    notifyTab(tabId, {
      type: "FBW_TRANSCRIBE_RESULT",
      videoId: id,
      success: true,
      text: saved.text,
      chunks: saved.chunks,
    });
  } catch (e) {
    await putTranscript(id, { status: "error", error: e.message });
    notifyTab(tabId, {
      type: "FBW_TRANSCRIBE_RESULT",
      videoId: id,
      success: false,
      error: e.message,
    });
  }
}

// ---- where downloads land -------------------------------------------------
// The service worker is the only context that actually calls chrome.downloads for
// media/JSON, so it — not the sender — decides the folder. Two shapes arrive:
//
//   • Panels and pin-api.js CAN import lib/downloadPath.js, so they send a finished
//     path. It is passed through underDownloadRoot(), which returns an already
//     rooted path byte-identical and re-roots anything else.
//   • The Facebook / Instagram / TikTok content scripts are import-free on purpose
//     (an ES import makes CRXJS emit a dynamic-import loader, which those origins'
//     CSP can kill — that would break all capture). They send a BARE file name plus
//     `platform` and, when the folder isn't just the media kind, `folder`.
//
// Either way it is impossible for a caller to land a file in the Downloads root.
function resolveDownloadPath(msg, fallbackName) {
  const name = msg.filename || fallbackName;
  if (msg.platform) return downloadPath(msg.platform, msg.folder || msg.kind || null, name);
  return underDownloadRoot(name);
}

async function runDownload(videoId, tabId, mediaUrl, candidates, mediaName, durationHint, primedAt) {
  // A direct progressive MP4 (Instagram, or a Facebook reel/video whose
  // progressive_url we read from the page JSON) → download it as-is, no mux.
  if (mediaUrl) {
    try {
      await chrome.downloads.download({
        url: mediaUrl,
        // mediaName arrives already rooted — the FBW_DOWNLOAD handler ran it through
        // downloadPath before calling us. underDownloadRoot is the belt-and-braces
        // guard so this stays safe if a future caller passes a raw name. The no-name
        // fallback is the Instagram case: the IG bridge is the only sender that omits
        // a name, and it always hands us a progressive MP4.
        filename: underDownloadRoot(
          mediaName || downloadPath("instagram", "video", `ig-${videoId || Date.now()}.mp4`),
        ),
      });
      notifyTab(tabId, { type: "FBW_DOWNLOAD_RESULT", videoId, success: true });
    } catch (e) {
      notifyTab(tabId, {
        type: "FBW_DOWNLOAD_RESULT",
        videoId,
        success: false,
        error: e.message,
      });
    }
    return;
  }
  // Facebook = DASH split → mux the captured tracks in the offscreen ffmpeg.
  const tracks = resolveTracks(videoId, candidates, durationHint, primedAt);
  if (!tracks || !tracks.videoUrl) {
    notifyTab(tabId, {
      type: "FBW_DOWNLOAD_RESULT",
      videoId,
      success: false,
      error: "No video captured yet — let it play once, then retry.",
    });
    return;
  }
  const id = tracks.videoId;
  try {
    await ensureOffscreen();
    const res = await callOffscreen({
      action: "muxDownload",
      videoId: id,
      videoUrl: tracks.videoUrl,
      audioUrl: tracks.audioUrl,
    });
    if (!res?.success) throw new Error(res?.error || "Download failed");
    // offscreen minted a blob: URL (valid while the offscreen doc is alive) — no
    // base64 round-trip. Hand it straight to chrome.downloads.
    await chrome.downloads.download({
      url: res.blobUrl,
      // The offscreen doc returns a BARE name — it muxes bytes, it doesn't decide
      // where files live. A DASH mux is always a Facebook video, so the folder is
      // known here.
      filename: downloadPath("facebook", "video", res.filename || `fb-${id}.mp4`),
    });
    notifyTab(tabId, {
      type: "FBW_DOWNLOAD_RESULT",
      videoId: id,
      success: true,
    });
  } catch (e) {
    notifyTab(tabId, {
      type: "FBW_DOWNLOAD_RESULT",
      videoId: id,
      success: false,
      error: e.message,
    });
  }
}

function notifyTab(tabId, msg) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// Tab awareness: when the user switches to a Facebook tab, ping it. If its content
// script answers, it re-publishes its in-view video (no hint). If it doesn't (tab
// loaded before the extension, or not yet injected), flag the panel to reload it.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!/^https?:\/\/[^/]*\.(facebook|instagram)\.com\//.test(tab.url || ""))
    return; // FB/IG tabs
  chrome.tabs
    .sendMessage(tabId, { type: "FBW_PING" })
    .then(() => chrome.storage.local.set({ [NEED_RELOAD_KEY]: false }))
    .catch(() => chrome.storage.local.set({ [NEED_RELOAD_KEY]: true }));
});

// ---- run logs ----
// A finished run lands in ~/Downloads/social-mate/sessoes/ as one JSON file: config +
// counters + the full structured event stream. That's the artifact you hand back
// for analysis ("here's last night's run, what's tuning badly?").
//
// Service workers have no URL.createObjectURL, so the file goes out as a data:
// URL. It must be built through TextEncoder — btoa() alone throws on the emoji in
// comment text, which would silently lose exactly the runs worth reading.
function jsonDataUrl(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
  let bin = "";
  const CHUNK = 0x8000; // keep String.fromCharCode off the arg-count limit
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return "data:application/json;base64," + btoa(bin);
}

async function writeRunLogFile(doc) {
  if (!doc || !Array.isArray(doc.events)) return;
  try {
    const started = doc.meta?.startedAt || Date.now();
    const stamp = new Date(started).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outcome = String(doc.outcome || "run").split(":")[0].trim();
    await chrome.downloads.download({
      url: jsonDataUrl(doc),
      filename: downloadPath(SESSIONS, null, `run-${stamp}-${outcome}.json`),
      saveAs: false,
      conflictAction: "uniquify",
    });
  } catch (e) {
    console.warn("[SW] run log write failed", e);
  }
}

// ---- message router (content + panel) ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ignore messages addressed to the offscreen document
  if (msg?.target === "offscreen") return false;

  switch (msg?.type) {
    // offscreen → bg: no jobs in flight, runtimes terminated. Close the document so
    // the WASM heaps (Whisper ~180 MB + MiniLM + ffmpeg) are actually returned to the
    // OS; WASM memory only shrinks by being discarded. Next job re-creates it.
    case "FBW_OFFSCREEN_IDLE": {
      (async () => {
        try {
          if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
        } catch {
          /* already gone */
        }
        offscreenReady = false;
      })();
      return false;
    }
    // panel → bg: bring ONE tab's content scripts back (re-inject, else reload)
    // and report what happened. The panel keeps its buttons enabled and shows
    // this result either way — the whole point is that a failed recovery is as
    // visible as a successful one.
    case "FBW_REVIVE_TAB": {
      (async () => {
        const res = await reviveTab(msg.tabId);
        if (res.ok) await markTabHealthy();
        sendResponse(res);
      })();
      return true; // async
    }
    case "FBW_RELOAD_TAB": {
      // The Library's stale-tab hint. Now routed through the same recovery as
      // the panel banner, so it re-injects (page state preserved) before
      // resorting to a reload — and clears the hint once the tab answers, which
      // a bare reload never did. Returning true keeps the worker alive for the
      // wait; the caller ignores the response.
      (async () => {
        const [t] = await chrome.tabs
          .query({ active: true, lastFocusedWindow: true })
          .catch(() => []);
        if (!t || !/(facebook|instagram)\.com/.test(t.url || "")) {
          sendResponse({ ok: false, error: "nenhuma aba compatível ativa" });
          return;
        }
        const res = await reviveTab(t.id);
        if (res.ok) await markTabHealthy();
        sendResponse(res);
      })();
      return true; // async
    }
    case "FBW_TRANSCRIBE": {
      runTranscription(msg.videoId, sender.tab?.id, {
        thumb: msg.thumb,
        counts: msg.counts,
        author: msg.author,
        caption: msg.caption,
        platform: msg.platform,
        sourceUrl: msg.sourceUrl,
        mediaUrl: msg.mediaUrl,
        captionUrl: msg.captionUrl, // caption-first (TikTok subtitleInfos webvtt)
        captionFormat: msg.captionFormat,
        // Feed post markup embeds NEIGHBOURING videos' ids — candidates from a
        // feed job are poison, refuse them even if a buggy/stale content
        // script sends some.
        candidates: msg.feedSurface ? null : msg.candidates,
        durationHint: msg.durationHint,
        primedAt: msg.primedAt,
      });
      sendResponse({ started: true });
      return false;
    }
    case "FBW_DOWNLOAD": {
      runDownload(
        msg.videoId,
        sender.tab?.id,
        msg.mediaUrl,
        msg.feedSurface ? null : msg.candidates,
        // The FB rail sends a bare "fb-<id>.mp4"; the IG bridge sends no name at all
        // (its progressive MP4 is always Instagram). The folder is decided here, not
        // by the content script — neither of them can import downloadPath.
        msg.mediaName ? downloadPath(msg.platform || "facebook", "video", msg.mediaName) : null,
        msg.durationHint,
        msg.primedAt,
      );
      sendResponse({ started: true });
      return false;
    }
    // content → bg: "which captured video is this DOM <video>?" — duration-keyed
    // lookup so a feed post with no permalink id still gets a deterministic
    // record id (and can then find its media in the page's embedded JSON).
    case "FBW_MATCH_TRACKS": {
      const rec = pickByWindow(trackRegistry.values(), msg.primedAt || 0, msg.durationHint, 2);
      sendResponse({ videoId: rec ? rec.videoId : null });
      return false;
    }
    // debug: dump the live track registry (panel/devtools use; no page access)
    // content → bg: a finished run's structured log → JSON file on disk.
    case "FBW_WRITE_RUN_LOG": {
      writeRunLogFile(msg.doc);
      sendResponse({ ok: true });
      return false;
    }
    // content → bg: an arbitrary JSON payload → file on disk (comment scrapes).
    // The SW has no URL.createObjectURL, so route through jsonDataUrl like the
    // run-log writer (TextEncoder → base64 data URL, emoji-safe).
    case "FBW_DL_JSON": {
      try {
        chrome.downloads.download({
          url: jsonDataUrl(msg.data),
          filename: resolveDownloadPath(msg, `export-${Date.now()}.json`),
          saveAs: false,
          conflictAction: "uniquify",
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return false;
    }
    // content → bg → offscreen: niche-relevance (+ spam) cosine for a post.
    // Fails open (score 1, spam 0) so a model hiccup never blocks the warmer.
    case "FBW_RELEVANCE": {
      (async () => {
        try {
          await ensureOffscreen();
          const res = await callOffscreen({
            action: "relevanceScore",
            keyword: msg.keyword,
            text: msg.text,
            spam: msg.spam,
          });
          sendResponse(
            res?.success
              ? { score: res.score, spam: res.spam }
              : { score: 1, spam: 0, error: res?.error },
          );
        } catch (e) {
          sendResponse({ score: 1, spam: 0, error: e.message });
        }
      })();
      return true; // async
    }
    // panel → bg: download IG media. video = direct URL; image = fetch in the SW
    // (host perms bypass page CORS) → base64 data URL. Carousels arrive one msg/child.
    case "FBW_DL_MEDIA": {
      (async () => {
        try {
          // TikTok media (video or thumbnail) needs the Referer header injected.
          if (/tiktok|tiktokcdn|tiktokv|muscdn|ibytedtos/.test(msg.url || "")) await ensureTiktokReferer();
          const filename = resolveDownloadPath(msg, `media-${Date.now()}`);
          if (msg.kind === "video") {
            await chrome.downloads.download({ url: msg.url, filename });
            sendResponse({ ok: true });
            return;
          }
          let res = await fetch(msg.url).catch(() => null);
          if ((!res || !res.ok) && msg.fallbackUrl)
            res = await fetch(msg.fallbackUrl).catch(() => null);
          if (!res || !res.ok)
            throw new Error("fetch failed " + (res ? res.status : "network"));
          const buf = new Uint8Array(await res.arrayBuffer());
          let bin = "";
          const CH = 0x8000;
          for (let i = 0; i < buf.length; i += CH)
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
          const type = res.headers.get("content-type") || "image/jpeg";
          const dataUrl = `data:${type};base64,${btoa(bin)}`;
          await chrome.downloads.download({ url: dataUrl, filename });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
    default:
      return false;
  }
});
