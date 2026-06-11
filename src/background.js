// FB Research — background service worker.
//  1) open the side panel on toolbar click
//  2) reflect run state on the action badge (watches chrome.storage)
//  3) capture fbcdn video/audio track URLs (webRequest) + drive offscreen
//     Whisper transcription / ffmpeg download for FB feed videos.

import { parseFbcdnTrack, foldTrack } from "./lib/fbcdn.js";

const SESSION_KEY = "fbw_session";
const TRANSCRIPTS_KEY = "fbw_transcripts"; // storage.local map: videoId -> { status, text, chunks, error, updatedAt }
const CURRENT_KEY = "fbw_current"; // storage.local: the in-view FB video the panel previews
const NEED_RELOAD_KEY = "fbw_need_reload"; // panel hint: active FB tab has no live content script

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
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
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  syncBadge();
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  syncBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SESSION_KEY]) updateBadge(changes[SESSION_KEY].newValue);
});

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

/** video_id -> { videoId, audioUrl, videoUrl, videoBitrate, lastSeen } */
const trackRegistry = new Map();

// The FB tab + video the panel is currently previewing (its in-view video).
let currentTabId = null;

chrome.webRequest?.onBeforeRequest.addListener(
  (details) => {
    const track = parseFbcdnTrack(details.url);
    if (!track) return;
    trackRegistry.set(track.videoId, foldTrack(trackRegistry.get(track.videoId), track, Date.now()));
  },
  { urls: ["*://*.fbcdn.net/*"] },
);

/** Most recently active (playing) video that has at least an audio track. */
function activeVideoId() {
  let best = null;
  for (const rec of trackRegistry.values()) {
    if (rec.audioUrl && (!best || rec.lastSeen > best.lastSeen)) best = rec;
  }
  return best ? best.videoId : null;
}

function resolveTracks(videoId) {
  // Explicit id (read from the DOM permalink) → ONLY that video's tracks, or null.
  // Never fall back to a different video — that crosses audio/metadata between the
  // several videos FB autoplays at once. No id (e.g. feed reels) → best-effort active.
  if (videoId) return trackRegistry.get(videoId) || null;
  const id = activeVideoId();
  return id ? trackRegistry.get(id) : null;
}

// ---- transcript store (storage.local) ----
async function getTranscripts() {
  const r = await chrome.storage.local.get(TRANSCRIPTS_KEY);
  return r[TRANSCRIPTS_KEY] || {};
}
async function putTranscript(videoId, patch) {
  const all = await getTranscripts();
  all[videoId] = { ...(all[videoId] || {}), ...patch, videoId, updatedAt: Date.now() };
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
        justification: "Local Whisper transcription and ffmpeg muxing of FB videos.",
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
async function runTranscription(videoId, tabId, meta = {}) {
  // Instagram hands us the progressive MP4 URL directly (it has audio). Facebook
  // has no direct URL → resolve the captured DASH audio track from the registry.
  let audioUrl = meta.mediaUrl || null;
  let id = videoId;
  if (!audioUrl) {
    const tracks = resolveTracks(videoId);
    if (!tracks || !tracks.audioUrl) {
      notifyTab(tabId, { type: "FBW_TRANSCRIBE_RESULT", videoId, success: false, error: "No audio captured yet — let the video play once, then retry." });
      return;
    }
    audioUrl = tracks.audioUrl;
    id = tracks.videoId;
  }
  if (!id) {
    notifyTab(tabId, { type: "FBW_TRANSCRIBE_RESULT", videoId, success: false, error: "Couldn't identify the video." });
    return;
  }
  const { thumb, counts, author, caption, platform } = meta;
  await putTranscript(id, {
    status: "running",
    error: null,
    ...(thumb ? { thumb } : {}),
    ...(counts ? { counts } : {}),
    ...(author ? { author } : {}),
    ...(caption ? { caption } : {}),
    ...(platform ? { platform } : {}),
  });
  notifyTab(tabId, { type: "FBW_TRANSCRIBE_PROGRESS", videoId: id, phase: "starting" });
  try {
    await ensureOffscreen();
    const res = await Promise.race([
      callOffscreen({ action: "transcribeFromAudioUrl", videoId: id, audioUrl }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Transcription timed out (3 min) — try again")), 180000)),
    ]);
    if (!res?.success) throw new Error(res?.error || "Transcription failed");
    const saved = await putTranscript(id, { status: "done", text: res.text, chunks: res.chunks || [] });
    notifyTab(tabId, { type: "FBW_TRANSCRIBE_RESULT", videoId: id, success: true, text: saved.text, chunks: saved.chunks });
  } catch (e) {
    await putTranscript(id, { status: "error", error: e.message });
    notifyTab(tabId, { type: "FBW_TRANSCRIBE_RESULT", videoId: id, success: false, error: e.message });
  }
}

async function runDownload(videoId, tabId, mediaUrl) {
  // Instagram = a single progressive MP4 → download it directly (no mux needed).
  if (mediaUrl) {
    try {
      await chrome.downloads.download({ url: mediaUrl, filename: `ig-${videoId || Date.now()}.mp4` });
      notifyTab(tabId, { type: "FBW_DOWNLOAD_RESULT", videoId, success: true });
    } catch (e) {
      notifyTab(tabId, { type: "FBW_DOWNLOAD_RESULT", videoId, success: false, error: e.message });
    }
    return;
  }
  // Facebook = DASH split → mux the captured tracks in the offscreen ffmpeg.
  const tracks = resolveTracks(videoId);
  if (!tracks || !tracks.videoUrl) {
    notifyTab(tabId, { type: "FBW_DOWNLOAD_RESULT", videoId, success: false, error: "No video captured yet — let it play once, then retry." });
    return;
  }
  const id = tracks.videoId;
  notifyTab(tabId, { type: "FBW_DOWNLOAD_PROGRESS", videoId: id, phase: "starting" });
  try {
    await ensureOffscreen();
    const res = await callOffscreen({ action: "muxDownload", videoId: id, videoUrl: tracks.videoUrl, audioUrl: tracks.audioUrl });
    if (!res?.success) throw new Error(res?.error || "Download failed");
    // offscreen returns a data: URL (blob can't cross to SW); hand to chrome.downloads
    await chrome.downloads.download({ url: res.dataUrl, filename: res.filename || `fb-${id}.mkv` });
    notifyTab(tabId, { type: "FBW_DOWNLOAD_RESULT", videoId: id, success: true });
  } catch (e) {
    notifyTab(tabId, { type: "FBW_DOWNLOAD_RESULT", videoId: id, success: false, error: e.message });
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
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!/^https?:\/\/[^/]*\.(facebook|instagram)\.com\//.test(tab.url || "")) return; // FB/IG tabs
  chrome.tabs
    .sendMessage(tabId, { type: "FBW_PING" })
    .then(() => { currentTabId = tabId; chrome.storage.local.set({ [NEED_RELOAD_KEY]: false }); })
    .catch(() => chrome.storage.local.set({ [NEED_RELOAD_KEY]: true }));
});

// ---- message router (content + panel) ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ignore messages addressed to the offscreen document
  if (msg?.target === "offscreen") return false;

  switch (msg?.type) {
    case "FBW_GET_ACTIVE_VIDEO": {
      const id = activeVideoId();
      sendResponse({ videoId: id, tracks: id ? trackRegistry.get(id) : null });
      return false;
    }
    // content → bg: the in-view video changed (publish it for the panel preview)
    case "FBW_CURRENT": {
      if (msg.current) currentTabId = sender.tab?.id ?? currentTabId;
      chrome.storage.local.set({
        [CURRENT_KEY]: msg.current ? { ...msg.current, updatedAt: Date.now() } : null,
        [NEED_RELOAD_KEY]: false, // this tab is live → no reload hint
      });
      return false;
    }
    // panel → bg: run on the currently-previewed video (relay to its tab)
    case "FBW_DO_TRANSCRIBE": {
      if (currentTabId != null) chrome.tabs.sendMessage(currentTabId, { type: "FBW_RUN_TRANSCRIBE" }).catch(() => {});
      sendResponse({ started: currentTabId != null });
      return false;
    }
    case "FBW_DO_DOWNLOAD": {
      if (currentTabId != null) chrome.tabs.sendMessage(currentTabId, { type: "FBW_RUN_DOWNLOAD" }).catch(() => {});
      sendResponse({ started: currentTabId != null });
      return false;
    }
    case "FBW_RELOAD_TAB": {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => {
        if (t && /(facebook|instagram)\.com/.test(t.url || "")) chrome.tabs.reload(t.id);
      });
      return false;
    }
    case "FBW_TRANSCRIBE": {
      runTranscription(msg.videoId, sender.tab?.id, {
        thumb: msg.thumb, counts: msg.counts, author: msg.author, caption: msg.caption,
        platform: msg.platform, mediaUrl: msg.mediaUrl,
      });
      sendResponse({ started: true });
      return false;
    }
    case "FBW_DOWNLOAD": {
      runDownload(msg.videoId, sender.tab?.id, msg.mediaUrl);
      sendResponse({ started: true });
      return false;
    }
    case "FBW_LIST_TRANSCRIPTS": {
      getTranscripts().then((all) => sendResponse({ transcripts: all }));
      return true; // async
    }
    default:
      return false;
  }
});
