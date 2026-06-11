/*
 * fbMassDownloader - prehook (MAIN world, document_start)
 *
 * Runs BEFORE engine/proxy.js. proxy.js defines its capture function with
 *   window.__setVideoRepresentations = window.__setVideoRepresentations || function(...)
 * so by defining ours FIRST, proxy.js keeps OUR version. proxy.js still patches
 * Facebook's `createRelayFBNetwork` to call __setVideoRepresentations with the
 * `all_video_dash_prefetch_representations` payload as the user browses.
 *
 * The original only stored the single highest-bandwidth VIDEO representation.
 * We keep the FULL list (video + audio) per video_id so we can offer HD video
 * with merged audio.
 */
(function () {
  "use strict";

  // Shared registry consumed by engine/bridge.js
  const FBMD = (window.__FBMD = window.__FBMD || {});
  FBMD.videos = FBMD.videos || new Map(); // video_id -> { id, representations, capturedAt }
  FBMD._listeners = FBMD._listeners || [];

  FBMD.onVideosChanged = function (fn) {
    FBMD._listeners.push(fn);
    return () => {
      const i = FBMD._listeners.indexOf(fn);
      if (~i) FBMD._listeners.splice(i, 1);
    };
  };
  FBMD._emitChange = function () {
    for (const fn of FBMD._listeners.slice()) {
      try {
        fn(FBMD.videos);
      } catch (e) {
        /* listener errors must not break capture */
      }
    }
  };

  // Compatibility map proxy.js / FB code may read (top video representation).
  window.videoRepresentationMap = window.videoRepresentationMap || {};

  // OUR capture function. Defined before proxy.js so its `|| function` keeps this.
  window.__setVideoRepresentations =
    window.__setVideoRepresentations ||
    function (list) {
      if (Array.isArray(list)) {
        try {
          let changed = false;
          for (const entry of list) {
            if (!entry || !Array.isArray(entry.representations)) continue;
            const id = String(entry.video_id);

            // Keep the highest-bandwidth video rep in the compat map.
            const videoReps = entry.representations
              .filter((r) => (r.mime_type || "").indexOf("video") > -1)
              .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
            if (videoReps[0]) window.videoRepresentationMap[id] = videoReps[0];

            // Store the FULL representation list for our own downloader.
            FBMD.videos.set(id, {
              id,
              representations: entry.representations,
              capturedAt: Date.now(),
            });
            changed = true;
          }
          if (changed) FBMD._emitChange();
        } catch (e) {
          console.error("[fbMassDownloader] capture error", e);
        }
      }
      // Mirror original return: only short-circuit FB prefetch if explicitly disabled.
      return !!window.__disablePreFetchVideo;
    };
})();
