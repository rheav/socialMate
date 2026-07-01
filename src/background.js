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
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  syncBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SESSION_KEY])
    updateBadge(changes[SESSION_KEY].newValue);
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

/** key -> { videoId, xpvId, durationS, audioUrl, videoUrl, videoBitrate, lastSeen }
 *  key = video_id when FB stamps one, else "xpv:<xpv_asset_id>" until aliased. */
const trackRegistry = new Map();
// xpv_asset_id -> video_id, learned from any track that carries BOTH ids. Lets us
// fold an orphaned (video_id:null) audio track into its real video record.
const xpvToVideoId = new Map();

// The FB tab + video the panel is currently previewing (its in-view video).
let currentTabId = null;

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

function resolveTracks(videoId, candidates) {
  // 1) Explicit id (rare on FB feed) → ONLY that video's tracks.
  if (videoId && trackRegistry.get(videoId)) return trackRegistry.get(videoId);
  // 2) Candidate ids scraped from the post (FB buries the real video_id in the
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
  // 3) Explicit id was given but not captured yet → don't cross to another video.
  if (videoId) return null;
  // 4) No id at all (e.g. FB reels) → best-effort most-recently-active video.
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
  all[videoId] = {
    ...(all[videoId] || {}),
    ...patch,
    videoId,
    updatedAt: Date.now(),
  };
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
async function runTranscription(videoId, tabId, meta = {}) {
  // Instagram hands us the progressive MP4 URL directly (it has audio). Facebook
  // has no direct URL → resolve the captured DASH audio track from the registry.
  let audioUrl = meta.mediaUrl || null;
  let id = videoId;
  if (!audioUrl) {
    const tracks = resolveTracks(videoId, meta.candidates);
    if (!tracks || !tracks.audioUrl) {
      notifyTab(tabId, {
        type: "FBW_TRANSCRIBE_RESULT",
        videoId,
        success: false,
        error: "No audio captured yet — let the video play once, then retry.",
      });
      return;
    }
    audioUrl = tracks.audioUrl;
    id = tracks.videoId;
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
  notifyTab(tabId, {
    type: "FBW_TRANSCRIBE_PROGRESS",
    videoId: id,
    phase: "starting",
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

async function runDownload(videoId, tabId, mediaUrl, candidates) {
  // Instagram = a single progressive MP4 → download it directly (no mux needed).
  if (mediaUrl) {
    try {
      await chrome.downloads.download({
        url: mediaUrl,
        filename: `ig-${videoId || Date.now()}.mp4`,
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
  const tracks = resolveTracks(videoId, candidates);
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
  notifyTab(tabId, {
    type: "FBW_DOWNLOAD_PROGRESS",
    videoId: id,
    phase: "starting",
  });
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
      filename: res.filename || `fb-${id}.mp4`,
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
    .then(() => {
      currentTabId = tabId;
      chrome.storage.local.set({ [NEED_RELOAD_KEY]: false });
    })
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
        [CURRENT_KEY]: msg.current
          ? { ...msg.current, updatedAt: Date.now() }
          : null,
        [NEED_RELOAD_KEY]: false, // this tab is live → no reload hint
      });
      return false;
    }
    // panel → bg: run on the currently-previewed video (relay to its tab)
    case "FBW_DO_TRANSCRIBE": {
      if (currentTabId != null)
        chrome.tabs
          .sendMessage(currentTabId, { type: "FBW_RUN_TRANSCRIBE" })
          .catch(() => {});
      sendResponse({ started: currentTabId != null });
      return false;
    }
    case "FBW_DO_DOWNLOAD": {
      if (currentTabId != null)
        chrome.tabs
          .sendMessage(currentTabId, { type: "FBW_RUN_DOWNLOAD" })
          .catch(() => {});
      sendResponse({ started: currentTabId != null });
      return false;
    }
    case "FBW_RELOAD_TAB": {
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then(([t]) => {
          if (t && /(facebook|instagram)\.com/.test(t.url || ""))
            chrome.tabs.reload(t.id);
        });
      return false;
    }
    case "FBW_TRANSCRIBE": {
      runTranscription(msg.videoId, sender.tab?.id, {
        thumb: msg.thumb,
        counts: msg.counts,
        author: msg.author,
        caption: msg.caption,
        platform: msg.platform,
        mediaUrl: msg.mediaUrl,
        candidates: msg.candidates,
      });
      sendResponse({ started: true });
      return false;
    }
    case "FBW_DOWNLOAD": {
      runDownload(msg.videoId, sender.tab?.id, msg.mediaUrl, msg.candidates);
      sendResponse({ started: true });
      return false;
    }
    case "FBW_LIST_TRANSCRIPTS": {
      getTranscripts().then((all) => sendResponse({ transcripts: all }));
      return true; // async
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
    // content → bg → offscreen: quick partial transcript of the in-view video.
    // Resolves the captured fbcdn audio track, Whisper-transcribes a ~12s cap.
    case "FBW_QUICK_TRANSCRIBE": {
      (async () => {
        try {
          const tracks = resolveTracks(msg.videoId, msg.candidates);
          if (!tracks || !tracks.audioUrl) {
            sendResponse({ text: "" });
            return;
          }
          await ensureOffscreen();
          const res = await callOffscreen({
            action: "quickTranscribe",
            audioUrl: tracks.audioUrl,
            maxSeconds: 12,
            videoId: tracks.videoId,
            lang: msg.lang,
          });
          sendResponse({ text: res?.success ? res.text : "" });
        } catch (e) {
          sendResponse({ text: "", error: e.message });
        }
      })();
      return true; // async
    }
    // panel → bg: download IG media. video = direct URL; image = fetch in the SW
    // (host perms bypass page CORS) → base64 data URL. Carousels arrive one msg/child.
    case "FBW_DL_MEDIA": {
      (async () => {
        try {
          if (msg.kind === "video") {
            await chrome.downloads.download({ url: msg.url, filename: msg.filename });
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
          await chrome.downloads.download({ url: dataUrl, filename: msg.filename });
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
